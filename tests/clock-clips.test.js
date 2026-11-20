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

test('分钟先填多少：网站上已经记的保留，加上插件还没交过的（没交过插件时间）', () => {
  // 纸书记了 45 分钟，插件今天在 Obsidian 里记了 30 分钟，还没交过 → 75
  assert.deepEqual(Clock.prefillMinutes({ siteMin: 45, clockSec: 30 * 60, committedSec: 0 }), { value: 75, fresh: 30 });
  // 网站上什么也没有 → 就是插件记的
  assert.deepEqual(Clock.prefillMinutes({ siteMin: 0, clockSec: 30 * 60 }), { value: 30, fresh: 30 });
});

test('分钟先填多少：插件已经交过的不重复算', () => {
  // 上次打卡交了 75（45 纸书 + 插件 30），记下插件交过 30 分钟；之后又读了 10 分钟，插件一共 40 → 85
  const committed = {};
  Clock.commit(committed, '2026-11-21', 'b.epub', 30 * 60);
  const sec = Clock.secondsOf(committed, '2026-11-21', 'b.epub');
  assert.deepEqual(Clock.prefillMinutes({ siteMin: 75, clockSec: 40 * 60, committedSec: sec }), { value: 85, fresh: 10 });
  // 交过以后没再读 → 就是网站上的，不加
  assert.deepEqual(Clock.prefillMinutes({ siteMin: 75, clockSec: 30 * 60, committedSec: sec }), { value: 75, fresh: 0 });
  // commit 只往大里记
  Clock.commit(committed, '2026-11-21', 'b.epub', 10 * 60);
  assert.equal(Clock.secondsOf(committed, '2026-11-21', 'b.epub'), 30 * 60);
  // 不超过 1440
  assert.equal(Clock.prefillMinutes({ siteMin: 1430, clockSec: 60 * 60 }).value, 1440);
});

test('不要这句：找不到时不删别的（findIndex 是 -1 时不能 splice 掉最后一个）', () => {
  const arr = [{ id: 'a' }, { id: 'b' }];
  assert.equal(Clips.dropFrom(arr, x => x.id === 'zzz'), false);
  assert.deepEqual(arr.map(x => x.id), ['a', 'b']);
  assert.equal(Clips.dropFrom(arr, x => x.id === 'a'), true);
  assert.deepEqual(arr.map(x => x.id), ['b']);
  assert.equal(Clips.dropFrom(arr, x => x.id === 'a'), false, '点两次也只删一次');
  assert.deepEqual(arr.map(x => x.id), ['b']);
});

test('摘句：一次最多交 20 句；两个字以下的不摘（网站不收）', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  const { send, held } = Clips.planSend(items);
  assert.equal(send.length, 20);
  assert.deepEqual(held, [20, 21, 22, 23, 24]);
  assert.equal(Clips.add([], { text: '嗯', book: 'b', day: 'd', now: 1 }), null);
});

test('摘句：只有网站存下了的才算交上去（文字比较和网站一样做 NFC、合并空白）', () => {
  const sent = [{ id: 1, text: 'café 一句' }, { id: 2, text: '没存下的' }];
  const server = [{ text: 'café   一句' }, { text: '别的' }];
  assert.deepEqual(Clips.acceptedIds(sent, server), [1]);
  assert.deepEqual(Clips.acceptedIds(sent, undefined), []);
});
