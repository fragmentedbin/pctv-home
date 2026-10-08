// Sleep / restart / shut down the computer.
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise((resolve, reject) => {
  if (process.env.PCTV_DRY_POWER || !['win32', 'darwin'].includes(process.platform)) {
    console.log('[power:dry-run]', cmd, args.join(' ')); return resolve();
  }
  execFile(cmd, args, { windowsHide: true }, err => err ? reject(err) : resolve());
});

let SetSuspendState = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    SetSuspendState = koffi.load('powrprof.dll').func('uint8 __stdcall SetSuspendState(uint8 hibernate, uint8 force, uint8 wakeupEventsDisabled)');
  } catch (e) { console.error('[power]', e.message); }
}

// Turn the display off (the PC keeps running) and back on. SC_MONITORPOWER: 2 = off, -1 = on.
let PostMessageW = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    PostMessageW = koffi.load('user32.dll').func('int __stdcall PostMessageW(intptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)');
  } catch (e) { console.error('[power]', e.message); }
}
const HWND_BROADCAST = 0xFFFF, WM_SYSCOMMAND = 0x112, SC_MONITORPOWER = 0xF170;

module.exports = {
  async displayOff() {
    if (process.platform === 'win32' && !process.env.PCTV_DRY_POWER) {
      if (!PostMessageW || !PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)) throw new Error('Could not turn the screen off');
      return;
    }
    return run('pmset', ['displaysleepnow']);
  },
  async displayOn() {
    if (process.platform === 'win32' && !process.env.PCTV_DRY_POWER) {
      if (PostMessageW) PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, -1);
      return;
    }
    return run('caffeinate', ['-u', '-t', '2']);
  },
  async sleep() {
    if (process.platform === 'win32') {
      if (process.env.PCTV_DRY_POWER) return run('SetSuspendState', []);
      if (!SetSuspendState || !SetSuspendState(0, 0, 0)) throw new Error('Sleep failed');
      return;
    }
    return run('pmset', ['sleepnow']);
  },
  reboot: () => process.platform === 'win32'
    ? run('shutdown', ['/r', '/t', '0'])
    : run('osascript', ['-e', 'tell application "System Events" to restart']),
  shutdown: () => process.platform === 'win32'
    ? run('shutdown', ['/s', '/t', '0'])
    : run('osascript', ['-e', 'tell application "System Events" to shut down']),
};
