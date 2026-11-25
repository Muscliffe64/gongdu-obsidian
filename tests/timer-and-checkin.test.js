'use strict';
// 0.2.1：看得见的计时、没计到时间时的说法、打卡窗口的检查和计数、几个小问题的修法。都不需要 Obsidian。
const test = require('node:test');
const assert = require('node:assert/strict');
const Clock = require('../src/clock');
const L = require('../src/checkin-logic');
const { barView, shortTitle, minutesText } = require('../src/timer-view');
const R = require('../src/reader-dom');

const T0 = Date.UTC(2026, 10, 21, 2, 0, 0);
const S = 1000;
const ctx = (over = {}) => ({ now: T0, day: '2026-11-21', book: 'Books/乡土中国.epub', focused: true, lastActive: T0 - 10 * S, paused: false, ...over });

/* ---------- 1. 计时看得见 ---------- */

test('计时状态：计时中，以及按顺序说出暂停的原因', () => {
  assert.deepEqual(Clock.stateOf(ctx()), { state: 'running', reason: '' });
  assert.deepEqual(Clock.stateOf(ctx({ book: '' })), { state: 'paused', reason: 'no-book' });
  assert.deepEqual(Clock.stateOf(ctx({ paused: true, focused: false })), { state: 'paused', reason: 'checkin' });
  assert.deepEqual(Clock.stateOf(ctx({ focused: false })), { state: 'paused', reason: 'unfocused' });
  assert.deepEqual(Clock.stateOf(ctx({ lastActive: T0 - Clock.IDLE_MS - S })), { state: 'paused', reason: 'idle' });
  // tick 和状态栏用同一个判断：暂停时不记
  assert.equal(Clock.tick({}, T0 - 15 * S, ctx({ focused: false })), 0);
  assert.equal(Clock.tick({}, T0 - 15 * S, ctx()), 15);
});

test('状态栏：计时中 / 已暂停分得开，有书名（截短）和这本书今天的分钟', () => {
  const run = barView({ state: 'running', reason: '', title: '乡土中国', bookSec: 12 * 60 + 30, checked: false });
  assert.equal(run.text, '共读 · 计时中 · 《乡土中国》 12 分钟 · 今天还没打卡');
  assert.equal(run.icon, 'timer');
  assert.equal(run.running, true);
  assert.equal(run.badge, '12');
  const idle = barView({ state: 'paused', reason: 'idle', title: '额尔古纳河右岸的长长的书名', bookSec: 40, checked: true });
  assert.equal(idle.text, '共读 · 已暂停 · 《额尔古纳河右岸的…》 不到 1 分钟 · 今天打过卡了');
  assert.equal(idle.icon, 'pause');
  assert.match(idle.tooltip, /3 分钟没动/);
  assert.match(idle.tooltip, /动一下鼠标就接着记，8 分钟之内回来的，停下的这段也补上/);
  assert.equal(idle.badge, '', '不到 1 分钟不标数字');
  assert.match(barView({ state: 'paused', reason: 'unfocused', title: '书', bookSec: 0 }).tooltip, /Obsidian 不在最前面.*回到 Obsidian 就接着记/);
});

test('状态栏：没开书时说今天一共几分钟；没连接时说怎么连', () => {
  const none = barView({ state: 'paused', reason: 'no-book', title: '', todaySec: 95 * 60, checked: null });
  assert.equal(none.text, '共读 · 没在读书 · 今天共 95 分钟');
  assert.equal(none.badge, '95');
  assert.equal(barView({ title: '', todaySec: 0 }).text, '共读 · 没在读书');
  const off = barView({ connected: false, state: 'running', title: '乡土中国', bookSec: 600 });
  assert.equal(off.text, '共读 · 还没连接');
  assert.match(off.tooltip, /连接 Obsidian/);
  assert.equal(shortTitle('一二三四五六七八九'), '一二三四五六七八…');
  assert.equal(minutesText(0), '0 分钟');
});

/* ---------- 2. 没计到时间 ---------- */

test('没计到时间：分钟框空着，来源是 none，不是错误', () => {
  const plan = L.minutesPlan({ fileKey: '3', selectedKey: '3', siteMin: 0, clockSec: 0, fromLog: 0 });
  assert.deepEqual(plan, { source: 'none', value: '', clockMin: 0, freshMin: 0, siteMin: 0, otherBook: false });
  // 网站上这本书今天已经记过（比如纸书）：先填网站上的，不让人以为要重填
  assert.equal(L.minutesPlan({ fileKey: '3', selectedKey: '3', siteMin: 45 }).value, '45');
  // 插件没记到，但 Qiaomu Reader 自己的计时有：退回用它
  const q = L.minutesPlan({ fileKey: '3', selectedKey: '3', fromLog: 20, rows: [], selectedId: 3 });
  assert.equal(q.source, 'qiaomu');
  assert.equal(q.value, '20');
});

test('分钟数检查：只在点打卡时用；错误说怎么改；全角数字也认', () => {
  assert.deepEqual(L.checkMinutes('30'), { ok: true, value: 30 });
  assert.deepEqual(L.checkMinutes(' ３０ '), { ok: true, value: 30 });
  assert.match(L.checkMinutes('').message, /1 到 1440 之间的整数，比如 30/);
  assert.match(L.checkMinutes('30分钟').message, /只填数字，比如 30/);
  assert.match(L.checkMinutes('12.5').message, /不要带小数/);
  assert.match(L.checkMinutes('0').message, /至少是 1/);
  assert.match(L.checkMinutes('2000').message, /最多 1440/);
  assert.deepEqual(L.checkPercent('45.55'), { ok: true, value: 45.6 });
  assert.deepEqual(L.checkPercent('４５％'), { ok: true, value: 45 });
  assert.match(L.checkPercent('').message, /0 到 100 之间的数，比如 45/);
  assert.match(L.checkPercent('120').message, /最多是 100/);
  assert.match(L.checkPercent('一半').message, /只填数字/);
});

/* ---------- 3. 打卡窗口 ---------- */

test('这次带上几句：手写 + 摘的 + 高亮，最多 20；超过时多出来几句（d：手写那句也算）', () => {
  assert.deepEqual(L.sendCount({ own: 0, clips: 3, highlights: 2 }), { total: 5, sending: 5, over: 0 });
  assert.deepEqual(L.sendCount({ own: 1, clips: 20, highlights: 0 }), { total: 21, sending: 20, over: 1 }, '20 句摘的 + 手写 1 句 = 超了 1 句');
  assert.deepEqual(L.sendCount({ own: 1, clips: 19, highlights: 0 }), { total: 20, sending: 20, over: 0 });
  assert.deepEqual(L.sendCount({}), { total: 0, sending: 0, over: 0 });
});

test('文件路径太长：中间省略', () => {
  const p = 'Books/示例书库/吾辈如神重构AI时代的生存力与胜任力 ([美]彼得·戴曼迪斯 [美]史蒂芬·科特勒 译者：芦义) (z-library.sk, 1lib.sk, z-lib.sk).epub';
  const short = L.shortPath(p, 48);
  assert.equal(short.length, 48);
  assert.ok(short.startsWith('Books/示例书库/'));
  assert.ok(short.endsWith('.epub'));
  assert.ok(short.includes('…'));
  assert.equal(L.shortPath('Books/乡土中国.epub', 48), 'Books/乡土中国.epub');
});

/* ---------- b) 选了别的书 ---------- */

test('b) 下拉框选了别的书：插件为这个文件计的时间不算进去，说明里讲清楚', () => {
  const base = { fileKey: '3', siteMin: 0, clockSec: 30 * 60, committedSec: 0 };
  const own = L.minutesPlan({ ...base, selectedKey: '3' });
  assert.equal(own.source, 'clock');
  assert.equal(own.value, '30');
  const other = L.minutesPlan({ ...base, selectedKey: '7', siteMin: 15 });
  assert.equal(other.source, 'none');
  assert.equal(other.value, '15', '只有那本书网站上已经记的');
  assert.equal(other.otherBook, true);
  // 文件对不上任何书（fileKey 空）：插件时间也不算给随便选的书
  assert.equal(L.minutesPlan({ ...base, fileKey: null, selectedKey: '3' }).source, 'none');
  // 新书（fileKey = 'new'）选的就是“加一本”：算
  assert.equal(L.minutesPlan({ ...base, fileKey: 'new', selectedKey: 'new' }).value, '30');
});

/* ---------- c) 往少里改 ---------- */

test('c) 交上去以后插件时间算交过多少：全交、往少里改、比网站原来的还少', () => {
  // 网站 0，插件 30 分钟没交过，交 30 → 全部算交过
  assert.equal(Clock.committedAfter({ siteMin: 0, submitted: 30, clockSec: 1800, committedSec: 0 }), 1800);
  // 交得比预填多（加了纸书时间）→ 插件的也全部算交过，不会超过插件实际记的
  assert.equal(Clock.committedAfter({ siteMin: 0, submitted: 50, clockSec: 1800, committedSec: 0 }), 1800);
  // 往少里改成 20 → 只有 20 分钟算交过，剩下 10 分钟下次还会加上
  assert.equal(Clock.committedAfter({ siteMin: 0, submitted: 20, clockSec: 1800, committedSec: 0 }), 1200);
  const next = L.minutesPlan({ fileKey: '3', selectedKey: '3', siteMin: 20, clockSec: 1800, committedSec: 1200 });
  assert.equal(next.freshMin, 10);
  assert.equal(next.value, '30');
  // 网站原来 45（纸书），插件新 30，只交了 40（比网站原来的还少）→ 插件的一点也不算交过
  assert.equal(Clock.committedAfter({ siteMin: 45, submitted: 40, clockSec: 1800, committedSec: 0 }), 0);
  // 之前已经交过 10 分钟，这次往少里改：不往回减
  assert.equal(Clock.committedAfter({ siteMin: 10, submitted: 5, clockSec: 1800, committedSec: 600 }), 600);
  // 网站 45 + 插件新 30 = 75，交 60 → 插件的 15 分钟算交过
  assert.equal(Clock.committedAfter({ siteMin: 45, submitted: 60, clockSec: 1800, committedSec: 0 }), 900);
});

test('预填不用 max：网站上记的比插件多也照样相加', () => {
  const plan = L.minutesPlan({ fileKey: '3', selectedKey: '3', siteMin: 90, clockSec: 10 * 60, committedSec: 0 });
  assert.equal(plan.value, '100');
});

/* ---------- a) 撤下监听 ---------- */

/** 假的 document：记着挂了哪些监听。 */
function fakeScope(children = []) {
  const listeners = new Map();
  return {
    nodeType: 9,
    listeners,
    querySelectorAll: () => children,
    addEventListener(ev, fn, opts) { listeners.set(ev, { fn, opts }); },
    removeEventListener(ev, fn) { if (listeners.get(ev) && listeners.get(ev).fn === fn) listeners.delete(ev); },
  };
}

test('a) 插件关掉时，挂在阅读页里（foliate 的 iframe）的监听全部撤下', () => {
  const inner = fakeScope();
  const foliate = { renderer: { getContents: () => [{ doc: Object.assign(inner, { documentElement: {} }) }] } };
  const root = fakeScope([foliate]);
  const onActive = () => {};
  const w = R.createWatcher(onActive);
  w.watch(root);
  w.watch(root); // 再挂一次不重复
  assert.equal(w.size, 2);
  assert.deepEqual([...inner.listeners.keys()].sort(), [...R.ACTIVITY_EVENTS].sort());
  assert.equal(inner.listeners.get('wheel').fn, onActive);
  w.detach();
  assert.equal(inner.listeners.size, 0, 'iframe 里的都撤下了');
  assert.equal(root.listeners.size, 0);
  assert.equal(w.size, 0);
});
