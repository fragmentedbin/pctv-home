#!/usr/bin/env node
// Make an unlock code for one device.
//   node scripts/issue-code.js --did 7F3A-91C2-0B4D-E6A8-55D1 --id ORDER-123 [--amt 25000] [--key keys/private.pem]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sign, verify, normDid } = require('../src/server/lib/supporter/code');

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const did = arg('did'), id = arg('id'), amt = arg('amt');
const keyFile = path.resolve(arg('key') || path.join(__dirname, '..', 'keys', 'private.pem'));

if (!did || !id) {
  console.error('Usage: node scripts/issue-code.js --did <deviceId> --id <orderId> [--amt 25000] [--key keys/private.pem]');
  process.exit(1);
}
const d = normDid(did);
if (!/^[0-9A-F]{20}$/.test(d)) { console.error(`"${did}" doesn't look like a PCTV Home device id (e.g. 7F3A-91C2-0B4D-E6A8-55D1).`); process.exit(1); }
if (amt !== undefined && !(Number(amt) > 0)) { console.error('--amt must be a positive number'); process.exit(1); }

let privateKey;
try { privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile)); }
catch (e) { console.error(`Can't read the private key at ${keyFile}: ${e.message}\nRun: node scripts/gen-keys.js`); process.exit(1); }

const payload = { v: 1, id: String(id), did: d.match(/.{4}/g).join('-'), ...(amt !== undefined && { amt: Number(amt) }), iat: Math.floor(Date.now() / 1000) };
const code = sign(payload, privateKey);

// sanity check with the matching public key
const check = verify(code, { publicKey: crypto.createPublicKey(privateKey), deviceId: d });
if (!check.ok) { console.error('Self-check failed:', check.reason); process.exit(1); }

console.log(code);
