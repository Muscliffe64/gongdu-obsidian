'use strict';
// 不需要 Obsidian 的部分：对书、读阅读器的数据、拆 EPUB、认出阅读器自己画的文字封面。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { titleKey, titlesFromPath, matchBook } = require('../src/match');
const Q = require('../src/qiaomu');
const { readEpub } = require('../src/epub');
const { isGeneratedCover, PAPERS } = require('../src/generated-cover');
const { epub, png, zip } = require('./helpers');

test('书名的比法和网站一样', () => {
  assert.equal(titleKey('《乡土中国》'), titleKey('乡土 中国'));
  assert.equal(titleKey('Sapiens: A Brief History'), titleKey('sapiens a brief history'));
});

test('从文件名猜书名：去掉文件夹、扩展名、括号里的作者和下载站', () => {
  assert.deepEqual(titlesFromPath('Books/乡土中国 (费孝通) (Z-Library).epub'), ['乡土中国']);
  assert.deepEqual(titlesFromPath('读书/【精校】活着（余华）.azw3'), ['活着']);
  assert.deepEqual(titlesFromPath('余华 - 活着.epub'), ['余华 - 活着', '余华', '活着']);
  assert.deepEqual(titlesFromPath('《沉思录》.pdf'), ['沉思录']);
});

test('对书：先用确认过的，再按书名对，宽一点的只在唯一时才算', () => {
  const books = [{ id: 1, title: '乡土中国', status: 'reading' }, { id: 2, title: '活着', status: 'reading' }, { id: 3, title: '平凡的世界', status: 'finished' }, { id: 4, title: '活着为了讲述', status: 'paused' }];
  assert.equal(matchBook({ path: 'a.epub', titles: ['乡土中国'] }, books).book.id, 1);
  assert.equal(matchBook({ path: 'a.epub', titles: ['《活着》'] }, books).book.id, 2);
  assert.equal(matchBook({ path: 'a.epub', titles: ['乡土中国（修订本）'] }, books).book.id, 1, '包含关系，且只对上一本');
  assert.equal(matchBook({ path: 'a.epub', titles: ['平凡的世界'] }, books).book, null, '读完的书不算');
  assert.equal(matchBook({ path: 'a.epub', titles: ['活'] }, books).book, null);
  const none = matchBook({ path: 'a.epub', titles: ['额尔古纳河右岸', '额尔古纳河右岸 迟子建'] }, books);
  assert.equal(none.book, null);
  assert.equal(none.title, '额尔古纳河右岸');
  assert.equal(matchBook({ path: 'x.epub', titles: ['别的书名'] }, books, { 'x.epub': 2 }).book.id, 2, '打卡时确认过的优先');
});

test('阅读器的数据：数据文件夹、今天的时长、进度、今天的高亮', () => {
  assert.equal(Q.progressPath({}), 'reading-progress.json');
  assert.equal(Q.progressPath({ booksFolder: 'Books/' }), 'Books/reading-progress.json', '没设数据文件夹就跟着书的文件夹');
  assert.equal(Q.highlightsPath({ dataFolder: '/读书数据', booksFolder: 'Books' }), '读书数据/reading-highlights.json');

  const today = Date.parse('2026-11-18T10:00:00');
  const day = Q.dayOf(today);
  assert.equal(day, '2026-11-18');
  assert.equal(Q.secondsOn({ readingLog: { [day]: 1830 } }, day), 1830);
  assert.equal(Q.secondsOn({ readingLog: {} }, day), 0);

  const progress = { 'a.epub': { pct: 0.4237, percent: 42, lastRead: today - 5000 }, 'b.epub': { percent: 10, lastRead: today } };
  assert.deepEqual(Q.latestBook(progress), { path: 'b.epub', lastRead: today, percent: 10 });
  assert.equal(Q.percentOf(progress, 'a.epub'), 42.4, '用更准的 pct');

  const highlights = { 'a.epub': [
    { id: 'h1', text: '昨天的', created: today - 86400000 },
    { id: 'h2', text: '  乡土社会是\n安土重迁的。 ', created: today - 1000 },
    { id: 'h3', text: '乡土社会是 安土重迁的。', created: today },
    { id: 'h4', text: '', created: today },
  ] };
  assert.deepEqual(Q.highlightsOn(highlights, 'a.epub', day).map(h => h.text), ['乡土社会是 安土重迁的。']);
  assert.equal(Q.isBookPath('x/书.EPUB'), true);
  assert.equal(Q.isBookPath('笔记.md'), false);
});

test('今天读了几分钟：这本书已经记的保留，加上阅读器里还没记到任何书上的', () => {
  assert.deepEqual(Q.suggestMinutes(31, [], 4), { value: '31', others: 0, mine: 0 });
  assert.equal(Q.suggestMinutes(50, [{ book_id: 4, minutes: 35 }], 14).value, '15', '别的书记了 35，剩 15');
  assert.equal(Q.suggestMinutes(31, [{ book_id: 4, minutes: 35 }], 14).value, '', '阅读器的时间都记在别的书上了，让学生自己填');
  assert.equal(Q.suggestMinutes(31, [{ book_id: 4, minutes: 35 }], 4).value, '35', '同一本书再交，不会比已经记的少（再交是覆盖）');
  assert.equal(Q.suggestMinutes(90, [{ book_id: 15, minutes: 20 }, { book_id: 4, minutes: 35 }], 4).value, '70', '35 + 还没记的 35');
  assert.equal(Q.suggestMinutes(0, [{ book_id: 4, minutes: 35 }], 4).value, '35', '阅读器没计时，沿用网站上记的');
  assert.equal(Q.suggestMinutes(0, [], null).value, '');
});

test('封面缓存的文件名和 Qiaomu Reader 算的一样', async () => {
  const file = { path: 'Books/乡土中国.epub', stat: { mtime: 1763000000000, size: 123456 } };
  const expected = crypto.createHash('sha256').update(JSON.stringify([file.path, file.stat.mtime, file.stat.size])).digest('hex') + '.jpg';
  assert.equal(await Q.thumbName(file, crypto.webcrypto.subtle), expected);
});

test('EPUB 3：properties="cover-image"', async () => {
  const img = png(300, 450);
  const book = epub({ opfBody: '<manifest><item id="c" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest>', extra: [['OEBPS/images/cover.png', img, false]] });
  const out = await readEpub(book);
  assert.equal(out.title, '乡土中国');
  assert.equal(out.author, '费孝通');
  assert.equal(out.cover.name, 'OEBPS/images/cover.png');
  assert.deepEqual(Buffer.from(out.cover.bytes), img);
});

test('EPUB 2：<meta name="cover">，图片是压缩过的', async () => {
  const img = png(200, 300, [1, 2, 3]);
  const book = epub({
    title: 'Meditations &amp; Notes',
    opfBody: '<metadata><meta name="cover" content="cover-img"/></metadata><manifest><item id="cover-img" href="Images/%E5%B0%81%E9%9D%A2.png" media-type="image/png"/></manifest>',
    extra: [['OEBPS/Images/封面.png', img]],
  });
  const out = await readEpub(book);
  assert.equal(out.title, 'Meditations & Notes');
  assert.deepEqual(Buffer.from(out.cover.bytes), img);
});

test('只有 <guide> 里的封面页：取页里的第一张图（含 ../ 路径）', async () => {
  const img = png(240, 360);
  const book = epub({
    opfBody: '<manifest><item id="p" href="Text/cover.xhtml" media-type="application/xhtml+xml"/></manifest><guide><reference type="cover" href="Text/cover.xhtml#top" title="封面"/></guide>',
    extra: [['OEBPS/Text/cover.xhtml', '<html><body><svg><image xlink:href="../Images/c.png"/></svg></body></html>'], ['OEBPS/Images/c.png', img]],
  });
  assert.deepEqual(Buffer.from((await readEpub(book)).cover.bytes), img);
});

test('没有封面的 EPUB、坏文件：不抛错', async () => {
  const out = await readEpub(epub({ opfBody: '<manifest><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest>' }));
  assert.equal(out.title, '乡土中国');
  assert.equal(out.cover, null);
  assert.equal(await readEpub(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(await readEpub(zip([['a.txt', 'hello']])), null);
});

/** 画一张像 Qiaomu Reader 文字封面的图：纸色底，左边写字，右下角圆圈。 */
function fakeGenerated(w, h, paper, ink = [38, 63, 56]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = paper;
      const text = x > 0.1 * w && x < 0.8 * w && ((y > 0.18 * h && y < 0.45 * h && (x + y) % 7 < 3) || (y > 0.7 * h && y < 0.76 * h && x < 0.5 * w));
      const r = Math.hypot(x - 0.79 * w, y - 0.97 * h);
      if (text || Math.abs(r - 0.24 * w) < 1) c = ink;
      // JPEG 的小偏差
      px[i] = c[0] + ((x * 7 + y) % 5) - 2; px[i + 1] = c[1] + ((x + y * 3) % 5) - 2; px[i + 2] = c[2] + ((x * y) % 5) - 2; px[i + 3] = 255;
    }
  }
  return px;
}

test('认得出 Qiaomu Reader 自己画的文字封面，真封面不会被认错', () => {
  for (const paper of PAPERS) assert.equal(isGeneratedCover(fakeGenerated(240, 360, paper), 240, 360), true);
  // 真封面：有图有颜色
  const real = new Uint8ClampedArray(240 * 360 * 4);
  for (let i = 0; i < real.length; i += 4) { real[i] = (i / 4) % 240; real[i + 1] = 120; real[i + 2] = Math.floor(i / 4 / 240) % 256; real[i + 3] = 255; }
  assert.equal(isGeneratedCover(real, 240, 360), false);
  // 白底的真封面（白色不是它的纸色）
  assert.equal(isGeneratedCover(fakeGenerated(240, 360, [250, 250, 250]), 240, 360), false);
  // 形状不对
  assert.equal(isGeneratedCover(fakeGenerated(300, 300, PAPERS[0]), 300, 300), false);
});
