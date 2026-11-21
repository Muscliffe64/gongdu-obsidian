'use strict';
// 自动计时：不用点开始、停止。插件每隔一会儿看一次，满足这三条才把这段时间算到正在读的书上：
// 1. 当前标签页是 Qiaomu Reader 里的一本书；
// 2. Obsidian 在最前面（窗口有焦点、没被藏起来）；
// 3. 最近 3 分钟里翻过页、滚过、点过或按过键（走开了就不算）。
// 打卡窗口开着的时候也不算（写想法、粘贴不算读书时间）。
// 记的是每本书每天的秒数：{ "YYYY-MM-DD": { 书的路径: 秒 } }，只留最近几天。

const IDLE_MS = 3 * 60 * 1000;
const TICK_MS = 15 * 1000;
const MAX_STEP_MS = 2 * TICK_MS; // 两次检查隔太久（电脑睡眠、卡住）时，最多算这么长
const KEEP_DAYS = 3;

/**
 * 记一次。log：上面的对象（会被改）。ctx：{ now, day, book（路径或空）, focused, lastActive, paused }。
 * last：上次检查的时间（毫秒），第一次是 0。返回这次加了几秒。
 */
function tick(log, last, ctx) {
  if (!last || stateOf(ctx).state !== 'running') return 0;
  const ms = Math.min(Math.max(0, ctx.now - last), MAX_STEP_MS);
  const sec = Math.round(ms / 1000);
  if (!sec) return 0;
  const today = log[ctx.day] || (log[ctx.day] = {});
  today[ctx.book] = (today[ctx.book] || 0) + sec;
  return sec;
}

/**
 * 现在在不在计时，不在的话为什么。ctx 和 tick 的一样。
 * 返回 { state: 'running' | 'paused', reason: '' | 'no-book' | 'checkin' | 'unfocused' | 'idle' }。
 * 原因按这个顺序判断：没开书 → 打卡窗口开着 → Obsidian 不在最前面 → 3 分钟没动。
 */
function stateOf(ctx) {
  if (!ctx.book) return { state: 'paused', reason: 'no-book' };
  if (ctx.paused) return { state: 'paused', reason: 'checkin' };
  if (!ctx.focused) return { state: 'paused', reason: 'unfocused' };
  if (!(ctx.now - ctx.lastActive <= IDLE_MS)) return { state: 'paused', reason: 'idle' };
  return { state: 'running', reason: '' };
}

/** 某天某本书记了几秒；不给书就是那天所有书一共。 */
function secondsOf(log, day, book) {
  const today = (log && log[day]) || {};
  if (book) return today[book] || 0;
  return Object.values(today).reduce((a, v) => a + (v || 0), 0);
}

/** 只留最近 KEEP_DAYS 天。 */
function prune(log) {
  const days = Object.keys(log || {}).sort();
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete log[d];
  return log;
}

/** 书改了名、挪了位置：把记下的时间跟过去。 */
function rename(log, from, to) {
  for (const today of Object.values(log || {})) {
    if (today[from] == null) continue;
    today[to] = (today[to] || 0) + today[from];
    delete today[from];
  }
}

/**
 * 打卡窗口里“今天读了几分钟”先填多少（插件记到时间的时候）。
 * 网站上这本书今天已经记的分钟（siteMin，可能有纸书、或者以前交过的）保留，
 * 再加上插件记了、还没交上去过的时间：clockSec − committedSec（committedSec：之前打卡时已经算进去的插件秒数）。
 * 这样以前记的不会被盖掉，插件已经交过的也不会算两遍。返回 { value, fresh }（分钟）。
 */
function prefillMinutes({ siteMin = 0, clockSec = 0, committedSec = 0 }) {
  const fresh = Math.max(0, Math.round((clockSec - committedSec) / 60));
  return { value: Math.min(1440, (siteMin || 0) + fresh), fresh };
}

/**
 * 打卡交上去以后，插件的时间有多少算“已经交过”（返回新的 committedSec）。
 * 规则：交上去的分钟数先算网站上原来记的（siteMin），多出来的部分才是插件的时间。
 * - 多出来的 ≥ 当时没交过的插件分钟（freshMin）：插件的时间全部算交过；
 * - 少一些（学生自己往少里改了）：只把多出来的这几分钟算交过，剩下的插件时间下次打卡还会加上；
 * - 没有多出来（≤ siteMin）：插件的时间一点也不算交过。
 * 永远不超过插件实际记的 clockSec，也不往回减。
 */
function committedAfter({ siteMin = 0, submitted = 0, clockSec = 0, committedSec = 0 }) {
  const freshSec = Math.max(0, clockSec - committedSec);
  const freshMin = Math.round(freshSec / 60);
  const used = (submitted || 0) - (siteMin || 0);
  let add;
  if (used <= 0) add = 0;
  else if (used >= freshMin) add = freshSec;
  else add = used * 60;
  return Math.max(committedSec, Math.min(clockSec, committedSec + add));
}

/** 记下这本书现在“已经交过”的插件秒数（只往大里记）。 */
function commit(committed, day, book, sec) {
  const today = committed[day] || (committed[day] = {});
  today[book] = Math.max(today[book] || 0, sec || 0);
}

module.exports = { tick, stateOf, secondsOf, prune, rename, prefillMinutes, committedAfter, commit, IDLE_MS, TICK_MS, MAX_STEP_MS };
