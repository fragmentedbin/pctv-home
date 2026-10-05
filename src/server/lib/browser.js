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

function launch() {
  const b = findBrowser();
  if (!b) { console.error('[browser] Chrome/Edge not found.'); return false; }
  if (incognito) wipeIncognito(); // every incognito launch starts empty
  // separate profile per browser; incognito gets a throwaway one
  const dataDir = incognito ? incognitoDir() : `${profileDir}-${/edge/i.test(b.name) ? 'edge' : 'chrome'}`;
  applySecureDns(dataDir);
  const args = [
    '--kiosk', homeUrl,
    `--user-data-dir=${dataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
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
  const page = pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl); // no Origin header -> allowed by Chrome
  const c = { ws, targetId: page.id, pending: new Map(), nextId: 1 };
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
      onFocusReport({ editable: false }); // new page in the main frame
    }
  });
  ws.on('close', () => { if (conn === c) { conn = null; onFocusReport({ editable: false }); } });
  conn = c;
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
  const pages = await listPages();
  for (const p of pages) {
    if (conn && p.id !== conn.targetId) {
      try { await fetch(`${CDP}/json/close/${p.id}`, { signal: AbortSignal.timeout(1000) }); } catch {}
    }
  }
}

module.exports = {
  FOCUS_SCRIPT, // exported for tests
  events,
  focusState: () => focusState,
  connected: () => !!conn,
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
    await new Promise(r => setTimeout(r, 2000));
    if (!on) wipeIncognito();
    if (!launch()) {
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
      if (!launch()) throw new Error('Chrome or Microsoft Edge is not installed');
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

  /** Play/pause the biggest video on the page. Returns false if there is none. */
  async togglePlayback() {
    try {
      await connect();
      const r = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        let best = null, area = 0;
        for (const v of document.querySelectorAll('video')) {
          const r = v.getBoundingClientRect(), a = r.width * r.height;
          if (a > area && v.readyState > 0) { area = a; best = v; }
        }
        if (!best) return false;
        best.paused ? best.play() : best.pause();
        return true;
      })()` });
      return !!r.result?.value;
    } catch { return false; }
  },

  /** Close the kiosk browser window. */
  async closeBrowser() {
    try { await connect(); await call('Browser.close'); } catch {}
    conn = null;
  },

  /** Close and reopen the kiosk browser. */
  async restartBrowser() {
    await module.exports.closeBrowser();
    await new Promise(r => setTimeout(r, 2000));
    if (!launch()) throw new Error('Chrome or Microsoft Edge is not installed');
  },

  /** Open a tile URL in the kiosk tab. tvMode = use TV user agent. */
  async open(url, tvMode) {
    await connect();
    await setUA(tvMode ? TV_UA : null);
    await call('Page.navigate', { url });
    await call('Page.bringToFront');
  },

  async home() {
    try {
      await connect();
      await closeExtraPages();
      await setUA(null);
      await call('Page.navigate', { url: homeUrl });
      await call('Page.bringToFront');
      ensureFullscreen(conn.targetId);
      return true;
    } catch (e) {
      // Browser closed or crashed: relaunch it in kiosk mode.
      if (kioskEnabled) { launch(); return true; }
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

  async currentUrl() {
    try {
      await connect();
      const { currentIndex, entries } = await call('Page.getNavigationHistory');
      return entries[currentIndex]?.url || null;
    } catch { return null; }
  },
};
