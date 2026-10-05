// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../src/server');

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pctv-test-'));
  srv = createServer({ dataDir: dir, port: PORT, host: '127.0.0.1' });
  await srv.start();
});
after(() => { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('health and info', async () => {
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.ok, true);
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.name, 'PCTV Home');
  assert.match(info.remoteUrl, /\/remote\?k=[\w-]{8,}/);
});

test('pages are served', async () => {
  for (const p of ['/', '/remote', '/panel', '/brand/logo.svg', '/manifest.webmanifest']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
});

test('tiles: defaults, add, delete', async () => {
  const tiles = await (await fetch(`${base}/api/tiles`)).json();
  assert.ok(tiles.some(t => t.id === 'netflix'));
  const add = await (await fetch(`${base}/api/tiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Example', url: 'example.com' }),
  })).json();
  assert.equal(add.url, 'https://example.com/');
  await fetch(`${base}/api/tiles/${add.id}`, { method: 'DELETE' });
  const after = await (await fetch(`${base}/api/tiles`)).json();
  assert.ok(!after.some(t => t.id === add.id));
  // reorder
  const ids = l => l.map(t => t.id);
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  await post('/api/tiles/netflix/move', { to: 0 });
  assert.equal(ids(await (await fetch(`${base}/api/tiles`)).json())[0], 'netflix');
  await post('/api/tiles/netflix/move', { by: 1 });
  assert.equal(ids(await (await fetch(`${base}/api/tiles`)).json())[1], 'netflix');
  // built-ins can be removed too, and reset brings them back
  await fetch(`${base}/api/tiles/netflix`, { method: 'DELETE' });
  assert.ok(!(await (await fetch(`${base}/api/tiles`)).json()).some(t => t.id === 'netflix'));
  await post('/api/tiles/reset', {});
  assert.equal(ids(await (await fetch(`${base}/api/tiles`)).json())[1], 'netflix');
});

test('typed addresses work like a browser address bar', () => {
  const { resolveAddress: r } = require('../src/server/lib/address');
  assert.equal(r('google'), 'https://www.google.com/search?q=google');
  assert.equal(r('google', { shortcut: true }), 'https://google.com/');
  assert.equal(r('Google.com'), 'https://google.com/');
  assert.equal(r('netflix.com/browse'), 'https://netflix.com/browse');
  assert.equal(r('detik.co.id'), 'https://detik.co.id/');
  assert.equal(r('lofi hip hop'), 'https://www.google.com/search?q=lofi%20hip%20hop');
  assert.equal(r('192.168.1.5:8080'), 'http://192.168.1.5:8080/');
  assert.equal(r('javascript:alert(1)'), 'https://www.google.com/search?q=javascript%3Aalert(1)');
  assert.equal(r('  '), null);
});

test('invalid tile url is rejected', async () => {
  const r = await fetch(`${base}/api/tiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://' }),
  });
  assert.equal(r.status, 400);
});

test('websocket hello', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msg = await new Promise((res, rej) => { ws.once('message', d => res(JSON.parse(d))); ws.once('error', rej); });
  assert.equal(msg.t, 'hello');
  assert.equal(msg.name, 'PCTV Home');
  ws.close();
});

test('injected page scripts compile', () => {
  // these are injected into web pages as strings; make sure they're valid JS
  new Function(require('../src/server/lib/tv-nav'));
  const { FOCUS_SCRIPT } = require('../src/server/lib/browser');
  for (const mode of ['auto', 'zoom', 'stretch', 'fit']) new Function(FOCUS_SCRIPT.replace('__PCTV_YT_MODE__', mode));
  new Function(require('../src/server/lib/yt-tv')({ browserVersion: '141.0.0.0', version: '1.0.0' }));
});
