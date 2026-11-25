'use strict';
// 0.4.1：3 分钟没动先暂停，8 分钟之内回来，把停下的那段补上（老师 2026-11-25 定的）。
const test = require('node:test');
const assert = require('node:assert/strict');
const Clock = require('../src/clock');

const T0 = Date.UTC(2026, 10, 25, 2, 0, 0);
const S = 1000; const M = 60 * S;
const BOOK = 'Books/乡土中国.epub';
const base = { day: '2026-11-25', book: BOOK, focused: true, paused: false };

/** 模拟插件：每 15 秒 tick 一次；actions 里的时刻有动作（回来）；over(t) 改某一刻的情况。返回记下的秒数。 */
function run({ until, actions = [], over = () => ({}) }) {
  const log = {};
  let hold = null; let last = 0; let lastActive = T0;
  const acts = [...actions].sort((a, b) => a - b);
  for (let t = T0; t <= T0 + until; t += Clock.TICK_MS) {
    while (acts.length && acts[0] <= t) {
      const a = acts.shift();
      Clock.resume(log, hold, a);
      hold = null;
      lastActive = a;
    }
    const ctx = { ...base, now: t, lastActive, ...over(t) };
    hold = Clock.holdIdle(hold, last, ctx);
    Clock.tick(log, last, ctx);
    last = t;
  }
  return Clock.secondsOf(log, base.day, BOOK);
}

test('读一页读了 6 分钟没碰鼠标，然后翻页：6 分钟全算', () => {
  const sec = run({ until: 7 * M, actions: [T0 + 6 * M] });
  assert.equal(sec, 7 * 60);
});

test('不回来：只算前 3 分钟（和以前一样）', () => {
  assert.equal(run({ until: 20 * M }), 3 * 60);
});

test('离上次动作超过 8 分钟才回来：停下的那段不补', () => {
  const sec = run({ until: 12 * M, actions: [T0 + 10 * M] });
  assert.equal(sec, 3 * 60 + 15 + 2 * 60, '前 3 分钟 + 回来那一下的 15 秒 + 回来以后的 2 分钟');
});

test('正好 8 分钟回来：补上', () => {
  const sec = run({ until: 9 * M, actions: [T0 + 8 * M] });
  assert.equal(sec, 9 * 60);
});

test('中间切到别的软件：不补', () => {
  const sec = run({ until: 7 * M, actions: [T0 + 6 * M], over: t => ({ focused: !(t > T0 + 4 * M && t < T0 + 5 * M) }) });
  assert.equal(sec, 3 * 60 + 15 + 60);
});

test('中间换了一本书、打开了打卡窗口：都不补', () => {
  const other = run({ until: 7 * M, actions: [T0 + 6 * M], over: t => (t > T0 + 4 * M && t < T0 + 5 * M ? { book: 'Books/别的书.epub' } : {}) });
  assert.equal(other, 3 * 60 + 15 + 60);
  const checkin = run({ until: 7 * M, actions: [T0 + 6 * M], over: t => ({ paused: t > T0 + 4 * M && t < T0 + 5 * M }) });
  assert.equal(checkin, 3 * 60 + 15 + 60);
});

test('holdIdle / resume 的边界', () => {
  const ctx = { ...base, now: T0 + 4 * M, lastActive: T0 };
  const h = Clock.holdIdle(null, T0 + 4 * M - 15 * S, ctx);
  assert.deepEqual(h, { day: base.day, book: BOOK, since: T0, sec: 15 });
  assert.equal(Clock.holdIdle(h, T0 + 4 * M, { ...ctx, now: T0 + 9 * M }).broken, true, '超过 8 分钟作废');
  const off = Clock.holdIdle(h, T0 + 4 * M, { ...ctx, focused: false });
  assert.equal(off.broken, true, '切走就作废');
  assert.equal(Clock.holdIdle(off, T0 + 4 * M, { ...ctx, now: T0 + 5 * M }).broken, true, '切回来也不再补，直到下一次动作');
  assert.equal(Clock.resume({}, off, T0 + 5 * M), 0);
  assert.equal(Clock.holdIdle(h, T0, { ...ctx, lastActive: T0 + 4 * M - S }), null, '在计时就不留');
  const log = {};
  assert.equal(Clock.resume(log, null, T0), 0);
  assert.equal(Clock.resume(log, { ...h }, T0 + 9 * M), 0, '回来晚了不补');
  assert.equal(Clock.resume(log, { ...h }, T0 + 5 * M), 15);
  assert.equal(Clock.secondsOf(log, base.day, BOOK), 15);
  assert.equal(Clock.BACKFILL_MS, 8 * M);
});
