// Unsupported-copy watermark on the TV, like Windows' "Activate Windows":
// plain gray text at 50 % opacity, no background, click-through, never takes focus, never blocks anything.
// It's a small transparent window in a bottom corner (not a full-screen layer), so it
// can't interfere with full-screen video. OLED safety: it fades to the other
// bottom corner every few minutes and never sits in exactly the same spot.
const { BrowserWindow } = require('electron');
const path = require('path');

const W = 360, H = 40, MARGIN_X = 40, MARGIN_Y = 64, JITTER = 22;
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
    // bottom corners only, like Windows: the top edge is where TV Home and the
    // apps keep their own menus, and the note shouldn't sit on top of them
    left = corner === 1;                          // 0 bottom-right, 1 bottom-left
    const top = false;
    const x = left ? b.x + MARGIN_X + j() : b.x + b.width - W - MARGIN_X - j();
    const y = top ? b.y + MARGIN_Y + j() : b.y + b.height - H - MARGIN_Y - j();
    win.setBounds({ x, y, width: W, height: H });
  }
  const run = js => win && !win.isDestroyed() && win.webContents.executeJavaScript(js).catch(() => {});

  return {
    get visible() { return visible; },
    /** @param {{leftOnly?: boolean}} o leftOnly: TV Home has its phone-remote card bottom-right */
    async show(o = {}) {
      if (busy) return;
      busy = true;
      try {
        ensure();
        if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
        if (o.leftOnly && corner !== 1) { // keep clear of TV Home's own bottom-right card
          if (visible) { await run('fadeOut()'); await sleep(900); }
          corner = 1; place(); win.showInactive(); await run(`fadeIn(${left})`);
          visible = true; lastMove = Date.now();
        } else if (!visible) {
          place();
          win.showInactive();
          await run(`fadeIn(${left})`);
          visible = true; lastMove = Date.now();
        } else if (Date.now() - lastMove >= moveEveryMs) {
          await run('fadeOut()'); await sleep(900);
          if (!o.leftOnly) corner = 1 - corner; // the other bottom corner; on TV Home it just shifts a little
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
