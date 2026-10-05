// Unlock codes: base64url(payloadJSON) + "." + base64url(Ed25519 signature)
//   payload = { v: 1, id: "<order id>", did: "<device id>", amt?: number, iat: <unix seconds> }
// Pure functions, no state: used by the app (verify), the issue script and tests (sign).
const crypto = require('crypto');

const B64U = /^[A-Za-z0-9_-]+$/;
const normDid = d => String(d || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

function sign(payload, privateKey) {
  const json = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, json, privateKey);
  return json.toString('base64url') + '.' + sig.toString('base64url');
}

/**
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 * reasons: 'malformed' | 'bad-signature' | 'no-key' | 'unsupported' | 'wrong-device'
 */
function verify(code, { publicKey, deviceId }) {
  if (!publicKey) return { ok: false, reason: 'no-key' };
  if (typeof code !== 'string') return { ok: false, reason: 'malformed' };
  const parts = code.replace(/\s+/g, '').split('.');
  if (parts.length !== 2 || !B64U.test(parts[0]) || !B64U.test(parts[1])) return { ok: false, reason: 'malformed' };
  const json = Buffer.from(parts[0], 'base64url');
  const sig = Buffer.from(parts[1], 'base64url');
  if (sig.length !== 64 || json.length === 0 || json.length > 2048) return { ok: false, reason: 'malformed' };
  let good = false;
  try { good = crypto.verify(null, json, publicKey, sig); } catch { return { ok: false, reason: 'no-key' }; }
  if (!good) return { ok: false, reason: 'bad-signature' };
  let p;
  try { p = JSON.parse(json.toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed' };
  if (p.v !== 1) return { ok: false, reason: 'unsupported' };
  if (typeof p.id !== 'string' || !p.id || typeof p.did !== 'string') return { ok: false, reason: 'malformed' };
  if (normDid(p.did) !== normDid(deviceId)) return { ok: false, reason: 'wrong-device' };
  return { ok: true, payload: p };
}

module.exports = { sign, verify, normDid };
