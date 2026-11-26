'use strict';
// 读书时摘下的句子：在阅读器里选中一句，点左边栏的共读按钮（或者用「摘下选中的句子」命令），就先存在这里，
// 打卡窗口里默认勾上。只存在本机插件数据里，打卡交上去以后去掉；不是今天的也去掉。
// 每条：{ id, text, book（文件路径）, day, at, location（第几章第几节）, page（纸书页数） }；出处拿不到就是空字符串

const MAX_LEN = 1000;
const MAX_CLIPS = 50;
const MAX_SEND = 20;   // 网站一次打卡只收前 20 句
const MIN_LEN = 2;     // 网站不收 2 个字以下的

/**
 * 选中的文字整理一下：合并空白（单个换行也当空格，选区里常有断行），去掉首尾空格；分段（空一行）留着，网站上按段显示。
 * 太长的截到 1000 字（网站最多收这么多）。
 */
function cleanText(raw) {
  return String(raw || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n\n').trim().slice(0, MAX_LEN);
}

/**
 * 摘一句。已经摘过同一句（同一本书、同一天）就不重复。
 * 返回 { clip, added }；文字是空的返回 null。
 */
function add(list, { text, book, day, now, location = '', page = '' }) {
  const t = cleanText(text);
  if (t.length < MIN_LEN) return null;
  const same = list.find(c => c.day === day && c.book === book && c.text === t);
  if (same) return { clip: same, added: false };
  const clip = { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, text: t, book: book || '', day, at: now, location: location || '', page: page || '' };
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

/** 从列表里去掉第一个满足条件的；找不到就什么也不做（不会误删最后一个）。返回去掉了没有。 */
function dropFrom(arr, pred) {
  const i = arr.findIndex(pred);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}

/** 一次最多交 MAX_SEND 句：按顺序取前面的，多的留下。返回 { send, held }。 */
function planSend(items, max = MAX_SEND) {
  return { send: items.slice(0, max), held: items.slice(max) };
}

/** 比较用：和网站一样做 NFC，再合并空白。 */
const key = t => cleanText(String(t || '').normalize('NFC'));

/**
 * 交上去的摘句里，网站真的存下了哪些：打卡返回的今天的摘录里有同样的文字才算。
 * 只有这些可以从本机去掉；没存下的（超过 20 句、太短、出错）留着。
 */
function acceptedIds(sent, serverExcerpts) {
  const saved = new Set((serverExcerpts || []).map(e => key(e && e.text)));
  return sent.filter(c => saved.has(key(c.text))).map(c => c.id);
}

/** 和阅读器高亮一样的句子不用再列一遍。 */
function notIn(list, texts) {
  const seen = new Set(texts.map(cleanText));
  return list.filter(c => !seen.has(c.text));
}

/** 一句摘句今天交没交过的记号：日期 + 书 + 整理过的文字。 */
function sentKey(day, book, text) { return `${day}\u0000${book}\u0000${cleanText(text)}`; }

module.exports = { sentKey, cleanText, add, forBook, remove, pruneDays, notIn, dropFrom, planSend, acceptedIds, MAX_LEN, MAX_SEND };
