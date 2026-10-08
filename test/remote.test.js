// Phone remote: skipping through a video. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../src/server');
const { seekScript, mediaScript } = require('../src/server/lib/browser');

// run the script the browser would run, against a fake page
function seekOn(video, hostname, seconds) {
  const doc = { querySelectorAll: () => (video ? [video] : []) };
  return new Function('document', 'location', `return ${seekScript(seconds)}`)(doc, { hostname });
}
const fakeVideo = (o = {}) => ({
  readyState: 4, currentTime: 100, duration: 600, seekable: { length: 1, start: () => 0, end: () => 600 },
  getBoundingClientRect: () => ({ width: 1280, height: 720 }), ...o,
});

test('seek moves the video forward and back', () => {
  const v = fakeVideo();
  assert.equal(seekOn(v, 'www.youtube.com', 10), 'ok'); assert.equal(v.currentTime, 110);
  assert.equal(seekOn(v, 'www.youtube.com', -10), 'ok'); assert.equal(v.currentTime, 100);
});

test('seek stays inside the video and inside a live stream window', () => {
  let v = fakeVideo({ currentTime: 4 });
  seekOn(v, 'vidio.com', -10); assert.equal(v.currentTime, 0);
  v = fakeVideo({ currentTime: 595 });
  seekOn(v, 'vidio.com', 10); assert.equal(v.currentTime, 600);
  v = fakeVideo({ duration: Infinity, currentTime: 5000, seekable: { length: 1, start: () => 4000, end: () => 5002 } });
  seekOn(v, 'vidio.com', 10); assert.equal(v.currentTime, 5002);
});

test('seek: nothing playing, and Netflix (blocks scripted seeking)', () => {
  assert.equal(seekOn(null, 'www.youtube.com', 10), 'none');
  const v = fakeVideo();
  assert.equal(seekOn(v, 'www.netflix.com', 10), 'keys'); assert.equal(v.currentTime, 100);
  assert.equal(seekOn(v, 'notnetflix.com', 10), 'ok');
});

test('seek amount is clamped and cannot inject code', () => {
  assert.doesNotMatch(seekScript('1);alert(1);//'), /alert/);
  const v = fakeVideo();
  seekOn(v, 'x.com', 99999); assert.equal(v.currentTime, 220);
});

function mediaOn(videos, url = 'https://www.youtube.com/tv', audios = []) {
  const u = new URL(url);
  const doc = { querySelectorAll: s => (s === 'audio' ? audios : videos) };
  return new Function('document', 'location', 'innerWidth', 'innerHeight', `return ${mediaScript()}`)(doc, { hostname: u.hostname, pathname: u.pathname }, 1920, 1080);
}
const vid = (w, h, readyState = 4, extra = {}) => ({ readyState, muted: false, loop: false, getBoundingClientRect: () => ({ width: w, height: h }), ...extra });

test('playback buttons show only for a big, loaded video', () => {
  assert.equal(mediaOn([]), false);                       // launcher: no video at all
  assert.equal(mediaOn([vid(1920, 1080)]), true);         // full-screen player
  assert.equal(mediaOn([vid(640, 360)]), false);          // small preview thumbnail
  assert.equal(mediaOn([vid(1920, 1080, 0)]), false);     // nothing loaded yet
  assert.equal(mediaOn([vid(100, 100), vid(1600, 900)]), true);
});

test('Netflix and Disney+ browse screens (autoplaying trailers) do not count, their players do', () => {
  const big = [vid(1920, 1080)];
  assert.equal(mediaOn(big, 'https://www.netflix.com/browse'), false);
  assert.equal(mediaOn(big, 'https://www.netflix.com/title/80100172'), false);
  assert.equal(mediaOn(big, 'https://www.netflix.com/watch/80100172?trackId=1'), true);
  assert.equal(mediaOn(big, 'https://www.disneyplus.com/home'), false);
  assert.equal(mediaOn(big, 'https://www.disneyplus.com/video/abc-123'), true);
  assert.equal(mediaOn(big, 'https://notnetflix.com/browse'), true);   // only the real site is special-cased
});

test('muted looping clips (banners, previews) do not count; a muted normal video does', () => {
  assert.equal(mediaOn([vid(1920, 1080, 4, { muted: true, loop: true })]), false);
  assert.equal(mediaOn([vid(1920, 1080, 4, { muted: true, loop: false })]), true);
});

let srv, dir;
const PORT = 3700 + Math.floor(Math.random() * 90);
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pctv-rem-'));
  srv = createServer({ dataDir: dir, port: PORT, host: '127.0.0.1' });
  await srv.start();
});
after(() => { srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a new phone is told right away that no video is showing', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  ws.on('message', d => msgs.push(JSON.parse(d)));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(msgs.find(m => m.t === 'media'), { t: 'media', on: false });
  ws.close();
});

test('the server takes the new remote messages and keeps running', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  for (const t of ['seek-back', 'seek-fwd']) ws.send(JSON.stringify({ t }));
  for (const k of ['prev', 'next', 'playpause']) ws.send(JSON.stringify({ t: 'key', k }));
  await new Promise(r => setTimeout(r, 400));
  assert.equal((await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).ok, true);
  ws.close();
});

test('a playing audio element counts as media (Spotify), a paused one does not', () => {
  assert.equal(mediaOn([], 'https://open.spotify.com/', [{ readyState: 4, paused: false, ended: false }]), true);
  assert.equal(mediaOn([], 'https://open.spotify.com/', [{ readyState: 4, paused: true, ended: false }]), false);
});
