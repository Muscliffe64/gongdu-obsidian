'use strict';
// 把阅读器里的一本书对到共读书架上的书。
// 书名的比法和网站一样（server/reading.js 的 titleKey）：去掉空格、书名号和常见标点，不分大小写。

const titleKey = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s《》〈〉<>"'“”‘’·•:：,，.。\-—_()（）[\]【】]/g, '');

const SITE_MARKS = /\b(?:z-?library|z-?lib|1lib|zlib|libgen|anna'?s[ _]archive|epubee|sobooks|ePUBw|kindle)\b|\.(?:com|net|org|cn)\b/ig;

/** 从文件路径猜书名：去掉文件夹、扩展名、括号里的作者和下载站标记。返回几个候选，最可能的在前。 */
function titlesFromPath(path) {
  const base = String(path || '').split('/').pop().replace(/\.[^.]+$/, '');
  const noBrackets = base.replace(/[（(【[［{][^）)】\]］}]*[）)】\]］}]/g, ' ').replace(SITE_MARKS, ' ');
  const cleaned = noBrackets.replace(/[《》]/g, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-—\s]+|[-—\s]+$/g, '');
  const out = [];
  const add = t => { t = String(t || '').trim(); if (t && !out.includes(t)) out.push(t); };
  add(cleaned);
  // “作者 - 书名” 或 “书名 - 作者”：两边都试试。
  if (/\s[-—–]\s/.test(cleaned)) cleaned.split(/\s[-—–]\s/).forEach(add);
  if (!out.length) add(base);
  return out;
}

/** 去掉书名两边的书名号。 */
const bareTitle = t => String(t || '').trim().replace(/^《(.+)》$/, '$1').trim();

/**
 * 对书。titles：候选书名（书里写的书名在前，其次是文件名猜的）。links：以前确认过的「文件路径 → 书的 id」。
 * 返回 { book, title }：book 是书架上的书（对不上就是 null），title 是拿来显示、加新书用的书名。
 */
function matchBook({ path, titles }, books, links = {}) {
  const list = (books || []).filter(b => b && b.status !== 'finished');
  const names = (titles || []).map(bareTitle).filter(Boolean);
  const title = names[0] || '';
  const linked = links && links[path];
  if (linked) {
    const b = list.find(x => x.id === linked);
    if (b) return { book: b, title: b.title, how: 'linked' };
  }
  const keyed = list.map(b => ({ b, k: titleKey(b.title) })).filter(x => x.k);
  for (const name of names) {
    const k = titleKey(name);
    if (!k) continue;
    const exact = keyed.filter(x => x.k === k);
    if (exact.length === 1) return { book: exact[0].b, title: exact[0].b.title, how: 'title' };
  }
  // 宽一点：一个书名包含另一个（比如“乡土中国（修订本）”和“乡土中国”）。短的那个至少 4 个字，而且只对上一本，才算。
  for (const name of names) {
    const k = titleKey(name);
    if (k.length < 2) continue;
    const loose = keyed.filter(x => Math.min(x.k.length, k.length) >= 4 && (x.k.includes(k) || k.includes(x.k)));
    if (loose.length === 1) return { book: loose[0].b, title: loose[0].b.title, how: 'loose' };
  }
  return { book: null, title, how: null };
}

module.exports = { titleKey, titlesFromPath, bareTitle, matchBook };
