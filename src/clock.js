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
  if (!last || !ctx.book || !ctx.focused || ctx.paused) return 0;
  if (!(ctx.now - ctx.lastActive <= IDLE_MS)) return 0;
  const ms = Math.min(Math.max(0, ctx.now - last), MAX_STEP_MS);
  const sec = Math.round(ms / 1000);
  if (!sec) return 0;
  const today = log[ctx.day] || (log[ctx.day] = {});
  today[ctx.book] = (today[ctx.book] || 0) + sec;
  return sec;
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

/** 打卡成功后记下这次算进去的插件秒数（按天、按书）。 */
function commit(committed, day, book, sec) {
  const today = committed[day] || (committed[day] = {});
  today[book] = Math.max(today[book] || 0, sec || 0);
}

module.exports = { tick, secondsOf, prune, rename, prefillMinutes, commit, IDLE_MS, TICK_MS, MAX_STEP_MS };
