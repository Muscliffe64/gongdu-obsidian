'use strict';
// 0.3.0：读书时不打扰，读完一次确认。都不需要 Obsidian。
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/checkin-logic');

test('高亮默认勾上：读书时摘的在前，高亮在后，全部勾上', () => {
  const items = L.excerptItems({ clips: [{ id: 'c1', text: '摘的一句' }], highlights: [{ text: '高亮一句' }, { text: '高亮两句' }] });
  assert.deepEqual(items.map(i => [i.kind, i.text, i.checked]), [['clip', '摘的一句', true], ['hl', '高亮一句', true], ['hl', '高亮两句', true]]);
  assert.deepEqual(L.excerptItems({}), []);
});

test('高亮多了也不丢：默认全勾上超过 20 句时，计数会提醒', () => {
  const items = L.excerptItems({ highlights: Array.from({ length: 23 }, (_, i) => ({ text: `第 ${i} 句` })) });
  const c = L.sendCount({ own: 0, clips: 0, highlights: items.filter(i => i.checked).length });
  assert.deepEqual(c, { total: 23, sending: 20, over: 3 });
});

test('左边栏按钮：选中了新的一句就摘下来，不打开窗口；没选中、或者这句已经摘过，就打开打卡窗口', () => {
  assert.equal(L.ribbonAction({ selection: '书里的一句话', alreadyClipped: false }), 'clip');
  assert.equal(L.ribbonAction({ selection: '', alreadyClipped: false }), 'checkin');
  assert.equal(L.ribbonAction({ selection: '   ', alreadyClipped: false }), 'checkin');
  assert.equal(L.ribbonAction({ selection: '书里的一句话', alreadyClipped: true }), 'checkin', '摘完再点一下就是打卡');
});

test('读完离开书时提醒打卡：条件都满足才提醒，一天一次', () => {
  const ok = { leftBook: 'Books/乡土中国.epub', nowBook: '', bookSec: 12 * 60, connected: true, checked: false, remindedDay: '', today: '2026-11-21', checkinOpen: false };
  assert.equal(L.shouldRemind(ok), true);
  assert.equal(L.shouldRemind({ ...ok, nowBook: 'Books/活着.epub' }), false, '换去读别的书不提醒');
  assert.equal(L.shouldRemind({ ...ok, leftBook: '' }), false);
  assert.equal(L.shouldRemind({ ...ok, bookSec: L.REMIND_MIN_SEC - 1 }), false, '不到 10 分钟不提醒');
  assert.equal(L.shouldRemind({ ...ok, bookSec: L.REMIND_MIN_SEC }), true);
  assert.equal(L.shouldRemind({ ...ok, checked: true }), false, '打过卡了不提醒');
  assert.equal(L.shouldRemind({ ...ok, checked: null }), false, '不知道打没打（连不上）不提醒');
  assert.equal(L.shouldRemind({ ...ok, remindedDay: '2026-11-21' }), false, '今天提醒过了');
  assert.equal(L.shouldRemind({ ...ok, remindedDay: '2026-11-20' }), true);
  assert.equal(L.shouldRemind({ ...ok, connected: false }), false);
  assert.equal(L.shouldRemind({ ...ok, checkinOpen: true }), false);
});

test('打卡成功后自己关窗口：有要看一眼的事就不关', () => {
  assert.equal(L.canAutoClose({}), true);
  assert.equal(L.canAutoClose({ left: 2 }), false, '还有摘句没交上去');
  assert.equal(L.canAutoClose({ heldHighlights: true }), false);
  assert.equal(L.canAutoClose({ coverProblem: true }), false);
});

test('0.5.1 打卡窗口变简单：分钟下面只有一句短说明，详细的点“怎么算的”才看', () => {
  const clock = L.minutesHint({ source: 'clock', clockMin: 37, freshMin: 37, siteMin: 0 });
  assert.deepEqual(clock, { text: '插件计时 37 分钟', warn: false, long: '' });
  const plus = L.minutesHint({ source: 'clock', clockMin: 50, freshMin: 20, siteMin: 30 });
  assert.equal(plus.text, '插件计时：网站上已记 30 分钟，加上新读的 20 分钟');
  const none = L.minutesHint({ source: 'none', siteMin: 0 });
  assert.equal(none.text, '还没计到时间，请填个大概的分钟数');
  assert.equal(none.warn, true);
  assert.match(none.long, /自动计时/);
  const site = L.minutesHint({ source: 'none', siteMin: 25 });
  assert.equal(site.text, '网站上今天已记 25 分钟');
  assert.equal(site.warn, false);
  const qm = L.minutesHint({ source: 'qiaomu', siteMin: 0 }, { fromLog: 42 });
  assert.equal(qm.warn, true);
  assert.match(qm.long, /一共 42 分钟/);
  const other = L.minutesHint({ source: 'none', siteMin: 0, otherBook: true }, { fileMin: 12 });
  assert.match(other.long, /插件计的 12 分钟是阅读器里开着的那本书的/);
});

test('摘句出处一小行；打过卡先收起来，有新摘的句子就不收', () => {
  assert.equal(L.placeLabel({ location: '第 1 章 神经网络的思想', page: '12' }), '第 1 章 神经网络的思想 · 第 12 页');
  assert.equal(L.placeLabel({ location: '第 1 章' }), '第 1 章');
  assert.equal(L.placeLabel({ page: '3' }), '第 3 页');
  assert.equal(L.placeLabel(null), '');
  assert.equal(L.foldChecked({ checked: true, newItems: 0 }), true);
  assert.equal(L.foldChecked({ checked: true, newItems: 2 }), false, '还有新摘的，展开着');
  assert.equal(L.foldChecked({ checked: false, newItems: 0 }), false);
});

test('交过的那句还选着：记号按整理过的文字算，再打开窗口不会又摘一次', () => {
  const Clips = require('../src/clips');
  const a = Clips.sentKey('2026-11-26', 'Books/a.epub', '称为该神经元的\n加权输入。');
  assert.equal(a, Clips.sentKey('2026-11-26', 'Books/a.epub', Clips.cleanText('称为该神经元的\n加权输入。')));
  assert.notEqual(a, Clips.sentKey('2026-11-27', 'Books/a.epub', '称为该神经元的\n加权输入。'), '第二天可以再摘');
});
