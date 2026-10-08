// Launches Chrome/Edge in kiosk mode and controls it over the Chrome DevTools
// Protocol (localhost only): go Home, history Back, and a TV user agent for
// youtube.com/tv (desktop Chrome gets redirected away from it otherwise).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const NAV_SCRIPT = require('./tv-nav');
const { keyEventsFor } = require('./keys');
const ytTvScript = require('./yt-tv');
const APP_VERSION = require('../../../package.json').version;

const events = new EventEmitter(); // emits 'focus' {editable, type, inputmode, autocomplete, name, label, maxlength}

// Injected into every page/frame: reports when an editable field gains/loses focus.
const FOCUS_SCRIPT = `(() => {
  if (window.__tvFocusInstalled) return; window.__tvFocusInstalled = true;
  const NON_TEXT = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i;
  const report = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (el && /^I?FRAME$/.test(el.tagName)) return; // the child frame reports for itself
    const editable = !!el && !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && !NON_TEXT.test(el.type)));
    let info = !editable ? { editable: false } : {
      editable: true,
      type: (el.type || 'text').toLowerCase(),
      inputmode: (el.inputMode || el.getAttribute('inputmode') || '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.name || el.id || '',
      label: el.getAttribute('aria-label') || el.placeholder || (el.labels && el.labels[0] && el.labels[0].innerText) || '',
      maxlength: el.maxLength > 0 ? el.maxLength : 0,
    };
    // pages with their own on-screen keyboard (YouTube TV) describe a "virtual" field
    if (!editable && typeof window.__pctvVirtualField === 'function') {
      const v = window.__pctvVirtualField();
      if (v) info = Object.assign({ editable: true, inputmode: '', autocomplete: '', maxlength: 0 }, v);
    }
    try { window.__tvFocus(JSON.stringify(info)); } catch (e) {}
  };
  let t; const schedule = () => { clearTimeout(t); t = setTimeout(report, 50); };
  window.__pctvReport = schedule;

  // TV-style pages (YouTube TV, Google's TV sign-in) have no real text field, only their
  // own on-screen keyboard. Describe it as a "virtual" field so the phone keyboard pops up.
  if (window.top === window) {
    window.__pctvVirtualField = () => {
      const key = document.querySelector('yt-keyboard-key, [class*="ytKeyboardKey"]');
      if (!key) return null;
      const r = key.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const txt = document.body ? document.body.innerText : '';
      const signIn = location.hostname === 'accounts.google.com' || txt.includes('@gmail.com');
      return signIn
        ? { type: 'email', name: 'tv-signin', label: 'Google sign-in' }
        : { type: 'search', name: 'tv-search', label: 'Search YouTube' };
    };
    let lastVirtual = '';
    setInterval(() => {
      const v = JSON.stringify(window.__pctvVirtualField());
      if (v !== lastVirtual) { lastVirtual = v; schedule(); }
    }, 400);
  }
  addEventListener('focusin', schedule, true);
  addEventListener('focusout', schedule, true);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', schedule); else schedule();

  // Page CSS via a constructed stylesheet: unlike a <style> tag it isn't blocked by
  // sites' Content-Security-Policy (YouTube blocks inline styles).
  // Hidden scrollbars everywhere (pages still scroll), TV-style.
  let rules = 'html.__tv-idle, html.__tv-idle * { cursor: none !important; }' +
    '* { scrollbar-width: none !important; }' +
    '::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }';
  // YouTube TV draws a fixed 16:9 UI. On other screen shapes (16:10 laptops,
  // ultrawide) fill the screen: 'auto' stretches menus (nothing gets cut off)
  // and zooms while a video plays (no distortion); 'zoom' / 'stretch' / 'fit' force one.
  const ytTv = location.hostname.endsWith('youtube.com') && location.pathname.startsWith('/tv');
  if (ytTv && window.top === window) {
    rules += '#container, #app-background { transform: scale(var(--pctv-zx, 1), var(--pctv-zy, 1)) !important;' +
             ' transform-origin: 50% 50% !important; transition: transform .35s ease !important; }' +
             'html, body { overflow: hidden !important; background: #000 !important; }';
    let mode = '__PCTV_YT_MODE__';
    let lastKey = '';
    const fit = () => {
      const de = document.documentElement;
      if (!de) return;
      const w = Math.min(innerWidth, innerHeight * 16 / 9), h = w * 9 / 16;
      const sx = innerWidth / w, sy = innerHeight / h;
      const watching = location.hash.startsWith('#/watch');
      const m = mode === 'auto' ? (watching ? 'zoom' : 'stretch') : mode;
      const z = Math.max(sx, sy);
      const [x, y] = m === 'zoom' ? [z, z] : m === 'stretch' ? [sx, sy] : [1, 1];
      const key = x + ',' + y;
      if (key === lastKey) return;
      lastKey = key;
      de.style.setProperty('--pctv-zx', String(x));
      de.style.setProperty('--pctv-zy', String(y));
    };
    // YouTube's TV app asks the TV (Cobalt's h5vcc API) how big the screen is and caps
    // the quality list to that; a browser has no such API, so it guesses low. Report the
    // real screen in physical pixels (same approach as the VacuumTube project).
    if (!window.h5vcc) {
      const screenRes = () => {
        const w = Math.round(Math.max(screen.width, screen.height) * devicePixelRatio);
        const h = Math.round(Math.min(screen.width, screen.height) * devicePixelRatio);
        for (const [a, b] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [7680, 4320]]) {
          if (w <= a && h <= b) return a + 'x' + b;
        }
        return w + 'x' + h;
      };
      window.h5vcc = { runtime: {}, system: { getVideoContainerSizeOverride: screenRes } };
    }
    window.__pctvSetYtMode = m => { mode = m; lastKey = ''; fit(); };
    fit();
    addEventListener('resize', fit);
    addEventListener('DOMContentLoaded', fit);
    setInterval(fit, 400); // the TV app changes routes with pushState, so poll the hash
  }
  try { // every frame, so embedded iframes lose their scrollbars too
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rules);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch (e) {}
  if (window.top === window) {
    // Hide the mouse pointer after 3 s without mouse use, or on any key press.
    let idleT = null, hidden = false;
    const root = () => document.documentElement;
    const hide = () => {
      hidden = true;
      if (root()) { root().classList.add('__tv-idle'); root().style.setProperty('cursor', 'none', 'important'); }
    };
    const wake = () => {
      if (Date.now() < (window.__tvSynth || 0)) return; // hover sent by D-pad navigation
      if (hidden) { hidden = false; if (root()) { root().classList.remove('__tv-idle'); root().style.removeProperty('cursor'); } }
      clearTimeout(idleT); idleT = setTimeout(hide, 3000);
    };
    addEventListener('mousemove', wake, true);
    addEventListener('mousedown', wake, true);
    addEventListener('keydown', hide, true);
    idleT = setTimeout(hide, 3000);
  }
})();`;

// Frames report independently (focusout in one, focusin in another), so a
// "not editable" is held back briefly in case an "editable" follows.
let focusState = { editable: false };
let blurTimer = null;
function onFocusReport(info) {
  if (process.env.PCTV_DEBUG) console.log('[focus]', JSON.stringify(info));
  if (info.editable) {
    clearTimeout(blurTimer); blurTimer = null;
    focusState = info; events.emit('focus', info);
  } else if (focusState.editable && !blurTimer) {
    blurTimer = setTimeout(() => { blurTimer = null; focusState = { editable: false }; events.emit('focus', focusState); }, 200);
  }
}

const CDP_PORT = Number(process.env.PCTV_CDP_PORT || 9222);
const CDP = `http://127.0.0.1:${CDP_PORT}`;
// YouTube's TV interface ("Leanback") picks its UI per device identity.
// 'ps4' gives the most up-to-date UI (same identity the VacuumTube project uses);
// 'tizen' is the Samsung TV one. Pick with PCTV_TV_UA_PRESET, or set PCTV_TV_UA directly.
const UA_PRESETS = {
  ps4: 'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25.lts.40.1035033; compatible; PCTVHome/1.0',
  tizen: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36',
};
const TV_UA = process.env.PCTV_TV_UA || UA_PRESETS[process.env.PCTV_TV_UA_PRESET || 'ps4'] || UA_PRESETS.ps4;

let homeUrl = 'http://localhost:3000/';
let kioskEnabled = false;
let conn = null;          // { ws, targetId, pending, nextId }
let parked = null;        // the app tab kept playing in the background: { id, tv }
let wantedTarget = null;  // connect() prefers this tab (used when switching tabs)
let appTv = false;        // does the app tab currently use the TV user agent?
let defaultUA = null;

const isHome = u => { try { const x = new URL(u); return x.origin + x.pathname === homeUrl; } catch { return false; } };

let profileDir = null;
let forcedBrowser = null;
let preference = 'auto'; // 'auto' | 'chrome' | 'edge'
let ytMode = 'auto';      // YouTube TV fill: 'auto' | 'zoom' | 'stretch' | 'fit'
let uiScale = null;       // kiosk zoom (Chrome --force-device-scale-factor); null = use Windows/macOS scaling
let launchedScale = null; // the scale the running kiosk was started with
let windowPos = null;      // {x, y}: open the kiosk on the display containing this point
let launchedPos = null;
let secureDns = 'off';     // DNS over HTTPS for the kiosk: 'off' (the PC's DNS) or a provider below
let incognito = false;     // private session: a throwaway profile, wiped when it ends

// Incognito uses its own empty profile folder. It is wiped before every incognito
// launch and when incognito is turned off, so nothing from it is ever kept.
const incognitoDir = () => `${profileDir}-incognito`;
const incognitoMarker = () => `${profileDir}-incognito.on`; // survives a launcher restart while the kiosk stays open
function wipeIncognito() {
  try { fs.rmSync(incognitoDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  catch (e) { console.warn('[browser] could not clear the incognito profile:', e.message); }
}

/** Locate Chrome or Edge on Windows / macOS / Linux. Returns {path, name} or null. */
function findBrowser() {
  const forced = forcedBrowser || process.env.PCTV_BROWSER;
  if (forced && fs.existsSync(forced)) return { path: forced, name: path.basename(forced) };
  let chrome = [], edge = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    chrome = [pf, pf86, local].map(b => path.join(b, 'Google\\Chrome\\Application\\chrome.exe'));
    edge = [pf86, pf, local].map(b => path.join(b, 'Microsoft\\Edge\\Application\\msedge.exe'));
  } else if (process.platform === 'darwin') {
    const home = require('os').homedir();
    chrome = ['/Applications', path.join(home, 'Applications')].map(b => path.join(b, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
    edge = ['/Applications', path.join(home, 'Applications')].map(b => path.join(b, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  } else {
    chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
    edge = ['/usr/bin/microsoft-edge'];
  }
  const preferEdge = preference === 'edge' || (preference === 'auto' && process.env.PCTV_PREFER_EDGE === '1');
  const found = (preferEdge ? [...edge, ...chrome] : [...chrome, ...edge]).find(p => p && fs.existsSync(p));
  if (!found) return null;
  return { path: found, name: /edge/i.test(found) ? 'Microsoft Edge' : /chromium/i.test(found) ? 'Chromium' : 'Google Chrome' };
}

// Secure DNS (DNS over HTTPS). The kiosk has its own browser profile, so a DNS
// setting made in your everyday Chrome/Edge doesn't apply to it. Sites blocked by
// the ISP's DNS (e.g. Reddit in some countries) open with this on.
const DOH = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query{?dns}',
  quad9: 'https://dns.quad9.net/dns-query',
  adguard: 'https://dns.adguard-dns.com/dns-query',
};
// Chrome and Edge keep this in the profile's "Local State" file, read at start-up.
function applySecureDns(dir) {
  const file = path.join(dir, 'Local State');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const want = DOH[secureDns]
    ? { mode: 'secure', templates: DOH[secureDns] }
    : { mode: 'automatic', templates: '' };
  const cur = st.dns_over_https || {};
  if (cur.mode === want.mode && (cur.templates || '') === want.templates) return;
  st.dns_over_https = { ...cur, ...want };
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(st)); }
  catch (e) { console.warn('[browser] could not set secure DNS:', e.message); }
}

// The kiosk never needs yesterday's tabs. Edge in particular brings back every
// tab of the last session after an unclean exit (and keeps running in the
// background), so each start used to add more pages and more memory. Before a
// start we drop the saved session and switch both behaviours off.
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, v) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
  catch (e) { console.warn(`[browser] could not update ${path.basename(f)}:`, e.message); }
}
function prepareProfile(dir) {
  applySecureDns(dir);
  const lsFile = path.join(dir, 'Local State');
  const ls = readJson(lsFile) || {};
  if (ls.background_mode?.enabled !== false) { ls.background_mode = { ...(ls.background_mode || {}), enabled: false }; writeJson(lsFile, ls); }
  const prefFile = path.join(dir, 'Default', 'Preferences');
  const pref = readJson(prefFile);
  if (pref) {
    pref.profile = { ...(pref.profile || {}), exit_type: 'Normal', exited_cleanly: true };
    pref.session = { ...(pref.session || {}), restore_on_startup: 5 }; // 5 = open the start page only
    writeJson(prefFile, pref);
  }
  // the saved tab list (not cookies or logins)
  try { fs.rmSync(path.join(dir, 'Default', 'Sessions'), { recursive: true, force: true }); } catch {}
}

/** Is a kiosk browser already answering on the DevTools port? */
async function cdpAlive(timeout = 1500) {
  try { await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(timeout) }); return true; } catch { return false; }
}
/** Wait for the old browser to be gone (after Browser.close), up to `ms`. */
async function waitClosed(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await cdpAlive(800))) { await new Promise(r => setTimeout(r, 700)); return true; }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// One start at a time, and never a second copy: starting the browser again while
// it runs just opens another window (not in kiosk mode) inside the running one.
let launching = null;
function launch() {
  if (!launching) {
    launching = (async () => {
      if (await cdpAlive()) {
        console.log('[browser] kiosk browser is already running, not starting another one');
        return true;
      }
      return spawnBrowser();
    })().finally(() => setTimeout(() => { launching = null; }, 3000));
  }
  return launching;
}

function spawnBrowser() {
  const b = findBrowser();
  if (!b) { console.error('[browser] Chrome/Edge not found.'); return false; }
  if (incognito) wipeIncognito(); // every incognito launch starts empty
  // separate profile per browser; incognito gets a throwaway one
  const dataDir = incognito ? incognitoDir() : `${profileDir}-${/edge/i.test(b.name) ? 'edge' : 'chrome'}`;
  prepareProfile(dataDir);
  const args = [
    '--kiosk', homeUrl,
    `--user-data-dir=${dataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    // background playback: a tab that is out of sight (parked app) must not be throttled or muted
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
    '--disable-background-mode',
    '--disable-features=Translate',
    '--overscroll-history-navigation=0',
    '--hide-scrollbars',
    '--start-fullscreen', // backup for --kiosk
  ];
  // Same physical size on every screen: websites are made for a desk, the TV is far away.
  if (uiScale) args.push(`--force-device-scale-factor=${uiScale}`);
  // Kiosk mode goes full screen on the display that contains the window's position.
  if (windowPos) args.push(`--window-position=${Math.round(windowPos.x)},${Math.round(windowPos.y)}`);
  launchedScale = uiScale;
  launchedPos = windowPos;
  if (incognito) args.push('--disable-sync', '--no-pings');
  console.log(`[browser] launching ${b.name} in kiosk mode${incognito ? ' (incognito)' : ''}`);
  spawn(b.path, args, { detached: true, stdio: 'ignore' }).unref();
  return true;
}

async function listPages() {
  const r = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) });
  const all = await r.json();
  return all.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
}

async function connect() {
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    // make sure our target still exists
    const pages = await listPages();
    if (pages.some(p => p.id === conn.targetId)) return conn;
    conn.ws.close();
  }
  const pages = await listPages();
  if (!pages.length) throw new Error('no page target');
  const page = pages.find(p => p.id === wantedTarget) || pages.find(p => !parked || p.id !== parked.id) || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl); // no Origin header -> allowed by Chrome
  const c = { ws, targetId: page.id, pending: new Map(), nextId: 1, url: page.url };
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id && c.pending.has(msg.id)) {
      const { resolve, reject } = c.pending.get(msg.id);
      c.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__tvFocus') {
      try { onFocusReport(JSON.parse(msg.params.payload)); } catch {}
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__tvHover') {
      // D-pad focus -> a real (trusted) mouse-over inside the page; the OS pointer doesn't move
      try {
        const { x, y } = JSON.parse(msg.params.payload);
        call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +x, y: +y, button: 'none' }).catch(() => {});
      } catch {}
    } else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
      c.url = msg.params.frame.url;
      events.emit('url', c.url);
      onFocusReport({ editable: false }); // new page in the main frame
    }
  });
  ws.on('close', () => { if (conn === c) { conn = null; onFocusReport({ editable: false }); } });
  conn = c;
  events.emit('url', c.url);
  console.log(`[browser] DevTools connected to ${page.url.slice(0, 60)}`);
  try { // focus detection for text fields (email, password, OTP...)
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Runtime.addBinding', { name: '__tvFocus' });
    await call('Runtime.addBinding', { name: '__tvHover' });
    // YouTube's voice search uses the PC's microphone; allow it up front, since a
    // permission bubble can't be answered with the remote. Only YouTube gets it.
    try {
      await call('Browser.grantPermissions', { origin: 'https://www.youtube.com', permissions: ['audioCapture'] });
    } catch (e) { console.warn('[browser] could not pre-allow the microphone:', e.message); }
    if (!defaultUA) {
      try { defaultUA = (await call('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome'); } catch {}
    }
    const page = pageScript();
    c.pageScriptId = (await call('Page.addScriptToEvaluateOnNewDocument', { source: page })).identifier;
    await call('Runtime.evaluate', { expression: page }); // page already open
    await call('Page.addScriptToEvaluateOnNewDocument', { source: NAV_SCRIPT });
    await call('Runtime.evaluate', { expression: NAV_SCRIPT });
  } catch (e) { console.warn('[browser] focus hook failed:', e.message); }
  ensureFullscreen(c.targetId, 'connected');
  closeExtraPages().catch(() => {}); // leftovers from an earlier run
  // Edge on Windows can restore its old window size a moment after starting: check again
  setTimeout(() => conn === c && ensureFullscreen(c.targetId, 'after 4 s'), 4000);
  if (!defaultUA) {
    try { defaultUA = (await call('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome'); } catch {}
  }
  return c;
}

// The kiosk must always cover the whole screen. If Chrome/Edge opened as a normal
// window (e.g. a copy using the same profile was still running in the background,
// so --kiosk was ignored), switch the window to full screen ourselves.
async function ensureFullscreen(targetId, when = '') {
  if (!kioskEnabled) return;
  try {
    const { windowId, bounds } = await call('Browser.getWindowForTarget', { targetId });
    const b = `${bounds.width}x${bounds.height} at ${bounds.left},${bounds.top}`;
    if (bounds.windowState === 'fullscreen') { if (when) console.log(`[browser] window ${when}: fullscreen ${b}`); return; }
    console.warn(`[browser] window ${when}: "${bounds.windowState}" ${b}, switching to full screen`);
    if (bounds.windowState !== 'normal') await call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    const after = (await call('Browser.getWindowForTarget', { targetId })).bounds;
    console.log(`[browser] window now "${after.windowState}" ${after.width}x${after.height}`);
  } catch (e) { console.warn('[browser] could not check the window state:', e.message); }
}

function call(method, params = {}) {
  const c = conn;
  if (!c) return Promise.reject(new Error('not connected'));
  const id = c.nextId++;
  return new Promise((resolve, reject) => {
    c.pending.set(id, { resolve, reject });
    c.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (c.pending.delete(id)) reject(new Error(`${method} timeout`)); }, 4000);
  });
}

// ---------- background playback ----------
// When you go Home while something is playing (YouTube, Spotify...), the app's tab is "parked":
// it keeps running in the same window, behind a fresh launcher tab, and the launcher shows a
// "Now playing" card. Opening the same app again (or the card) brings the parked tab back.

// Runs inside a page: what is playing? null = nothing media-like on this page.
function playingScript() {
  return `(() => {
    const host = location.hostname, path = location.pathname || '';
    if (/(^|\\.)netflix\\.com$/.test(host) && !path.startsWith('/watch')) return null;
    if (/(^|\\.)disneyplus\\.com$/.test(host) && !/\\/(video|play)\\//.test(path)) return null;
    const ms = navigator.mediaSession, md = ms && ms.metadata;
    const screen = innerWidth * innerHeight;
    const big = e => { const r = e.getBoundingClientRect(); return r.width * r.height > screen * 0.25; };
    const els = [...document.querySelectorAll('video,audio')]
      .filter(e => e.readyState > 0 && !(e.muted && e.loop) && (e.tagName === 'AUDIO' || !!md || big(e)));
    const playing = els.some(e => !e.paused && !e.ended) || (!!ms && ms.playbackState === 'playing');
    if (!playing && !els.length && !md) return null;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    return { playing, host, title: (md && md.title) || document.title || host, artist: (md && (md.artist || md.album)) || '', art };
  })()`;
}

// Sites like to pause when their tab is hidden; a parked tab keeps telling them it is visible.
const SPOOF_VISIBLE = `(() => {
  if (window.__pctvVis) return;
  const stop = e => e.stopImmediatePropagation();
  window.__pctvVis = stop;
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  } catch {}
  window.addEventListener('visibilitychange', stop, true);
  document.addEventListener('visibilitychange', stop, true);
})()`;
const UNSPOOF_VISIBLE = `(() => {
  const stop = window.__pctvVis;
  if (!stop) return;
  window.removeEventListener('visibilitychange', stop, true);
  document.removeEventListener('visibilitychange', stop, true);
  try { delete document.hidden; delete document.visibilityState; } catch {}
  delete window.__pctvVis;
})()`;

const KNOWN_APPS = { 'youtube.com': 'YouTube', 'spotify.com': 'Spotify', 'netflix.com': 'Netflix', 'disneyplus.com': 'Disney+', 'twitch.tv': 'Twitch', 'primevideo.com': 'Prime Video' };
function appLabel(host = '') {
  const h = host.replace(/^(www|open|music|m|play)\./, '');
  const key = Object.keys(KNOWN_APPS).find(k => h === k || h.endsWith('.' + k));
  return key ? KNOWN_APPS[key] : h;
}
// "open.spotify.com" and "www.spotify.com" are the same app
const siteOf = u => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return ''; } };

/** Run a script in any tab over a short-lived DevTools connection (the main one stays on the shown tab). */
async function evalOn(targetId, expression, timeout = 3000) {
  const page = (await listPages()).find(p => p.id === targetId);
  if (!page) throw new Error('tab is gone');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const done = (fn, v) => { clearTimeout(t); try { ws.close(); } catch {} fn(v); };
    const t = setTimeout(() => done(reject, new Error('evalOn timeout')), timeout);
    ws.once('error', e => done(reject, e));
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.id !== 1) return;
      m.error ? done(reject, new Error(m.error.message)) : done(resolve, m.result?.result?.value);
    });
  });
}

/** Evaluate in the tab that holds the media: the parked app if there is one, else the shown tab. */
async function evalMedia(expression) {
  if (parked) return evalOn(parked.id, expression);
  await connect();
  const r = await call('Runtime.evaluate', { returnByValue: true, expression });
  return r.result?.value;
}

async function closeTab(id) {
  try { await fetch(`${CDP}/json/close/${id}`, { signal: AbortSignal.timeout(1500) }); } catch {}
}

/** Point the main DevTools connection at another tab. */
async function switchTo(id) {
  wantedTarget = id;
  try {
    if (conn) { const old = conn; conn = null; try { old.ws.close(); } catch {} }
    await connect();
  } finally { wantedTarget = null; }
}

async function newTab(url) {
  try {
    const r = await fetch(`${CDP}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
    const t = await r.json();
    if (t?.id) return t.id;
  } catch {}
  const r = await call('Target.createTarget', { url });
  return r.targetId;
}

// Everything injected into each page: focus/keyboard hook, pointer hide, YouTube TV fixes.
function pageScript() {
  const browserVersion = ((defaultUA || '').match(/(?:Chrome|Edg)\/([\d.]+)/) || [])[1];
  return FOCUS_SCRIPT.replace('__PCTV_YT_MODE__', ytMode) + '\n' + ytTvScript({ browserVersion, version: APP_VERSION });
}

async function setUA(ua) {
  // The override only lives while this CDP connection is open, so we keep it open.
  await call('Emulation.setUserAgentOverride', { userAgent: ua || defaultUA || '' });
}

async function closeExtraPages() {
  if (!conn) return 0;
  let n = 0;
  for (const p of await listPages()) {
    if (p.id === conn.targetId || (parked && p.id === parked.id)) continue;
    try { await call('Target.closeTarget', { targetId: p.id }); n++; }
    catch { try { await fetch(`${CDP}/json/close/${p.id}`, { signal: AbortSignal.timeout(1000) }); n++; } catch {} }
  }
  if (n) console.log(`[browser] closed ${n} extra page${n > 1 ? 's' : ''}`);
  return n;
}

// Runs inside the page: is something actually being watched? A big, loaded video counts, except
//  - Netflix / Disney+ outside their player pages (the browse screens autoplay a muted trailer), and
//  - muted looping clips (autoplaying banners and previews on any site).
function mediaScript() {
  return `(() => {
    const host = location.hostname, path = location.pathname || '';
    if (/(^|\\.)netflix\\.com$/.test(host) && !path.startsWith('/watch')) return false;
    if (/(^|\\.)disneyplus\\.com$/.test(host) && !/\\/(video|play)\\//.test(path)) return false;
    const screen = innerWidth * innerHeight;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (v.readyState > 0 && r.width * r.height > screen * 0.25 && !(v.muted && v.loop)) return true;
    }
    // music players (Spotify...) have no picture: a playing audio element counts
    for (const a of document.querySelectorAll('audio')) if (a.readyState > 0 && !a.paused && !a.ended) return true;
    return false;
  })()`;
}

// Runs inside the page. Netflix throws an error if a script sets currentTime, so it gets arrow keys.
function seekScript(seconds) {
  const d = Math.max(-120, Math.min(120, Math.round(Number(seconds) || 0)));
  return `(() => {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect(), a = r.width * r.height;
      if (a > area && v.readyState > 0) { area = a; best = v; }
    }
    if (!best) return 'none';
    if (/(^|\\.)netflix\\.com$/.test(location.hostname)) return 'keys';
    const s = best.seekable;
    const lo = s.length ? s.start(0) : 0;
    const hi = s.length ? s.end(s.length - 1) : (isFinite(best.duration) ? best.duration : best.currentTime);
    best.currentTime = Math.max(lo, Math.min(hi, best.currentTime + (${d})));
    return 'ok';
  })()`;
}

module.exports = {
  seekScript, mediaScript, playingScript, appLabel, siteOf, // exported for tests
  FOCUS_SCRIPT, // exported for tests
  events,
  focusState: () => focusState,
  connected: () => !!conn,
  /** URL of the shown tab as last seen (no DevTools round trip). */
  lastUrl: () => (conn && conn.url) || '',
  findBrowser,
  setPreference(p) { preference = ['chrome', 'edge'].includes(p) ? p : 'auto'; },
  /**
   * Set the kiosk's UI scale (1 = 100%). The browser only reads it at start-up, so a
   * running kiosk is restarted (back to the home screen) when `restart` is true.
   */
  async setUiScale(f, { restart = false } = {}) {
    uiScale = f ? Math.min(4, Math.max(0.5, Number(f))) : null;
    if (!restart || uiScale === launchedScale || !conn) return false;
    console.log(`[browser] UI scale -> ${uiScale ?? 'system'}, restarting the kiosk`);
    await module.exports.restartBrowser();
    return true;
  },
  getUiScale: () => ({ wanted: uiScale, running: launchedScale }),

  /**
   * Choose which screen the kiosk uses, and its scale, in one go (one restart).
   * @param {{scale?: number|null, position?: {x:number,y:number}|null}} p
   */
  async setPlacement(p, { restart = false } = {}) {
    if ('scale' in p) uiScale = p.scale ? Math.min(4, Math.max(0.5, Number(p.scale))) : null;
    if ('position' in p) windowPos = p.position || null;
    const same = uiScale === launchedScale && JSON.stringify(windowPos) === JSON.stringify(launchedPos);
    if (!restart || same || !conn) return false;
    console.log(`[browser] kiosk placement -> scale ${uiScale ?? 'system'}, position ${JSON.stringify(windowPos)}; restarting`);
    await module.exports.restartBrowser();
    return true;
  },

  /** Secure DNS provider for the kiosk ('off' | 'cloudflare' | 'google' | 'quad9' | 'adguard'); restarts it. */
  async setSecureDns(v, { restart = false } = {}) {
    v = DOH[v] ? v : 'off';
    if (v === secureDns) return false;
    secureDns = v;
    if (!restart || !conn) return false;
    console.log(`[browser] secure DNS -> ${v}, restarting the kiosk`);
    await module.exports.restartBrowser();
    return true;
  },

  /** Incognito: restart the kiosk with an empty throwaway profile (or back to the normal one). */
  isIncognito: () => incognito,
  async setIncognito(on) {
    on = !!on;
    if (on === incognito) return false;
    incognito = on;
    try { on ? fs.writeFileSync(incognitoMarker(), '') : fs.rmSync(incognitoMarker(), { force: true }); } catch {}
    console.log(`[browser] incognito ${on ? 'on' : 'off'}, restarting the kiosk`);
    events.emit('incognito', on);
    await module.exports.closeBrowser();
    await waitClosed();
    if (!on) wipeIncognito();
    if (!(await launch())) {
      incognito = false; try { fs.rmSync(incognitoMarker(), { force: true }); } catch {}
      events.emit('incognito', false);
      throw new Error('Chrome or Microsoft Edge is not installed');
    }
    return true;
  },

  async setYoutubeFill(m) {
    ytMode = ['zoom', 'stretch', 'fit'].includes(m) ? m : 'auto';
    if (!conn) return;
    try { // re-register for future pages and apply to the open one right away
      if (conn.pageScriptId) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: conn.pageScriptId });
      conn.pageScriptId = (await call('Page.addScriptToEvaluateOnNewDocument', { source: pageScript() })).identifier;
      await call('Runtime.evaluate', { expression: `window.__pctvSetYtMode && window.__pctvSetYtMode('${ytMode}')` });
    } catch {}
  },
  init({ home, kiosk, profileDir: dir, browserPath, browserPreference, youtubeFill, uiScale: scale, windowPosition, secureDns: dns }) {
    if (DOH[dns]) secureDns = dns;
    if (scale) uiScale = scale;
    if (windowPosition) windowPos = windowPosition;
    if (browserPreference) module.exports.setPreference(browserPreference);
    if (youtubeFill) ytMode = youtubeFill;
    homeUrl = home;
    kioskEnabled = true; // Home/relaunch may (re)open the kiosk
    profileDir = dir;
    forcedBrowser = browserPath || null;
    // after a launcher restart the kiosk is usually still open: reuse it (and stay
    // incognito if it was). If it isn't running, an old incognito session is over.
    const wasIncognito = fs.existsSync(incognitoMarker());
    listPages().then(() => {
      incognito = wasIncognito;
      console.log(`[browser] kiosk already running, reusing it${incognito ? ' (incognito)' : ''}`);
    }).catch(() => {
      if (wasIncognito) { try { fs.rmSync(incognitoMarker(), { force: true }); } catch {} wipeIncognito(); }
      if (kiosk) launch();
    });
    // keep a DevTools connection open so focus events arrive without any command first
    let warned = false;
    setInterval(() => {
      if (conn) { warned = false; return; }
      connect().catch(e => {
        if (!warned) console.warn(`[browser] DevTools not reachable on port ${CDP_PORT} (${e.message}) - retrying`);
        warned = true;
      });
    }, 2000);
  },

  /** F5 on the kiosk tab. */
  async reload() {
    await connect();
    await call('Page.reload', { ignoreCache: true });
  },

  /** Show the kiosk: focus it if it's running, otherwise start it. */
  async launchOrFocus() {
    try {
      const c = await connect();
      await call('Page.bringToFront');
      await ensureFullscreen(c.targetId);
      return true;
    } catch {
      if (!(await launch())) throw new Error('Chrome or Microsoft Edge is not installed');
      return true;
    }
  },

  /**
   * Type text into the kiosk page. YouTube's TV app only accepts real key presses,
   * so there we send DevTools key events; elsewhere returns false and the caller
   * uses OS-level input (works in every normal text field).
   */
  async typeText(text) {
    await connect();
    const r = await call('Runtime.evaluate', { returnByValue: true, expression:
      `!!document.querySelector('yt-keyboard-key, [class*="ytKeyboardKey"]') || /^https:\\/\\/(www\\.)?youtube\\.com\\/tv/.test(location.href)` });
    if (!r.result?.value) return false;
    for (const ev of keyEventsFor(text)) await call('Input.dispatchKeyEvent', ev);
    return true;
  },

  /** Start YouTube TV's voice search (PC microphone). Returns false when not on YouTube TV. */
  async startVoiceSearch() {
    await connect();
    const r = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      if (!/youtube\\.com$/.test(location.hostname) || !location.pathname.startsWith('/tv')) return null;
      const b = [...document.querySelectorAll('ytlr-search-voice-mic-button')].find(e => e.getBoundingClientRect().width > 0);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()` });
    const p = r.result?.value;
    if (!p) return false;
    // the TV app ignores element.click(); a real (trusted) mouse click starts listening
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    return true;
  },

  /** Play/pause the media on the page (or in the parked app). Returns false if there is none to control. */
  async togglePlayback() {
    try {
      return (await evalMedia(`(() => {
        let best = null, area = -1;
        for (const v of document.querySelectorAll('video,audio')) {
          if (v.readyState <= 0) continue;
          const r = v.getBoundingClientRect(), a = r.width * r.height;
          if (a > area) { area = a; best = v; }
        }
        if (!best) return false;
        best.paused ? best.play() : best.pause();
        return true;
      })()`)) === true;
    } catch { return false; }
  },

  /**
   * Skip the biggest video on the page by `seconds` (negative = back).
   * Returns 'ok', 'keys' (the site blocks scripted seeking: send arrow keys instead) or 'none'.
   */
  async seek(seconds) {
    try { return (await evalMedia(seekScript(seconds))) || 'none'; } catch { return 'none'; }
  },

  /** Is something playing/showing that the phone's playback buttons can control? */
  async hasMedia() {
    try {
      if (parked) return !!(await module.exports.nowPlaying());
      return (await evalMedia(mediaScript())) === true;
    } catch { return false; }
  },

  /** What the parked (background) app is playing, or null when nothing is parked. */
  async nowPlaying() {
    if (!parked) return null;
    try {
      const info = await evalOn(parked.id, playingScript());
      const page = (await listPages()).find(p => p.id === parked.id);
      const host = info?.host || (page ? new URL(page.url).hostname : '');
      return {
        app: appLabel(host), host,
        title: info?.title || page?.title || appLabel(host),
        artist: info?.artist || '', art: info?.art || '',
        playing: !!info?.playing,
      };
    } catch {
      parked = null; // the tab was closed or crashed
      return null;
    }
  },
  isParked: () => !!parked,

  /** Bring the parked app back on screen. */
  async resume() {
    if (!parked) return false;
    const p = parked;
    try {
      if (!(await listPages()).some(x => x.id === p.id)) { parked = null; return false; }
      parked = null; // connect() may now close the launcher tab
      await switchTo(p.id);
      try { await call('Runtime.evaluate', { expression: UNSPOOF_VISIBLE }); } catch {}
      if (p.tv) await setUA(TV_UA);
      appTv = !!p.tv;
      await call('Page.bringToFront');
      await closeExtraPages().catch(() => {});
      ensureFullscreen(conn.targetId);
      return true;
    } catch (e) { console.warn('[browser] could not resume the app:', e.message); parked = null; return false; }
  },

  /** Stop the background app (closes its tab). */
  async stopParked() {
    if (!parked) return false;
    const id = parked.id; parked = null;
    await closeTab(id);
    return true;
  },

  /** Close the kiosk browser window. */
  async closeBrowser() {
    try { await connect(); await call('Browser.close'); } catch {}
    conn = null; parked = null;
  },

  /** Close and reopen the kiosk browser. */
  async restartBrowser() {
    await module.exports.closeBrowser();
    if (!(await waitClosed())) console.warn('[browser] old browser still running after 10 s');
    if (!(await launch())) throw new Error('Chrome or Microsoft Edge is not installed');
  },

  /** Open a tile URL in the kiosk tab. tvMode = use TV user agent. */
  async open(url, tvMode) {
    await connect();
    if (parked) { // an app is playing in the background
      const pp = (await listPages()).find(p => p.id === parked.id);
      if (pp && siteOf(pp.url) && siteOf(pp.url) === siteOf(url)) { // same app: just come back to it
        if (await module.exports.resume()) return;
      }
      await module.exports.stopParked(); // a different app replaces it
    }
    await closeExtraPages().catch(() => {}); // pop-ups/tabs from the previous app
    await setUA(tvMode ? TV_UA : null);
    appTv = !!tvMode;
    await call('Page.navigate', { url });
    await call('Page.bringToFront');
  },

  async home() {
    try {
      await connect();
      const me = (await listPages()).find(p => p.id === conn.targetId);
      if (me && !isHome(me.url) && !parked) {
        // leaving an app: if it is playing, keep it running in its own tab behind the launcher
        let playing = false;
        try { playing = (await call('Runtime.evaluate', { returnByValue: true, expression: playingScript() })).result?.value?.playing === true; } catch {}
        if (playing) {
          const appId = conn.targetId;
          const launcher = (await listPages()).find(p => p.id !== appId && isHome(p.url));
          parked = { id: appId, tv: appTv };
          try { await call('Runtime.evaluate', { expression: SPOOF_VISIBLE }); } catch {}
          const lid = launcher ? launcher.id : await newTab(homeUrl);
          await switchTo(lid);
          await setUA(null);
          await call('Page.bringToFront');
          ensureFullscreen(conn.targetId);
          return true;
        }
      }
      await closeExtraPages();
      await setUA(null);
      appTv = false;
      await call('Page.navigate', { url: homeUrl });
      await call('Page.bringToFront');
      ensureFullscreen(conn.targetId);
      return true;
    } catch (e) {
      // Browser closed or crashed: relaunch it in kiosk mode.
      parked = null;
      if (kioskEnabled) { await launch(); return true; }
      return false;
    }
  },

  /** Returns 'handled' if CDP did a history back, or the current URL kind. */
  async back() {
    await connect();
    const { currentIndex, entries } = await call('Page.getNavigationHistory');
    const cur = entries[currentIndex]?.url || '';
    if (isHome(cur)) return 'launcher';
    if (/youtube\.com\/tv/.test(cur)) return 'tvapp';
    if (currentIndex > 0) {
      const prev = entries[currentIndex - 1];
      if (isHome(prev.url)) await setUA(null);
      await call('Page.navigateToHistoryEntry', { entryId: prev.id });
      return 'handled';
    }
    await module.exports.home();
    return 'handled';
  },

  /** Is the kiosk on screen and in front (not minimised, not behind another app)? */
  async isForeground() {
    if (!conn) return false;
    try {
      const r = await call('Runtime.evaluate', { returnByValue: true, expression: "document.visibilityState === 'visible' && document.hasFocus()" });
      return r.result?.value === true;
    } catch { return false; }
  },

  async currentUrl() {
    try {
      await connect();
      const { currentIndex, entries } = await call('Page.getNavigationHistory');
      return entries[currentIndex]?.url || null;
    } catch { return null; }
  },
};
