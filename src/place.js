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

/**
 * 按书里的具体位置找章节：目录里指到这个文件、带 #锚点 的各项，锚点在 range 开头之前（或者包着它）的、最靠后的那一项。
 * 有的电子书整本只有一个文件（比如《深度学习的数学》），只看第几个文件会一律落到目录最后一项（“附录”），所以要看位置。
 * 找不到返回 ''。
 */
function chapterAtRange(book, index, range) {
  const start = range && range.startContainer;
  const doc = start && (start.ownerDocument || start);
  if (!book || !doc || typeof doc.getElementById !== 'function' || !Number.isInteger(index) || index < 0) return '';
  let best = null; let bestEl = null; let whole = null;
  for (const e of flatToc(book.toc)) {
    const href = String(e.item.href || '');
    if (sectionIndexOf(book, href) !== index) continue;
    const frag = href.split('#')[1];
    if (!frag) { if (!whole) whole = e; continue; }
    let id = frag;
    try { id = decodeURIComponent(frag); } catch { /* 原样用 */ }
    const el = doc.getElementById(id);
    if (!el) continue;
    const before = el === start || (el.contains && el.contains(start)) || (el.compareDocumentPosition(start) & 4); // 4：start 在 el 后面
    if (!before) continue;
    if (!bestEl || bestEl === el || (bestEl.compareDocumentPosition(el) & 4) || (bestEl.contains && bestEl.contains(el))) { best = e; bestEl = el; }
  }
  const pick = best || whole;
  if (!pick || !pick.labels.length) return '';
  const sub = bestEl ? subHeading(doc, bestEl, start) : '';
  return joinLabels(sub && !pick.labels.includes(sub) ? [...pick.labels, sub] : pick.labels);
}

/**
 * 目录只到“第几章”的书：在这一章里，再找 start 前面最近的小节标题（h1–h4 里级别最高的那一级的最后一个），
 * 比如“第 1 章 神经网络的思想”后面接“1-2 神经元工作的数学表示”。没有就是 ''。
 */
function subHeading(doc, anchor, start) {
  if (typeof doc.querySelectorAll !== 'function') return '';
  let best = null; let bestLevel = 9;
  for (const h of Array.from(doc.querySelectorAll('h1,h2,h3,h4'))) {
    if (h === anchor || (anchor.contains && anchor.contains(h))) continue;
    if (!(anchor.compareDocumentPosition(h) & 4)) continue;             // 要在目录锚点后面
    if (!(h.compareDocumentPosition(start) & 4) && !(h.contains && h.contains(start))) break; // 到了 start 后面就停
    const level = Number(String(h.tagName || h.localName || '').replace(/\D/g, '')) || 9;
    if (level <= bestLevel) { best = h; bestLevel = level; }
  }
  return best ? tidy(best.textContent) : '';
}

/** range 在书的第几个文件里：foliate 的 renderer.getContents() 里同一个 document 的那一项。 */
function indexOfRange(view, range) {
  const start = range && range.startContainer;
  const doc = start && (start.ownerDocument || start);
  if (!doc || !view || !view.renderer || typeof view.renderer.getContents !== 'function') return -1;
  try {
    const c = (view.renderer.getContents() || []).find(x => x && x.doc === doc);
    return c && Number.isInteger(c.index) ? c.index : -1;
  } catch { return -1; }
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
 * range：选中的那段（摘句时），先按它在书里的位置找章节；没有就看 lastLocation.range（现在这一页）。
 */
function placeOf(view, cfi, range = null) {
  const out = { location: '', page: '' };
  if (!view || !view.book) return out;
  try {
    if (cfi) {
      let index = -1; let at = null;
      try {
        const r = typeof view.resolveCFI === 'function' ? view.resolveCFI(cfi) : null;
        if (r && Number.isInteger(r.index)) {
          index = r.index;
          // 这个文件现在打开着：foliate 的 anchor(doc) 给出高亮在书里的位置，按位置找章节
          const c = view.renderer && typeof view.renderer.getContents === 'function' ? (view.renderer.getContents() || []).find(x => x && x.index === index) : null;
          if (c && c.doc && typeof r.anchor === 'function') { const a = r.anchor(c.doc); if (a && a.startContainer) at = a; }
        }
      } catch { index = -1; }
      if (index < 0) index = indexFromCfi(cfi);
      out.location = (at ? chapterAtRange(view.book, index, at) : '') || chapterAtIndex(view.book, index);
      return out;
    }
    const loc = view.lastLocation || null;
    if (range) {
      const i = indexOfRange(view, range);
      out.location = chapterAtRange(view.book, i, range);
      if (out.location) { out.page = pageOf(loc && loc.pageItem); return out; }
    }
    if (!loc) return out;
    const index = loc.section && Number.isInteger(loc.section.current) ? loc.section.current : loc.index;
    out.location = chapterOfItem(view.book, loc.tocItem)
      || (loc.range ? chapterAtRange(view.book, index, loc.range) : '')
      || chapterAtIndex(view.book, index);
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

module.exports = { flatToc, chapterAtIndex, chapterAtRange, chapterOfItem, indexFromCfi, pageOf, placeOf, placeLabel, LOC_MAX };
