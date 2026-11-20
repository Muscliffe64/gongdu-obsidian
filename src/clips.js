'use strict';
// 读书时摘下的句子：在阅读器里选中一句，点左边栏的共读按钮（或者用「摘下选中的句子」命令），就先存在这里，
// 打卡窗口里默认勾上。只存在本机插件数据里，打卡交上去以后去掉；不是今天的也去掉。
// 每条：{ id, text, book（文件路径）, day, at }

const MAX_LEN = 1000;
const MAX_CLIPS = 50;

/** 选中的文字整理一下：合并空白，去掉首尾空格。太长的截到 1000 字（网站最多收这么多）。 */
function cleanText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

/**
 * 摘一句。已经摘过同一句（同一本书、同一天）就不重复。
 * 返回 { clip, added }；文字是空的返回 null。
 */
function add(list, { text, book, day, now }) {
  const t = cleanText(text);
  if (!t) return null;
  const same = list.find(c => c.day === day && c.book === book && c.text === t);
  if (same) return { clip: same, added: false };
  const clip = { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, text: t, book: book || '', day, at: now };
  list.push(clip);
  while (list.length > MAX_CLIPS) list.shift();
  return { clip, added: true };
}

/** 这本书今天摘的（不给书就是今天所有的），按摘的先后。 */
function forBook(list, day, book) {
  return list.filter(c => c.day === day && (!book || c.book === book)).sort((a, b) => a.at - b.at);
}

/** 去掉这些 id 的。 */
function remove(list, ids) {
  const drop = new Set(ids);
  return list.filter(c => !drop.has(c.id));
}

/** 不是今天的都去掉。 */
function pruneDays(list, day) {
  return list.filter(c => c.day === day);
}

/** 和阅读器高亮一样的句子不用再列一遍。 */
function notIn(list, texts) {
  const seen = new Set(texts.map(cleanText));
  return list.filter(c => !seen.has(c.text));
}

module.exports = { cleanText, add, forBook, remove, pruneDays, notIn, MAX_LEN };
