'use strict';
// 读 Qiaomu Reader（乔木阅读器）记下的数据。都是只读，不改它的任何文件。
// 依据 Qiaomu Reader 4.9.x 的源码（github.com/joeseesun/qiaomu-reader，src/main.js）：
// - 插件数据 <插件目录>/data.json：{ settings: { readingLog: { "YYYY-MM-DD": 秒 }, dataFolder, booksFolder, bookNoteLinks }, lastBookPath }
// - 进度 <数据文件夹>/reading-progress.json：{ 书的路径: { pct, percent(0–100), lastRead(毫秒) } }
// - 高亮 <数据文件夹>/reading-highlights.json：{ 书的路径: [ { id, text, created(毫秒), color, ... } ] }
// - 数据文件夹 = settings.dataFolder，空着就用 settings.booksFolder，再空就是库的根目录。
// - 封面缓存 <插件目录>/thumbnails-v3/<sha256(JSON.stringify([路径, mtime, size]))>.jpg

const PLUGIN_ID = 'qiaomu-reader';
const BOOK_EXTENSIONS = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'cbz', 'txt'];

const isBookPath = p => BOOK_EXTENSIONS.includes(String(p || '').split('.').pop().toLowerCase());

const normPath = p => String(p || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');

/** 本机日期 YYYY-MM-DD（和 Qiaomu Reader 记阅读时长用的一样）。 */
function dayOf(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dataFolder(settings) {
  const s = settings || {};
  return normPath(s.dataFolder) || normPath(s.booksFolder) || '';
}

const inFolder = (folder, name) => (folder ? `${folder}/${name}` : name);
const progressPath = settings => inFolder(dataFolder(settings), 'reading-progress.json');
const highlightsPath = settings => inFolder(dataFolder(settings), 'reading-highlights.json');

/** 某天读了多少秒（阅读器的计时）。 */
function secondsOn(settings, day) {
  const v = settings && settings.readingLog && settings.readingLog[day];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 最近读的那本书：lastRead 最新的。没有就是 null。 */
function latestBook(progress) {
  let best = null;
  for (const [path, r] of Object.entries(progress || {})) {
    if (!r || !Number.isFinite(r.lastRead)) continue;
    if (!best || r.lastRead > best.lastRead) best = { path, lastRead: r.lastRead, percent: percentOf(progress, path) };
  }
  return best;
}

/** 一本书读到百分之几（0–100，一位小数）。没有记录就是 null。 */
function percentOf(progress, path) {
  const r = progress && progress[path];
  if (!r) return null;
  const v = Number.isFinite(r.pct) ? r.pct * 100 : Number(r.percent);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : null;
}

/** 某本书在某天划的高亮，按时间先后，重复的只留一条。 */
function highlightsOn(highlights, path, day) {
  const seen = new Set();
  const out = [];
  for (const hl of (highlights && highlights[path]) || []) {
    const text = String((hl && hl.text) || '').replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(hl.created) || dayOf(hl.created) !== day || seen.has(text)) continue;
    seen.add(text);
    out.push({ id: hl.id || null, text, created: hl.created, cfi: typeof hl.cfi === 'string' ? hl.cfi : '' });
  }
  return out.sort((a, b) => a.created - b.created);
}

/**
 * 打卡窗口里“今天读了几分钟”先填多少。阅读器记的是今天所有书一起的分钟（fromLog）。
 * 网站上同一本书同一天再交是覆盖，所以：这本书今天已经记过的分钟保留，再加上阅读器里还没记到任何书上的分钟。
 * 别的书已经记过的不再算一遍。rows：网站上今天的记录（readings + pending）。
 * 返回 { value（要填的；空字符串就是让学生自己填）, others（别的书记了多少）, mine（这本书记了多少） }。
 */
function suggestMinutes(fromLog, rows, bookId) {
  const list = rows || [];
  const others = list.filter(r => r.book_id !== bookId).reduce((a, r) => a + (r.minutes || 0), 0);
  const found = list.find(r => r.book_id === bookId);
  const mine = found ? found.minutes || 0 : 0;
  const unrecorded = Math.max(0, (fromLog || 0) - others - mine);
  const total = mine + unrecorded;
  return { value: total > 0 ? String(total) : '', others, mine };
}

/** 书的笔记（Qiaomu Reader 设置里记的「书 → 笔记」）。返回笔记路径或空。 */
function bookNoteFor(settings, bookPath) {
  const raw = settings && settings.bookNoteLinks && settings.bookNoteLinks[bookPath];
  return String(raw || '').trim().replace(/^\[\[|\]\]$/g, '').trim();
}

/** 封面缓存的文件名（不含文件夹）。subtle：crypto.subtle。 */
async function thumbName(file, subtle) {
  const bytes = new TextEncoder().encode(JSON.stringify([file.path, (file.stat && file.stat.mtime) || 0, (file.stat && file.stat.size) || 0]));
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') + '.jpg';
}

module.exports = {
  PLUGIN_ID, BOOK_EXTENSIONS, isBookPath, normPath, dayOf, dataFolder, progressPath, highlightsPath,
  secondsOn, latestBook, percentOf, highlightsOn, suggestMinutes, bookNoteFor, thumbName,
};
