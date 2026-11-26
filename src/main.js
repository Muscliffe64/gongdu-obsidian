'use strict';
// 共读打卡：Obsidian 插件。和 Qiaomu Reader（乔木阅读器）一起用。
// - 状态栏：今天读了几分钟、打卡了没有；点一下打开打卡窗口。
// - 自动计时：在 Qiaomu Reader 里读书、最近 3 分钟有动作才算，8 分钟之内回来的补上停下的那段，按书记（见 clock.js）。
// - 摘句：在书里选中一句，点左边栏的共读按钮（或「摘下选中的句子」命令），打卡时默认勾上（见 clips.js）。
// - 读书打卡：命令面板、左边栏按钮、状态栏都能打开。
// - 打开一本书时，在后台把封面传到共读书架上对应的书（只传网站上还没有封面图的）。
const { Plugin, Modal, Notice, TFile, PluginSettingTab, Setting, requestUrl, setIcon } = require('obsidian');
const Q = require('./qiaomu');
const { createApi } = require('./api');
const { CoverSync } = require('./cover-sync');
const { createCoverFinder, readQiaomu } = require('./obsidian-io');
const { CheckinModal } = require('./checkin-modal');
const C = require('./connect');
const Clock = require('./clock');
const Clips = require('./clips');
const Place = require('./place');
const R = require('./reader-dom');
const { barView } = require('./timer-view');
const { titlesFromPath } = require('./match');
const L = require('./checkin-logic');

const DEFAULTS = {
  base: 'https://123.57.56.38:627',
  token: '',
  autoCover: true,
  links: {},   // 文件路径 → 共读书架上的书 id（打卡时确认过的）
  covers: {},  // 书 id → { sig, result, at }：封面传没传过
  time: {},    // 自动计时：{ "YYYY-MM-DD": { 书的路径: 秒 } }
  committed: {}, // 打卡时已经算进去的插件秒数：{ "YYYY-MM-DD": { 书的路径: 秒 } }
  remindedDay: '', // 读完离开书时提醒打卡：今天提醒过没有
  clips: [],   // 读书时摘下、还没打卡交上去的句子
};

const NOTE_MS = 60 * 1000;

/** 一个标签页里打开的书（Qiaomu Reader 的阅读页把书放在 view.file；也看 getState().file）。不是书就是 null。 */
function bookFileIn(app, leaf) {
  const view = leaf && leaf.view;
  if (!view) return null;
  let file = view.file;
  if (!(file instanceof TFile)) {
    let state = null;
    try { state = view.getState && view.getState(); } catch { state = null; }
    const p = state && (state.file || state.path);
    file = typeof p === 'string' ? app.vault.getAbstractFileByPath(p) : null;
  }
  return file instanceof TFile && Q.isBookPath(file.path) ? file : null;
}

/** Obsidian 的 requestUrl 包一层：不因为 4xx 抛错，返回 { status, json }。 */
async function obsidianRequest({ url, method, headers, body }) {
  const res = await requestUrl({ url, method, headers, body, throw: false });
  let json = null;
  try { json = res.json; } catch { json = null; }
  return { status: res.status, json };
}

class GongduPlugin extends Plugin {
  async onload() {
    this.data = Object.assign({}, DEFAULTS, await this.loadData());
    this.data.links = this.data.links || {};
    this.data.covers = this.data.covers || {};
    this.data.time = Clock.prune(this.data.time || {});
    this.data.committed = Clock.prune(this.data.committed || {});
    this.data.clips = Clips.pruneDays(Array.isArray(this.data.clips) ? this.data.clips : [], Q.dayOf(Date.now()));
    this.finder = createCoverFinder(this.app);
    this.sync = new CoverSync({
      api: { status: () => this.api().status(), uploadCover: (id, b) => this.api().uploadCover(id, b) },
      titlesOf: f => this.finder.titlesOf(f),
      findCover: f => this.finder.findCover(f),
      memo: { get: id => this.data.covers[id], set: (id, rec) => { this.data.covers[id] = rec; this.saveSoon(); } },
      links: () => this.data.links,
      hint: text => this.note(text, 'hint'),
      warn: text => this.note(text, 'warn'),
    });

    // 状态栏：常驻的计时（计时中 / 已暂停、书名、这本书今天几分钟）+ 打卡了没有。点一下打开打卡窗口。
    this.bar = this.addStatusBarItem();
    this.bar.addClass('gongdu-bar', 'mod-clickable');
    this.barIcon = this.bar.createSpan({ cls: 'gongdu-bar-icon' });
    this.barText = this.bar.createSpan({ cls: 'gongdu-bar-text' });
    this.bar.setAttribute('aria-label', '共读：点一下打卡');
    this.bar.setAttribute('data-tooltip-position', 'top');
    this.registerDomEvent(this.bar, 'click', () => this.openCheckin());
    this.checked = null;   // 今天打过卡没有（问过网站才知道）
    this.connected = !!this.data.token;
    this.barProblem = '';  // 连不上、令牌失效时的说法

    this.addCommand({ id: 'checkin', name: '读书打卡', callback: () => this.openCheckin() });
    this.addCommand({ id: 'clip', name: '摘下选中的句子（打卡时会列出来）', callback: () => this.clipSelection(true) });
    this.addCommand({ id: 'sync-cover', name: '再试一次同步这本书的封面', callback: () => this.retryCover() });
    // 左边栏的按钮。Qiaomu Reader 读书时会藏起状态栏，所以有提示时也在这个按钮上标一个小点，点开打卡窗口能看到是什么。
    // 书里选中了一句：点一下摘下来（不打开窗口，不打断读书）；没选中：点一下打卡。
    this.ribbon = this.addRibbonIcon('book-open-check', '共读：书里选中一句时点一下摘下来；没选中时点一下打卡', () => this.ribbonClick());
    this.ribbon.addClass('gongdu-ribbon');
    this.addSettingTab(new GongduSettingTab(this.app, this));
    // 共读网站上点「连接 Obsidian」会打开 obsidian://gongdu-connect?server=…&code=…
    this.registerObsidianProtocolHandler('gongdu-connect', params => new ConnectModal(this.app, this, params.server, params.code).open());

    // Qiaomu Reader 的阅读页不算 Obsidian 的“当前文件”（打开书时没有 file-open），
    // 所以看当前标签页：换了标签页、标签页里换了书，都会触发 active-leaf-change / layout-change。
    this.registerEvent(this.app.workspace.on('file-open', file => this.onOpen(file)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { this.onOpen(bookFileIn(this.app, leaf)); this.renderBar(); this.checkLeftBook(); }));
    this.registerEvent(this.app.workspace.on('layout-change', () => { this.onOpen(this.currentBook()); this.renderBar(); this.checkLeftBook(); }));
    this.app.workspace.onLayoutReady(() => {
      this.refreshBar(true);
      this.onOpen(this.currentBook());
    });
    this.registerInterval(window.setInterval(() => this.refreshBar(), 5 * 60 * 1000));

    // 自动计时：外面的 document 和阅读页里（shadow DOM、iframe）的点击、按键、滚动、鼠标移动都算“在读”。
    // 右边栏的 AI 伴读也在这个 document 里，所以在那里点、滚、动鼠标也算。
    this.lastActive = 0;
    this.lastTick = 0;
    this.unsaved = 0;
    this.hold = null; // 3 分钟没动时先记着、还没算进去的时间（见 clock.js 的 holdIdle）
    // 挂在阅读页里（foliate 的 iframe 等）的监听：插件关掉时要撤下（onunload 里 detach）
    const mark = () => this.markActive(Date.now());
    this.watcher = R.createWatcher(mark);
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) this.registerDomEvent(document, ev, mark, { capture: true, passive: true });
    this.registerInterval(window.setInterval(() => this.tickClock(), Clock.TICK_MS));
    // 切到别的软件、切回来：状态栏马上变，不用等下一次计时。切走了，停下的那段就不补了。
    this.registerDomEvent(window, 'focus', () => this.renderBar());
    this.registerDomEvent(window, 'blur', () => { this.hold = { since: this.lastActive, broken: true, sec: 0 }; this.renderBar(); });
    this.registerDomEvent(document, 'visibilitychange', () => this.renderBar());
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      Clock.rename(this.data.time, oldPath, file.path);
      Clock.rename(this.data.committed, oldPath, file.path);
      for (const c of this.data.clips) if (c.book === oldPath) c.book = file.path;
      this.saveSoon();
    }));
  }

  onunload() {
    window.clearTimeout(this.saveTimer); window.clearTimeout(this.noteTimer);
    if (this.watcher) this.watcher.detach(); // 阅读页里挂的监听不归 Obsidian 管，自己撤下
    if (this.ribbon) { this.ribbon.removeAttribute('data-gongdu-min'); }
    if (this.unsaved) this.saveData(this.data);
  }

  /** 有动作了：8 分钟之内回来的，把停下的那段补上；从“3 分钟没动”回来，马上显示计时中。 */
  markActive(now) {
    const was = this.lastActive;
    if (this.hold) {
      const added = Clock.resume(this.data.time, this.hold, now);
      this.hold = null;
      if (added) this.saveSoon();
    }
    this.lastActive = now;
    if (!was || now - was > Clock.IDLE_MS) this.renderBar();
  }

  /** 现在这一刻的计时情况（tick 和状态栏共用）。 */
  clockCtx(now = Date.now()) {
    const r = this.readingLeaf();
    return {
      r,
      ctx: {
        now, day: Q.dayOf(now), book: r ? r.file.path : '',
        focused: document.hasFocus() && document.visibilityState !== 'hidden',
        lastActive: this.lastActive, paused: !!this.checkinOpen,
      },
    };
  }

  /** 画状态栏和左边栏按钮上的计时。不问网站，随时可以调。 */
  renderBar() {
    if (!this.bar) return;
    const { r, ctx } = this.clockCtx();
    const st = Clock.stateOf(ctx);
    const title = r ? (titlesFromPath(r.file.path)[0] || r.file.basename) : '';
    const view = barView({
      connected: !!this.data.token, state: st.state, reason: st.reason, title,
      bookSec: r ? Clock.secondsOf(this.data.time, ctx.day, r.file.path) : 0,
      todaySec: Clock.secondsOf(this.data.time, ctx.day),
      checked: this.checked,
    });
    const noting = this.noteUntil && Date.now() < this.noteUntil && this.lastNote;
    let text = view.text;
    if (this.barProblem && this.data.token) text = `${text.replace(/ · 今天(打过卡了|还没打卡)$/, '')} · ${this.barProblem}`;
    if (noting) text = `${text.replace(/ · 今天(打过卡了|还没打卡)$/, '')} · ${this.lastNote.text}`;
    if (this.barIconName !== view.icon) { setIcon(this.barIcon, view.icon); this.barIconName = view.icon; }
    this.barText.setText(text);
    this.bar.toggleClass('gongdu-running', view.running);
    this.bar.toggleClass('gongdu-paused', !view.running);
    this.bar.toggleClass('gongdu-warn', !!(noting && this.lastNote.kind === 'warn') || !!this.barProblem);
    this.bar.toggleClass('gongdu-hint', !!(noting && this.lastNote.kind !== 'warn'));
    this.bar.setAttribute('aria-label', noting ? `${this.lastNote.text}\n${view.tooltip}` : view.tooltip);
    // Qiaomu Reader 读书时会把状态栏藏起来，所以左边栏按钮上也标出来：分钟数，计时中是强调色
    if (this.ribbon) {
      if (view.badge) this.ribbon.setAttribute('data-gongdu-min', view.badge); else this.ribbon.removeAttribute('data-gongdu-min');
      this.ribbon.toggleClass('gongdu-running', view.running);
      this.ribbon.setAttribute('aria-label', `共读：读书打卡。${view.tooltip}`);
    }
  }

  /** 正在看的标签页里的书和这个标签页（只看当前标签页，侧边栏开着的书不算在读）。 */
  readingLeaf() {
    const ws = this.app.workspace;
    const leaf = ws.getMostRecentLeaf ? ws.getMostRecentLeaf() : ws.activeLeaf;
    const file = bookFileIn(this.app, leaf);
    return file ? { leaf, file } : null;
  }

  /** 每 15 秒一次：在读就把这段时间记到这本书上。 */
  tickClock() {
    const now = Date.now();
    const r = this.readingLeaf();
    if (r && r.leaf.view && r.leaf.view.containerEl) this.watcher.watch(r.leaf.view.containerEl);
    // 阅读器的进度变了也算翻过页（有的翻页方式外面收不到事件）
    if (r) {
      const qm = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins[Q.PLUGIN_ID];
      const pr = qm && qm.progress && qm.progress[r.file.path];
      const sig = pr ? `${r.file.path}|${pr.pct}|${pr.percent}` : '';
      if (sig && this.progressSig && sig !== this.progressSig) this.markActive(now);
      this.progressSig = sig;
    }
    const { ctx } = this.clockCtx(now);
    this.hold = Clock.holdIdle(this.hold, this.lastTick, ctx);
    const added = Clock.tick(this.data.time, this.lastTick, ctx);
    this.lastTick = now;
    this.renderBar();
    if (!added) return;
    this.unsaved += added;
    if (this.unsaved >= 60) { this.unsaved = 0; Clock.prune(this.data.time); Clock.prune(this.data.committed); this.saveSoon(); }
  }

  /** 今天在插件里记的分钟：给书就是这本书，不给就是所有书。 */
  minutesToday(path) { return Math.round(Clock.secondsOf(this.data.time, Q.dayOf(Date.now()), path) / 60); }

  /**
   * 把阅读页里选中的句子摘下来。loud：没选中或摘好了都说一句（用命令时）；
   * 打开打卡窗口前顺手摘的时候不出声，窗口里能看到。
   */
  clipSelection(loud = false) {
    const r = this.readingLeaf();
    const { text, range } = r && r.leaf.view && r.leaf.view.containerEl ? R.selection(r.leaf.view.containerEl) : { text: '', range: null };
    if (!text) { if (loud) new Notice('先在书里选中一句话，再摘。'); return null; }
    const day = Q.dayOf(Date.now());
    // 今天已经交上去的那句还选着（打完卡再打开窗口时）：不再摘一次
    if (this.sentKeys && this.sentKeys.has(Clips.sentKey(day, r.file.path, text))) { if (loud) new Notice('这句今天已经交过了。'); return null; }
    this.data.clips = Clips.pruneDays(this.data.clips, day);
    const out = Clips.add(this.data.clips, { text, book: r.file.path, day, now: Date.now(), ...this.placeNow(r, '', range) });
    if (!out) return null;
    this.saveSoon();
    if (loud) this.clipNotice(out, r.file.path, day);
    return out;
  }

  /**
   * 阅读页里现在读到第几章第几节（还有电子书自带的纸书页码）。cfi：高亮记的位置，按它找章节。
   * 拿不到就是 { location: '', page: '' }。
   */
  placeNow(r = this.readingLeaf(), cfi = '', range = null) {
    const el = r && r.leaf.view && r.leaf.view.containerEl;
    return Place.placeOf(el ? R.foliateView(el) : null, cfi, range);
  }

  /** 摘好以后的一句短提示（几秒就消失，不是弹窗）。 */
  clipNotice(out, path, day) {
    const n = Clips.forBook(this.data.clips, day, path).length;
    const t = out.clip.text;
    const where = Place.placeLabel(out.clip);
    new Notice(out.added ? `摘下了：「${t.slice(0, 24)}${t.length > 24 ? '…' : ''}」${where ? `（${where}）` : ''}。今天这本书摘了 ${n} 句，打卡时会带上。` : '这句已经摘过了。', 3500);
  }

  /** 左边栏共读按钮：选中了新的一句就摘下来；否则打开打卡窗口。 */
  ribbonClick() {
    const r = this.readingLeaf();
    const text = r && r.leaf.view && r.leaf.view.containerEl ? R.selectedText(r.leaf.view.containerEl) : '';
    const day = Q.dayOf(Date.now());
    const already = !!text && this.data.clips.some(c => c.day === day && c.book === r.file.path && c.text === Clips.cleanText(text));
    if (L.ribbonAction({ selection: text, alreadyClipped: already }) === 'clip') {
      const out = this.clipSelection(false);
      if (out) { this.clipNotice(out, r.file.path, day); return; }
    }
    this.openCheckin();
  }

  /**
   * 读完离开书（换到别的标签页、关掉书，现在没在读别的书）：这本书今天计了 10 分钟以上、今天还没打卡，
   * 就在右上角提醒一句“打卡？”，带个按钮。一天最多一次，不是弹窗。
   */
  async checkLeftBook() {
    const r = this.readingLeaf();
    const nowBook = r ? r.file.path : '';
    const leftBook = this.lastReadingBook && this.lastReadingBook !== nowBook ? this.lastReadingBook : '';
    this.lastReadingBook = nowBook;
    if (!leftBook || nowBook) return;
    const today = Q.dayOf(Date.now());
    const base = { leftBook, nowBook, bookSec: Clock.secondsOf(this.data.time, today, leftBook), connected: !!this.data.token, remindedDay: this.data.remindedDay, today, checkinOpen: !!this.checkinOpen };
    // 先粗看一下（不问网站），再问网站今天打过卡没有（可能在网页上打过）
    if (!L.shouldRemind({ ...base, checked: false })) return;
    await this.refreshBar(true);
    if (!L.shouldRemind({ ...base, checked: this.checked })) return;
    this.data.remindedDay = today;
    this.saveSoon();
    const minutes = Math.floor(base.bookSec / 60);
    const title = titlesFromPath(leftBook)[0] || '这本书';
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: `今天读《${title}》${minutes} 分钟了，还没打卡。` });
    const btn = frag.createEl('button', { cls: 'mod-cta gongdu-notice-btn', text: '打卡' });
    const notice = new Notice(frag, 15000);
    btn.addEventListener('click', e => { e.stopPropagation(); notice.hide(); this.openCheckin(); });
  }

  /** 交上去的摘句去掉。 */
  /** 记下今天交上去的摘句（只记在内存里），书里还选着它时不再摘一次。 */
  markSent(clips) {
    if (!this.sentKeys) this.sentKeys = new Set();
    for (const c of clips) this.sentKeys.add(Clips.sentKey(c.day, c.book, c.text));
  }

  async dropClips(ids) {
    if (!ids.length) return;
    this.data.clips = Clips.remove(this.data.clips, ids);
    await this.saveData(this.data);
  }

  api() { return createApi({ base: this.data.base, token: this.data.token, request: obsidianRequest }); }

  saveSoon() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveData(this.data), 500);
  }

  async remember(path, bookId) {
    this.data.links[path] = Number(bookId);
    await this.saveData(this.data);
  }

  /** 打开打卡窗口。阅读页里正好选中了一句，先把它摘下来（窗口里默认勾上）。 */
  openCheckin() {
    this.clipSelection(false);
    new CheckinModal(this.app, this).open();
  }

  /** 用连接码连上共读：换到令牌，存好地址和令牌，马上刷新状态，再同步一次正在读的书的封面。 */
  async connect(server, code) {
    const r = await C.exchange({ server, code, request: obsidianRequest });
    this.data.base = r.base;
    this.data.token = r.token;
    this.data.covers = {};
    this.sync.forget();
    await this.saveData(this.data);
    this.seen = new Map();
    this.refreshBar(true);
    this.onOpen(this.currentBook());
    return r;
  }

  /** 取走最近的提示（打卡窗口里显示），左边栏的小点消掉。一小时前的就不说了。 */
  takeNote() {
    const n = this.lastNote && Date.now() - this.lastNote.at < 60 * 60 * 1000 ? this.lastNote : null;
    this.lastNote = null;
    if (this.ribbon) this.ribbon.removeClass('gongdu-attn-hint', 'gongdu-attn-warn');
    return n;
  }

  /** 现在在读的书：当前标签页里的书；没有就找最近用过的 Qiaomu Reader 阅读页。 */
  currentBook() {
    const ws = this.app.workspace;
    const active = bookFileIn(this.app, ws.getMostRecentLeaf ? ws.getMostRecentLeaf() : ws.activeLeaf);
    if (active) return active;
    const leaves = ws.getLeavesOfType ? ws.getLeavesOfType(Q.PLUGIN_ID) : [];
    for (const leaf of leaves) { const f = bookFileIn(this.app, leaf); if (f) return f; }
    return null;
  }

  /**
   * 打开了一本书：等一下（让阅读器先把封面缓存写好），再在后台同步封面。
   * 换标签页、调整窗口都会触发，所以同一本书十分钟内只跑一次。
   */
  onOpen(file) {
    if (!(file instanceof TFile) || !Q.isBookPath(file.path)) return;
    const now = Date.now();
    this.seen = this.seen || new Map();
    const last = this.seen.get(file.path);
    if (last && now - last < 10 * 60 * 1000) return;
    this.seen.set(file.path, now);
    this.refreshBar();
    if (!this.data.autoCover || !this.data.token || !this.data.base) return;
    window.setTimeout(() => { this.sync.sync(file).catch(() => {}); }, 1500);
  }

  async retryCover() {
    const f = this.currentBook();
    if (!(f instanceof TFile) || !Q.isBookPath(f.path)) { this.note('先在阅读器里打开一本书', 'hint'); return; }
    this.data.covers = Object.fromEntries(Object.entries(this.data.covers).filter(([, r]) => !r || !String(r.sig || '').startsWith(f.path + '|')));
    this.saveSoon();
    const r = await this.sync.sync(f, { force: true });
    const say = { set: '封面传好了', same: '网站上已经是这张封面了', 'has-cover': '网站上这本书已经有封面图了（要换的话在打卡窗口里勾选）', kept: '网站上这本书已经有封面图了', removed: '这本书的封面图被去掉过，要换回来在打卡窗口里勾选', none: '阅读器里没找到这本书的封面' }[r];
    if (say) this.note(say, 'hint');
  }

  /** 状态栏：今天读了几分钟、打卡了没有。force：不用缓存，重新问网站。 */
  async refreshBar(force = false) {
    if (!this.data.token) { this.checked = null; this.barProblem = ''; this.renderBar(); return; }
    try {
      const status = await this.sync.status(force);
      this.checked = !!status.checked;
      this.barProblem = '';
    } catch (e) {
      this.checked = null;
      this.barProblem = e && e.status === 401 ? '连接失效了，到共读网站重新连接' : '没连上共读';
    }
    this.renderBar();
  }

  /**
   * 一句提示，不弹窗：状态栏上显示一分钟（Qiaomu Reader 读书时状态栏是藏起来的）；
   * 左边栏按钮上标个小点（提示是蓝的，出错是红的），打开打卡窗口时在最上面说这句话，然后小点消掉。
   */
  note(text, kind = 'hint') {
    this.lastNote = { text, kind, at: Date.now() };
    if (this.ribbon) {
      this.ribbon.removeClass('gongdu-attn-hint', 'gongdu-attn-warn');
      this.ribbon.addClass(kind === 'warn' ? 'gongdu-attn-warn' : 'gongdu-attn-hint');
    }
    this.noteUntil = Date.now() + NOTE_MS;
    this.renderBar();
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.noteUntil = 0; this.refreshBar(); }, NOTE_MS);
  }
}

/** 从共读网站的链接打开：先问一句要不要连，连上后说连的是谁。 */
class ConnectModal extends Modal {
  constructor(app, plugin, server, code) {
    super(app);
    this.plugin = plugin;
    this.server = C.cleanServer(server);
    this.code = C.cleanCode(code);
  }

  onOpen() {
    const el = this.contentEl;
    this.modalEl.addClass('gongdu-modal');
    this.titleEl.setText('连接共读');
    if (!this.server || !this.code) {
      el.createEl('p', { cls: 'gongdu-bad', text: '这个连接链接不完整。请回到共读网站“我的”页面，再点一次「连接 Obsidian」。' });
      return;
    }
    const current = C.cleanServer(this.plugin.data.base);
    el.createEl('p', { text: `把这个 Obsidian 连到共读网站 ${this.server}？连上以后，在这里打卡、同步封面都记到你的共读账号上。` });
    if (current && current !== this.server) el.createEl('p', { cls: 'gongdu-bad', text: `注意：这和现在设置里的地址（${current}）不一样。不是老师给的地址就别连。` });
    if (this.plugin.data.token) el.createEl('p', { cls: 'gongdu-note', text: '这里已经连过共读，连上新的会换掉之前的。' });
    const msg = el.createEl('p', { cls: 'gongdu-note' });
    const row = el.createDiv({ cls: 'gongdu-actions' });
    const cancel = row.createEl('button', { text: '不连' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: '连接' });
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      cancel.disabled = true;
      msg.setText('正在连接……');
      try {
        const r = await this.plugin.connect(this.server, this.code);
        el.empty();
        el.createEl('p', { cls: 'gongdu-ok', text: `连上了：${r.name}${r.class_name ? `（${r.class_name}）` : ''}。` });
        el.createEl('p', { cls: 'gongdu-note', text: '读书时点左边栏的共读按钮打卡。打开一本书时，封面会自动传到共读书架上。' });
        el.createDiv({ cls: 'gongdu-actions' }).createEl('button', { cls: 'mod-cta', text: '好' }).addEventListener('click', () => this.close());
      } catch (e) {
        msg.setText(`没连上：${e.message}`);
        msg.addClass('gongdu-bad');
        cancel.disabled = false;
      }
    });
  }

  onClose() { this.contentEl.empty(); }
}

class GongduSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    containerEl.createEl('p', { text: '和 Qiaomu Reader 一起用：读书时记下的时长、进度和高亮，在这里一键打卡到共读；打开一本书时，自动把封面传到共读书架上。' });

    const link = new Setting(containerEl).setName('连接共读')
      .setDesc(p.data.token ? '已经连上了。要换账号，或者连接失效了，就在共读网站“我的”页面点「连接 Obsidian」。' : '在共读网站“我的”页面点「连接 Obsidian」，会自动打开这里连好。Obsidian 在另一台设备上的话，把网站上显示的连接码填在这里。');
    let codeInput = null;
    link.addText(t => { codeInput = t; t.setPlaceholder('连接码，像 K7QM-2XPA'); });
    link.addButton(b => b.setButtonText('连接').setCta().onClick(async () => {
      b.setDisabled(true);
      link.setDesc('正在连接……');
      try {
        const r = await p.connect(p.data.base, codeInput.getValue());
        link.setDesc(`连上了：${r.name}${r.class_name ? `（${r.class_name}）` : ''}。`);
        codeInput.setValue('');
        tokenInput && tokenInput.setValue(p.data.token);
      } catch (e) { link.setDesc(`没连上：${e.message}`); }
      b.setDisabled(false);
    }));

    new Setting(containerEl).setName('共读网站地址').setDesc('老师给的地址。')
      .addText(t => t.setPlaceholder('https://…').setValue(p.data.base).onChange(async v => { p.data.base = v.trim(); p.sync.forget(); await p.saveData(p.data); }));

    let tokenInput = null;
    new Setting(containerEl).setName('令牌').setDesc('连接共读时自动填好，一般不用管。这是你的个人凭证，不要发给别人，也不要把这个库公开分享。')
      .addText(t => {
        tokenInput = t;
        t.inputEl.type = 'password';
        t.setPlaceholder('gd_…').setValue(p.data.token).onChange(async v => { p.data.token = v.trim(); p.sync.forget(); await p.saveData(p.data); });
      });

    const check = new Setting(containerEl).setName('检查连接');
    check.addButton(b => b.setButtonText('检查').onClick(async () => {
      check.setDesc('正在连接……');
      try {
        const s = await p.sync.status(true);
        const qm = await readQiaomu(p.app);
        check.setDesc(`连上了：${s.name}，书架上有 ${(s.books || []).length} 本在读或搁置的书。${qm.installed ? '' : '没找到 Qiaomu Reader 插件的数据，时长、进度和高亮读不到。'}`);
        p.refreshBar(true);
      } catch (e) { check.setDesc(`没连上：${e.message}`); }
    }));

    new Setting(containerEl).setName('自动同步封面')
      .setDesc('打开一本书时，把阅读器里的封面传到共读书架上同一本书（只传网站上还没有封面图的，已经有的不换）。')
      .addToggle(t => t.setValue(p.data.autoCover).onChange(async v => { p.data.autoCover = v; await p.saveData(p.data); }));
  }
}

module.exports = GongduPlugin;
module.exports.bookFileIn = bookFileIn;
