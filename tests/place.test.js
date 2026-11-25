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
