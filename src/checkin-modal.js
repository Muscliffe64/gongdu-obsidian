'use strict';
// 读书打卡窗口：书、今天读了几分钟、读到哪里、读书时摘的句子和今天的高亮（每句可以加想法）、换封面（可选），一屏打完。
// 窗口开着的时候自动计时停下（写想法、粘贴不算读书时间）。
const { Modal, TFile } = require('obsidian');
const Q = require('./qiaomu');
const { matchBook } = require('./match');
const { readQiaomu } = require('./obsidian-io');
const Clips = require('./clips');
const Clock = require('./clock');
const L = require('./checkin-logic');

const NEW = 'new';

class CheckinModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.plugin.checkinOpen = true;
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

    const section = (label, forId) => {
      const box = el.createDiv({ cls: 'gongdu-section' });
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
    const book = section('书', 'gongdu-book').box;
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
    const minSec = section('今天读了多久', 'gongdu-min');
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
        lines.push('在 Qiaomu Reader 里打开这本书读一会儿就会自动记（Obsidian 在最前面、3 分钟内翻过页或滚动过才算），也可以自己填个大概的分钟数。');
      }
      if (plan.otherBook) lines.push(`插件计的 ${Math.round(this.clockSeconds / 60)} 分钟是阅读器里这个文件的，选了别的书就不算进去。`);
      minNote.setText(lines.join(''));
    };
    fillMinutes();

    // 3. 进度
    const pctSec = section('读到哪里', 'gongdu-pct');
    const pctRow = pctSec.box.createDiv({ cls: 'gongdu-inline' });
    const pct = pctRow.createEl('input', { type: 'text', cls: 'gongdu-num', attr: { id: 'gongdu-pct', inputmode: 'decimal', placeholder: '比如 45', autocomplete: 'off' } });
    pctRow.createSpan({ text: '%' });
    if (this.percent != null) pct.value = String(this.percent);
    if (this.percent != null) pctSec.box.createDiv({ cls: 'gongdu-note', text: '阅读器里这本书的进度。可以改。' });
    const pctErr = fieldError(pctSec.box);
    pct.addEventListener('input', () => clearError(pct, pctErr));

    // 4. 摘句：读书时摘的 + 今天的高亮
    const exSec = section('摘句');
    const countEl = exSec.head.createSpan({ cls: 'gongdu-count' });
    const exBox = exSec.box.createDiv({ cls: 'gongdu-excerpts' });
    const picked = [];
    const clipped = [];
    const listRow = (text, checked) => {
      const row = exBox.createDiv({ cls: 'gongdu-hl' });
      const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = checked;
      label.createSpan({ text });
      const thought = row.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
      thought.toggleClass('gongdu-hidden', !checked);
      box.addEventListener('change', () => { thought.toggleClass('gongdu-hidden', !box.checked); countNote(); });
      return { row, box, thought };
    };
    if (this.clips.length) {
      exBox.createDiv({ cls: 'gongdu-subhead', text: `读书时摘的 · ${this.clips.length} 句` });
      for (const c of this.clips) {
        const { row, box, thought } = listRow(c.text, true);
        const drop = row.createEl('button', { cls: 'gongdu-drop clickable-icon', text: '不要这句' });
        drop.addEventListener('click', async () => {
          drop.disabled = true;
          await p.dropClips([c.id]);
          row.remove();
          Clips.dropFrom(clipped, x => x.c === c);
          countNote();
        });
        clipped.push({ c, box, thought });
      }
    }
    if (this.highlights.length) {
      exBox.createDiv({ cls: 'gongdu-subhead', text: `今天的高亮 · ${this.highlights.length} 句` });
      for (const hl of this.highlights) {
        const { box, thought } = listRow(hl.text, false);
        picked.push({ hl, box, thought });
      }
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
    const ownThought = ownBody.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
    if (this.clips.length || this.highlights.length) {
      // 有摘的或高亮时先收起来，要用再展开
      ownBody.addClass('gongdu-hidden');
      const more = ownSec.head.createEl('button', { cls: 'gongdu-link', text: '展开' });
      more.addEventListener('click', () => { ownBody.removeClass('gongdu-hidden'); more.remove(); ownText.focus(); });
    }
    ownText.addEventListener('input', () => { clearError(null, exErr); countNote(); });

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
    const submit = btns.createEl('button', { cls: 'mod-cta', text: '打卡' });
    btns.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());

    let done = false;
    submit.addEventListener('click', async () => {
      if (done) { this.close(); return; }
      msg.setText(''); msg.className = 'gongdu-msg';
      const bad = text => { msg.setText(text); msg.addClass('gongdu-bad'); };
      const mc = L.checkMinutes(minutes.value);
      if (!mc.ok) return showError(minutes, minErr, mc.message);
      const pc = L.checkPercent(pct.value);
      if (!pc.ok) return showError(pct, pctErr, pc.message);
      if (select.value === NEW && !titleInput.value.trim()) return showError(titleInput, titleErr, '请填书名，比如 乡土中国。');
      // 一次最多交 20 句（网站只收前 20 句）：自己写的放最前面（关了窗口就没了），再是摘的，再是高亮。
      const all = [];
      if (ownText.value.trim()) all.push({ kind: 'own', ex: { text: ownText.value.trim(), thought: ownThought.value.trim() || undefined } });
      for (const x of clipped.filter(y => y.box.checked)) all.push({ kind: 'clip', clip: x.c, ex: { text: x.c.text, thought: x.thought.value.trim() || undefined } });
      for (const x of picked.filter(y => y.box.checked)) all.push({ kind: 'hl', ex: { text: x.hl.text, thought: x.thought.value.trim() || undefined } });
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
        if (held.length && held.some(x => x.kind !== 'clip')) lines.push(`超过 ${Clips.MAX_SEND} 句的高亮这次没交，可以再打一次卡勾上。`);
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
              lines.push(!r ? '阅读器里没找到这本书的封面，封面没换。' : r.status === 'same' ? '网站上已经是这张封面了。' : '封面换好了。');
            } catch (e) { lines.push(`封面没换：${e.message}`); }
          } else {
            p.sync.sync(this.file, { force: true }).catch(() => {});
          }
        }
        if (out.new_achievements && out.new_achievements.length) lines.push(`新成就：${out.new_achievements.map(a => a.name || a.title || a).join('、')}`);
        msg.setText(lines.join(' ')); msg.addClass('gongdu-ok');
        submit.setText('关闭');
        submit.disabled = false;
        done = true;
        p.refreshBar(true);
      } catch (e) {
        submit.disabled = false;
        bad(e.message || '出错了');
      }
    });
  }
}

module.exports = { CheckinModal };
