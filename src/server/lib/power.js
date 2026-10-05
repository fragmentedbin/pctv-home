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

module.exports = {
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
