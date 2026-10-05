// Windows: battery via kernel32!GetSystemPowerStatus (koffi), Wi-Fi via the
// built-in, Microsoft-signed `netsh` tool. No scripts are run.
const koffi = require('koffi');
const { execFile } = require('child_process');

const kernel32 = koffi.load('kernel32.dll');
const SYSTEM_POWER_STATUS = koffi.struct('PCTV_SYSTEM_POWER_STATUS', {
  ACLineStatus: 'uint8', BatteryFlag: 'uint8', BatteryLifePercent: 'uint8', SystemStatusFlag: 'uint8',
  BatteryLifeTime: 'uint32', BatteryFullLifeTime: 'uint32',
});
const GetSystemPowerStatus = kernel32.func('bool __stdcall GetSystemPowerStatus(_Out_ PCTV_SYSTEM_POWER_STATUS *status)');

const run = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { windowsHide: true, timeout: 6000, encoding: 'buffer' }, (err, out) => resolve(err ? '' : decode(out))));

// netsh prints in the console code page; try UTF-8 first, fall back to Latin-1
function decode(buf) {
  const s = buf.toString('utf8');
  return s.includes('�') ? buf.toString('latin1') : s;
}

async function battery() {
  const st = {};
  if (!GetSystemPowerStatus(st)) return { present: false };
  const noBattery = st.BatteryFlag === 128 || st.BatteryFlag === 255 || st.BatteryLifePercent === 255;
  if (noBattery) return { present: false, plugged: st.ACLineStatus === 1 };
  return {
    present: true,
    percent: st.BatteryLifePercent,
    plugged: st.ACLineStatus === 1,
    charging: (st.BatteryFlag & 8) !== 0,
    minutesLeft: st.BatteryLifeTime !== 0xffffffff ? Math.round(st.BatteryLifeTime / 60) : null,
  };
}

async function network() {
  // Labels are translated on non-English Windows, so values are matched by shape where possible.
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  let ssid = null, signal = null, connected = false;
  for (const line of out.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\s*SSID\s*:\s*(.+)$/))) ssid = m[1].trim();
    else if ((m = line.match(/:\s*(\d{1,3})\s*%\s*$/))) signal = Number(m[1]);
    if (/:\s*(connected|terhubung|verbunden|connecté|conectado|connesso|已连接|接続されました)\s*$/i.test(line)) connected = true;
  }
  if (ssid || (connected && signal != null)) return { type: 'wifi', ssid, signal };
  // Windows 11 24H2+ hides Wi-Fi details from netsh while Location is off; still report Wi-Fi if it's up
  if (/location|lokasi|standort|localisation/i.test(out) && /wlan|wi-?fi/i.test(out)) {
    return { type: 'wifi', ssid: null, signal: null, note: 'location-off' };
  }
  return null; // caller decides between ethernet and offline
}

module.exports = { battery, network };
