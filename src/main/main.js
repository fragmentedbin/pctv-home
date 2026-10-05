// PCTV Home desktop app: runs the TV/remote server in the background (tray /
// menu bar), opens the kiosk browser, and shows a small control panel for pairing.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { createServer } = require('../server');

const DEV = process.argv.includes('--dev');
const ICONS = path.join(__dirname, 'icons'); // runtime copies of build/ icons (see scripts/make-icons.py)
const isStore = process.windowsStore === true; // MSIX / Microsoft Store build
const PORT = Number(process.env.PORT || 3000);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.fragmentedbin.pctvhome');

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { openOnStart: true, firstRun: true, browser: 'auto', youtubeFill: 'auto', uiScale: 'auto' };

// ---------- TV size (kiosk UI scale) ----------
// 'auto' sizes websites for viewing from the couch on whatever screen the kiosk is
// on: the page gets ~1280×720 CSS pixels (1080p TV → 150%, 4K → 300%), no matter
// what Windows/macOS scaling each display uses. A number forces a scale, 'system'
// leaves it to the OS.
const SCALES = ['auto', 'system', 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function kioskDisplay() {
  // the kiosk opens on the primary display; with a TV/monitor attached that's usually the one you want
  return screen.getPrimaryDisplay();
}
function autoScale() {
  const d = kioskDisplay();
  const w = d.size.width * d.scaleFactor, h = d.size.height * d.scaleFactor; // physical pixels
  const f = Math.min(w / 1280, h / 720);
  return Math.min(3, Math.max(1, Math.round(f * 4) / 4)); // steps of 25 %
}
function effectiveScale() {
  if (settings.uiScale === 'system') return null;
  if (settings.uiScale === 'auto') return autoScale();
  return Number(settings.uiScale) || null;
}
let displayTimer = null;
function watchDisplays() {
  const changed = () => {
    clearTimeout(displayTimer);
    displayTimer = setTimeout(async () => { // wait until Windows has finished re-arranging the screens
      if (settings.uiScale !== 'auto') return;
      try {
        if (await server.setUiScale(effectiveScale(), { restart: true })) {
          console.log('[display] screen changed, kiosk restarted at', effectiveScale());
        }
      } catch (e) { console.error('[display]', e.message); }
    }, 2500);
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', changed);
}
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// Store (MSIX) builds start at login through the package's startup task instead.
function getStartAtLogin() {
  if (isStore || !app.isPackaged) return undefined; // dev runs (npm start) never register at login
  return app.getLoginItemSettings({ args: ['--background'] }).openAtLogin;
}
function setStartAtLogin(on) {
  if (isStore || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--background'] });
}

// ---------- windows ----------
let panel = null, tray = null, server = null;
const startedInBackground = process.argv.includes('--background') ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);

function showPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  panel = new BrowserWindow({
    width: 520, height: 760, minWidth: 460, minHeight: 600,
    title: 'PCTV Home', backgroundColor: '#0f1016', show: false, autoHideMenuBar: true,
    icon: path.join(ICONS, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  panel.loadURL(`http://localhost:${PORT}/panel`);
  panel.once('ready-to-show', () => panel.show());
  panel.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } }); // keep running in the tray
}

function trayImage() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(ICONS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ICONS, 'tray.png'));
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('PCTV Home');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open TV Home', click: () => server.openKiosk().catch(e => dialog.showErrorBox('PCTV Home', e.message)) },
    { label: 'Pair phone / settings…', click: showPanel },
    { type: 'separator' },
    ...(getStartAtLogin() === undefined ? [] : [{
      label: 'Start with my computer', type: 'checkbox', checked: getStartAtLogin(),
      click: item => setStartAtLogin(item.checked),
    }]),
    { label: 'Restart PCTV Home', click: restart },
    { type: 'separator' },
    { label: 'Quit PCTV Home', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('right-click', () => tray.setContextMenu(menu()));
  if (process.platform === 'win32') tray.on('click', showPanel);
}

function restart() {
  app.isQuitting = true;
  try { server?.stop(); } catch {}
  app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--background').concat('--background') });
  app.exit(0);
}

// ---------- macOS permission ----------
function ensureAccessibility() {
  if (process.platform !== 'darwin') return;
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt once
  }
}

// ---------- start ----------
app.on('second-instance', showPanel);
app.on('window-all-closed', e => e.preventDefault?.()); // stay in the tray
app.on('before-quit', () => { app.isQuitting = true; server?.stop(); });
app.on('activate', showPanel); // macOS dock click

app.whenReady().then(async () => {
  loadSettings();
  if (process.platform === 'darwin' && !DEV) app.dock?.hide(); // menu-bar app
  if (settings.firstRun) setStartAtLogin(true); // installed app: start with the computer by default

  server = createServer({
    dataDir: path.join(app.getPath('userData'), 'data'),
    port: PORT,
    kiosk: settings.openOnStart && !(settings.firstRun && !startedInBackground),
    browserPreference: settings.browser,
    youtubeFill: settings.youtubeFill,
    uiScale: effectiveScale(),
    watchDir: DEV ? path.join(__dirname, '..') : null,
    onRestart: restart,
    app: {
      getState: () => ({
        startAtLogin: getStartAtLogin(),
        openOnStart: settings.openOnStart,
        browser: settings.browser,
        youtubeFill: settings.youtubeFill,
        uiScale: settings.uiScale,
        uiScaleEffective: effectiveScale(),
        display: (() => { const d = kioskDisplay(); return { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor, osScale: d.scaleFactor }; })(),
        store: isStore,
        packaged: app.isPackaged,
        accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : null,
      }),
      update: async body => {
        if (typeof body.startAtLogin === 'boolean') setStartAtLogin(body.startAtLogin);
        if (typeof body.openOnStart === 'boolean') { settings.openOnStart = body.openOnStart; saveSettings(); }
        if (['auto', 'chrome', 'edge'].includes(body.browser)) {
          settings.browser = body.browser; saveSettings(); server.setBrowserPreference(body.browser);
        }
        if (body.uiScale !== undefined && SCALES.includes(body.uiScale)) {
          settings.uiScale = body.uiScale; saveSettings();
          await server.setUiScale(effectiveScale(), { restart: true });
        }
        if (['auto', 'zoom', 'stretch', 'fit'].includes(body.youtubeFill)) {
          settings.youtubeFill = body.youtubeFill; saveSettings(); await server.setYoutubeFill(body.youtubeFill);
        }
        if (body.action === 'accessibility') {
          systemPreferences.isTrustedAccessibilityClient(true);
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        }
        if (body.action === 'open-url' && /^https:\/\//.test(body.url || '')) shell.openExternal(body.url);
        return { ok: true };
      },
    },
  });

  try {
    await server.start();
  } catch (e) {
    dialog.showErrorBox('PCTV Home',
      e.code === 'EADDRINUSE'
        ? `Port ${PORT} is already used by another program (or another copy of PCTV Home).`
        : `PCTV Home could not start:\n${e.message}`);
    app.exit(1);
    return;
  }

  buildTray();
  watchDisplays();
  ensureAccessibility();
  if (settings.firstRun || !startedInBackground) showPanel(); // first run: show how to pair
  if (settings.firstRun) { settings.firstRun = false; saveSettings(); }
});
