// macOS: battery via `pmset`, Wi-Fi via `networksetup` / `ipconfig` / `system_profiler`
// (all built into macOS).
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 6000) => new Promise(resolve =>
  execFile(cmd, args, { timeout }, (err, out) => resolve(err ? '' : String(out))));

async function battery() {
  const out = await run('pmset', ['-g', 'batt']);
  const plugged = /AC Power/.test(out);
  const m = out.match(/(\d+)%;\s*([^;]+);\s*(?:(\d+):(\d+))?/);
  if (!m) return { present: false, plugged };
  const state = m[2].trim().toLowerCase();
  return {
    present: true,
    percent: Number(m[1]),
    plugged,
    charging: state.startsWith('charging') || state === 'finishing charge',
    minutesLeft: m[3] != null && !plugged ? Number(m[3]) * 60 + Number(m[4]) : null,
  };
}

let wifiDevice = null;
let profilerCache = { at: 0, ssid: null, signal: null };

async function findWifiDevice() {
  if (wifiDevice) return wifiDevice;
  const out = await run('networksetup', ['-listallhardwareports']);
  const m = out.match(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\w+)/);
  wifiDevice = m ? m[1] : 'en0';
  return wifiDevice;
}

// system_profiler is slow (1–3 s), so it is read at most every 30 s
async function profiler() {
  if (Date.now() - profilerCache.at < 30000) return profilerCache;
  const out = await run('system_profiler', ['SPAirPortDataType', '-json'], 10000);
  let ssid = null, signal = null;
  try {
    const ifaces = JSON.parse(out).SPAirPortDataType?.[0]?.spairport_airport_interfaces || [];
    for (const i of ifaces) {
      const cur = i.spairport_current_network_information;
      if (!cur) continue;
      if (cur._name && !/redacted/i.test(cur._name)) ssid = cur._name;
      const dbm = parseInt(String(cur.spairport_signal_noise || '').split('/')[0], 10);
      if (!Number.isNaN(dbm)) signal = Math.max(0, Math.min(100, 2 * (dbm + 100)));
    }
  } catch {}
  profilerCache = { at: Date.now(), ssid, signal };
  return profilerCache;
}

async function network() {
  const dev = await findWifiDevice();
  const summary = await run('ipconfig', ['getsummary', dev]);
  const connected = /LinkStatusActive\s*:\s*TRUE/i.test(summary) || /SSID\s*:/.test(summary);
  if (!connected) return null;
  let ssid = (summary.match(/^\s*SSID\s*:\s*(.+)$/m) || [])[1]?.trim() || null;
  if (ssid && /redacted/i.test(ssid)) ssid = null; // macOS 14.4+ hides it without Location access
  if (!ssid) {
    const old = await run('networksetup', ['-getairportnetwork', dev]);
    const m = old.match(/Current Wi-Fi Network:\s*(.+)/);
    if (m) ssid = m[1].trim();
  }
  const p = await profiler();
  return { type: 'wifi', ssid: ssid || p.ssid, signal: p.signal };
}

module.exports = { battery, network };
