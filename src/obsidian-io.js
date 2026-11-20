'use strict';
// 用 Obsidian 的接口读 Qiaomu Reader 的数据、找封面、把封面缩成 JPEG。
// 只读，不写 Qiaomu Reader 的任何文件。
const { TFile, requestUrl, arrayBufferToBase64 } = require('obsidian');
const Q = require('./qiaomu');
const { readEpub } = require('./epub');
const { titlesFromPath } = require('./match');
const { isGeneratedCover } = require('./generated-cover');

const MAX_W = 480;
const MAX_H = 720;
const MAX_BYTES = 280 * 1024;    // 网站最多收 300 KB
const MAX_REMOTE = 5 * 1024 * 1024;

async function readJson(app, path) {
  try {
    if (!path || !(await app.vault.adapter.exists(path))) return null;
    const v = JSON.parse(await app.vault.adapter.read(path));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

const plainObject = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Qiaomu Reader 现在的数据。插件开着就读它内存里的（最新），读不到再读文件。 */
async function readQiaomu(app) {
  const qm = app.plugins && app.plugins.plugins && app.plugins.plugins[Q.PLUGIN_ID];
  const dir = (qm && qm.manifest && qm.manifest.dir) || `${app.vault.configDir}/plugins/${Q.PLUGIN_ID}`;
  let settings = qm && plainObject(qm.settings);
  let lastBookPath = qm && typeof qm._lastBookPath === 'string' ? qm._lastBookPath : '';
  if (!settings) {
    const data = await readJson(app, `${dir}/data.json`);
    settings = (data && plainObject(data.settings)) || null;
    lastBookPath = lastBookPath || (data && data.lastBookPath) || '';
  }
  const installed = !!qm || !!settings;
  settings = settings || {};
  const progress = (qm && plainObject(qm.progress)) || (await readJson(app, Q.progressPath(settings))) || {};
  const highlights = (qm && plainObject(qm.highlights)) || (await readJson(app, Q.highlightsPath(settings))) || {};
  return { installed, dir, settings, progress, highlights, lastBookPath };
}

/** 把图片缩到 480×720 以内，白底，转成 JPEG。checkGenerated：先看是不是 Qiaomu 自己画的文字封面。 */
async function toJpeg(bytes, { checkGenerated = false } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes])); } catch { return null; }
  try {
    const w = bitmap.width, h = bitmap.height;
    if (!w || !h || h / w < 0.6 || h / w > 2.5 || Math.min(w, h) < 60) return null;
    if (checkGenerated) {
      const probe = document.createElement('canvas');
      probe.width = w; probe.height = h;
      const pc = probe.getContext('2d', { willReadFrequently: true });
      pc.drawImage(bitmap, 0, 0);
      const generated = isGeneratedCover(pc.getImageData(0, 0, w, h).data, w, h);
      probe.width = probe.height = 0;
      if (generated) return null;
    }
    let scale = Math.min(1, MAX_W / w, MAX_H / h);
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = attempt < 3 ? [0.86, 0.76, 0.66][attempt] : 0.66;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      canvas.width = canvas.height = 0;
      if (blob && blob.size <= MAX_BYTES) return { mime: 'image/jpeg', data: arrayBufferToBase64(await blob.arrayBuffer()) };
      if (attempt >= 2) scale *= 0.8;
    }
    return null;
  } finally { bitmap.close && bitmap.close(); }
}

function createCoverFinder(app, { subtle = globalThis.crypto && globalThis.crypto.subtle } = {}) {
  const epubs = new Map(); // 路径 → { sig, promise }

  function epubOf(file) {
    if (file.extension !== 'epub') return Promise.resolve(null);
    const sig = `${file.stat.mtime}|${file.stat.size}`;
    const hit = epubs.get(file.path);
    if (hit && hit.sig === sig) return hit.promise;
    const promise = app.vault.readBinary(file).then(buf => readEpub(new Uint8Array(buf))).catch(() => null);
    epubs.set(file.path, { sig, promise });
    if (epubs.size > 20) epubs.delete(epubs.keys().next().value);
    return promise;
  }

  /** 候选书名：书里写的书名在前，然后是文件名猜的。 */
  async function titlesOf(file) {
    const epub = await epubOf(file);
    const out = [];
    if (epub && epub.title) out.push(epub.title);
    for (const t of titlesFromPath(file.path)) if (!out.includes(t)) out.push(t);
    return out;
  }

  /** 书的笔记里写的封面（cover: 图片链接或网址）。Qiaomu Reader 也是先用这个。 */
  async function noteCover(file, qiaomu) {
    const name = Q.bookNoteFor(qiaomu.settings, file.path);
    if (!name) return null;
    const notePath = name.endsWith('.md') ? name : `${name}.md`;
    let note = app.vault.getAbstractFileByPath(Q.normPath(notePath));
    if (!(note instanceof TFile)) {
      const same = app.vault.getMarkdownFiles().filter(f => f.basename === name);
      note = same.length === 1 ? same[0] : null;
    }
    if (!note) return null;
    const fm = (app.metadataCache.getFileCache(note) || {}).frontmatter || {};
    const raw = fm.cover !== undefined ? fm.cover : fm.Cover;
    const val = String(Array.isArray(raw) ? raw[0] : raw || '').trim();
    if (!val) return null;
    if (/^https?:\/\//i.test(val)) {
      const res = await requestUrl({ url: val, throw: false });
      return res.status === 200 && res.arrayBuffer.byteLength <= MAX_REMOTE ? new Uint8Array(res.arrayBuffer) : null;
    }
    const inner = ((val.match(/^!?\[\[([^\]|#]+)/) || [])[1] || val).trim();
    const img = app.metadataCache.getFirstLinkpathDest(inner, note.path) || app.vault.getAbstractFileByPath(Q.normPath(inner));
    return img instanceof TFile ? new Uint8Array(await app.vault.readBinary(img)) : null;
  }

  /** Qiaomu Reader 的封面缓存（它在书库里显示过这本书才有）。 */
  async function cachedCover(file, qiaomu) {
    if (!subtle) return null;
    const path = `${qiaomu.dir}/thumbnails-v3/${await Q.thumbName(file, subtle)}`;
    if (!(await app.vault.adapter.exists(path))) return null;
    return new Uint8Array(await app.vault.adapter.readBinary(path));
  }

  /** 找封面：书的笔记 → 书里自带的（EPUB）→ Qiaomu Reader 的缓存（跳过它自己画的文字封面）。都没有返回 null。 */
  async function findCover(file) {
    const qiaomu = await readQiaomu(app);
    const fromNote = await noteCover(file, qiaomu).catch(() => null);
    if (fromNote) { const out = await toJpeg(fromNote); if (out) return { ...out, source: 'note' }; }
    const epub = await epubOf(file);
    if (epub && epub.cover) { const out = await toJpeg(epub.cover.bytes); if (out) return { ...out, source: 'epub' }; }
    const cached = await cachedCover(file, qiaomu).catch(() => null);
    if (cached) { const out = await toJpeg(cached, { checkGenerated: true }); if (out) return { ...out, source: 'qiaomu-cache' }; }
    return null;
  }

  return { titlesOf, findCover, epubOf };
}

module.exports = { readQiaomu, createCoverFinder, toJpeg };
