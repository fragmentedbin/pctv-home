// PC status for the home screen and remote: battery, network, internet ping.
// Polled every 5 s; platform specifics live in win32.js / darwin.js.
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const events = new EventEmitter();
let latest = null;
let timer = null;
let backend = null;
let tick = 0;
let netCache = null;

try {
  if (process.platform === 'win32') backend = require('./win32');
  else if (process.platform === 'darwin') backend = require('./darwin');
} catch (e) { console.error('[stats] backend failed to load:', e.message); }

/** Internet latency as TCP connect time (works without ICMP or admin rights). */
function tcpPing(host, port, timeout = 1500) {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(null));
    s.once('error', () => done(null));
    s.once('connect', () => done(Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6))));
  });
}

function hasLan() {
  return Object.values(os.networkInterfaces()).flat()
    .some(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
}

async function poll() {
  try {
    if (!backend) { // development on other OSes: plausible demo values
      latest = {
        battery: { present: true, percent: 76, plugged: false, charging: false, minutesLeft: 184 },
        net: { type: 'wifi', ssid: 'Demo Wi-Fi 5G', signal: 82 },
        pingInternet: await tcpPing('1.1.1.1', 443) ?? 20, ts: Date.now(), demo: true,
      };
    } else {
      const [battery, ping] = await Promise.all([
        backend.battery().catch(() => ({ present: false })),
        tcpPing('1.1.1.1', 443).then(v => v ?? tcpPing('8.8.8.8', 53)),
      ]);
      // Wi-Fi details are slower to read: every 3rd poll (15 s), or right away when offline/online changes
      if (tick % 3 === 0 || !netCache || (netCache.type === 'none') === hasLan()) {
        netCache = await backend.network().catch(() => null)
          || { type: hasLan() ? 'ethernet' : 'none' };
      }
      latest = { battery, net: netCache, pingInternet: ping, ts: Date.now() };
    }
    tick++;
    events.emit('update', latest);
  } catch (e) { console.error('[stats]', e.message); }
}

module.exports = {
  events,
  get: () => latest,
  start() { if (!timer) { poll(); timer = setInterval(poll, 5000); } },
  stop() { clearInterval(timer); timer = null; },
  tcpPing,
};
