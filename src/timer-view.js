'use strict';
// 状态栏和左边栏按钮上显示的计时：现在在不在计时、为什么停了、这本书今天记了几分钟。不碰 Obsidian。

const REASONS = {
  'no-book': '没在 Qiaomu Reader 里打开书',
  checkin: '打卡窗口开着',
  unfocused: 'Obsidian 不在最前面',
  idle: '3 分钟没翻页或滚动',
};

const RESUME = {
  idle: '翻页或滚动一下就接着记。',
  unfocused: '回到 Obsidian 就接着记。',
  checkin: '关掉打卡窗口就接着记。',
  'no-book': '',
};

/** 书名截短：最多 n 个字，多了用省略号。 */
function shortTitle(title, n = 8) {
  const t = String(title || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 分钟的说法：不到 1 分钟也要说清楚，免得以为没在记。 */
function minutesText(sec) {
  const m = Math.floor((sec || 0) / 60);
  return m >= 1 ? `${m} 分钟` : sec > 0 ? '不到 1 分钟' : '0 分钟';
}

/**
 * 状态栏要显示的东西。参数：
 *   connected（连上共读没有）、state / reason（Clock.stateOf 的结果）、title（正在读的书名，没开书就空）、
 *   bookSec（这本书今天插件记了几秒）、todaySec（今天所有书一共几秒）、checked（今天打过卡没有：true / false / null 不知道）。
 * 返回 { icon, text, tooltip, running, badge（左边栏按钮上的分钟数，空就不显示） }。
 */
function barView({ connected = true, state = 'paused', reason = 'no-book', title = '', bookSec = 0, todaySec = 0, checked = null }) {
  const running = state === 'running';
  const tail = checked === true ? ' · 今天打过卡了' : checked === false ? ' · 今天还没打卡' : '';
  if (!connected) {
    return { icon: 'book-open-check', text: '共读 · 还没连接', tooltip: '还没连上共读：在共读网站“我的”页面点「连接 Obsidian」。计时照样在记。', running, badge: '' };
  }
  const why = REASONS[reason] || '';
  if (!title) {
    // 没开书：说今天一共记了多少
    const text = `共读 · 没在读书${todaySec ? ` · 今天共 ${minutesText(todaySec)}` : ''}${tail}`;
    return { icon: 'pause', text, tooltip: `计时已暂停：${why}。在 Qiaomu Reader 里打开书读，会自动计时。点一下打卡。`, running: false, badge: todaySec >= 60 ? String(Math.floor(todaySec / 60)) : '' };
  }
  const head = running ? '计时中' : '已暂停';
  const text = `共读 · ${head} · 《${shortTitle(title)}》 ${minutesText(bookSec)}${tail}`;
  const tooltip = running
    ? `正在计时：《${title}》今天 ${minutesText(bookSec)}。点一下打卡。`
    : `计时已暂停（${why}）：《${title}》今天 ${minutesText(bookSec)}。${RESUME[reason] || ''}点一下打卡。`;
  return { icon: running ? 'timer' : 'pause', text, tooltip, running, badge: bookSec >= 60 ? String(Math.floor(bookSec / 60)) : '' };
}

module.exports = { barView, shortTitle, minutesText, REASONS };
