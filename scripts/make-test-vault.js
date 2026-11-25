#!/usr/bin/env node
'use strict';
// 建一个测试库：三本测试 EPUB（一本有封面、一本没有封面、一本不在书架上）、Qiaomu Reader 的时长/进度/高亮、本插件的设置。
// 用法：node scripts/make-test-vault.js <库的路径> <共读网站地址> <令牌>
// 然后：把 Qiaomu Reader 的 Release（main.js、manifest.json、styles.css）放进 <库>/.obsidian/plugins/qiaomu-reader/，
//       node build.js <库的路径>，再用 scripts/obsidian-e2e.mjs 起 Obsidian。
// 只对着本机的共读服务器用（node scripts/dev-seed.js 的演示数据），不要填线上网站的令牌。
const fs = require('fs'), path = require('path');
const { zip, png } = require('../tests/helpers');
const [V, base, token] = process.argv.slice(2);
if (!V || !base || !token) { console.error('用法：node scripts/make-test-vault.js <库的路径> <共读网站地址> <令牌>'); process.exit(1); }
fs.mkdirSync(path.join(V, 'Books'), { recursive: true });
fs.mkdirSync(path.join(V, '.obsidian/plugins/qiaomu-reader'), { recursive: true });
const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
function book(title, author, cover) {
  const xhtml = t => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh"><head><title>${t}</title></head><body>${t}</body></html>`;
  // 两章，目录有两级（第一部 > 第一章；第二章 > 第一节），还有纸书页码表（page-list），摘句时用来找第几章第几节和页数
  const chapter = xhtml(`<h1>第一章</h1><span id="p12"></span>${'<p>这是测试用的正文。读书是一件慢慢来的事情。</p>'.repeat(40)}`);
  const chapter2 = xhtml(`<h1>第二章</h1><h2 id="s1">第一节</h2>${'<p>第二章的正文。慢慢读，慢慢想。</p>'.repeat(40)}`);
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">第一部</a><ol><li><a href="ch1.xhtml">第一章 媒介即隐喻</a></li></ol></li><li><a href="ch2.xhtml">第二章</a><ol><li><a href="ch2.xhtml#s1">第一节 印刷术</a></li></ol></li></ol></nav><nav epub:type="page-list"><ol><li><a href="ch1.xhtml#p12">12</a></li></ol></nav></body></html>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">test-${encodeURIComponent(title)}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-11-18T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>${cover ? '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' : ''}</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`;
  const files = [['mimetype', 'application/epub+zip', false], ['META-INF/container.xml', CONTAINER], ['OEBPS/content.opf', opf], ['OEBPS/nav.xhtml', nav], ['OEBPS/ch1.xhtml', chapter], ['OEBPS/ch2.xhtml', chapter2]];
  if (cover) files.push(['OEBPS/images/cover.png', png(300, 450, cover), false]);
  return zip(files);
}
const books = {
  'Books/娱乐至死 (尼尔·波兹曼) (Z-Library).epub': book('娱乐至死', '尼尔·波兹曼', [150, 40, 40]),
  'Books/乡土中国.epub': book('乡土中国', '费孝通', null),
  'Books/额尔古纳河右岸.epub': book('额尔古纳河右岸', '迟子建', [40, 90, 120]),
};
for (const [p, b] of Object.entries(books)) fs.writeFileSync(path.join(V, p), b);
const now = Date.now(); const d = new Date(now); const pad = n => String(n).padStart(2, '0');
const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const main = 'Books/娱乐至死 (尼尔·波兹曼) (Z-Library).epub';
fs.writeFileSync(path.join(V, '.obsidian/plugins/qiaomu-reader/data.json'), JSON.stringify({ settings: { readingLog: { [day]: 1830 }, lifetimeSeconds: 1830 } }));
fs.writeFileSync(path.join(V, 'reading-progress.json'), JSON.stringify({ [main]: { pct: 0.42, percent: 42, lastRead: now - 60000 } }, null, 2));
fs.writeFileSync(path.join(V, 'reading-highlights.json'), JSON.stringify({ [main]: [
  { id: 'h1', color: 'yellow', text: '我们的政治、宗教、新闻、体育、教育和商业都心甘情愿地成为娱乐的附庸。', created: now - 120000 },
  { id: 'h2', color: 'yellow', text: '有两种方法可以让文化精神枯萎。', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', created: now - 90000 }, // 第二章
] }, null, 2));
fs.mkdirSync(path.join(V, '.obsidian/plugins/gongdu'), { recursive: true });
fs.writeFileSync(path.join(V, '.obsidian/plugins/gongdu/data.json'), JSON.stringify({ base, token, autoCover: true }));
fs.writeFileSync(path.join(V, '.obsidian/community-plugins.json'), JSON.stringify(['qiaomu-reader', 'gongdu']));
fs.writeFileSync(path.join(V, '欢迎.md'), '# 测试库\n');
console.log('vault ready, day', day);
