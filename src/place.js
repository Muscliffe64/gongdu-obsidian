'use strict';
// 摘句在书里的位置：第几章第几节（从书的目录取），有纸书页码表的电子书再带上页数。
// Qiaomu Reader 用 foliate-js 显示书。阅读页里的 <…foliate-view> 元素上有：
//   book.toc       目录树 [{ label, href, subitems }]
//   book.sections  书的各个文件（spine），book.resolveHref(href) → { index }
//   lastLocation   现在读到的地方 { section: { current }, tocItem, pageItem, cfi }（Qiaomu 带的 foliate-js 是这样存的）
// 这里只读这些，不改阅读页。拿不到就返回空，摘句照常存，只是不带出处。

const LOC_MAX = 60;   // 网站的“第几章第几节”最多收 60 字
const PAGE_MAX = 20;

const tidy = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** 目录摊平：每一项带上它上面各级的标题，按目录顺序。 */
function flatToc(toc, parents = [], out = []) {
  for (const item of Array.isArray(toc) ? toc : []) {
    if (!item) continue;
    const label = tidy(item.label);
    const labels = label ? [...parents, label] : parents;
    out.push({ item, labels });
    if (item.subitems && item.subitems.length) flatToc(item.subitems, labels, out);
  }
  return out;
}

/** 几级标题合成一行，太长就只留最里面一级（再长就截断）。 */
function joinLabels(labels) {
  const all = labels.join(' ');
  if (Array.from(all).length <= LOC_MAX) return all;
  const last = labels[labels.length - 1] || '';
  return Array.from(last).slice(0, LOC_MAX).join('');
}

/** 目录里一项的 href 指到书的第几个文件。拿不到返回 -1。 */
function sectionIndexOf(book, href) {
  if (!href) return -1;
  try {
    if (typeof book.resolveHref === 'function') {
      const r = book.resolveHref(href);
      if (r && Number.isInteger(r.index)) return r.index;
    }
  } catch { /* 换下面的办法 */ }
  const id = String(href).split('#')[0];
  const secs = Array.isArray(book.sections) ? book.sections : [];
  const i = secs.findIndex(s => s && (s.id === id || (typeof s.id === 'string' && s.id.endsWith('/' + id))));
  return i;
}

/** epubcfi(/6/14!/4/…) 里书的第几个文件：/6/N → N/2 - 1。 */
function indexFromCfi(cfi) {
  const m = /^epubcfi\(\/6\/(\d+)/.exec(String(cfi || ''));
  return m ? Number(m[1]) / 2 - 1 : -1;
}

/** 第 index 个文件属于目录里哪一章：目录里指到它或它前面的、最靠后的那一项。 */
function chapterAtIndex(book, index) {
  if (!book || !Number.isInteger(index) || index < 0) return '';
  let best = null; let bestIdx = -1;
  for (const e of flatToc(book.toc)) {
    const i = sectionIndexOf(book, e.item.href);
    if (i < 0 || i > index) continue;
    if (i >= bestIdx) { best = e; bestIdx = i; }   // 一样的取后面的（更细的一级）
  }
  return best && best.labels.length ? joinLabels(best.labels) : '';
}

/** 目录里这一项（foliate 给的 tocItem）连同上面各级的标题。 */
function chapterOfItem(book, tocItem) {
  if (!book || !tocItem) return '';
  const flat = flatToc(book.toc);
  const e = flat.find(x => x.item === tocItem) || (tocItem.href ? flat.find(x => x.item.href === tocItem.href) : null);
  if (e && e.labels.length) return joinLabels(e.labels);
  return joinLabels([tidy(tocItem.label)].filter(Boolean));
}

/** 纸书页码（电子书里带的页码表）。太长的不要（不像页码）。 */
function pageOf(pageItem) {
  const p = tidy(pageItem && pageItem.label);
  return p && Array.from(p).length <= PAGE_MAX ? p : '';
}

/**
 * 现在读到的地方：{ location, page }，没有的是空字符串。
 * cfi：高亮自己记的位置，有就按它找章节（高亮可能不在现在这一页）；没有就用 lastLocation。
 */
function placeOf(view, cfi) {
  const out = { location: '', page: '' };
  if (!view || !view.book) return out;
  try {
    if (cfi) {
      let index = -1;
      try { const r = typeof view.resolveCFI === 'function' ? view.resolveCFI(cfi) : null; if (r && Number.isInteger(r.index)) index = r.index; } catch { index = -1; }
      if (index < 0) index = indexFromCfi(cfi);
      out.location = chapterAtIndex(view.book, index);
      return out;
    }
    const loc = view.lastLocation || null;
    if (!loc) return out;
    const index = loc.section && Number.isInteger(loc.section.current) ? loc.section.current : loc.index;
    out.location = chapterOfItem(view.book, loc.tocItem) || chapterAtIndex(view.book, index);
    out.page = pageOf(loc.pageItem);
  } catch { /* 读不到就不带出处 */ }
  return out;
}

/** 出处显示成一行：“第2章 第3节 · 第 45 页”。 */
function placeLabel({ location = '', page = '' } = {}) {
  const p = tidy(page);
  const pl = p ? (/^\d+(–\d+)?$/.test(p) ? `第 ${p} 页` : p) : '';
  return [tidy(location), pl].filter(Boolean).join(' · ');
}

module.exports = { flatToc, chapterAtIndex, chapterOfItem, indexFromCfi, pageOf, placeOf, placeLabel, LOC_MAX };
