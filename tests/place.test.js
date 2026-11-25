'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Place = require('../src/place');
const Clips = require('../src/clips');
const Q = require('../src/qiaomu');

// 像 foliate-js 的 book：目录树 + 文件列表 + resolveHref
function fakeBook() {
  const ch1 = { label: '第1章 开头', href: 'Text/ch1.xhtml' };
  const s21 = { label: '第1节 富足', href: 'Text/ch2.xhtml#s1' };
  const s22 = { label: '第2节  之上', href: 'Text/ch3.xhtml' };
  const ch2 = { label: '第2章 技术', href: 'Text/ch2.xhtml', subitems: [s21, s22] };
  const part = { label: '第一部', href: 'Text/ch1.xhtml', subitems: [ch1, ch2] };
  const sections = ['Text/cover.xhtml', 'Text/ch1.xhtml', 'Text/ch2.xhtml', 'Text/ch3.xhtml', 'Text/notes.xhtml'].map(id => ({ id }));
  return {
    items: { ch1, ch2, s21, s22, part },
    book: { toc: [part], sections, resolveHref: href => ({ index: sections.findIndex(s => s.id === href.split('#')[0]) }) },
  };
}

test('章节：目录里这一项连同上面各级的标题', () => {
  const { book, items } = fakeBook();
  assert.equal(Place.chapterOfItem(book, items.s22), '第一部 第2章 技术 第2节 之上', '多余的空格合并');
  assert.equal(Place.chapterOfItem(book, items.ch1), '第一部 第1章 开头');
  // 不是同一个对象，href 一样也认
  assert.equal(Place.chapterOfItem(book, { label: 'x', href: 'Text/ch1.xhtml' }), '第一部', '同一个 href 取目录里第一项');
  // 目录里找不到，就用它自己的标题
  assert.equal(Place.chapterOfItem(book, { label: '附录', href: 'nowhere' }), '附录');
});

test('章节：按书的第几个文件找，取指到它或它前面的、最靠后的一项', () => {
  const { book } = fakeBook();
  assert.equal(Place.chapterAtIndex(book, 0), '', '封面在第一章前面：没有章节');
  assert.equal(Place.chapterAtIndex(book, 1), '第一部 第1章 开头', '一样的取更细的一级');
  assert.equal(Place.chapterAtIndex(book, 2), '第一部 第2章 技术 第1节 富足');
  assert.equal(Place.chapterAtIndex(book, 3), '第一部 第2章 技术 第2节 之上');
  assert.equal(Place.chapterAtIndex(book, 4), '第一部 第2章 技术 第2节 之上', '注释在最后一节后面');
  // 没有 resolveHref 的书：按文件名对
  const { book: b2 } = fakeBook(); delete b2.resolveHref;
  assert.equal(Place.chapterAtIndex(b2, 3), '第一部 第2章 技术 第2节 之上');
});

test('太长的章节名只留最里面一级，再长就截到 60 字', () => {
  const long = '很长'.repeat(30);
  const book = { toc: [{ label: long, href: 'a', subitems: [{ label: '第3节', href: 'a' }] }], sections: [{ id: 'a' }] };
  assert.equal(Place.chapterAtIndex(book, 0), '第3节');
  const book2 = { toc: [{ label: '长'.repeat(80), href: 'a' }], sections: [{ id: 'a' }] };
  assert.equal(Array.from(Place.chapterAtIndex(book2, 0)).length, 60);
});

test('现在读到的地方：用 lastLocation 的 tocItem、section.current、pageItem；高亮按 cfi', () => {
  const { book, items } = fakeBook();
  const view = { book, lastLocation: { section: { current: 3, total: 5 }, tocItem: items.s21, pageItem: { label: '45' } } };
  assert.deepEqual(Place.placeOf(view), { location: '第一部 第2章 技术 第1节 富足', page: '45' });
  // 没有 tocItem（比如在两章之间）：按 section.current
  view.lastLocation = { section: { current: 3, total: 5 } };
  assert.deepEqual(Place.placeOf(view), { location: '第一部 第2章 技术 第2节 之上', page: '' });
  // 高亮：cfi /6/6 是第 2 个文件（从 0 数）
  assert.equal(Place.indexFromCfi('epubcfi(/6/6!/4/78,/1:101,/1:365)'), 2);
  assert.deepEqual(Place.placeOf(view, 'epubcfi(/6/6!/4/2)'), { location: '第一部 第2章 技术 第1节 富足', page: '' });
  // view 自己会解 cfi 就用它的
  view.resolveCFI = () => ({ index: 1 });
  assert.equal(Place.placeOf(view, 'epubcfi(/6/6!/4/2)').location, '第一部 第1章 开头');
  // 拿不到书、读不出来：空的，不报错
  assert.deepEqual(Place.placeOf(null), { location: '', page: '' });
  assert.deepEqual(Place.placeOf({ book, lastLocation: null }), { location: '', page: '' });
  assert.deepEqual(Place.placeOf({ book: { get toc() { throw new Error('x'); } }, lastLocation: { section: { current: 1 } } }), { location: '', page: '' });
  assert.equal(Place.pageOf({ label: '这不是页码这不是页码这不是页码这不是页码，多一点' }), '', '太长的不像页码');
});

test('出处显示：章节 · 第 N 页', () => {
  assert.equal(Place.placeLabel({ location: '第2章', page: '45' }), '第2章 · 第 45 页');
  assert.equal(Place.placeLabel({ location: '第2章', page: '' }), '第2章');
  assert.equal(Place.placeLabel({ location: '', page: 'xii' }), 'xii');
  assert.equal(Place.placeLabel({}), '');
});

test('摘句带上出处；高亮带上 cfi', () => {
  const list = [];
  const out = Clips.add(list, { text: '一句话。', book: 'a.epub', day: '2026-11-24', now: 1, location: '第2章', page: '45' });
  assert.equal(out.clip.location, '第2章');
  assert.equal(out.clip.page, '45');
  const old = Clips.add(list, { text: '没有出处的。', book: 'a.epub', day: '2026-11-24', now: 2 });
  assert.equal(old.clip.location, '');
  const day = Q.dayOf(Date.UTC(2026, 10, 24, 4));
  const hls = Q.highlightsOn({ 'a.epub': [{ id: 'h', text: '高亮', cfi: 'epubcfi(/6/6!/4/2)', created: Date.UTC(2026, 10, 24, 4) }] }, 'a.epub', day);
  assert.equal(hls[0].cfi, 'epubcfi(/6/6!/4/2)');
});

test('整本书只有一个文件：按选中那段前面最近的目录锚点找章节，不会一律落到“附录”', () => {
  // 假的 document：几个带 id 的标题，按文档顺序排；compareDocumentPosition 用顺序比
  const order = [];
  const node = id => { const n = { id, contains: x => x === n, compareDocumentPosition: o => (order.indexOf(o) > order.indexOf(n) ? 4 : 2) }; order.push(n); return n; };
  const h11 = node('nav_point_11'); const p1 = node(null); const h13 = node('nav_point_13'); const p2 = node(null); const h40 = node('nav_point_40');
  const doc = { getElementById: id => order.find(n => n.id === id) || null };
  for (const n of order) n.ownerDocument = doc;
  const toc = [
    { label: '第1章 神经网络的思想', href: 'OEBPS/text00000.html#nav_point_11', subitems: [
      { label: '1-2 神经元工作的数学表示', href: 'OEBPS/text00000.html#nav_point_13' }] },
    { label: '附录', href: 'OEBPS/text00000.html#nav_point_40' },
  ];
  const book = { toc, sections: [{ id: 'OEBPS/text00000.html' }] };
  const view = { book, renderer: { getContents: () => [{ doc, index: 0 }] }, lastLocation: { section: { current: 0 } } };
  assert.equal(Place.placeOf(view).location, '附录', '只知道第几个文件时（以前的样子）');
  assert.equal(Place.placeOf(view, '', { startContainer: p2 }).location, '第1章 神经网络的思想 1-2 神经元工作的数学表示');
  assert.equal(Place.placeOf(view, '', { startContainer: p1 }).location, '第1章 神经网络的思想');
  // 现在这一页的 range（foliate 的 lastLocation.range）
  view.lastLocation = { section: { current: 0 }, range: { startContainer: p2 } };
  assert.equal(Place.placeOf(view).location, '第1章 神经网络的思想 1-2 神经元工作的数学表示');
  // 高亮：foliate 解 cfi 给出 anchor(doc)
  view.resolveCFI = () => ({ index: 0, anchor: () => ({ startContainer: p1 }) });
  assert.equal(Place.placeOf(view, 'epubcfi(/6/2!/4/10)').location, '第1章 神经网络的思想');
  void h11; void h13; void h40;
});

test('目录只到章：再接上选中那段前面最近的小节标题', () => {
  const order = [];
  const node = (id, tag, text) => { const n = { id, tagName: tag, textContent: text || '', contains: x => x === n, compareDocumentPosition: o => (order.indexOf(o) > order.indexOf(n) ? 4 : 2) }; order.push(n); return n; };
  node('nav_point_4', 'H1', '第 1 章 神经网络的思想');
  node(null, 'H2', '1-1 神经网络和深度学习'); node(null, 'H3', '小节一');
  node(null, 'H2', '1-2 神经元工作的数学表示'); node(null, 'H3', '整理神经元的工作');
  const p = node(null, 'P');
  node(null, 'H2', '1-3 激活函数');
  node('nav_point_185', 'H1', '附录');
  const doc = { getElementById: id => order.find(n => n.id === id) || null, querySelectorAll: () => order.filter(n => /^H\d/.test(n.tagName)) };
  for (const n of order) n.ownerDocument = doc;
  const book = { toc: [{ label: '第 1 章　神经网络的思想', href: 'OEBPS/text00000.html#nav_point_4' }, { label: '附录', href: 'OEBPS/text00000.html#nav_point_185' }], sections: [{ id: 'OEBPS/text00000.html' }] };
  const view = { book, renderer: { getContents: () => [{ doc, index: 0 }] }, lastLocation: { section: { current: 0 } } };
  assert.equal(Place.placeOf(view, '', { startContainer: p }).location, '第 1 章 神经网络的思想 1-2 神经元工作的数学表示');
});
