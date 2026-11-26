'use strict';
// 打卡窗口里不碰 Obsidian 的部分：分钟先填多少、怎么说明来源、检查填的数、这次带上几句。
const Q = require('./qiaomu');
const Clock = require('./clock');
const Clips = require('./clips');

/**
 * “今天读了几分钟”先填多少，以及下面那行说明用到的数。
 * 插件记的时间是记在阅读器里的这个文件上的，只有下拉框选的正是这个文件对应的那本书（fileKey === selectedKey）才算进去；
 * 选了别的书，插件的时间一分钟也不算（那是另一本书的时间）。
 *
 * 参数：fileKey（文件对应的书：书的 id 字符串，或者 'new'，对不上就是空）、selectedKey（下拉框现在选的）、
 *       siteMin（网站上选的这本书今天已经记的分钟）、clockSec、committedSec（这个文件今天插件记的、已经交过的秒数）、
 *       fromLog（Qiaomu Reader 自己的计时，今天所有书一起的分钟）、rows（网站上今天的记录）、selectedId（选的书的 id，新书是 null）。
 * 返回 { source: 'clock' | 'qiaomu' | 'none', value: 要填的字符串（'' 表示不填）, clockMin, freshMin, siteMin, otherBook }。
 */
function minutesPlan({ fileKey, selectedKey, siteMin = 0, clockSec = 0, committedSec = 0, fromLog = 0, rows = [], selectedId = null }) {
  const ownsClock = !!fileKey && fileKey === selectedKey;
  const clockMin = ownsClock ? Math.round(clockSec / 60) : 0;
  // 选了别的书，而这个文件插件记到过时间：说明里要讲清楚这些时间不算到这本书上
  const otherBook = !ownsClock && Math.round(clockSec / 60) > 0;
  if (clockMin > 0) {
    const { value, fresh } = Clock.prefillMinutes({ siteMin, clockSec, committedSec });
    return { source: 'clock', value: value > 0 ? String(value) : '', clockMin, freshMin: fresh, siteMin, otherBook };
  }
  // 插件没记到：退回 Qiaomu Reader 自己的计时（要在阅读器菜单里手动开始，多数人没开）
  if (fromLog > 0) {
    const { value } = Q.suggestMinutes(fromLog, rows, selectedId);
    if (value) return { source: 'qiaomu', value, clockMin: 0, freshMin: 0, siteMin, otherBook };
  }
  // 什么也没记到：网站上这本书今天已经记过就填那个（再交是覆盖，空着会让人以为要重填），不然空着
  return { source: 'none', value: siteMin > 0 ? String(siteMin) : '', clockMin: 0, freshMin: 0, siteMin, otherBook };
}

/** 全角数字、全角小数点换成半角，去掉空格（学生用中文输入法常打出全角）。 */
function normalizeNumber(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[．。]/g, '.')
    .replace(/\s+/g, '');
}

/** 检查分钟数。网站要 1–1440 的整数。返回 { ok: true, value } 或 { ok: false, message }（告诉人怎么改）。 */
function checkMinutes(raw) {
  const t = normalizeNumber(raw);
  if (!t) return { ok: false, message: '请填今天读了多少分钟：一个 1 到 1440 之间的整数，比如 30。记不清就填个大概。' };
  if (!/^\d+$/.test(t)) return { ok: false, message: `“${String(raw).trim()}”不是整数分钟。只填数字，比如 30，不要带小数、单位或别的字。` };
  const v = Number(t);
  if (v < 1) return { ok: false, message: '分钟数至少是 1。今天读了不到 1 分钟的话，就先不打卡。' };
  if (v > 1440) return { ok: false, message: '分钟数最多 1440（一整天）。请填这本书今天实际读的分钟数。' };
  return { ok: true, value: v };
}

/** 检查读到百分之几：0–100，最多一位小数。 */
function checkPercent(raw) {
  const t = normalizeNumber(raw).replace(/[%％]$/, '');
  if (!t) return { ok: false, message: '请填读到百分之几：0 到 100 之间的数，比如 45。阅读器底部能看到这本书的进度。' };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, message: `“${String(raw).trim()}”不是数字。只填数字，比如 45 或 45.5。` };
  const v = Number(t);
  if (v > 100) return { ok: false, message: '读到百分之几最多是 100。' };
  return { ok: true, value: Math.round(v * 10) / 10 };
}

/**
 * 这次会带上几句：自己写的（有就算 1 句）+ 勾上的摘句 + 勾上的高亮，最多 MAX_SEND 句。
 * 返回 { total（一共勾了/写了几句）, sending（这次带上几句）, over（多出来几句） }。
 */
function sendCount({ own = 0, clips = 0, highlights = 0 }) {
  const total = (own ? 1 : 0) + clips + highlights;
  const sending = Math.min(total, Clips.MAX_SEND);
  return { total, sending, over: total - sending };
}

/** 路径太长时中间省略，悬停看全文。max 是保留的字数。 */
function shortPath(path, max = 36) {
  const p = String(path || '');
  if (p.length <= max) return p;
  const tail = Math.ceil(max * 0.6);
  return p.slice(0, max - tail - 1) + '…' + p.slice(-tail);
}

/**
 * 摘句列表：读书时摘的在前，今天的高亮在后，都默认勾上（学生读书时画高亮就等于摘下来了）。
 * 和高亮一样的摘句不重复列（调用前已经用 Clips.notIn 去掉）。
 */
function excerptItems({ clips = [], highlights = [] }) {
  return [
    ...clips.map(c => ({ kind: 'clip', clip: c, text: c.text, checked: true })),
    ...highlights.map(h => ({ kind: 'hl', hl: h, text: h.text, checked: true })),
  ];
}

/**
 * 分钟格子下面那一行短短的说明（一句话）。long 是点“怎么算的”才看到的详细说明。
 * warn：要学生自己看一眼、填一下（没计到时间、不是插件计的）。
 */
function minutesHint(plan, { fileMin = 0, fromLog = 0 } = {}) {
  const long = [];
  let text;
  let warn = false;
  if (plan.source === 'clock') {
    text = plan.siteMin ? `插件计时：网站上已记 ${plan.siteMin} 分钟，加上新读的 ${plan.freshMin} 分钟` : `插件计时 ${plan.clockMin} 分钟`;
  } else if (plan.source === 'qiaomu') {
    text = '按 Qiaomu Reader 的计时先填的，请看一下对不对';
    warn = true;
    long.push(`插件今天没为这本书计到时间。Qiaomu Reader 自己记的今天所有书一共 ${fromLog} 分钟，别的书已经记过的减掉了。`);
  } else {
    text = plan.siteMin ? `网站上今天已记 ${plan.siteMin} 分钟` : '还没计到时间，请填个大概的分钟数';
    warn = !plan.siteMin;
  }
  if (plan.source !== 'clock') {
    long.push('在 Qiaomu Reader 里打开这本书读，插件会自动计时：Obsidian 在最前面、3 分钟内翻过页、滚动过或动过鼠标才算，8 分钟之内回来的会补上停下的那段。');
  }
  if (plan.otherBook) long.push(`插件计的 ${fileMin} 分钟是阅读器里开着的那本书的，选了别的书就不算进去。`);
  return { text, warn, long: long.join('') };
}

/** 摘句出处的一小行：“第 1 章 … · 第 12 页”；都没有就是空。 */
function placeLabel(place) {
  const loc = String((place && place.location) || '').trim();
  const page = String((place && place.page) || '').trim();
  return [loc, page ? `第 ${page} 页` : ''].filter(Boolean).join(' · ');
}

/**
 * 今天已经打过卡：窗口先收成一行“今天已打卡 · N 分钟”，点“再交一次”才展开。
 * 还有新摘的句子没交时不收（打开窗口多半就是来交它们的）。
 */
function foldChecked({ checked = false, newItems = 0 } = {}) {
  return !!checked && newItems === 0;
}

/**
 * 左边栏共读按钮点一下做什么：书里选中了一句、而且这句还没摘过 → 摘下来（不打开窗口）；
 * 别的情况（没选中、这句已经摘过）→ 打开打卡窗口。
 */
function ribbonAction({ selection = '', alreadyClipped = false }) {
  return String(selection).trim() && !alreadyClipped ? 'clip' : 'checkin';
}

const REMIND_MIN_SEC = 10 * 60;

/**
 * 读完离开书时要不要提醒一句“打卡？”。都满足才提醒：
 * 从一本书离开、而且现在没在读别的书；这本书今天插件计了 10 分钟以上；连上了共读；今天还没打卡；今天还没提醒过；打卡窗口没开着。
 */
function shouldRemind({ leftBook = '', nowBook = '', bookSec = 0, connected = true, checked = null, remindedDay = '', today = '', checkinOpen = false }) {
  return !!leftBook && !nowBook && bookSec >= REMIND_MIN_SEC && connected && checked === false && remindedDay !== today && !checkinOpen;
}

/** 打卡成功后可以自己关掉窗口吗：有要学生看一眼的事（还有句子没交、高亮超了没交、封面没换成）就不关。 */
function canAutoClose({ left = 0, heldHighlights = false, coverProblem = false }) {
  return !left && !heldHighlights && !coverProblem;
}

module.exports = {
  minutesPlan, normalizeNumber, checkMinutes, checkPercent, sendCount, shortPath,
  excerptItems, minutesHint, placeLabel, foldChecked, ribbonAction, shouldRemind, canAutoClose, REMIND_MIN_SEC,
};
