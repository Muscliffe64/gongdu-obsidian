'use strict';
// 自动同步封面的规则，对着本机起的共读服务器（../gongdu，要有封面图接口的版本）跑。
// 没有 ../gongdu 就跳过这些测试。GONGDU_DIR 可以指定别的位置。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApi } = require('../src/api');
const { CoverSync } = require('../src/cover-sync');
const { png } = require('./helpers');

const GONGDU = process.env.GONGDU_DIR || path.join(__dirname, '..', '..', 'gongdu');
const hasServer = fs.existsSync(path.join(GONGDU, 'server', 'covers.js'));
const skip = hasServer ? false : `没有找到共读服务器（${GONGDU}），跳过`;

const fetchRequest = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

/** 起一个共读服务器（内存数据库），加一个学生、一本书、一个令牌。 */
async function world(t, { clock } = {}) {
  const { openDb } = require(path.join(GONGDU, 'server/db'));
  const { loadConfig } = require(path.join(GONGDU, 'server/config'));
  const { createApp } = require(path.join(GONGDU, 'server/server'));
  const { ensureClass } = require(path.join(GONGDU, 'server/users'));
  const auth = require(path.join(GONGDU, 'server/auth'));
  const reading = require(path.join(GONGDU, 'server/reading'));
  const db = openDb(':memory:');
  ensureClass(db, 'class-a', '甲班');
  const cls = db.prepare("SELECT id FROM classes WHERE code = 'class-a'").get();
  const ts = new Date().toISOString();
  const uid = Number(db.prepare(`INSERT INTO users (login, name, role, class_id, password_hash, password_set_at, created_at) VALUES ('2099000001', '张三', 'student', ?, ?, ?, ?)`)
    .run(cls.id, auth.hashPassword('secret123'), ts, ts).lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const book = reading.createBook(db, uid, { title: '乡土中国', format: 'ebook' }, '2026-11-18');
  const server = http.createServer(createApp({ db, config: { ...loadConfig({}) }, now: clock || (() => new Date()) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 令牌：直接登录拿
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: '2099000001', password: 'secret123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const token = (await (await fetch(base + '/api/agent-token', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).json()).token;
  return { db, base, token, book, user, cookie, api: createApi({ base, token, request: fetchRequest }) };
}

/** 一个 CoverSync，找封面、书名、记录都是假的，提示收集起来。 */
function syncer(api, { titles = ['乡土中国'], cover = () => ({ mime: 'image/png', data: png(240, 360).toString('base64') }), now } = {}) {
  const memo = new Map();
  const notes = [];
  let found = 0;
  const s = new CoverSync({
    api,
    titlesOf: async () => titles,
    findCover: async () => { found++; return cover(); },
    memo: { get: id => memo.get(id), set: (id, r) => memo.set(id, r) },
    hint: t => notes.push(['hint', t]),
    warn: t => notes.push(['warn', t]),
    now: now || (() => Date.now()),
    statusTtl: 0,
  });
  return { s, memo, notes, found: () => found };
}

const file = (p = 'Books/乡土中国 (费孝通).epub', mtime = 1000, size = 5000) => ({ path: p, extension: 'epub', stat: { mtime, size } });

test('网站上还没有封面图：打开书就传上去；再打开不重复传', { skip }, async t => {
  const w = await world(t);
  const { s, notes, found } = syncer(w.api);
  assert.equal(await s.sync(file()), 'set');
  const status = await w.api.status();
  assert.match(status.books[0].cover_url, /^\/api\/books\/\d+\/cover\?v=/);
  assert.equal(await s.sync(file()), 'has-cover');
  assert.equal(found(), 1, '第二次不用再找封面');
  assert.deepEqual(notes, [], '成功时不出声');
});

test('网站上已经有封面图：不换', { skip }, async t => {
  const w = await world(t);
  await w.api.uploadCover(w.book.id, { mime: 'image/png', data: png(240, 360, [9, 9, 9]).toString('base64') });
  const before = (await w.api.status()).books[0].cover_url;
  const { s, found } = syncer(w.api);
  assert.equal(await s.sync(file()), 'has-cover');
  assert.equal(found(), 0);
  assert.equal((await w.api.status()).books[0].cover_url, before);
});

test('书还不在共读书架上：不传，状态栏提示', { skip }, async t => {
  const w = await world(t);
  const { s, notes, found } = syncer(w.api, { titles: ['额尔古纳河右岸'] });
  assert.equal(await s.sync(file('Books/额尔古纳河右岸.epub')), 'not-on-shelf');
  assert.equal(found(), 0);
  assert.deepEqual(notes, [['hint', '《额尔古纳河右岸》还不在共读书架上，打卡时会加上']]);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM book_covers').get().n, 0);
});

test('找不到封面：不出声，一天内不再找；换了文件马上再试', { skip }, async t => {
  const w = await world(t);
  let t0 = Date.parse('2026-11-18T10:00:00+08:00');
  let cover = null;
  const { s, notes, found } = syncer(w.api, { cover: () => cover, now: () => t0 });
  assert.equal(await s.sync(file()), 'none');
  assert.equal(await s.sync(file()), 'skip');
  assert.equal(found(), 1);
  assert.deepEqual(notes, []);
  cover = { mime: 'image/png', data: png(240, 360).toString('base64') };
  assert.equal(await s.sync(file('Books/乡土中国 (费孝通).epub', 2000)), 'set', '文件换了（mtime 变了）');
  assert.equal(found(), 2);
});

test('图片不收（形状不像封面）：状态栏说一句，这个文件不再试', { skip }, async t => {
  const w = await world(t);
  const { s, notes, found } = syncer(w.api, { cover: () => ({ mime: 'image/png', data: png(600, 200).toString('base64') }) });
  assert.equal(await s.sync(file()), 'rejected');
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], 'warn');
  assert.match(notes[0][1], /《乡土中国》的封面没传上：这张图的形状不像书的封面/);
  assert.equal(await s.sync(file()), 'skip');
  assert.equal(found(), 1);
});

test('去掉过封面图的书：不再自动传', { skip }, async t => {
  const w = await world(t);
  await w.api.uploadCover(w.book.id, { mime: 'image/png', data: png(240, 360).toString('base64') });
  await fetch(`${w.base}/api/books/${w.book.id}/cover/remove`, { method: 'POST', headers: { Cookie: w.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  const { s, found } = syncer(w.api);
  assert.equal(await s.sync(file()), 'removed');
  assert.equal(found(), 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM book_covers').get().n, 0);
});

test('打卡窗口里勾选换封面：带 replace 换掉现在的', { skip }, async t => {
  const w = await world(t);
  await w.api.uploadCover(w.book.id, { mime: 'image/png', data: png(240, 360, [9, 9, 9]).toString('base64') });
  const before = (await w.api.status()).books[0].cover_url;
  const { s } = syncer(w.api);
  const out = await s.replace(file(), w.book.id);
  assert.equal(out.status, 'replaced');
  assert.notEqual((await w.api.status()).books[0].cover_url, before);
});

test('令牌失效、连不上：状态栏说一句，不弹窗', { skip }, async t => {
  const w = await world(t);
  const bad = syncer(createApi({ base: w.base, token: 'gd_wrong', request: fetchRequest }));
  assert.equal(await bad.s.sync(file()), 'bad-token');
  assert.deepEqual(bad.notes, [['warn', '共读令牌失效了，请到网站“我的”页面重新生成']]);
  const off = syncer(createApi({ base: 'http://127.0.0.1:9', token: w.token, request: fetchRequest }));
  assert.equal(await off.s.sync(file()), 'error');
  assert.match(off.notes[0][1], /没连上共读网站/);
  const none = syncer(createApi({ base: w.base, token: '', request: fetchRequest }));
  assert.equal(await none.s.sync(file()), 'no-token');
  assert.deepEqual(none.notes, [], '没填令牌就什么也不做');
});

test('同一本书同时打开两次，只传一次', { skip }, async t => {
  const w = await world(t);
  const { s, found } = syncer(w.api);
  const [a, b] = await Promise.all([s.sync(file()), s.sync(file())]);
  assert.equal(a, 'set');
  assert.equal(b, 'set');
  assert.equal(found(), 1);
});

test('插件打卡：按书名加的新书，打完马上能传封面', { skip }, async t => {
  const w = await world(t);
  const out = await w.api.checkin({ book_title: '额尔古纳河右岸', format: 'ebook', minutes: 30, percent: 12, excerpts: [{ text: '我是雨和雪的老熟人了。', thought: '开头就好。' }] });
  assert.equal(out.ok, true);
  assert.ok(out.book_id);
  const { s } = syncer(w.api, { titles: ['额尔古纳河右岸'] });
  assert.equal(await s.sync(file('Books/额尔古纳河右岸.epub'), { force: true }), 'set');
});

test('摘了 25 句：只交前 20 句，网站存下的才从本机去掉，其余 5 句留着', { skip }, async t => {
  const Clips = require('../src/clips');
  const w = await world(t);
  const clips = [];
  for (let i = 1; i <= 25; i++) Clips.add(clips, { text: `第 ${i} 句：读书是一件慢慢来的事情。`, book: 'Books/乡土中国.epub', day: 'd', now: i });
  // 一句以前已经交过（网站上有），一句太短会被网站跳过：都在前 20 句里
  clips[0].text = '人是为活着本身而活着的。';
  await w.api.checkin({ book_id: w.book.id, minutes: 10, percent: 5, excerpts: [{ text: clips[0].text }] });
  const { send, held } = Clips.planSend(Clips.forBook(clips, 'd', 'Books/乡土中国.epub'));
  assert.equal(send.length, 20);
  assert.equal(held.length, 5);
  const out = await w.api.checkin({ book_id: w.book.id, minutes: 20, percent: 8, excerpts: send.map(c => ({ text: c.text })) });
  const saved = Clips.acceptedIds(send, out.excerpts);
  assert.equal(saved.length, 20, '前 20 句都存下了（交过的那句也算）');
  const left = Clips.remove(clips, saved);
  assert.deepEqual(left.map(c => c.id), held.map(c => c.id), '没交的 5 句留在本机');
  assert.equal(out.excerpts.length, 20);

  // 网站只收前 20 句：一次交 25 句时，后 5 句不会被当成交上去
  const more = [];
  for (let i = 1; i <= 25; i++) Clips.add(more, { text: `另一批第 ${i} 句，慢慢读。`, book: 'b', day: 'd', now: i });
  const out2 = await w.api.checkin({ book_id: w.book.id, minutes: 20, percent: 8, excerpts: more.map(c => ({ text: c.text })) });
  const saved2 = Clips.acceptedIds(more, out2.excerpts);
  assert.equal(saved2.length, 20);
  assert.deepEqual(Clips.remove(more, saved2).map(c => c.text), more.slice(20).map(c => c.text));
});
