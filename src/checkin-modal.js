'use strict';
// 读书打卡窗口：最上面一块是书、今天读了几分钟、读到哪里；下面是摘句（每句的想法、出处点了才展开）；
// 自己写一句、换封面都收起来，要用再点开。今天打过卡就先收成一行。
// 窗口开着的时候自动计时停下（写想法、粘贴不算读书时间）。
const { Modal, TFile, Platform, MarkdownRenderer, Component } = require('obsidian');
const MathText = require('./mathtext');
const Q = require('./qiaomu');
const { matchBook } = require('./match');
const { readQiaomu } = require('./obsidian-io');
const Clips = require('./clips');
const Clock = require('./clock');
const L = require('./checkin-logic');

const NEW = 'new';

/**
 * 一句摘录的出处：第几章第几节、纸书页数，两格。先填好从书的目录读到的，可以改，也可以清空。
 * value() 只给填了的：{ location?, page? }。
 */
function placeInputs(parent, place) {
  const row = parent.createDiv({ cls: 'gongdu-place' });
  const loc = row.createEl('input', { type: 'text', cls: 'gongdu-place-loc', attr: { placeholder: '第几章第几节（可以不写）', maxlength: '60', 'aria-label': '第几章第几节' } });
  const page = row.createEl('input', { type: 'text', cls: 'gongdu-place-page', attr: { placeholder: '页数', inputmode: 'numeric', maxlength: '20', 'aria-label': '纸质书页数' } });
  loc.value = (place && place.location) || '';
  page.value = (place && place.page) || '';
  return {
    row,
    value() {
      const out = {};
      if (loc.value.trim()) out.location = loc.value.trim();
      if (page.value.trim()) out.page = page.value.trim();
      return out;
    },
  };
}

/** 粘贴来的 HTML 里有公式就转成 Markdown 文字；没有公式返回 null，照普通粘贴。 */
function mathFromHtml(html) {
  if (!html || typeof DOMParser === 'undefined' || !/<img|<math/i.test(html)) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return MathText.hasMath(doc.body) ? MathText.fromNode(doc.body) || null : null;
  } catch { return null; }
}

class CheckinModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.md = new Component();
  }

  /** 摘句的文字：有公式或者分了段，按 Markdown 显示（Obsidian 自己会渲染 $…$）；否则照原样。 */
  showText(el, text) {
    if (!/\$|\n|\*\*/.test(text) || !MarkdownRenderer || typeof MarkdownRenderer.render !== 'function') { el.setText(text); return; }
    el.addClass('gongdu-md');
    MarkdownRenderer.render(this.app, text, el, '', this.md).catch(() => { el.empty(); el.setText(text); });
  }

  async onOpen() {
    this.plugin.checkinOpen = true;
    this.md.load();
    this.modalEl.addClass('gongdu-modal');
    this.titleEl.setText('读书打卡');
    this.contentEl.createEl('p', { cls: 'gongdu-note', text: '正在读阅读器的记录……' });
    try {
      await this.load();
      this.draw();
    } catch (e) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { cls: 'gongdu-bad', text: e.message || '出错了' });
      if (e.status === 401 || e.code === 'no_token' || e.code === 'no_base') {
        this.contentEl.createEl('p', { cls: 'gongdu-note', text: '还没连上共读：在共读网站“我的”页面点「连接 Obsidian」，会自动打开这里连好。' });
      }
    }
  }

  onClose() {
    this.plugin.checkinOpen = false;
    this.plugin.lastTick = Date.now(); // 窗口开着的这段不补算
    this.contentEl.empty();
    this.md.unload();
  }

  /** 读网站的书架和今天的情况、阅读器的记录，选出这次打卡的那本书。 */
  async load() {
    const p = this.plugin;
    this.status = await p.sync.status(true);
    this.qiaomu = await readQiaomu(this.app);
    const day = this.status.day || Q.dayOf(Date.now());
    this.day = day;
    // 哪本书：现在打开的书 → 阅读器最后读的 → 进度里最新的。
    const active = p.currentBook();
    const latest = Q.latestBook(this.qiaomu.progress);
    const path = (active && active.path) || this.qiaomu.lastBookPath || (latest && latest.path) || '';
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    this.file = file instanceof TFile ? file : null;
    this.books = (this.status.books || []).filter(b => b.status !== 'finished');
    if (this.file) {
      const titles = await p.finder.titlesOf(this.file);
      this.match = matchBook({ path: this.file.path, titles }, this.books, p.data.links);
      this.localCover = p.finder.findCover(this.file).catch(() => null); // 后台先找着，勾选换封面时用
    } else {
      this.match = { book: null, title: '' };
    }
    // 阅读器里这个文件对应的书：插件计的时间只算给它（下拉框选了别的书就不算）
    this.fileKey = this.file ? (this.match.book ? String(this.match.book.id) : this.match.title ? NEW : null) : null;
    this.highlights = this.file ? Q.highlightsOn(this.qiaomu.highlights, this.file.path, day) : [];
    // 高亮记着它在书里的位置（cfi），书开着的话按它找第几章第几节
    this.highlights = this.highlights.map(hl => ({ ...hl, ...(hl.cfi ? p.placeNow(undefined, hl.cfi) : { location: '', page: '' }) }));
    this.here = p.placeNow(); // 自己写一句时先填现在读到的章节
    this.seconds = Q.secondsOn(this.qiaomu.settings, day);
    // 插件自动记的：用本机的日期（和计时时一样）
    const today = Q.dayOf(Date.now());
    this.clockDay = today;
    this.clockSeconds = this.file ? Clock.secondsOf(p.data.time, today, this.file.path) : 0;
    this.committedSeconds = this.file ? Clock.secondsOf(p.data.committed, today, this.file.path) : 0;
    this.clips = Clips.notIn(Clips.forBook(p.data.clips, today, this.file ? this.file.path : ''), this.highlights.map(h => h.text));
    this.percent = this.file ? Q.percentOf(this.qiaomu.progress, this.file.path) : null;
  }

  draw() {
    const el = this.contentEl;
    el.empty();
    const s = this.status;
    const p = this.plugin;

    // 插件的提示（次要色小字）
    const note = p.takeNote();
    if (note) el.createEl('p', { cls: note.kind === 'warn' ? 'gongdu-note gongdu-warn-text' : 'gongdu-note', text: note.text });

    // 今天已经打过卡：先收成一行，点“再交一次”才展开下面的
    const newItems = this.clips.length;
    const folded = L.foldChecked({ checked: !!s.checked, newItems });
    let unfold = () => {};
    if (s.checked) {
      const done = el.createDiv({ cls: 'gongdu-done' });
      done.createSpan({ cls: 'gongdu-done-text', text: `今天已打卡 · ${s.minutes} 分钟` });
      if (folded) {
        const again = done.createEl('button', { cls: 'gongdu-link', text: '再交一次' });
        again.addEventListener('click', () => unfold());
      } else {
        done.createSpan({ cls: 'gongdu-note', text: `还有 ${newItems} 句新摘的，可以再交一次` });
      }
    }
    const form = el.createDiv({ cls: 'gongdu-form' });
    if (s.checked) form.createDiv({ cls: 'gongdu-note', text: '再交一次：同一本书会更新分钟和进度，换一本书另记一条。' });

    const fieldError = box => box.createDiv({ cls: 'gongdu-error gongdu-hidden', attr: { role: 'alert' } });
    const showError = (input, errEl, text) => {
      errEl.setText(text); errEl.removeClass('gongdu-hidden');
      if (input) { input.addClass('gongdu-invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); }
    };
    const clearError = (input, errEl) => {
      errEl.setText(''); errEl.addClass('gongdu-hidden');
      if (input) { input.removeClass('gongdu-invalid'); input.removeAttribute('aria-invalid'); }
    };
    // 点一下才展开的小链接（想法、出处、怎么算的、自己写一句……）
    const opener = (parent, text, onOpen) => {
      const btn = parent.createEl('button', { cls: 'gongdu-link', text });
      btn.addEventListener('click', () => { btn.addClass('gongdu-hidden'); onOpen(); });
      return btn;
    };

    // 1. 主要的一块：书、分钟、进度
    const main = form.createDiv({ cls: 'gongdu-main' });
    const select = main.createEl('select', { cls: 'dropdown gongdu-book', attr: { id: 'gongdu-book', 'aria-label': '书' } });
    for (const b of this.books) select.createEl('option', { value: String(b.id), text: `《${b.title}》${b.status === 'paused' ? '（搁置）' : ''}` });
    const newTitle = this.match.book ? '' : this.match.title;
    if (newTitle) select.createEl('option', { value: NEW, text: `加一本：《${newTitle}》` });
    if (!this.books.length && !newTitle) select.createEl('option', { value: NEW, text: '加一本新书' });
    select.value = this.fileKey || (this.books[0] ? String(this.books[0].id) : NEW);
    if (this.file) select.setAttribute('title', `阅读器里的文件：${this.file.path}`); // 路径很长，悬停才看
    const titleInput = main.createEl('input', { type: 'text', cls: 'gongdu-newtitle', value: newTitle, attr: { placeholder: '书名', 'aria-label': '新书的书名' } });
    const showTitle = () => titleInput.toggleClass('gongdu-hidden', select.value !== NEW);
    showTitle();
    if (!this.file) main.createDiv({ cls: 'gongdu-note gongdu-warn-text', text: '没找到阅读器里正在读的书，请选一下是哪本。' });

    const nums = main.createDiv({ cls: 'gongdu-nums' });
    const numField = (label, unit, attrs) => {
      const wrap = nums.createEl('label', { cls: 'gongdu-numfield' });
      wrap.createSpan({ text: label });
      const input = wrap.createEl('input', { type: 'text', cls: 'gongdu-num', attr: { autocomplete: 'off', ...attrs } });
      wrap.createSpan({ text: unit });
      return input;
    };
    const minutes = numField('今天读了', '分钟', { id: 'gongdu-min', inputmode: 'numeric', placeholder: '30', 'aria-describedby': 'gongdu-min-note' });
    const pct = numField('读到', '%', { id: 'gongdu-pct', inputmode: 'decimal', placeholder: '45' });
    if (this.percent != null) pct.value = String(this.percent);
    const hintRow = main.createDiv({ cls: 'gongdu-hint' });
    const minNote = hintRow.createSpan({ cls: 'gongdu-note', attr: { id: 'gongdu-min-note' } });
    const hintMore = hintRow.createEl('button', { cls: 'gongdu-link', text: '怎么算的' });
    const hintLong = main.createDiv({ cls: 'gongdu-note gongdu-hidden' });
    hintMore.addEventListener('click', () => { hintLong.toggleClass('gongdu-hidden', !hintLong.hasClass('gongdu-hidden')); });
    const mainErr = fieldError(main);
    for (const input of [minutes, pct, titleInput]) input.addEventListener('input', () => clearError(input, mainErr));

    const fromLog = Math.round(this.seconds / 60);
    const rows = [...(s.readings || []), ...(s.pending || [])];
    const siteMinOf = key => {
      if (key === NEW) return 0;
      const found = rows.find(r => r.book_id === Number(key));
      return found ? found.minutes || 0 : 0;
    };
    let plan = null;
    const fillMinutes = () => {
      const key = select.value;
      plan = L.minutesPlan({
        fileKey: this.fileKey, selectedKey: key, siteMin: siteMinOf(key),
        clockSec: this.clockSeconds, committedSec: this.committedSeconds,
        fromLog, rows, selectedId: key === NEW ? null : Number(key),
      });
      minutes.value = plan.value;
      clearError(minutes, mainErr);
      const hint = L.minutesHint(plan, { fileMin: Math.round(this.clockSeconds / 60), fromLog });
      minNote.setText(hint.text);
      minNote.toggleClass('gongdu-warn-text', hint.warn);
      hintLong.setText(hint.long);
      hintMore.toggleClass('gongdu-hidden', !hint.long);
      if (!hint.long) hintLong.addClass('gongdu-hidden');
    };
    fillMinutes();

    // 2. 摘句：读书时摘的 + 今天的高亮。都没有就不出这一块。
    const items = L.excerptItems({ clips: this.clips, highlights: this.highlights });
    const exSec = form.createDiv({ cls: 'gongdu-section' });
    const exHead = exSec.createDiv({ cls: 'gongdu-section-head' });
    exHead.createSpan({ cls: 'gongdu-label', text: '摘句' });
    const countEl = exHead.createSpan({ cls: 'gongdu-count' });
    const exBox = exSec.createDiv({ cls: 'gongdu-excerpts' });
    if (!items.length) exBox.addClass('gongdu-hidden');
    const picked = [];
    const clipped = [];

    // 一句下面的小字：出处、想法、不要这句。想法框和出处的格子点了才出来。
    const extras = (row, place, { drop } = {}) => {
      const line = row.createDiv({ cls: 'gongdu-extras' });
      const placeText = line.createSpan({ cls: 'gongdu-place-text' });
      const where = placeInputs(row, place);
      where.row.addClass('gongdu-hidden');
      const label = L.placeLabel(place);
      placeText.setText(label);
      opener(line, label ? '改出处' : '加出处', () => { placeText.addClass('gongdu-hidden'); where.row.removeClass('gongdu-hidden'); });
      const thought = row.createEl('textarea', { cls: 'gongdu-thought gongdu-hidden', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
      opener(line, '写想法', () => { thought.removeClass('gongdu-hidden'); thought.focus(); });
      let dropBtn = null;
      if (drop) { dropBtn = line.createEl('button', { cls: 'gongdu-link gongdu-quiet', text: '不要这句' }); }
      return { line, thought, where, dropBtn };
    };

    const listRow = (text, checked, place, opts) => {
      const row = exBox.createDiv({ cls: 'gongdu-hl' });
      const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = checked;
      const span = label.createSpan({ cls: 'gongdu-hl-text' });
      this.showText(span, text);
      const x = extras(row, place, opts);
      const show = () => { row.toggleClass('gongdu-off', !box.checked); x.line.toggleClass('gongdu-hidden', !box.checked); if (!box.checked) { x.thought.addClass('gongdu-hidden'); x.where.row.addClass('gongdu-hidden'); } };
      show();
      box.addEventListener('change', () => { show(); countNote(); });
      return { row, box, ...x };
    };
    // 读书时摘的、今天的高亮，都默认勾上（读书时画了高亮就等于摘下来了），不想交的取消勾选
    const kinds = new Set(items.map(it => it.kind));
    let lastKind = null;
    for (const it of items) {
      if (kinds.size > 1 && it.kind !== lastKind) {
        exBox.createDiv({ cls: 'gongdu-subhead', text: it.kind === 'clip' ? '读书时摘的' : '今天在阅读器里画的高亮' });
        lastKind = it.kind;
      }
      const isClip = it.kind === 'clip';
      const { row, box, thought, where, dropBtn } = listRow(it.text, it.checked, isClip ? it.clip : it.hl, { drop: isClip });
      if (isClip) {
        const c = it.clip;
        dropBtn.addEventListener('click', async () => {
          dropBtn.disabled = true;
          await p.dropClips([c.id]);
          row.remove();
          Clips.dropFrom(clipped, x => x.c === c);
          countNote();
        });
        clipped.push({ c, box, thought, where });
      } else picked.push({ hl: it.hl, box, thought, where });
    }
    const overNote = exSec.createDiv({ cls: 'gongdu-note gongdu-warn-text gongdu-hidden' });
    const exErr = fieldError(exSec);

    // 3. 自己写一句：平时收成一个链接。今天一句都还没有（没摘、没高亮、网站上也没有）时直接展开。
    const ownSec = exSec.createDiv({ cls: 'gongdu-own' });
    const ownBody = ownSec.createDiv({ cls: 'gongdu-stack gongdu-hidden' });
    const ownText = ownBody.createEl('textarea', { attr: { id: 'gongdu-own', rows: '2', placeholder: '书里的一句话', maxlength: '1000', 'aria-label': '自己写一句书里的话' } });
    const own = extras(ownBody, this.here);
    const ownWhere = own.where;
    const ownThought = own.thought;
    const nothingYet = !items.length && !(s.excerpts && s.excerpts.length);
    const openOwn = () => { ownBody.removeClass('gongdu-hidden'); ownText.focus(); };
    if (nothingYet) {
      const tip = ownSec.createDiv({ cls: 'gongdu-note', text: this.file ? '今天还没摘句子。读书时选中一句，点左边栏的共读按钮就会摘到这里；也可以在这里写一句。' : '写一句今天读到的书里的话。' });
      ownSec.insertBefore(tip, ownBody);
      ownBody.removeClass('gongdu-hidden');
    } else {
      opener(ownSec, '+ 自己写一句', openOwn);
    }
    ownText.addEventListener('input', () => { clearError(null, exErr); countNote(); });
    // 从书里复制来的公式（图片的 alt、MathML）写成 $…$，网站上显示成公式
    ownText.addEventListener('paste', ev => {
      const t = mathFromHtml(ev.clipboardData && ev.clipboardData.getData('text/html'));
      if (!t) return;
      ev.preventDefault();
      const a = ownText.selectionStart, b = ownText.selectionEnd;
      ownText.value = ownText.value.slice(0, a) + t + ownText.value.slice(b);
      ownText.dispatchEvent(new Event('input'));
    });

    function countNote() {
      const c = L.sendCount({ own: ownText.value.trim() ? 1 : 0, clips: clipped.filter(x => x.box.checked).length, highlights: picked.filter(x => x.box.checked).length });
      countEl.setText(c.total ? `带上 ${c.sending} 句` : '');
      overNote.toggleClass('gongdu-hidden', c.over <= 0);
      overNote.setText(`一共 ${c.total} 句，网站一次最多收 ${Clips.MAX_SEND} 句：这次先交前 ${Clips.MAX_SEND} 句（自己写的排最前），读书时摘的其余 ${c.over} 句留着下次交。`);
      if (c.total) clearError(null, exErr);
    }
    countNote();

    // 4. 更多：换封面（只有网站上已经有封面图、或者去掉过，而阅读器里找得到封面时才出现）
    const more = form.createEl('details', { cls: 'gongdu-more gongdu-hidden' });
    more.createEl('summary', { text: '更多' });
    const coverLabel = more.createEl('label', { cls: 'gongdu-check' });
    const replaceBox = coverLabel.createEl('input', { type: 'checkbox' });
    coverLabel.createSpan({ text: '换成阅读器里的封面' });
    const coverNote = more.createDiv({ cls: 'gongdu-note' });
    const drawCover = async () => {
      const b = this.books.find(x => String(x.id) === select.value);
      const show = !!b && (b.cover_url || b.cover_removed) && this.localCover && (await this.localCover);
      more.toggleClass('gongdu-hidden', !show);
      if (show) coverNote.setText(b.cover_url ? '网站上这本书已经有封面图，勾上才会换掉。' : b.cover_removed === 'teacher' ? '老师去掉过这本书的封面图。勾上会换上阅读器里的封面（和老师去掉的是同一张就换不了）。' : '你去掉过这本书的封面图，勾上会换回阅读器里的封面。');
    };
    select.addEventListener('change', () => { showTitle(); fillMinutes(); replaceBox.checked = false; drawCover(); });
    drawCover();

    // 5. 按钮。结果和网站返回的错误写在按钮上面；填的不对，错误写在那一块下面
    const msg = el.createDiv({ cls: 'gongdu-msg', attr: { role: 'status' } });
    const btns = el.createDiv({ cls: 'modal-button-container' });
    const kbd = Platform.isMobile ? null : btns.createSpan({ cls: 'gongdu-kbd', text: Platform.isMacOS ? '⌘↵ 打卡' : 'Ctrl+Enter 打卡' });
    const submit = btns.createEl('button', { cls: 'mod-cta', text: '打卡' });
    const cancel = btns.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    // Cmd/Ctrl+Enter 直接打卡（在想法框里写完就能交）
    this.scope.register(['Mod'], 'Enter', () => { if (!form.hasClass('gongdu-hidden')) submit.click(); return false; });

    // 光标先放在要动手的地方：没书名 → 书名；分钟没填或不是插件计的 → 分钟；没进度 → 进度；今天一句都没有 → 自己写一句
    const focusFirst = () => window.setTimeout(() => {
      const target = select.value === NEW && !titleInput.value.trim() ? titleInput
        : !minutes.value.trim() || plan.source === 'qiaomu' ? minutes
        : !pct.value.trim() ? pct
        : nothingYet ? ownText : null;
      if (target) target.focus();
    }, 50);
    const foldedParts = [form, submit, kbd].filter(Boolean);
    if (folded) {
      foldedParts.forEach(x => x.addClass('gongdu-hidden'));
      cancel.setText('关闭');
      unfold = () => {
        foldedParts.forEach(x => x.removeClass('gongdu-hidden'));
        cancel.setText('取消');
        el.querySelector('.gongdu-done .gongdu-link')?.remove();
        focusFirst();
      };
    } else focusFirst();

    let done = false;
    submit.addEventListener('click', async () => {
      if (done) { this.close(); return; }
      msg.setText(''); msg.className = 'gongdu-msg';
      const bad = text => { msg.setText(text); msg.addClass('gongdu-bad'); };
      const mc = L.checkMinutes(minutes.value);
      if (!mc.ok) return showError(minutes, mainErr, mc.message);
      const pc = L.checkPercent(pct.value);
      if (!pc.ok) return showError(pct, mainErr, pc.message);
      if (select.value === NEW && !titleInput.value.trim()) return showError(titleInput, mainErr, '请填书名，比如 乡土中国。');
      // 一次最多交 20 句（网站只收前 20 句）：自己写的放最前面（关了窗口就没了），再是摘的，再是高亮。
      const all = [];
      if (ownText.value.trim()) all.push({ kind: 'own', ex: { text: ownText.value.trim(), thought: ownThought.value.trim() || undefined, ...ownWhere.value() } });
      for (const x of clipped.filter(y => y.box.checked)) all.push({ kind: 'clip', clip: x.c, ex: { text: x.c.text, thought: x.thought.value.trim() || undefined, ...x.where.value() } });
      for (const x of picked.filter(y => y.box.checked)) all.push({ kind: 'hl', ex: { text: x.hl.text, thought: x.thought.value.trim() || undefined, ...x.where.value() } });
      const { send, held } = Clips.planSend(all);
      const excerpts = send.map(x => x.ex);
      const sentClips = send.filter(x => x.kind === 'clip').map(x => x.clip);
      if (!excerpts.length && !(s.excerpts && s.excerpts.length)) {
        showError(null, exErr, '今天还没有摘录：勾上一句摘的或高亮，或者自己写一句书里的话。');
        openOwn();
        return;
      }
      const body = { minutes: mc.value, percent: pc.value };
      if (select.value === NEW) {
        body.book_title = titleInput.value.trim();
        body.format = 'ebook';
      } else body.book_id = Number(select.value);
      if (excerpts.length) body.excerpts = excerpts;
      const ownsClock = !!this.fileKey && select.value === this.fileKey;
      const siteMinBefore = siteMinOf(select.value);

      submit.disabled = true;
      try {
        const out = await p.api().checkin(body);
        const bookId = out.book_id || body.book_id;
        const lines = [`打好了。连续 ${out.streak} 天，班里今天 ${out.class_done}/${out.class_total} 人读了。`];
        if (this.file && bookId) await p.remember(this.file.path, bookId);
        // 只去掉网站真的存下了的摘句；没交上去的、没存下的都留在本机。
        const savedIds = Clips.acceptedIds(sentClips, out.excerpts);
        p.markSent(sentClips.filter(c => savedIds.includes(c.id)));
        await p.dropClips(savedIds);
        const left = p.data.clips.filter(c => c.day === this.clockDay && (!this.file || c.book === this.file.path)).length;
        if (left) lines.push(`还有 ${left} 句摘的没交上去，留在这里，下次打卡时会列出来。`);
        const heldHighlights = held.length > 0 && held.some(x => x.kind !== 'clip');
        if (heldHighlights) lines.push(`超过 ${Clips.MAX_SEND} 句的高亮这次没交，可以再打一次卡勾上。`);
        let coverProblem = false;
        // 记下这次算进去的插件时间（只在选的正是这个文件的书时；往少里改了就只算进去的那部分），下次不再重复加
        if (this.file && ownsClock && this.clockSeconds) {
          const next = Clock.committedAfter({ siteMin: siteMinBefore, submitted: mc.value, clockSec: this.clockSeconds, committedSec: this.committedSeconds });
          Clock.commit(p.data.committed, this.clockDay, this.file.path, next);
          p.saveSoon();
        }
        p.sync.forget();
        // 封面：勾了换封面就换；没勾就按平常的规则（网站上没有才传）。
        if (this.file && bookId) {
          if (replaceBox.checked) {
            try {
              const r = await p.sync.replace(this.file, bookId);
              if (!r) coverProblem = true;
              lines.push(!r ? '阅读器里没找到这本书的封面，封面没换。' : r.status === 'same' ? '网站上已经是这张封面了。' : '封面换好了。');
            } catch (e) { coverProblem = true; lines.push(`封面没换：${e.message}`); }
          } else {
            p.sync.sync(this.file, { force: true }).catch(() => {});
          }
        }
        if (out.new_achievements && out.new_achievements.length) lines.push(`新成就：${out.new_achievements.map(a => a.name || a.title || a).join('、')}。`);
        // 没有要学生看一眼的事，就过一会儿自己关掉
        const auto = L.canAutoClose({ left, heldHighlights, coverProblem });
        msg.setText(lines.join(' ') + (auto ? ' 窗口马上会自己关上。' : '')); msg.addClass('gongdu-ok');
        submit.setText('关闭');
        submit.disabled = false;
        done = true;
        p.refreshBar(true);
        if (auto) window.setTimeout(() => this.close(), 3000);
      } catch (e) {
        submit.disabled = false;
        bad(e.message || '出错了');
      }
    });
  }
}

module.exports = { CheckinModal };
