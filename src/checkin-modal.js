'use strict';
// 读书打卡窗口：书、今天读了几分钟、读到哪里、读书时摘的句子和今天的高亮（每句可以加想法）、换封面（可选），一屏打完。
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

    // 最上面：插件的提示、今天打过卡没有（次要色小字）
    const note = p.takeNote();
    if (note) el.createEl('p', { cls: note.kind === 'warn' ? 'gongdu-note gongdu-warn-text' : 'gongdu-note', text: note.text });
    if (s.checked) el.createEl('p', { cls: 'gongdu-note gongdu-ok', text: `今天已经打过卡了（${s.minutes} 分钟）。再交一次：同一本书会更新分钟和进度，换一本书会另记一条。` });

    // 最上面一行摘要：《书》 · N 分钟 · 读到 P%  改。书、分钟、进度默认收起来，拿不准时才展开。
    const summary = el.createDiv({ cls: 'gongdu-summary' });
    const summaryText = summary.createSpan({ cls: 'gongdu-summary-text' });
    const editBtn = summary.createEl('button', { cls: 'gongdu-link', text: '改' });
    const reasonsEl = el.createDiv({ cls: 'gongdu-note gongdu-warn-text gongdu-hidden' });
    const details = el.createDiv({ cls: 'gongdu-details gongdu-hidden' });
    const showDetails = () => { details.removeClass('gongdu-hidden'); editBtn.addClass('gongdu-hidden'); };
    editBtn.addEventListener('click', () => { showDetails(); minutes.focus(); });

    const section = (label, forId, parent = el) => {
      const box = parent.createDiv({ cls: 'gongdu-section' });
      const head = box.createDiv({ cls: 'gongdu-section-head' });
      head.createEl('label', { cls: 'gongdu-label', text: label, attr: forId ? { for: forId } : {} });
      return { box, head };
    };
    const fieldError = box => box.createDiv({ cls: 'gongdu-error gongdu-hidden', attr: { role: 'alert' } });
    const showError = (input, errEl, text) => {
      errEl.setText(text); errEl.removeClass('gongdu-hidden');
      if (input) { input.addClass('gongdu-invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); }
    };
    const clearError = (input, errEl) => {
      errEl.setText(''); errEl.addClass('gongdu-hidden');
      if (input) { input.removeClass('gongdu-invalid'); input.removeAttribute('aria-invalid'); }
    };

    // 1. 书
    const book = section('书', 'gongdu-book', details).box;
    const select = book.createEl('select', { cls: 'dropdown', attr: { id: 'gongdu-book' } });
    for (const b of this.books) select.createEl('option', { value: String(b.id), text: `《${b.title}》${b.status === 'paused' ? '（搁置）' : ''}` });
    const newTitle = this.match.book ? '' : this.match.title;
    if (newTitle) select.createEl('option', { value: NEW, text: `加一本：《${newTitle}》` });
    if (!this.books.length && !newTitle) select.createEl('option', { value: NEW, text: '加一本新书' });
    select.value = this.fileKey || (this.books[0] ? String(this.books[0].id) : NEW);
    const titleInput = book.createEl('input', { type: 'text', cls: 'gongdu-newtitle', value: newTitle, attr: { placeholder: '书名', 'aria-label': '新书的书名' } });
    const titleErr = fieldError(book);
    const showTitle = () => titleInput.toggleClass('gongdu-hidden', select.value !== NEW);
    titleInput.addEventListener('input', () => clearError(titleInput, titleErr));
    showTitle();
    if (this.file) {
      // 路径常常很长：一行，中间省略，悬停看全文
      const fileLine = book.createDiv({ cls: 'gongdu-note gongdu-path', text: `文件：${L.shortPath(this.file.path, 48)}` });
      fileLine.setAttribute('aria-label', this.file.path);
      fileLine.setAttribute('title', this.file.path);
    }

    // 2. 今天读了多久
    const minSec = section('今天读了多久', 'gongdu-min', details);
    const minRow = minSec.box.createDiv({ cls: 'gongdu-inline' });
    const minutes = minRow.createEl('input', { type: 'text', cls: 'gongdu-num', attr: { id: 'gongdu-min', inputmode: 'numeric', placeholder: '比如 30', autocomplete: 'off', 'aria-describedby': 'gongdu-min-note' } });
    minRow.createSpan({ text: '分钟' });
    const minNote = minSec.box.createDiv({ cls: 'gongdu-note', attr: { id: 'gongdu-min-note' } });
    const minErr = fieldError(minSec.box);
    minutes.addEventListener('input', () => clearError(minutes, minErr));
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
      clearError(minutes, minErr);
      const lines = [];
      if (plan.source === 'clock') {
        lines.push(`插件今天为这本书计时 ${plan.clockMin} 分钟（未提交 ${plan.freshMin} 分钟）。`);
        lines.push(plan.siteMin ? `网站上这本书今天已经记了 ${plan.siteMin} 分钟，加上未提交的 ${plan.freshMin} 分钟，先填 ${plan.value || 0}。可以改。` : '可以改。');
      } else if (plan.source === 'qiaomu') {
        lines.push(`插件今天没为这本书计到时间，先按 Qiaomu Reader 自己的计时填（今天所有书一共 ${fromLog} 分钟，别的书已经记过的减掉了）。可以改。`);
      } else {
        lines.push(plan.siteMin ? `网站上这本书今天已经记了 ${plan.siteMin} 分钟，先填这个。` : '今天还没计到这本书的阅读时间。');
        lines.push('在 Qiaomu Reader 里打开这本书读一会儿就会自动记（Obsidian 在最前面、3 分钟内翻过页、滚动过或动过鼠标才算，8 分钟之内回来的会补上停下的那段），也可以自己填个大概的分钟数。');
      }
      if (plan.otherBook) lines.push(`插件计的 ${Math.round(this.clockSeconds / 60)} 分钟是阅读器里这个文件的，选了别的书就不算进去。`);
      minNote.setText(lines.join(''));
    };
    fillMinutes();

    // 3. 进度
    const pctSec = section('读到哪里', 'gongdu-pct', details);
    const pctRow = pctSec.box.createDiv({ cls: 'gongdu-inline' });
    const pct = pctRow.createEl('input', { type: 'text', cls: 'gongdu-num', attr: { id: 'gongdu-pct', inputmode: 'decimal', placeholder: '比如 45', autocomplete: 'off' } });
    pctRow.createSpan({ text: '%' });
    if (this.percent != null) pct.value = String(this.percent);
    if (this.percent != null) pctSec.box.createDiv({ cls: 'gongdu-note', text: '阅读器里这本书的进度。可以改。' });
    const pctErr = fieldError(pctSec.box);
    pct.addEventListener('input', () => clearError(pct, pctErr));

    const bookTitle = () => {
      if (select.value === NEW) return titleInput.value.trim();
      const b = this.books.find(x => String(x.id) === select.value);
      return b ? b.title : '';
    };
    const updateSummary = () => summaryText.setText(L.summaryText({ title: bookTitle(), minutes: minutes.value, percent: pct.value, isNew: select.value === NEW }));
    for (const input of [minutes, pct, titleInput]) input.addEventListener('input', updateSummary);
    select.addEventListener('change', () => updateSummary());
    updateSummary();
    // 有拿不准的（没找到书、没计到时间、没有进度……）就一打开就展开，并说为什么
    const reasons = L.detailReasons({ hasFile: !!this.file, minutes: minutes.value, percent: pct.value, source: plan.source, isNew: select.value === NEW, newTitle: titleInput.value });
    if (reasons.length) {
      showDetails();
      reasonsEl.setText(reasons.join('；') + '。');
      reasonsEl.removeClass('gongdu-hidden');
    }

    // 4. 摘句：读书时摘的 + 今天的高亮
    const exSec = section('摘句');
    const countEl = exSec.head.createSpan({ cls: 'gongdu-count' });
    const exBox = exSec.box.createDiv({ cls: 'gongdu-excerpts' });
    const picked = [];
    const clipped = [];
    const listRow = (text, checked, place) => {
      const row = exBox.createDiv({ cls: 'gongdu-hl' });
      const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = checked;
      const span = label.createSpan({ cls: 'gongdu-hl-text' });
      this.showText(span, text);
      const where = placeInputs(row, place);
      const thought = row.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
      const show = () => { thought.toggleClass('gongdu-hidden', !box.checked); where.row.toggleClass('gongdu-hidden', !box.checked); };
      show();
      box.addEventListener('change', () => { show(); countNote(); });
      return { row, box, thought, where };
    };
    // 读书时摘的、今天的高亮，都默认勾上（读书时画了高亮就等于摘下来了），不想交的取消勾选
    let lastKind = null;
    for (const it of L.excerptItems({ clips: this.clips, highlights: this.highlights })) {
      if (it.kind !== lastKind) {
        exBox.createDiv({ cls: 'gongdu-subhead', text: it.kind === 'clip' ? `读书时摘的 · ${this.clips.length} 句` : `今天在阅读器里画的高亮 · ${this.highlights.length} 句` });
        lastKind = it.kind;
      }
      const { row, box, thought, where } = listRow(it.text, it.checked, it.kind === 'clip' ? it.clip : it.hl);
      if (it.kind === 'clip') {
        const c = it.clip;
        const drop = row.createEl('button', { cls: 'gongdu-drop clickable-icon', text: '不要这句' });
        drop.addEventListener('click', async () => {
          drop.disabled = true;
          await p.dropClips([c.id]);
          row.remove();
          Clips.dropFrom(clipped, x => x.c === c);
          countNote();
        });
        clipped.push({ c, box, thought, where });
      } else picked.push({ hl: it.hl, box, thought, where });
    }
    if (!this.clips.length && !this.highlights.length) {
      exBox.createDiv({ cls: 'gongdu-note', text: this.file ? '今天还没摘句子。读书时在书里选中一句，点左边栏的共读按钮，就会摘到这里；阅读器里的高亮也会列在这里。也可以在下面自己写一句。' : '没找到阅读器里正在读的书。可以在下面自己写一句。' });
    }
    const overNote = exSec.box.createDiv({ cls: 'gongdu-note gongdu-warn-text gongdu-hidden' });
    const exErr = fieldError(exSec.box);

    // 5. 想法：自己写一句（书里的话 + 想法）
    const ownSec = section(s.excerpts && s.excerpts.length ? `自己写一句（今天已经摘了 ${s.excerpts.length} 句，可以不写）` : '自己写一句', 'gongdu-own');
    const ownBody = ownSec.box.createDiv({ cls: 'gongdu-stack' });
    const ownText = ownBody.createEl('textarea', { attr: { id: 'gongdu-own', rows: '2', placeholder: '书里的一句话', maxlength: '1000' } });
    const ownWhere = placeInputs(ownBody, this.here);
    const ownThought = ownBody.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
    if (this.clips.length || this.highlights.length) {
      // 有摘的或高亮时先收起来，要用再展开
      ownBody.addClass('gongdu-hidden');
      const more = ownSec.head.createEl('button', { cls: 'gongdu-link', text: '写一句' });
      more.addEventListener('click', () => { ownBody.removeClass('gongdu-hidden'); more.remove(); ownText.focus(); });
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
      countEl.setText(c.total ? `这次会带上 ${c.sending} 句（最多 ${Clips.MAX_SEND}）` : '');
      overNote.toggleClass('gongdu-hidden', c.over <= 0);
      overNote.setText(`一共 ${c.total} 句（自己写的也算），网站一次最多收 ${Clips.MAX_SEND} 句：这次先交前 ${Clips.MAX_SEND} 句（自己写的排最前），读书时摘的其余 ${c.over} 句留在这里，下次打卡再交。`);
      if (c.total) clearError(null, exErr);
    }
    countNote();

    // 6. 封面（只有网站上已经有封面图、或者去掉过，而阅读器里找得到封面时才出现）
    const coverRow = el.createDiv({ cls: 'gongdu-section gongdu-hidden' });
    const coverLabel = coverRow.createEl('label', { cls: 'gongdu-check' });
    const replaceBox = coverLabel.createEl('input', { type: 'checkbox' });
    coverLabel.createSpan({ text: '换成阅读器里的封面' });
    const coverNote = coverRow.createDiv({ cls: 'gongdu-note' });
    const drawCover = async () => {
      const b = this.books.find(x => String(x.id) === select.value);
      const show = !!b && (b.cover_url || b.cover_removed) && this.localCover && (await this.localCover);
      coverRow.toggleClass('gongdu-hidden', !show);
      if (show) coverNote.setText(b.cover_url ? '网站上这本书已经有封面图，勾上才会换掉。' : b.cover_removed === 'teacher' ? '老师去掉过这本书的封面图。勾上会换上阅读器里的封面（和老师去掉的是同一张就换不了）。' : '你去掉过这本书的封面图，勾上会换回阅读器里的封面。');
    };
    select.addEventListener('change', () => { showTitle(); fillMinutes(); replaceBox.checked = false; drawCover(); });
    drawCover();

    // 7. 按钮。结果和网站返回的错误写在按钮上面；填的不对，错误写在那一栏下面
    const msg = el.createDiv({ cls: 'gongdu-msg', attr: { role: 'status' } });
    const btns = el.createDiv({ cls: 'modal-button-container' });
    if (!Platform.isMobile) btns.createSpan({ cls: 'gongdu-kbd', text: Platform.isMacOS ? '⌘↵ 打卡' : 'Ctrl+Enter 打卡' });
    const submit = btns.createEl('button', { cls: 'mod-cta', text: '打卡' });
    btns.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    // Cmd/Ctrl+Enter 直接打卡（在想法框里写完就能交）
    this.scope.register(['Mod'], 'Enter', () => { submit.click(); return false; });

    // 光标先放在要动手的地方：有拿不准的就放在那一栏；不然放在第一句的想法框里
    window.setTimeout(() => {
      let target = null;
      if (reasons.length) {
        target = select.value === NEW && !titleInput.value.trim() ? titleInput
          : (!minutes.value.trim() || plan.source !== 'clock') ? minutes
          : !pct.value.trim() ? pct : select;
      }
      else {
        const first = [...clipped, ...picked].find(x => x.box.checked);
        target = first ? first.thought : null;
        if (!target && ownBody.hasClass('gongdu-hidden') === false) target = ownText;
      }
      if (target) target.focus();
    }, 50);

    let done = false;
    submit.addEventListener('click', async () => {
      if (done) { this.close(); return; }
      msg.setText(''); msg.className = 'gongdu-msg';
      const bad = text => { msg.setText(text); msg.addClass('gongdu-bad'); };
      const mc = L.checkMinutes(minutes.value);
      if (!mc.ok) { showDetails(); return showError(minutes, minErr, mc.message); }
      const pc = L.checkPercent(pct.value);
      if (!pc.ok) { showDetails(); return showError(pct, pctErr, pc.message); }
      if (select.value === NEW && !titleInput.value.trim()) { showDetails(); return showError(titleInput, titleErr, '请填书名，比如 乡土中国。'); }
      // 一次最多交 20 句（网站只收前 20 句）：自己写的放最前面（关了窗口就没了），再是摘的，再是高亮。
      const all = [];
      if (ownText.value.trim()) all.push({ kind: 'own', ex: { text: ownText.value.trim(), thought: ownThought.value.trim() || undefined, ...ownWhere.value() } });
      for (const x of clipped.filter(y => y.box.checked)) all.push({ kind: 'clip', clip: x.c, ex: { text: x.c.text, thought: x.thought.value.trim() || undefined, ...x.where.value() } });
      for (const x of picked.filter(y => y.box.checked)) all.push({ kind: 'hl', ex: { text: x.hl.text, thought: x.thought.value.trim() || undefined, ...x.where.value() } });
      const { send, held } = Clips.planSend(all);
      const excerpts = send.map(x => x.ex);
      const sentClips = send.filter(x => x.kind === 'clip').map(x => x.clip);
      if (!excerpts.length && !(s.excerpts && s.excerpts.length)) {
        showError(null, exErr, '今天还没有摘录：勾上一句读书时摘的或高亮，或者展开“自己写一句”写一句书里的话。');
        if (!ownBody.hasClass('gongdu-hidden')) ownText.focus();
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
