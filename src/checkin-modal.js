'use strict';
// 读书打卡窗口：书、今天读了几分钟、读到哪里、读书时摘的句子和今天的高亮（每句可以加想法）、换封面（可选），一屏打完。
// 窗口开着的时候自动计时停下（写想法、粘贴不算读书时间）。
const { Modal, TFile } = require('obsidian');
const Q = require('./qiaomu');
const { matchBook } = require('./match');
const { readQiaomu } = require('./obsidian-io');
const Clips = require('./clips');
const Clock = require('./clock');

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
    this.highlights = this.file ? Q.highlightsOn(this.qiaomu.highlights, this.file.path, day) : [];
    this.seconds = Q.secondsOn(this.qiaomu.settings, day);
    // 插件自动记的：用本机的日期（和计时时一样）
    const today = Q.dayOf(Date.now());
    this.clockSeconds = this.file ? Clock.secondsOf(p.data.time, today, this.file.path) : 0;
    this.clips = Clips.notIn(Clips.forBook(p.data.clips, today, this.file ? this.file.path : ''), this.highlights.map(h => h.text));
    this.percent = this.file ? Q.percentOf(this.qiaomu.progress, this.file.path) : null;
  }

  draw() {
    const el = this.contentEl;
    el.empty();
    const s = this.status;
    const note = this.plugin.takeNote();
    if (note) el.createEl('p', { cls: note.kind === 'warn' ? 'gongdu-bad' : 'gongdu-note', text: note.text });
    if (s.checked) el.createEl('p', { cls: 'gongdu-ok', text: `今天已经打过卡了（${s.minutes} 分钟）。再交一次：同一本书会更新分钟和进度，换一本书会另记一条。` });

    // 书
    const bookRow = el.createDiv({ cls: 'gongdu-field' });
    bookRow.createEl('label', { text: '书', attr: { for: 'gongdu-book' } });
    const select = bookRow.createEl('select', { cls: 'dropdown', attr: { id: 'gongdu-book' } });
    for (const b of this.books) select.createEl('option', { value: String(b.id), text: `《${b.title}》${b.status === 'paused' ? '（搁置）' : ''}` });
    const newTitle = this.match.book ? '' : this.match.title;
    if (newTitle) select.createEl('option', { value: NEW, text: `加一本：《${newTitle}》` });
    select.value = this.match.book ? String(this.match.book.id) : newTitle ? NEW : (this.books[0] ? String(this.books[0].id) : '');
    const titleInput = bookRow.createEl('input', { type: 'text', cls: 'gongdu-newtitle', value: newTitle, attr: { placeholder: '书名', 'aria-label': '新书的书名' } });
    const showTitle = () => { titleInput.toggleClass('gongdu-hidden', select.value !== NEW); };
    if (!this.books.length && !newTitle) {
      select.createEl('option', { value: NEW, text: '加一本新书' });
      select.value = NEW;
    }
    showTitle();
    if (this.file) bookRow.createEl('div', { cls: 'gongdu-note', text: `阅读器里的文件：${this.file.path}` });

    // 分钟
    const minRow = el.createDiv({ cls: 'gongdu-field gongdu-inline' });
    minRow.createEl('label', { text: '今天读了', attr: { for: 'gongdu-min' } });
    const minutes = minRow.createEl('input', { type: 'number', attr: { id: 'gongdu-min', min: '1', max: '1440', step: '1', inputmode: 'numeric' } });
    minRow.createSpan({ text: '分钟' });
    // 阅读器记的是今天所有书一起的时长。今天别的书已经记过的分钟要减掉，不然同一段时间算两次。
    const fromLog = Math.round(this.seconds / 60);
    const minNote = el.createEl('div', { cls: 'gongdu-note' });
    const clockMin = Math.round(this.clockSeconds / 60);
    const fillMinutes = () => {
      const id = select.value === NEW ? null : Number(select.value);
      const rows = [...(s.readings || []), ...(s.pending || [])];
      if (clockMin > 0) {
        // 插件按书自动记的时间。网站上同一本书再交是覆盖，所以不比已经交过的少（交过的可能还有纸书的时间）。
        const found = id == null ? null : rows.find(r => r.book_id === id);
        const mine = found ? found.minutes || 0 : 0;
        minutes.value = String(Math.max(clockMin, mine));
        minNote.setText(`插件自动记的：今天在这里读这本书 ${clockMin} 分钟（书开着、最近 3 分钟翻过页才算）。${mine > clockMin ? `网站上这本书今天已经记了 ${mine} 分钟，先填这个。` : ''}可以改。`);
        return;
      }
      const { value, others, mine } = Q.suggestMinutes(fromLog, rows, id);
      minutes.value = value;
      const parts = [fromLog > 0 ? `阅读器今天一共记了 ${fromLog} 分钟` : '今天还没有记到读这本书的时间'];
      if (others) parts.push(`别的书已经记了 ${others} 分钟`);
      if (mine) parts.push(`这本书已经记了 ${mine} 分钟（再交会换成下面填的数）`);
      minNote.setText(parts.join('，') + (value ? '。可以改。' : '。请自己填这本书读了多久（以后在 Obsidian 里开着书读，会自动记）。'));
    };
    fillMinutes();

    // 进度
    const pctRow = el.createDiv({ cls: 'gongdu-field gongdu-inline' });
    pctRow.createEl('label', { text: '读到', attr: { for: 'gongdu-pct' } });
    const pct = pctRow.createEl('input', { type: 'number', attr: { id: 'gongdu-pct', min: '0', max: '100', step: '0.1', inputmode: 'decimal' } });
    pctRow.createSpan({ text: '%' });
    if (this.percent != null) pct.value = String(this.percent);

    // 摘录
    const exBox = el.createDiv({ cls: 'gongdu-excerpts' });
    const picked = [];
    const clipped = [];
    if (this.clips.length) {
      exBox.createEl('h4', { text: `读书时摘的 · ${this.clips.length} 句` });
      for (const c of this.clips) {
        const row = exBox.createDiv({ cls: 'gongdu-hl' });
        const label = row.createEl('label');
        const box = label.createEl('input', { type: 'checkbox' });
        box.checked = true;
        label.createSpan({ text: c.text });
        const thought = row.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
        box.addEventListener('change', () => thought.toggleClass('gongdu-hidden', !box.checked));
        const drop = row.createEl('button', { cls: 'gongdu-drop', text: '不要这句' });
        drop.addEventListener('click', async () => { await this.plugin.dropClips([c.id]); row.remove(); clipped.splice(clipped.findIndex(x => x.c === c), 1); });
        clipped.push({ c, box, thought });
      }
    }
    if (this.highlights.length) {
      exBox.createEl('h4', { text: `今天的高亮 · ${this.highlights.length} 句` });
      exBox.createEl('div', { cls: 'gongdu-note', text: '勾上想摘的句子，每句可以加自己的想法。' });
      for (const hl of this.highlights) {
        const row = exBox.createDiv({ cls: 'gongdu-hl' });
        const label = row.createEl('label');
        const box = label.createEl('input', { type: 'checkbox' });
        label.createSpan({ text: hl.text });
        const thought = row.createEl('textarea', { cls: 'gongdu-thought gongdu-hidden', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });
        box.addEventListener('change', () => thought.toggleClass('gongdu-hidden', !box.checked));
        picked.push({ hl, box, thought });
      }
    } else if (!this.clips.length) {
      exBox.createEl('div', { cls: 'gongdu-note', text: this.file ? '今天还没摘句子。读书时在书里选中一句，点左边栏的共读按钮，就会摘到这里（阅读器里的高亮也会列在这里）。' : '没找到阅读器里正在读的书。' });
    }
    const own = el.createDiv({ cls: 'gongdu-field' });
    // 有摘的或高亮时，“自己写一句”先收起来，要用再展开
    if (this.clips.length || this.highlights.length) {
      own.addClass('gongdu-hidden');
      const more = el.createEl('button', { cls: 'gongdu-more', text: '自己再写一句' });
      own.before(more);
      more.addEventListener('click', () => { own.removeClass('gongdu-hidden'); more.remove(); own.querySelector('textarea').focus(); });
    }
    own.createEl('label', { text: s.excerpts && s.excerpts.length ? `自己写一句（今天已经摘了 ${s.excerpts.length} 句，可以不写）` : '自己写一句', attr: { for: 'gongdu-own' } });
    const ownText = own.createEl('textarea', { attr: { id: 'gongdu-own', rows: '2', placeholder: '书里的一句话', maxlength: '1000' } });
    const ownThought = own.createEl('textarea', { cls: 'gongdu-thought', attr: { rows: '2', placeholder: '想法（可以不写）', maxlength: '500' } });

    // 换封面（只有网站上已经有封面图、或者去掉过，而阅读器里找得到封面时才出现）
    const coverRow = el.createDiv({ cls: 'gongdu-field gongdu-hidden' });
    const coverLabel = coverRow.createEl('label', { cls: 'gongdu-check' });
    const replaceBox = coverLabel.createEl('input', { type: 'checkbox' });
    coverLabel.createSpan({ text: '换成阅读器里的封面' });
    const coverNote = coverRow.createEl('div', { cls: 'gongdu-note' });
    const drawCover = async () => {
      const book = this.books.find(b => String(b.id) === select.value);
      const show = !!book && (book.cover_url || book.cover_removed) && this.localCover && (await this.localCover);
      coverRow.toggleClass('gongdu-hidden', !show);
      if (show) coverNote.setText(book.cover_url ? '网站上这本书已经有封面图，勾上才会换掉。' : book.cover_removed === 'teacher' ? '老师去掉过这本书的封面图。勾上会换上阅读器里的封面（和老师去掉的是同一张就换不了）。' : '你去掉过这本书的封面图，勾上会换回阅读器里的封面。');
    };
    select.addEventListener('change', () => { showTitle(); fillMinutes(); replaceBox.checked = false; drawCover(); });
    drawCover();

    const msg = el.createEl('div', { cls: 'gongdu-msg', attr: { role: 'status' } });
    const btns = el.createDiv({ cls: 'modal-button-container' });
    const submit = btns.createEl('button', { cls: 'mod-cta', text: '打卡' });
    btns.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());

    let done = false;
    submit.addEventListener('click', async () => {
      if (done) { this.close(); return; }
      msg.setText(''); msg.className = 'gongdu-msg';
      const bad = text => { msg.setText(text); msg.addClass('gongdu-bad'); };
      const m = Number(minutes.value);
      if (!Number.isInteger(m) || m < 1 || m > 1440) return bad('分钟数要填 1–1440 之间的整数。');
      const pv = pct.value === '' ? null : Number(pct.value);
      if (pv === null || !Number.isFinite(pv) || pv < 0 || pv > 100) return bad('读到百分之几要填 0–100。');
      const fromClips = clipped.filter(x => x.box.checked);
      const excerpts = fromClips.map(x => ({ text: x.c.text, thought: x.thought.value.trim() || undefined }));
      excerpts.push(...picked.filter(x => x.box.checked).map(x => ({ text: x.hl.text, thought: x.thought.value.trim() || undefined })));
      if (ownText.value.trim()) excerpts.push({ text: ownText.value.trim(), thought: ownThought.value.trim() || undefined });
      if (!excerpts.length && !(s.excerpts && s.excerpts.length)) return bad('今天还没有摘录：至少勾一句，或者自己写一句。');
      const body = { minutes: m, percent: Math.round(pv * 10) / 10 };
      if (select.value === NEW) {
        if (!titleInput.value.trim()) return bad('请填书名。');
        body.book_title = titleInput.value.trim();
        body.format = 'ebook';
      } else body.book_id = Number(select.value);
      if (excerpts.length) body.excerpts = excerpts;

      submit.disabled = true;
      try {
        const out = await this.plugin.api().checkin(body);
        const bookId = out.book_id || body.book_id;
        const lines = [`打好了。连续 ${out.streak} 天，班里今天 ${out.class_done}/${out.class_total} 人读了。`];
        if (this.file && bookId) await this.plugin.remember(this.file.path, bookId);
        await this.plugin.dropClips(fromClips.map(x => x.c.id));
        this.plugin.sync.forget();
        // 封面：勾了换封面就换；没勾就按平常的规则（网站上没有才传）。
        if (this.file && bookId) {
          if (replaceBox.checked) {
            try {
              const r = await this.plugin.sync.replace(this.file, bookId);
              lines.push(!r ? '阅读器里没找到这本书的封面，封面没换。' : r.status === 'same' ? '网站上已经是这张封面了。' : '封面换好了。');
            } catch (e) { lines.push(`封面没换：${e.message}`); }
          } else {
            this.plugin.sync.sync(this.file, { force: true }).catch(() => {});
          }
        }
        if (out.new_achievements && out.new_achievements.length) lines.push(`新成就：${out.new_achievements.map(a => a.name || a.title || a).join('、')}`);
        msg.setText(lines.join(' ')); msg.addClass('gongdu-ok');
        submit.setText('关闭');
        submit.disabled = false;
        done = true;
        this.plugin.refreshBar(true);
      } catch (e) {
        submit.disabled = false;
        bad(e.message || '出错了');
      }
    });
  }
}

module.exports = { CheckinModal };
