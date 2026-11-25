'use strict';
// 看 Qiaomu Reader 的阅读页里发生了什么：有没有在翻页、选中了哪句话。
// Qiaomu Reader 用 foliate-js 显示书：书的内容在（closed）shadow DOM 里的 iframe 里，
// 外面的 document 收不到里面的点击、滚动、按键，也拿不到里面选中的文字。
// 进去的办法：foliate-view 元素的 renderer.getContents()（foliate-js 公开的接口），以及 open 的 shadow root 和同源 iframe。
// 只看、只听，不改阅读页里的任何东西。

const MathText = require('./mathtext');
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll', 'selectionchange'];

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
 * 一个可以撤下的监听器：watch(root) 挂上（挂过的不重复挂），detach() 把挂过的全部撤下（插件关掉时用）。
 * 挂过的地方用 WeakRef 记着：书翻章节时旧的 iframe 没了，不会因为这里记着而留在内存里。
 */
function createWatcher(onActive) {
  const watched = new WeakSet();
  let refs = [];
  const opts = { capture: true, passive: true };
  return {
    watch(root) {
      for (const scope of scopesIn(root)) {
        if (watched.has(scope)) continue;
        watched.add(scope);
        for (const ev of ACTIVITY_EVENTS) {
          try { scope.addEventListener(ev, onActive, opts); } catch { /* 有的地方挂不上，跳过 */ }
        }
        refs.push(typeof WeakRef === 'function' ? new WeakRef(scope) : { deref: () => scope });
      }
      refs = refs.filter(r => r.deref()); // 已经没了的不再记
    },
    detach() {
      for (const r of refs) {
        const scope = r.deref();
        if (!scope) continue;
        for (const ev of ACTIVITY_EVENTS) {
          try { scope.removeEventListener(ev, onActive, opts); } catch { /* 跳过 */ }
        }
      }
      refs = [];
    },
    get size() { return refs.filter(r => r.deref()).length; },
  };
}

/**
 * 选区里的文字。书里的公式常是图片（alt 里写着 LaTeX）或 MathML，sel.toString() 会把它们丢掉，
 * 所以有公式时一个个节点读出来：公式写成 $…$ / $$…$$，段落之间空一行（见 mathtext.js）。
 */
function selectionText(sel) {
  try {
    const parts = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const frag = sel.getRangeAt(i).cloneContents();
      if (!MathText.hasMath(frag)) return '';
      parts.push(MathText.fromNode(frag));
    }
    return parts.join('\n\n').trim();
  } catch { return ''; }
}

/** 阅读页里现在选中的文字（先看外面的 document，再看各层 iframe）。没有就是空字符串。 */
function selectedText(root) {
  return selection(root).text;
}

/** 选中的文字和选区（range 用来找第几章第几节）。没选中是 { text: '', range: null }。 */
function selection(root) {
  const docs = scopesIn(root).filter(s => s.nodeType === 9); // document
  const top = root && root.ownerDocument;
  if (top && !docs.includes(top)) docs.unshift(top);
  for (const doc of docs) {
    let sel = null;
    try { sel = doc.getSelection ? doc.getSelection() : (doc.defaultView || window).getSelection(); } catch { sel = null; }
    if (!sel || sel.isCollapsed || !sel.rangeCount) continue;
    // 外面 document 的选区要在阅读页里面才算（别把笔记里选中的字当成书里的）
    if (doc === top && root.contains && !root.contains(sel.anchorNode)) continue;
    const text = selectionText(sel) || String(sel.toString() || '').trim();
    if (text) { let range = null; try { range = sel.getRangeAt(0); } catch { range = null; } return { text, range }; }
  }
  return { text: '', range: null };
}

/** 阅读页里显示书的 foliate-view 元素（身上有 book 和 renderer）。找不到返回 null。 */
function foliateView(root) {
  for (const scope of scopesIn(root)) {
    if (scope.nodeType === 9) continue; // 书里面的 document 不用看
    let all = [];
    try { all = scope.querySelectorAll ? scope.querySelectorAll('*') : []; } catch { all = []; }
    for (const el of all) {
      if (el.book && el.renderer && typeof el.renderer.getContents === 'function') return el;
    }
  }
  return null;
}

module.exports = { scopesIn, createWatcher, selectedText, selection, foliateView, ACTIVITY_EVENTS };
