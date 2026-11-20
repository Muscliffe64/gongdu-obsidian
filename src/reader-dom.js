'use strict';
// 看 Qiaomu Reader 的阅读页里发生了什么：有没有在翻页、选中了哪句话。
// Qiaomu Reader 用 foliate-js 显示书：书的内容在（closed）shadow DOM 里的 iframe 里，
// 外面的 document 收不到里面的点击、滚动、按键，也拿不到里面选中的文字。
// 进去的办法：foliate-view 元素的 renderer.getContents()（foliate-js 公开的接口），以及 open 的 shadow root 和同源 iframe。
// 只看、只听，不改阅读页里的任何东西。

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'selectionchange'];

/** root 下面所有能进去的地方：root 自己、各层 shadow root、同源 iframe 里的 document。 */
function scopesIn(root, out = [], seen = new Set()) {
  if (!root || seen.has(root)) return out;
  seen.add(root);
  out.push(root);
  let all = [];
  try { all = root.querySelectorAll ? root.querySelectorAll('*') : []; } catch { all = []; }
  for (const el of all) {
    if (el.shadowRoot) scopesIn(el.shadowRoot, out, seen);
    // foliate-js 的 shadow root 是 closed，从外面进不去；它的 <…foliate-view> 有 renderer.getContents()，返回正在显示的 [{ doc }]
    const renderer = el.renderer;
    if (renderer && typeof renderer.getContents === 'function') {
      let contents = [];
      try { contents = renderer.getContents() || []; } catch { contents = []; }
      for (const c of contents) if (c && c.doc && c.doc.documentElement) scopesIn(c.doc, out, seen);
    }
    if (el.tagName === 'IFRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch { doc = null; } // 跨域的进不去，跳过
      if (doc && doc.documentElement) scopesIn(doc, out, seen);
    }
  }
  return out;
}

/**
 * 在 root 里每个能进去的地方挂上监听：有点击、按键、滚轮、触摸、滚动、选字，就调 onActive。
 * 书翻章节时 iframe 会换掉，所以要定时再调一次；挂过的不会重复挂（watched 是 WeakSet）。
 */
function watchActivity(root, onActive, watched) {
  for (const scope of scopesIn(root)) {
    if (watched.has(scope)) continue;
    watched.add(scope);
    for (const ev of ACTIVITY_EVENTS) {
      try { scope.addEventListener(ev, onActive, { capture: true, passive: true }); } catch { /* 有的地方挂不上，跳过 */ }
    }
  }
}

/** 阅读页里现在选中的文字（先看外面的 document，再看各层 iframe）。没有就是空字符串。 */
function selectedText(root) {
  const docs = scopesIn(root).filter(s => s.nodeType === 9); // document
  const top = root && root.ownerDocument;
  if (top && !docs.includes(top)) docs.unshift(top);
  for (const doc of docs) {
    let sel = null;
    try { sel = doc.getSelection ? doc.getSelection() : (doc.defaultView || window).getSelection(); } catch { sel = null; }
    if (!sel || sel.isCollapsed || !sel.rangeCount) continue;
    // 外面 document 的选区要在阅读页里面才算（别把笔记里选中的字当成书里的）
    if (doc === top && root.contains && !root.contains(sel.anchorNode)) continue;
    const text = String(sel.toString() || '').trim();
    if (text) return text;
  }
  return '';
}

module.exports = { scopesIn, watchActivity, selectedText, ACTIVITY_EVENTS };
