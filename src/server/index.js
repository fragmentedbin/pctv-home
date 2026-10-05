// PCTV Home server: TV home screen + phone remote over HTTP/WebSocket.
// Hosted by the desktop app (src/main) or run headless for development (src/server/cli.js).
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const input = require('./lib/input');
const browser = require('./lib/browser');
const createIcons = require('./lib/icons');
const stats = require('./lib/stats');
const power = require('./lib/power');
const pkg = require('../../package.json');

const PUB = path.join(__dirname, '..', 'public');

const DEFAULT_TILES = [
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/tv?env_enableMediaStreams=true', color: '#1c1c1f', accent: '#ff0033', tv: true, builtin: true },
  { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/browse', color: '#0b0b0b', accent: '#e50914', builtin: true },
  { id: 'disney', name: 'Disney+', url: 'https://www.disneyplus.com/', color: '#0a1446', accent: '#1f80e0', builtin: true },
  { id: 'vidio', name: 'Vidio', url: 'https://www.vidio.com/', color: '#1d0a0d', accent: '#ee2b3b', builtin: true },
];

/**
 * @param {object} opts
 * @param {string} opts.dataDir      where config, tiles, icons and the kiosk profile live
 * @param {number} [opts.port=3000]
 * @param {string} [opts.host='0.0.0.0']
 * @param {boolean} [opts.kiosk]     open the kiosk browser on start
 * @param {string} [opts.browserPath] force a browser executable
 * @param {() => void} [opts.onRestart] how to restart the whole app
 * @param {string} [opts.watchDir]   dev only: restart/reload on code changes
 * @param {object} [opts.app]        desktop-app hooks for the control panel
 */
function createServer(opts) {
  const PORT = Number(opts.port || 3000);
  const HOST = opts.host || '0.0.0.0';
  const DATA = opts.dataDir;
  const BOOT_ID = crypto.randomBytes(4).toString('hex'); // pages reload when this changes
  const events = new EventEmitter();
  fs.mkdirSync(DATA, { recursive: true });
  const icons = createIcons(path.join(DATA, 'icons'));

  // ---------- persistent config + tiles ----------
  const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fallback; } };
  const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2));

  const config = readJSON('config.json', {});
  if (!config.token) { config.token = crypto.randomBytes(9).toString('base64url'); writeJSON('config.json', config); }

  let tiles = readJSON('tiles.json', null) || structuredClone(DEFAULT_TILES);
  tiles = tiles.map(t => t.builtin ? { ...t, ...(DEFAULT_TILES.find(d => d.id === t.id) || {}) } : t);
  const saveTiles = () => writeJSON('tiles.json', tiles);

  // ---------- network helpers ----------
  function lanIp() {
    if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
    const skip = /(vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth|Loopback|tailscale|ZeroTier|utun|awdl|llw|bridge)/i;
    const cands = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal || skip.test(name)) continue;
        const score = /^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0;
        cands.push({ ip: a.address, score, wifi: /wi-?fi|wlan|wireless|^en0$/i.test(name) });
      }
    }
    cands.sort((a, b) => (b.wifi - a.wifi) || (b.score - a.score));
    return cands[0]?.ip || '127.0.0.1';
  }
  const remoteUrl = () => `http://${lanIp()}:${PORT}/remote?k=${config.token}`;
  const isLocal = addr => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
  const authed = req => isLocal(req.socket.remoteAddress) ||
    req.query.k === config.token || req.get('x-remote-key') === config.token;

  // ---------- http ----------
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => { if (!req.path.startsWith('/api/icon/') && !req.path.startsWith('/brand/')) res.set('Cache-Control', 'no-store'); next(); });

  const localOnly = (req, res, next) => isLocal(req.socket.remoteAddress) ? next() : res.status(403).end();
  const auth = (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'bad key' });

  app.get('/', (req, res) => res.sendFile(path.join(PUB, 'launcher', 'index.html')));
  app.get('/remote', (req, res) => res.sendFile(path.join(PUB, 'remote', 'index.html')));
  app.get('/panel', localOnly, (req, res) => res.sendFile(path.join(PUB, 'panel', 'index.html')));
  app.use('/launcher', express.static(path.join(PUB, 'launcher')));
  app.use('/remote', express.static(path.join(PUB, 'remote')));
  app.use('/panel', localOnly, express.static(path.join(PUB, 'panel')));
  app.use('/brand', express.static(path.join(PUB, 'brand'), { maxAge: '7d' }));
  app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(PUB, 'remote', 'manifest.webmanifest')));
  app.get('/health', (req, res) => res.json({ ok: true, devtools: browser.connected(), version: pkg.version }));

  app.get('/api/info', localOnly, (req, res) => res.json({
    name: pkg.productName, version: pkg.version, remoteUrl: remoteUrl(), ip: lanIp(), port: PORT,
    platform: process.platform, browser: browser.findBrowser(), devtools: browser.connected(),
    input: input.status(), remotes: remoteCount(), incognito: browser.isIncognito(),
  }));
  app.get('/api/qr.svg', localOnly, async (req, res) => {
    const svg = await QRCode.toString(remoteUrl(), { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  });

  // desktop-app settings for the control panel (start at login etc.)
  app.get('/api/app', localOnly, (req, res) => res.json(opts.app?.getState?.() || {}));
  app.post('/api/app', localOnly, async (req, res) => {
    try { res.json(await opts.app?.update?.(req.body || {}) || {}); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/app/new-key', localOnly, (req, res) => {
    config.token = crypto.randomBytes(9).toString('base64url'); writeJSON('config.json', config);
    for (const c of wss.clients) if (c.isRemote) c.close(4001, 'key changed');
    res.json({ ok: true });
  });

  // screens the kiosk can be shown on (desktop app only)
  app.get('/api/displays', auth, (req, res) => res.json(opts.app?.listDisplays?.() || []));
  app.post('/api/displays', auth, async (req, res) => {
    try {
      if (!opts.app?.setDisplay) throw new Error('Not available');
      res.json(await opts.app.setDisplay(String(req.body?.id || '')));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/tiles', auth, (req, res) => res.json(tiles));
  app.post('/api/tiles', auth, (req, res) => {
    let { name, url, color, tv, icon } = req.body || {};
    name = String(name || '').trim().slice(0, 40);
    url = String(url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (!name) name = new URL(url).hostname.replace(/^www\./, '');
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) color = '#2b2f3a';
    icon = String(icon || '').trim();
    if (icon && !/^https?:\/\//i.test(icon)) icon = '';
    const tile = { id: crypto.randomBytes(4).toString('hex'), name, url, color, tv: !!tv, ...(icon && { icon }) };
    tiles.push(tile); saveTiles(); broadcast({ t: 'tiles' });
    res.json(tile);
  });
  app.delete('/api/tiles/:id', auth, (req, res) => {
    const before = tiles.length;
    tiles = tiles.filter(t => t.id !== req.params.id || t.builtin);
    if (tiles.length !== before) { icons.remove(req.params.id); saveTiles(); broadcast({ t: 'tiles' }); }
    res.json({ ok: true });
  });
  app.post('/api/tiles/reset', auth, (req, res) => { tiles = structuredClone(DEFAULT_TILES); saveTiles(); broadcast({ t: 'tiles' }); res.json({ ok: true }); });

  app.get('/api/icon/:id', auth, async (req, res) => {
    const tile = tiles.find(t => t.id === req.params.id);
    const ic = tile && await icons.get(tile);
    if (!ic) return res.status(404).end();
    res.set('Cache-Control', 'max-age=86400').type(ic.type).sendFile(ic.file);
  });
  app.post('/api/icon/:id/refresh', auth, (req, res) => { icons.remove(req.params.id); broadcast({ t: 'tiles' }); res.json({ ok: true }); });

  app.get('/api/stats', auth, (req, res) => res.json(stats.get() || {}));
  app.post('/api/sys', localOnly, (req, res) => {
    system(req.body?.a).then(msg => res.json({ ok: true, msg }), e => res.status(400).json({ ok: false, msg: e.message }));
  });

  app.post('/api/open', auth, async (req, res) => {
    const tile = tiles.find(t => t.id === req.body?.id);
    if (!tile) return res.status(404).json({ error: 'no tile' });
    try { await browser.open(tile.url, tile.tv); res.json({ ok: true, via: 'cdp' }); }
    catch (e) { res.json({ ok: false, url: tile.url }); } // launcher falls back to location.href
  });

  // ---------- websocket (remote control) ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('error', () => {}); // listen errors are reported by start()

  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(s);
  }
  function remoteCount() {
    let n = 0;
    for (const c of wss.clients) if (c.isRemote && c.readyState === 1) n++;
    return n;
  }
  const broadcastRemotes = () => { broadcast({ t: 'remotes', n: remoteCount() }); events.emit('remotes', remoteCount()); };

  // After touchpad use, the next D-pad key parks the pointer first so TV web apps
  // leave pointer mode; 3 s after the last touchpad use the pointer is parked too.
  const DPAD = new Set(['up', 'down', 'left', 'right', 'enter']);
  let pointerDirty = false, idlePark = null;
  function pointerUsed() {
    pointerDirty = true;
    clearTimeout(idlePark);
    idlePark = setTimeout(() => input.park(), 3000);
  }
  function navKey(k) {
    if (DPAD.has(k) && pointerDirty) {
      pointerDirty = false; clearTimeout(idlePark);
      input.park();
      setTimeout(() => input.key(k), 40);
    } else input.key(k);
  }
  const NAV_KEYS = new Set(['up', 'down', 'left', 'right', 'enter', 'escape', 'backspace', 'space', 'tab',
    'volup', 'voldown', 'mute', 'next', 'prev', 'f', 'f11']);

  async function doBack() {
    try {
      const r = await browser.back();
      if (r === 'launcher' || r === 'tvapp') input.key('escape'); // let the page handle its own back
    } catch { input.browserBack(); }
  }
  async function doHome() { if (!(await browser.home())) input.browserHome(); }
  async function doPlayPause() { if (!(await browser.togglePlayback())) input.key('playpause'); }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (!isLocal(req.socket.remoteAddress) && url.searchParams.get('k') !== config.token) {
      ws.close(4001, 'bad key'); return;
    }
    ws.isRemote = !isLocal(req.socket.remoteAddress);
    ws.send(JSON.stringify({ t: 'hello', input: input.status(), boot: BOOT_ID, name: pkg.productName, version: pkg.version, incognito: browser.isIncognito() }));
    broadcastRemotes();
    ws.on('close', broadcastRemotes);
    ws.send(JSON.stringify({ t: 'focus', ...browser.focusState() }));
    if (stats.get()) ws.send(JSON.stringify({ t: 'stats', ...stats.get() }));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case 'key':
          if (m.k === 'playpause') doPlayPause();
          else if (NAV_KEYS.has(m.k)) navKey(m.k);
          break;
        case 'back': doBack(); break;
        case 'voice': browser.startVoiceSearch().then(
          ok => ws.send(JSON.stringify({ t: 'voice-ack', ok })),
          () => ws.send(JSON.stringify({ t: 'voice-ack', ok: false })));
          break;
        case 'home': doHome(); break;
        case 'move': pointerUsed(); input.move(m.dx, m.dy); break;
        case 'click': pointerUsed(); input.click(m.b); break;
        case 'wheel': pointerUsed(); input.wheel(m.d); break;
        case 'text': {
          const str = String(m.s || '').slice(0, 500);
          browser.typeText(str).then(ok => { if (!ok) input.text(str); }, () => input.text(str));
          break;
        }
        case 'bs': for (let i = 0; i < Math.min(Number(m.n) || 0, 200); i++) input.key('backspace'); break;
        case 'ping': ws.send('{"t":"pong"}'); break;
        case 'sys': system(m.a).then(
          msg => ws.send(JSON.stringify({ t: 'sys-ack', a: m.a, ok: true, msg })),
          e => ws.send(JSON.stringify({ t: 'sys-ack', a: m.a, ok: false, msg: e.message })));
          break;
      }
    });
  });

  stats.events.on('update', st => broadcast({ t: 'stats', ...st }));
  browser.events.on('focus', info => broadcast({ t: 'focus', ...info }));
  browser.events.on('incognito', on => broadcast({ t: 'incognito', on }));

  // ---------- system actions ----------
  let powerTimer = null;
  function restartApp(reason) {
    if (!opts.onRestart) throw new Error('Restart is not available in this mode');
    console.log(`[sys] restarting (${reason})`);
    broadcast({ t: 'restarting' });
    setTimeout(() => { stop(); opts.onRestart(); }, 400);
  }
  function delayedPower(fn, what) {
    clearTimeout(powerTimer);
    powerTimer = setTimeout(() => { powerTimer = null; fn().catch(e => console.error('[power]', e.message)); }, 10000);
    return `${what} in 10 s`;
  }
  async function system(action) {
    switch (action) {
      case 'reload': await browser.reload(); return 'Page reloaded';
      case 'restart-app': restartApp('requested'); return 'Restarting PCTV Home';
      case 'restart-browser': await browser.restartBrowser(); return 'Browser restarted';
      case 'open-kiosk': await browser.launchOrFocus(); return 'TV Home opened';
      case 'incognito-on': await browser.setIncognito(true); return 'Incognito on: nothing is saved';
      case 'incognito-off': await browser.setIncognito(false); return 'Incognito off: your accounts are back';
      case 'incognito-toggle': return system(browser.isIncognito() ? 'incognito-off' : 'incognito-on');
      case 'exit-kiosk': await browser.closeBrowser(); return 'Kiosk closed';
      case 'sleep': setTimeout(() => power.sleep().catch(e => console.error('[power]', e.message)), 800); return 'Going to sleep';
      case 'reboot': return delayedPower(power.reboot, 'Restarting PC');
      case 'shutdown': return delayedPower(power.shutdown, 'Shutting down');
      case 'cancel-power': clearTimeout(powerTimer); powerTimer = null; return 'Cancelled';
      default: throw new Error('unknown action');
    }
  }

  // ---------- dev: restart / reload on code changes ----------
  let watcher = null;
  if (opts.watchDir) {
    let timer = null, needRestart = false, needReload = false;
    try {
      watcher = fs.watch(opts.watchDir, { recursive: true }, (ev, file) => {
        if (!file || /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/.test(file) || /(~|\.tmp|\.swp)$/.test(file)) return;
        if (/(^|[\\/])public[\\/]/.test(file)) needReload = true;
        else if (/\.(js|json)$/.test(file)) needRestart = true;
        else return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (needRestart && opts.onRestart) restartApp(`code changed: ${file}`);
          else { console.log('[watch] UI changed, reloading pages'); broadcast({ t: 'reload-ui' }); }
          needRestart = needReload = false;
        }, 1200);
      });
      console.log('[watch] reloading on code changes');
    } catch (e) { console.warn('[watch] unavailable:', e.message); }
  }

  // ---------- lifecycle ----------
  function start() {
    return new Promise((resolve, reject) => {
      input.start();
      stats.start();
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        browser.init({
          home: `http://localhost:${PORT}/`,
          kiosk: !!opts.kiosk,
          profileDir: path.join(DATA, 'browser-profile'),
          browserPath: opts.browserPath,
          browserPreference: opts.browserPreference,
          youtubeFill: opts.youtubeFill,
          uiScale: opts.uiScale,
          windowPosition: opts.windowPosition,
        });
        setTimeout(() => input.park(), 4000);
        resolve({ port: PORT, remoteUrl: remoteUrl(), homeUrl: `http://localhost:${PORT}/` });
      });
    });
  }
  function stop() {
    try { watcher?.close(); } catch {}
    input.stop(); stats.stop();
    for (const c of wss.clients) try { c.terminate(); } catch {}
    try { server.close(); } catch {}
  }

  return {
    start, stop, events, system, broadcast,
    setBrowserPreference: p => browser.setPreference(p),
    setYoutubeFill: m => browser.setYoutubeFill(m),
    setUiScale: (f, o) => browser.setUiScale(f, o),
    setKioskPlacement: (p, o) => browser.setPlacement(p, o),
    info: () => ({ remoteUrl: remoteUrl(), homeUrl: `http://localhost:${PORT}/`, port: PORT, remotes: remoteCount() }),
    openKiosk: () => browser.launchOrFocus(),
    closeKiosk: () => browser.closeBrowser(),
  };
}

module.exports = { createServer, DEFAULT_TILES };
