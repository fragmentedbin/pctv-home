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
  assert.equal(add.url, 'https://example.com');
  await fetch(`${base}/api/tiles/${add.id}`, { method: 'DELETE' });
  const after = await (await fetch(`${base}/api/tiles`)).json();
  assert.ok(!after.some(t => t.id === add.id));
  // built-ins can't be deleted
  await fetch(`${base}/api/tiles/netflix`, { method: 'DELETE' });
  assert.ok((await (await fetch(`${base}/api/tiles`)).json()).some(t => t.id === 'netflix'));
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
});
