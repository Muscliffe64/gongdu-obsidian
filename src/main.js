'use strict';
// 共读打卡：Obsidian 插件。和 Qiaomu Reader（乔木阅读器）一起用。
// - 状态栏：今天读了几分钟、打卡了没有；点一下打开打卡窗口。
// - 读书打卡：命令面板、左边栏按钮、状态栏都能打开。
// - 打开一本书时，在后台把封面传到共读书架上对应的书（只传网站上还没有封面图的）。
const { Plugin, Modal, TFile, PluginSettingTab, Setting, requestUrl } = require('obsidian');
const Q = require('./qiaomu');
const { createApi } = require('./api');
const { CoverSync } = require('./cover-sync');
const { createCoverFinder, readQiaomu } = require('./obsidian-io');
const { CheckinModal } = require('./checkin-modal');
const C = require('./connect');

const DEFAULTS = {
  base: 'https://123.57.56.38:627',
  token: '',
  autoCover: true,
  links: {},   // 文件路径 → 共读书架上的书 id（打卡时确认过的）
  covers: {},  // 书 id → { sig, result, at }：封面传没传过
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

    this.bar = this.addStatusBarItem();
    this.bar.addClass('gongdu-bar', 'mod-clickable');
    this.bar.setAttribute('aria-label', '共读：点一下打卡');
    this.registerDomEvent(this.bar, 'click', () => this.openCheckin());

    this.addCommand({ id: 'checkin', name: '读书打卡', callback: () => this.openCheckin() });
    this.addCommand({ id: 'sync-cover', name: '再试一次同步这本书的封面', callback: () => this.retryCover() });
    // 左边栏的按钮。Qiaomu Reader 读书时会藏起状态栏，所以有提示时也在这个按钮上标一个小点，点开打卡窗口能看到是什么。
    this.ribbon = this.addRibbonIcon('book-open-check', '共读：读书打卡', () => this.openCheckin());
    this.ribbon.addClass('gongdu-ribbon');
    this.addSettingTab(new GongduSettingTab(this.app, this));
    // 共读网站上点「连接 Obsidian」会打开 obsidian://gongdu-connect?server=…&code=…
    this.registerObsidianProtocolHandler('gongdu-connect', params => new ConnectModal(this.app, this, params.server, params.code).open());

    // Qiaomu Reader 的阅读页不算 Obsidian 的“当前文件”（打开书时没有 file-open），
    // 所以看当前标签页：换了标签页、标签页里换了书，都会触发 active-leaf-change / layout-change。
    this.registerEvent(this.app.workspace.on('file-open', file => this.onOpen(file)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => this.onOpen(bookFileIn(this.app, leaf))));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.onOpen(this.currentBook())));
    this.app.workspace.onLayoutReady(() => {
      this.refreshBar(true);
      this.onOpen(this.currentBook());
    });
    this.registerInterval(window.setInterval(() => this.refreshBar(), 5 * 60 * 1000));
  }

  onunload() { window.clearTimeout(this.saveTimer); window.clearTimeout(this.noteTimer); }

  api() { return createApi({ base: this.data.base, token: this.data.token, request: obsidianRequest }); }

  saveSoon() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveData(this.data), 500);
  }

  async remember(path, bookId) {
    this.data.links[path] = Number(bookId);
    await this.saveData(this.data);
  }

  openCheckin() { new CheckinModal(this.app, this).open(); }

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
    if (this.noteUntil && Date.now() < this.noteUntil) return;
    this.bar.removeClass('gongdu-warn', 'gongdu-hint');
    if (!this.data.token) { this.bar.setText('共读 · 还没连接'); return; }
    let text = '共读';
    try {
      const qm = await readQiaomu(this.app);
      const status = await this.sync.status(force);
      const m = Math.round(Q.secondsOn(qm.settings, status.day || Q.dayOf(Date.now())) / 60);
      text = `共读 · ${m ? `阅读器今天 ${m} 分钟 · ` : ''}${status.checked ? '今天打过卡了' : '今天还没打卡'}`;
    } catch (e) {
      text = e && e.status === 401 ? '共读 · 连接失效了，到共读网站重新连接' : '共读 · 没连上';
    }
    if (!(this.noteUntil && Date.now() < this.noteUntil)) this.bar.setText(text);
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
    this.bar.setText(`共读 · ${text}`);
    this.bar.removeClass('gongdu-warn', 'gongdu-hint');
    this.bar.addClass(kind === 'warn' ? 'gongdu-warn' : 'gongdu-hint');
    this.bar.setAttribute('aria-label', text);
    this.noteUntil = Date.now() + NOTE_MS;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.noteUntil = 0; this.bar.setAttribute('aria-label', '共读：点一下打卡'); this.refreshBar(); }, NOTE_MS);
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
