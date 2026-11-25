'use strict';
// 书里的公式：图片的 alt / MathML 读成 $…$；摘句的分段留着。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MathText = require('../src/mathtext');
const R = require('../src/reader-dom');
const Clips = require('../src/clips');

const T = v => ({ nodeType: 3, nodeValue: v, get textContent() { return v; } });
function E(tag, attrs, ...kids) {
  const childNodes = kids.map(k => (typeof k === 'string' ? T(k) : k));
  return { nodeType: 1, localName: tag, childNodes, getAttribute: k => (attrs && k in attrs ? attrs[k] : null), get textContent() { return childNodes.map(c => c.textContent).join(''); } };
}
const frag = (...kids) => ({ nodeType: 11, childNodes: kids });

test('选中带公式图片的一段：公式写成 $…$，单独一行的写成 $$…$$', () => {
  const body = frag(
    E('p', null, '此外，该表中的 ', E('img', { alt: 'z' }), '\n 的表达式'),
    E('p', { class: '图' }, E('img', { alt: 'z=w_1x_1+w_2x_2+w_3x_3-\\theta\\quad\\quad\\quad(4)' })),
    E('p', null, '称为该神经元的', E('strong', null, '加权输入'), '。'));
  const sel = { rangeCount: 1, isCollapsed: false, anchorNode: null, getRangeAt: () => ({ cloneContents: () => body }), toString: () => '此外，该表中的 \n 的表达式\n称为该神经元的加权输入。' };
  const doc = { nodeType: 9, getSelection: () => sel, querySelectorAll: () => [] };
  const root = { ownerDocument: doc, contains: () => true, querySelectorAll: () => [], shadowRoot: null };
  assert.equal(R.selectedText(root), '此外，该表中的 $z$ 的表达式\n\n$$z=w_1x_1+w_2x_2+w_3x_3-\\theta \\tag{4}$$\n\n称为该神经元的**加权输入**。');

  // 没有公式：和以前一样用选中的文字
  const plain = { ...sel, getRangeAt: () => ({ cloneContents: () => frag(E('p', null, '普通的一句。')) }), toString: () => '普通的一句。' };
  const doc2 = { ...doc, getSelection: () => plain };
  assert.equal(R.selectedText({ ...root, ownerDocument: doc2 }), '普通的一句。');
});

test('摘句整理：每行里合并空白，分段留着', () => {
  assert.equal(Clips.cleanText('  第一段  有  空格\n\n\n$$z=1$$\n\n第三段 '), '第一段 有 空格\n\n$$z=1$$\n\n第三段');
});

test('src/mathtext.js 和共读网站的 web/js/mathtext.js 是同一份', t => {
  const site = path.join(__dirname, '..', '..', 'gongdu', 'web', 'js', 'mathtext.js');
  if (!fs.existsSync(site)) { t.skip('本机没有 gongdu 仓库'); return; }
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'mathtext.js'), 'utf8'), fs.readFileSync(site, 'utf8'));
  assert.equal(typeof MathText.fromNode, 'function');
});
