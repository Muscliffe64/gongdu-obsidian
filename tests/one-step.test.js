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

test('摘要一行：书、分钟、进度；没填的说没填', () => {
  assert.equal(L.summaryText({ title: '乡土中国', minutes: '37', percent: '25' }), '《乡土中国》 · 37 分钟 · 读到 25%');
  assert.equal(L.summaryText({ title: '乡土中国', minutes: '', percent: '', isNew: true }), '《乡土中国》（加到书架） · 分钟没填 · 进度没填');
  assert.equal(L.summaryText({}), '书没选 · 分钟没填 · 进度没填');
});

test('什么时候一打开就展开书、分钟、进度：拿不准的都说出来', () => {
  assert.deepEqual(L.detailReasons({ hasFile: true, minutes: '37', percent: '25', source: 'clock' }), [], '都是插件拿到的，收起来');
  assert.deepEqual(L.detailReasons({ hasFile: true, minutes: '', percent: '25', source: 'none' }), ['今天还没计到这本书的阅读时间，请填分钟数']);
  assert.deepEqual(L.detailReasons({ hasFile: true, minutes: '45', percent: '25', source: 'none' }), ['分钟数不是插件计时得来的，请看一下对不对']);
  assert.deepEqual(L.detailReasons({ hasFile: true, minutes: '20', percent: '25', source: 'qiaomu' }), ['分钟数不是插件计时得来的，请看一下对不对']);
  assert.deepEqual(L.detailReasons({ hasFile: false, minutes: '', percent: '', source: 'none', isNew: true, newTitle: '' }), [
    '没找到阅读器里正在读的书，请选一下是哪本', '请填书名', '今天还没计到这本书的阅读时间，请填分钟数', '请填读到百分之几']);
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
