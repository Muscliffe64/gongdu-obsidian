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
 * 打卡窗口最上面一行：《书》 · N 分钟 · 读到 P%。没填的写“分钟没填”“进度没填”。
 */
function summaryText({ title = '', minutes = '', percent = '', isNew = false }) {
  const t = title ? `《${title}》${isNew ? '（加到书架）' : ''}` : '书没选';
  const m = String(minutes).trim() ? `${String(minutes).trim()} 分钟` : '分钟没填';
  const pc = String(percent).trim() ? `读到 ${String(percent).trim()}%` : '进度没填';
  return `${t} · ${m} · ${pc}`;
}

/**
 * 书、分钟、进度要不要一打开就展开给人看（默认收成一行摘要，点“改”再展开）。
 * 有一样拿不准就展开，并说为什么：没找到阅读器里的书、分钟没计到、进度没有、新书没书名。
 * 返回原因的列表，空就是不用展开。
 */
function detailReasons({ hasFile = true, minutes = '', percent = '', source = 'clock', isNew = false, newTitle = '' }) {
  const why = [];
  if (!hasFile) why.push('没找到阅读器里正在读的书，请选一下是哪本');
  if (isNew && !String(newTitle).trim()) why.push('请填书名');
  if (!String(minutes).trim()) why.push('今天还没计到这本书的阅读时间，请填分钟数');
  else if (source !== 'clock') why.push('分钟数不是插件计时得来的，请看一下对不对');
  if (!String(percent).trim()) why.push('请填读到百分之几');
  return why;
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
  excerptItems, summaryText, detailReasons, ribbonAction, shouldRemind, canAutoClose, REMIND_MIN_SEC,
};
