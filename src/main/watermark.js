// Unsupported-copy watermark on the TV, like Windows' "Activate Windows":
// small, 40 % opacity, click-through, never takes focus, never blocks anything.
// It's a small transparent window in a corner (not a full-screen layer), so it
// can't interfere with full-screen video. OLED safety: it fades to another
// corner every few minutes and never sits in exactly the same spot.
const { BrowserWindow } = require('electron');
const path = require('path');

const W = 620, H = 40, MARGIN = 26, JITTER = 22;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createWatermark({ text, moveEveryMs = 5 * 60e3, getDisplay }) {
  let win = null, visible = false, busy = false, corner = 0, lastMove = 0, left = false;

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
      ...(process.platform === 'linux' && { type: 'toolbar' }),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, 'watermark.html'), { query: { text } });
    win.on('closed', () => { win = null; visible = false; });
    return win;
  }

  function place() {
    const b = getDisplay().bounds;
    const j = () => Math.round(Math.random() * JITTER);
    left = corner === 1 || corner === 2;          // 0 bottom-right, 1 bottom-left, 2 top-left, 3 top-right
    const top = corner === 2 || corner === 3;
    const x = left ? b.x + MARGIN + j() : b.x + b.width - W - MARGIN - j();
    const y = top ? b.y + MARGIN + j() : b.y + b.height - H - MARGIN - j();
    win.setBounds({ x, y, width: W, height: H });
  }
  const run = js => win && !win.isDestroyed() && win.webContents.executeJavaScript(js).catch(() => {});

  return {
    get visible() { return visible; },
    async show() {
      if (busy) return;
      busy = true;
      try {
        ensure();
        if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
        if (!visible) {
          place();
          win.showInactive();
          await run(`fadeIn(${left})`);
          visible = true; lastMove = Date.now();
        } else if (Date.now() - lastMove >= moveEveryMs) {
          await run('fadeOut()'); await sleep(900);
          corner = (corner + 1 + Math.floor(Math.random() * 3)) % 4; // any other corner
          place();
          await run(`fadeIn(${left})`);
          lastMove = Date.now();
        } else {
          win.setAlwaysOnTop(true, 'screen-saver'); // stay above the kiosk
          win.moveTop();
        }
      } finally { busy = false; }
    },
    async hide() {
      if (!visible || busy || !win) return;
      busy = true;
      try { await run('fadeOut()'); await sleep(850); if (win && !win.isDestroyed()) win.hide(); visible = false; }
      finally { busy = false; }
    },
    replace() { if (visible && win) place(); },      // the kiosk moved to another screen
    destroy() { if (win && !win.isDestroyed()) win.destroy(); win = null; visible = false; },
  };
}

module.exports = { createWatermark };
