'use strict';
// 从 EPUB 文件里取出书名、作者和封面图。不用第三方库：自己读 zip 目录，压缩的部分用平台自带的 DecompressionStream 解开。
// 找封面的顺序和常见阅读器一样：
// 1. OPF 里 properties 带 cover-image 的条目（EPUB 3）
// 2. <meta name="cover" content="条目 id"> 指向的条目（EPUB 2）
// 3. <guide> 里 type="cover" 的页面里的第一张图
// 4. id 或文件名里带 cover 的图片条目

const MAX_ENTRY = 20 * 1024 * 1024;

/** 读 zip 的中央目录：{ 文件名: { offset, method, csize, size } }。不是 zip 就抛错。 */
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not-a-zip');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out[name] = { offset, method, csize, size };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 取出 zip 里的一个文件。没有这个文件返回 null。 */
async function zipRead(bytes, entries, name) {
  const e = entries[name];
  if (!e) return null;
  if (e.size > MAX_ENTRY || e.csize > MAX_ENTRY) throw new Error('entry-too-large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(e.offset, true) !== 0x04034b50) throw new Error('bad-local-header');
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRaw(raw);
  throw new Error('unsupported-compression');
}

const decodeXml = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

/** 一个标签里的属性：{ 名字（小写，去掉前缀）: 值 }。 */
function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase().replace(/^.*:/, '')] = decodeXml(m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

const tagsOf = (xml, name) => [...String(xml).matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, 'gi'))].map(m => attrsOf(m[0]));
const textOf = (xml, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(String(xml));
  return m ? decodeXml(m[1]) : '';
};

/** 相对路径拼到某个文件所在的文件夹上，处理 ./ 和 ../，去掉 #片段。 */
function resolve(fromFile, href) {
  let h = String(href || '').split('#')[0];
  try { h = decodeURIComponent(h); } catch { /* 保持原样 */ }
  if (!h) return '';
  const parts = (h.startsWith('/') ? [] : fromFile.split('/').slice(0, -1));
  for (const seg of h.replace(/^\//, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const isImageItem = it => /^image\/(jpeg|png|gif|webp)$/i.test(it['media-type'] || '') || (!it['media-type'] && IMAGE_EXT.test(it.href || ''));

/** 从 OPF 里找封面图在 zip 里的路径。找不到返回 { href: null, page }（page 是要再去看的封面页）。 */
function coverHrefFromOpf(opf, opfPath) {
  const items = tagsOf(opf, 'item');
  const byId = new Map(items.map(it => [it.id, it]));
  const props = items.find(it => /(^|\s)cover-image(\s|$)/.test(it.properties || '') && isImageItem(it));
  if (props) return { href: resolve(opfPath, props.href) };
  const meta = tagsOf(opf, 'meta').find(m => String(m.name || '').toLowerCase() === 'cover' && m.content);
  if (meta) {
    const it = byId.get(meta.content) || items.find(x => x.href === meta.content);
    if (it && isImageItem(it)) return { href: resolve(opfPath, it.href) };
  }
  const guide = tagsOf(opf, 'reference').find(r => String(r.type || '').toLowerCase() === 'cover' && r.href);
  const named = items.find(it => isImageItem(it) && (/cover/i.test(it.id || '') || /cover/i.test((it.href || '').split('/').pop())));
  return { href: null, page: guide ? resolve(opfPath, guide.href) : null, fallback: named ? resolve(opfPath, named.href) : null };
}

/** 封面页（xhtml）里的第一张图。 */
function firstImageIn(html, pagePath) {
  const img = tagsOf(html, 'img').find(a => a.src) || tagsOf(html, 'image').find(a => a.href);
  return img ? resolve(pagePath, img.src || img.href) : null;
}

const mimeOf = name => {
  const ext = String(name).split('.').pop().toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
};

/**
 * 读一本 EPUB：{ title, author, cover: { name, mime, bytes } | null }。
 * 不是 EPUB、文件坏了，返回 null，不抛错。
 */
async function readEpub(bytes) {
  try {
    const entries = zipEntries(bytes);
    const container = await zipRead(bytes, entries, 'META-INF/container.xml');
    if (!container) return null;
    const rootfile = tagsOf(new TextDecoder().decode(container), 'rootfile').find(r => r['full-path']);
    if (!rootfile) return null;
    const opfPath = rootfile['full-path'];
    const opfBytes = await zipRead(bytes, entries, opfPath);
    if (!opfBytes) return null;
    const opf = new TextDecoder().decode(opfBytes);
    const out = { title: textOf(opf, 'title'), author: textOf(opf, 'creator'), cover: null };
    const found = coverHrefFromOpf(opf, opfPath);
    let href = found.href;
    if (!href && found.page && entries[found.page]) {
      const page = await zipRead(bytes, entries, found.page);
      const img = page ? firstImageIn(new TextDecoder().decode(page), found.page) : null;
      if (img && IMAGE_EXT.test(img)) href = img;
    }
    if (!href) href = found.fallback;
    if (href && entries[href]) {
      const data = await zipRead(bytes, entries, href);
      if (data && data.length) out.cover = { name: href, mime: mimeOf(href), bytes: data };
    }
    return out;
  } catch {
    return null;
  }
}

module.exports = { zipEntries, zipRead, readEpub, coverHrefFromOpf, firstImageIn, resolve, attrsOf, decodeXml };
