// Finds and caches each tile's app icon from the site itself
// (apple-touch-icon / largest <link rel=icon>), falling back to a favicon service.
const fs = require('fs');
const path = require('path');


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const inflight = new Map();


async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok || !/^image\//.test(type)) throw new Error(`not an image: ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('bad size');
  return { buf, type };
}

async function candidatesFromPage(pageUrl) {
  const u = new URL(pageUrl);
  const out = [];
  try {
    const r = await fetch(u.origin + '/', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(6000) });
    const html = (await r.text()).slice(0, 400000);
    const manifest = (html.match(/<link\b[^>]*rel=["']?manifest[^>]*>/i) || [''])[0].match(/href=["']?([^"' >]+)/i);
    if (manifest) {
      try {
        const mu = new URL(manifest[1].replace(/&amp;/g, '&'), r.url || u.origin);
        const m = await (await fetch(mu, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) })).json();
        for (const ic of m.icons || []) {
          const size = Math.max(0, ...String(ic.sizes || '').split(/\s+/).map(x => parseInt(x, 10) || 0));
          if (ic.src && !/monochrome/.test(ic.purpose || '')) out.push({ url: new URL(ic.src, mu).href, score: size });
        }
      } catch {}
    }
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const rel = (tag.match(/rel=["']?([^"'>]+)/i) || [])[1] || '';
      const href = (tag.match(/href=["']?([^"' >]+)/i) || [])[1];
      if (!href || !/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
      const sizes = (tag.match(/sizes=["']?([^"'>]+)/i) || [])[1] || '';
      const size = /any/i.test(sizes) ? 512 : Math.max(0, ...sizes.split(/\s+/).map(s => parseInt(s, 10) || 0));
      const score = size || (/apple-touch/i.test(rel) ? 180 : 16);
      try { out.push({ url: new URL(href.replace(/&amp;/g, '&'), r.url || u.origin).href, score }); } catch {}
    }
  } catch {}
  out.push({ url: `${u.origin}/apple-touch-icon.png`, score: 180 });
  out.push({ url: `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(u.origin)}&size=256`, score: 150 });
  out.sort((a, b) => b.score - a.score);
  return [...new Set(out.map(c => c.url))];
}

// Pixel width of PNG / ICO / GIF; SVG counts as large; others assumed medium.
function measure(buf, type) {
  if (/svg/.test(type)) return 512;
  if (buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    let best = 0;
    for (let i = 0, n = buf.readUInt16LE(4); i < n; i++) best = Math.max(best, buf[6 + i * 16] || 256);
    return best;
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') return buf.readUInt16LE(6);
  return 128;
}

async function fetchIcon(tile, fileFor) {
  const list = tile.icon ? [tile.icon, ...(await candidatesFromPage(tile.url))] : await candidatesFromPage(tile.url);
  let best = null;
  for (const url of list.slice(0, 8)) {
    try {
      const { buf, type } = await download(url);
      const px = tile.icon && url === tile.icon ? 9999 : measure(buf, type);
      if (!best || px > best.px) best = { buf, type, px };
      if (best.px >= 180) break; // good enough
    } catch {}
  }
  if (best) {
    fs.writeFileSync(fileFor(tile.id), best.buf);
    fs.writeFileSync(fileFor(tile.id) + '.type', best.type);
    return true;
  }
  fs.writeFileSync(fileFor(tile.id) + '.type', 'none'); // remember the miss (cleared on refresh)
  return false;
}

module.exports = function createIcons(DIR) {
  fs.mkdirSync(DIR, { recursive: true });
  const fileFor = id => path.join(DIR, id.replace(/[^a-z0-9_-]/gi, ''));
  return {
  /** Resolves to {file, type} or null. */
  async get(tile) {
    const f = fileFor(tile.id);
    if (fs.existsSync(f + '.type')) {
      const type = fs.readFileSync(f + '.type', 'utf8');
      return type === 'none' ? null : { file: f, type };
    }
    if (!inflight.has(tile.id)) inflight.set(tile.id, fetchIcon(tile, fileFor).finally(() => inflight.delete(tile.id)));
    return (await inflight.get(tile.id)) ? { file: f, type: fs.readFileSync(f + '.type', 'utf8') } : null;
  },
  remove(id) {
    for (const f of [fileFor(id), fileFor(id) + '.type']) { try { fs.unlinkSync(f); } catch {} }
  },
};
};
