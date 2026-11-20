'use strict';
// 自动计时和读书时摘句：不需要 Obsidian 的部分。
const test = require('node:test');
const assert = require('node:assert/strict');
const Clock = require('../src/clock');
const Clips = require('../src/clips');

const T0 = Date.UTC(2026, 10, 21, 2, 0, 0);
const S = 1000;
const ctx = (over = {}) => ({ now: T0 + 15 * S, day: '2026-11-21', book: 'Books/乡土中国.epub', focused: true, lastActive: T0, paused: false, ...over });

test('开着书、窗口在前面、最近翻过页：这段时间记到这本书上', () => {
  const log = {};
  assert.equal(Clock.tick(log, T0, ctx()), 15);
  assert.equal(Clock.tick(log, T0 + 15 * S, ctx({ now: T0 + 30 * S })), 15);
  assert.equal(Clock.secondsOf(log, '2026-11-21', 'Books/乡土中国.epub'), 30);
  assert.equal(Clock.secondsOf(log, '2026-11-21'), 30);
});

test('不算的情况：没开书、窗口不在前面、走开超过 3 分钟、打卡窗口开着、第一次检查', () => {
  const log = {};
  assert.equal(Clock.tick(log, T0, ctx({ book: '' })), 0);
  assert.equal(Clock.tick(log, T0, ctx({ focused: false })), 0);
  assert.equal(Clock.tick(log, T0, ctx({ paused: true })), 0);
  assert.equal(Clock.tick(log, T0, ctx({ now: T0 + Clock.IDLE_MS + S, lastActive: T0 })), 0);
  assert.equal(Clock.tick(log, 0, ctx()), 0);
  assert.deepEqual(log, {});
});

test('刚好 3 分钟前翻过页还算；电脑睡了一觉回来，最多补 30 秒', () => {
  const log = {};
  assert.equal(Clock.tick(log, T0 + Clock.IDLE_MS - 15 * S, ctx({ now: T0 + Clock.IDLE_MS })), 15);
  const wake = T0 + 2 * 3600 * S;
  assert.equal(Clock.tick(log, T0, ctx({ now: wake, lastActive: wake })), 30);
});

test('两本书分开记；只留最近 3 天；书改名时间跟过去', () => {
  const log = {};
  Clock.tick(log, T0, ctx());
  Clock.tick(log, T0, ctx({ book: 'Books/活着.epub' }));
  for (const d of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']) log[d] = { x: 1 };
  Clock.prune(log);
  assert.deepEqual(Object.keys(log).sort(), ['2026-11-19', '2026-11-20', '2026-11-21']);
  Clock.rename(log, 'Books/活着.epub', 'Books/余华/活着.epub');
  assert.equal(Clock.secondsOf(log, '2026-11-21', 'Books/余华/活着.epub'), 15);
  assert.equal(Clock.secondsOf(log, '2026-11-21', 'Books/活着.epub'), 0);
});

test('摘句：整理空白，同一句不重复，按书和日期列出来', () => {
  const list = [];
  const a = Clips.add(list, { text: '  我是雨和雪的\n  老熟人了。 ', book: 'b.epub', day: '2026-11-21', now: 1 });
  assert.equal(a.added, true);
  assert.equal(a.clip.text, '我是雨和雪的 老熟人了。');
  assert.equal(Clips.add(list, { text: a.clip.text, book: 'b.epub', day: '2026-11-21', now: 2 }).added, false);
  assert.equal(Clips.add(list, { text: '   ', book: 'b.epub', day: '2026-11-21', now: 3 }), null);
  Clips.add(list, { text: '第二句', book: 'b.epub', day: '2026-11-21', now: 5 });
  Clips.add(list, { text: '别的书', book: 'c.epub', day: '2026-11-21', now: 4 });
  Clips.add(list, { text: '昨天的', book: 'b.epub', day: '2026-11-20', now: 0 });
  assert.deepEqual(Clips.forBook(list, '2026-11-21', 'b.epub').map(c => c.text), [a.clip.text, '第二句']);
  assert.equal(Clips.forBook(list, '2026-11-21', '').length, 3);
  assert.equal(Clips.pruneDays(list, '2026-11-21').length, 3);
});

test('摘句：太长截到 1000 字；交上去的去掉；和高亮一样的不再列', () => {
  const list = [];
  const long = Clips.add(list, { text: '字'.repeat(1200), book: 'b', day: 'd', now: 1 });
  assert.equal(long.clip.text.length, Clips.MAX_LEN);
  const two = Clips.add(list, { text: '高亮过的 一句', book: 'b', day: 'd', now: 2 });
  assert.deepEqual(Clips.notIn(list, ['高亮过的  一句']).map(c => c.id), [long.clip.id]);
  assert.deepEqual(Clips.remove(list, [long.clip.id]).map(c => c.id), [two.clip.id]);
});
