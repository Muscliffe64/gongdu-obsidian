'use strict';
// 从电子书里选中或复制一段，变成 Markdown 文字：公式写成 $…$（行内）或 $$…$$（单独一行）。
// 很多电子书（比如《深度学习的数学》）的公式是图片，图片的 alt 里是 LaTeX；有的是 MathML，里面带 LaTeX 注释。
// 直接取选中的文字会把这些图片丢掉，所以要自己从网页节点里一个个读出来。
// 共读网站（粘贴）和 Obsidian 插件（选中）共用同一份：插件仓库里的 src/mathtext.js 是这个文件的拷贝。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MathText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'blockquote', 'figure', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'pre', 'hr', 'body', 'html']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'rt', 'rp']);
  const CELL = new Set(['td', 'th']);

  const tagOf = n => String(n.localName || n.nodeName || '').toLowerCase().replace(/^.*:/, '');
  const attr = (n, k) => (n.getAttribute ? n.getAttribute(k) : null);
  const kids = n => Array.from(n.childNodes || []);

  /** alt 里的 LaTeX 整理一下：去掉前后空白；结尾的“\quad\quad(4)”这种式子编号变成 \tag{4}（单独一行时）或者去掉。 */
  function cleanTex(raw, display) {
    let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    t = t.replace(/^\$+|\$+$/g, '').trim();
    const m = /(?:\s|\\quad|\\qquad|\\,|\\;|\\ |~)*\(\s*(\d{1,3}(?:[.\-－]\d{1,3})?)\s*\)\s*$/.exec(t);
    if (m && m.index > 0 && /\\quad|\\qquad/.test(m[0])) {
      t = t.slice(0, m.index).trim() + (display ? ` \\tag{${m[1]}}` : '');
    }
    return t.replace(/(?:\s|\\quad|\\qquad)+$/, '').trim();
  }

  /** 看起来像公式的 alt：有反斜杠命令、上下标、等号这类，或者就是一两个字母。普通插图的 alt（“图 1-2”）不算。 */
  function looksLikeTex(alt) {
    const a = String(alt || '').trim();
    if (!a) return false;
    if (/[一-鿿]/.test(a) && !/\\[a-zA-Z]/.test(a)) return false;
    return /\\[a-zA-Z]+|[_^{}=<>+\-]|^[A-Za-z0-9]{1,3}$/.test(a) || /^[A-Za-z]('|′)?$/.test(a);
  }

  /** 一个节点里的公式：图片的 alt、MathML 里的 LaTeX 注释。不是公式返回 null。 */
  function texOf(n) {
    const tag = tagOf(n);
    if (tag === 'img') {
      const alt = attr(n, 'alt');
      return looksLikeTex(alt) ? alt : null;
    }
    if (tag === 'math') {
      const find = node => {
        for (const c of kids(node)) {
          if (c.nodeType !== 1) continue;
          if (tagOf(c) === 'annotation' && /tex/i.test(attr(c, 'encoding') || '')) return c.textContent;
          const r = find(c);
          if (r != null) return r;
        }
        return null;
      };
      const tex = find(n);
      if (tex != null) return tex;
      return attr(n, 'alttext') || null;
    }
    return null;
  }

  const isDisplayMath = n => tagOf(n) === 'math' && (attr(n, 'display') === 'block' || attr(n, 'mode') === 'display');

  /** 这个块里只有一个公式（前后没有别的字）：当成单独一行的公式。 */
  function soleMath(block) {
    let found = null;
    const visit = node => {
      for (const c of kids(node)) {
        if (c.nodeType === 3) { if (String(c.nodeValue || '').trim()) return false; continue; }
        if (c.nodeType !== 1) continue;
        if (SKIP.has(tagOf(c))) continue;
        if (texOf(c) != null) { if (found) return false; found = c; continue; }
        if (tagOf(c) === 'img') continue; // 不是公式的图（插图）不影响
        if (visit(c) === false) return false;
      }
      return true;
    };
    return visit(block) !== false ? found : null;
  }

  /** 普通文字里的 $ 写成 \$，不然会被当成公式。 */
  const escapeText = s => s.replace(/\$/g, '\\$');

  /**
   * 节点（选区的 cloneContents()、粘贴来的 HTML 的 body）→ Markdown 文字。
   * 段落之间空一行，公式写成 $…$ / $$…$$，<strong> 写成 **…**。没有公式时和原来的文字差不多。
   */
  function fromNode(rootNode) {
    const blocks = [];
    let cur = '';
    const flush = () => {
      const t = cur.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
      if (t) blocks.push(t);
      cur = '';
    };
    const display = tex => { flush(); const t = cleanTex(tex, true); if (t) blocks.push(`$$${t}$$`); };
    const walk = node => {
      for (const c of kids(node)) {
        if (c.nodeType === 3) { cur += escapeText(String(c.nodeValue || '').replace(/\s+/g, ' ')); continue; }
        if (c.nodeType !== 1 && c.nodeType !== 11) continue;
        const tag = tagOf(c);
        if (SKIP.has(tag)) continue;
        const tex = c.nodeType === 1 ? texOf(c) : null;
        if (tex != null) {
          if (isDisplayMath(c)) display(tex);
          else { const t = cleanTex(tex, false); if (t) cur += `$${t}$`; }
          continue;
        }
        if (tag === 'img') continue;
        if (tag === 'br') { cur += '\n'; continue; }
        if (CELL.has(tag)) { cur += ' '; walk(c); cur += ' '; continue; }
        if (BLOCK.has(tag)) {
          flush();
          const sole = tag !== 'ul' && tag !== 'ol' && tag !== 'table' ? soleMath(c) : null;
          if (sole) { display(texOf(sole)); continue; }
          if (tag === 'li') cur += '- ';
          walk(c);
          flush();
          continue;
        }
        if (tag === 'strong' || tag === 'b') {
          const before = cur; cur = '';
          walk(c);
          const inner = cur.trim();
          cur = before + (inner && !inner.includes('\n') && !inner.includes('**') ? `**${inner}**` : cur);
          continue;
        }
        walk(c);
      }
    };
    walk(rootNode);
    flush();
    return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 这段 HTML 里有没有公式（图片 alt 像 LaTeX、或者 MathML）。没有就不用改写，照普通粘贴。 */
  function hasMath(rootNode) {
    const visit = node => {
      for (const c of kids(node)) {
        if (c.nodeType !== 1 && c.nodeType !== 11) continue;
        if (c.nodeType === 1 && texOf(c) != null) return true;
        if (visit(c)) return true;
      }
      return false;
    };
    return visit(rootNode);
  }

  return { fromNode, hasMath, cleanTex, looksLikeTex };
});
