// Auto-update for the installed app, on top of electron-updater (GitHub Releases).
//
// - Windows installer builds: checks quietly, downloads in the background, then waits.
//   It NEVER restarts by itself while someone is watching: the update installs when the
//   user taps "Restart to update" (TV, phone or tray) or the next time the app is quit.
// - macOS: the DMG is only ad-hoc signed, and macOS refuses to replace such an app, so
//   there it just announces the new version and opens the download page.
// - Microsoft Store builds update through the Store; `npm run dev` never updates.
//
// The electron-updater object is passed in, so the logic below is unit-tested with a fake.
const { EventEmitter } = require('events');

const RELEASES_URL = 'https://github.com/fragmentedbin/pctv-home/releases/latest';
const FIRST_CHECK_MS = 45 * 1000;           // let the kiosk come up first
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function createUpdater({ autoUpdater, app, platform = process.platform, isStore = false, isEnabled = () => true, openExternal = () => {}, log = console }) {
  const events = new EventEmitter();
  const reason = !autoUpdater ? 'missing' : !app.isPackaged ? 'dev' : isStore ? 'store' : null;
  const canInstall = !reason && platform !== 'darwin'; // unsigned macOS apps can't replace themselves
  let state = {
    status: reason ? 'unsupported' : 'idle', // idle | checking | available | downloading | ready | error | unsupported
    reason, canInstall, current: app.getVersion(),
    version: null, percent: 0, error: null, lastChecked: null,
  };
  let manual = false;     // the person asked for this check (so it also downloads, and errors are shown)
  let timers = [];

  const set = patch => { state = { ...state, ...patch }; events.emit('state', state); };
  const short = e => String(e && e.message || e || 'Update failed').split('\n')[0].slice(0, 160);

  if (!reason) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = canInstall; // a ready update installs when the app is next quit
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => { if (state.status !== 'downloading' && state.status !== 'ready') set({ status: 'checking' }); });
    autoUpdater.on('update-available', info => {
      set({ status: 'available', version: info.version, error: null, lastChecked: Date.now() });
      if (canInstall && (manual || isEnabled())) download();
    });
    autoUpdater.on('update-not-available', () => {
      if (state.status === 'ready' || state.status === 'downloading') return;
      set({ status: 'idle', version: null, error: null, lastChecked: Date.now() });
    });
    autoUpdater.on('download-progress', p => set({ status: 'downloading', percent: Math.max(0, Math.min(99, Math.round(p.percent || 0))) }));
    autoUpdater.on('update-downloaded', info => set({ status: 'ready', version: info.version || state.version, percent: 100, error: null }));
    autoUpdater.on('error', e => {
      log.warn?.('[update]', short(e));
      // a failed background check (offline, rate limit) stays quiet; a failed download or a manual check is shown
      const loud = manual || state.status === 'downloading';
      set({ status: loud ? 'error' : (state.status === 'ready' ? 'ready' : 'idle'), error: short(e), lastChecked: Date.now() });
    });
  }

  function download() {
    set({ status: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate().catch(() => {}); // failures arrive through the 'error' event
  }

  function check(isManual = false) {
    if (reason) return state;
    if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
    manual = !!isManual;
    set({ status: 'checking', error: null });
    autoUpdater.checkForUpdates().catch(() => {});
    return state;
  }

  // "Restart to update" / "Get update"
  function install() {
    if (reason) return { ok: false, reason };
    if (!canInstall) { openExternal(RELEASES_URL); return { ok: true, opened: true }; }
    if (state.status === 'ready') { autoUpdater.quitAndInstall(true, true); return { ok: true }; }
    if (state.status === 'available') { manual = true; download(); return { ok: true }; }
    return { ok: false, reason: 'nothing to install' };
  }

  function start() {
    if (reason) { log.log?.(`[update] off (${reason})`); return; }
    const tick = () => { if (isEnabled()) check(false); };
    const first = setTimeout(tick, FIRST_CHECK_MS);
    const every = setInterval(tick, CHECK_EVERY_MS);
    first.unref?.(); every.unref?.();
    timers = [first, every];
  }
  const stop = () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers = []; };

  return { events, state: () => state, check, install, start, stop, RELEASES_URL };
}

module.exports = { createUpdater, RELEASES_URL };
