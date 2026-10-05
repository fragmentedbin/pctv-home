// Device id: a salted SHA-256 of the OS machine id, shortened to something a
// person can read out or paste: "7F3A-91C2-0B4D-E6A8-55D1".
// No extra dependencies: reg.exe (Microsoft-signed) on Windows, ioreg on macOS.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function machineId() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i);
      if (m) return m[1].toLowerCase();
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1].toLowerCase();
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch {}
      }
    }
  } catch {}
  return null;
}

/** @param {string} salt  @param {() => string} [fallback] used when the OS id can't be read */
function deviceId(salt, fallback) {
  const raw = machineId() || (fallback && fallback()) || os.hostname();
  const hex = crypto.createHash('sha256').update(salt + '\0' + raw).digest('hex').slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

module.exports = { deviceId, machineId };
