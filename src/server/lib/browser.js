// Launches Chrome/Edge in kiosk mode and controls it over the Chrome DevTools
// Protocol (localhost only): go Home, history Back, and a TV user agent for
// youtube.com/tv (desktop Chrome gets redirected away from it otherwise).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const NAV_SCRIPT = require('./tv-nav');

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
    const info = !editable ? { editable: false } : {
      editable: true,
      type: (el.type || 'text').toLowerCase(),
      inputmode: (el.inputMode || el.getAttribute('inputmode') || '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.name || el.id || '',
      label: el.getAttribute('aria-label') || el.placeholder || (el.labels && el.labels[0] && el.labels[0].innerText) || '',
      maxlength: el.maxLength > 0 ? el.maxLength : 0,
    };
    try { window.__tvFocus(JSON.stringify(info)); } catch (e) {}
  };
  let t; const schedule = () => { clearTimeout(t); t = setTimeout(report, 50); };
  addEventListener('focusin', schedule, true);
  addEventListener('focusout', schedule, true);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', schedule); else schedule();

  // Page CSS via a constructed stylesheet: unlike a <style> tag it isn't blocked by
  // sites' Content-Security-Policy (YouTube blocks inline styles).
  // Hidden scrollbars everywhere (pages still scroll), TV-style.
  let rules = 'html.__tv-idle, html.__tv-idle * { cursor: none !important; }' +
    '* { scrollbar-width: none !important; }' +
    '::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }';
  // YouTube TV locks its UI to a centred 16:9 box -> black bands on 16:10 screens.
  if (location.hostname.endsWith('youtube.com') && location.pathname.startsWith('/tv')) {
    rules += '#container, #app-background { margin: 0 !important; top: 0 !important; left: 0 !important;' +
             ' width: 100vw !important; height: 100vh !important; }' +
             'html, body { overflow: hidden !important; }'; // the TV app never scrolls the page
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

function launch() {
  const b = findBrowser();
  if (!b) { console.error('[browser] Chrome/Edge not found.'); return false; }
  const args = [
    '--kiosk', homeUrl,
    `--user-data-dir=${profileDir}-${/edge/i.test(b.name) ? 'edge' : 'chrome'}`, // separate profile per browser
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
    '--disable-features=Translate',
    '--overscroll-history-navigation=0',
    '--hide-scrollbars',
  ];
  console.log(`[browser] launching ${b.name} in kiosk mode`);
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
    await call('Page.addScriptToEvaluateOnNewDocument', { source: FOCUS_SCRIPT });
    await call('Runtime.evaluate', { expression: FOCUS_SCRIPT }); // page already open
    await call('Page.addScriptToEvaluateOnNewDocument', { source: NAV_SCRIPT });
    await call('Runtime.evaluate', { expression: NAV_SCRIPT });
  } catch (e) { console.warn('[browser] focus hook failed:', e.message); }
  if (!defaultUA) {
    try { defaultUA = (await call('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome'); } catch {}
  }
  return c;
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
  events,
  focusState: () => focusState,
  connected: () => !!conn,
  findBrowser,
  setPreference(p) { preference = ['chrome', 'edge'].includes(p) ? p : 'auto'; },
  init({ home, kiosk, profileDir: dir, browserPath, browserPreference }) {
    if (browserPreference) module.exports.setPreference(browserPreference);
    homeUrl = home;
    kioskEnabled = true; // Home/relaunch may (re)open the kiosk
    profileDir = dir;
    forcedBrowser = browserPath || null;
    // after a launcher restart the kiosk is usually still open: reuse it
    if (kiosk) listPages().then(() => console.log('[browser] kiosk already running, reusing it')).catch(() => launch());
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
      await connect();
      await call('Page.bringToFront');
      return true;
    } catch {
      if (!launch()) throw new Error('Chrome or Microsoft Edge is not installed');
      return true;
    }
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
