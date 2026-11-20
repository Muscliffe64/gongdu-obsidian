'use strict';
// 自动同步封面：打开一本书时，在后台把阅读器里的封面传到共读书架上对应的那本书。
// 规则（老师 2026-11-18 定的）：
// - 只给网站上还没有封面图的书传；已经有的不换（换封面只在打卡窗口里勾选）。
// - 书还不在共读书架上就不传，状态栏给个小提示。
// - 用 /api/agent/status 判断有没有封面图，不重复传；失败过的不在每次打开时重试。
// - 安静：不弹窗，出问题只在状态栏写一句。
// 读文件、找封面、缩图这些要用 Obsidian 和浏览器的东西，由调用方以函数传进来（测试里换成假的）。

const { matchBook } = require('./match');

const DAY = 24 * 60 * 60 * 1000;

class CoverSync {
  /**
   * @param {object} deps
   *   api：createApi() 的结果
   *   titlesOf(file) → Promise<string[]>：候选书名
   *   findCover(file) → Promise<{ mime, data(base64) } | null>：找到并缩好的封面
   *   memo：{ get(bookId), set(bookId, record) }：记下每本书传没传过，存在插件数据里
   *   links()：以前确认过的「文件路径 → 书的 id」
   *   hint(text)：状态栏的小提示；warn(text)：状态栏的出错提示
   */
  constructor({ api, titlesOf, findCover, memo, links = () => ({}), hint = () => {}, warn = () => {}, now = () => Date.now(), statusTtl = 2 * 60 * 1000, retryAfter = DAY }) {
    Object.assign(this, { api, titlesOf, findCover, memo, links, hint, warn, now, statusTtl, retryAfter });
    this.cached = null;
    this.running = new Map();
  }

  /** 书架（/api/agent/status），两分钟内用缓存。 */
  async status(force = false) {
    if (!force && this.cached && this.now() - this.cached.at < this.statusTtl) return this.cached.value;
    const value = await this.api.status();
    this.cached = { at: this.now(), value };
    return value;
  }

  forget() { this.cached = null; }

  /** 打开了一本书。返回发生了什么（测试和日志用）。同一个文件同时只跑一次。 */
  sync(file, opts = {}) {
    const key = file.path;
    if (this.running.has(key)) return this.running.get(key);
    const job = this._sync(file, opts).finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  async _sync(file, { force = false } = {}) {
    let status;
    try { status = await this.status(force); } catch (e) { return this._failed(null, null, e, '没连上共读网站，封面这次没同步'); }
    const titles = await this.titlesOf(file).catch(() => []);
    const { book, title } = matchBook({ path: file.path, titles }, status.books, this.links());
    if (!book) {
      if (title) this.hint(`《${title}》还不在共读书架上，打卡时会加上`);
      return 'not-on-shelf';
    }
    if (book.cover_url) return 'has-cover';
    if (book.cover_removed) return 'removed';

    const sig = signature(file);
    const rec = this.memo.get(book.id);
    if (rec && rec.sig === sig) {
      if (rec.result === 'rejected' || rec.result === 'done') return 'skip';
      // 没找到封面、出过错：一天之内不再试（Qiaomu Reader 的封面缓存可能过一阵才有）。
      if ((rec.result === 'none' || rec.result === 'error') && this.now() - rec.at < this.retryAfter) return 'skip';
    }

    let cover = null;
    try { cover = await this.findCover(file); } catch { cover = null; }
    if (!cover) {
      // 找不到封面：不出声，换了文件（或者过了很久）再试。
      this.memo.set(book.id, { sig, result: 'none', at: this.now() });
      return 'none';
    }
    try {
      const out = await this.api.uploadCover(book.id, { mime: cover.mime, data: cover.data, replace: false });
      this.memo.set(book.id, { sig, result: out.status === 'removed' ? 'removed' : 'done', at: this.now() });
      if (out.cover_url) book.cover_url = out.cover_url;
      if (out.status === 'removed') book.cover_removed = out.removed_by || 'self';
      return out.status;
    } catch (e) {
      return this._failed(book, sig, e, `《${book.title}》的封面没传上`);
    }
  }

  _failed(book, sig, e, what) {
    const status = e && e.status;
    if (status === 401) { this.warn('共读令牌失效了，请到网站“我的”页面重新生成'); return 'bad-token'; }
    if (e && e.code === 'no_token') return 'no-token';
    if (e && e.code === 'no_base') return 'no-base';
    // 400：图片不收（太大、形状不对等），这个文件不再试；别的（断网、429、服务器出错）过一天再试。
    if (book) this.memo.set(book.id, { sig, result: status === 400 ? 'rejected' : 'error', at: this.now() });
    this.warn(`${what}：${(e && e.message) || '出错了'}`);
    return status === 400 ? 'rejected' : 'error';
  }

  /** 打卡窗口里勾选了“换成阅读器里的封面”：照样找封面，带 replace 传上去。找不到返回 null。 */
  async replace(file, bookId) {
    const cover = await this.findCover(file).catch(() => null);
    if (!cover) return null;
    const out = await this.api.uploadCover(bookId, { mime: cover.mime, data: cover.data, replace: true });
    this.memo.set(bookId, { sig: signature(file), result: 'done', at: this.now() });
    this.forget();
    return out;
  }
}

const signature = file => `${file.path}|${(file.stat && file.stat.mtime) || 0}|${(file.stat && file.stat.size) || 0}`;

module.exports = { CoverSync, signature };
