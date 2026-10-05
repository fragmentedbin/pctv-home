#!/usr/bin/env node
// Create the Ed25519 key pair for PCTV Home unlock codes.
//   node scripts/gen-keys.js            -> writes keys/private.pem, prints the public key
//   node scripts/gen-keys.js --write    -> also puts the public key into src/server/lib/supporter/config.js
//   --force                             -> replace an existing keys/private.pem (old codes stop working!)
// keys/ is git-ignored. Back the private key up somewhere safe: without it you
// can't issue codes for this public key any more.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const keyFile = path.join(root, 'keys', 'private.pem');
const cfgFile = path.join(root, 'src', 'server', 'lib', 'supporter', 'config.js');
const args = process.argv.slice(2);

if (fs.existsSync(keyFile) && !args.includes('--force')) {
  console.error(`${path.relative(root, keyFile)} already exists. Use --force to replace it (codes made with the old key will stop working).`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();

console.log(`Private key written to ${path.relative(root, keyFile)} (git-ignored, back it up, never share it).\n`);
console.log('Public key (goes in src/server/lib/supporter/config.js as PUBLIC_KEY_PEM):\n');
console.log(pub + '\n');

if (args.includes('--write')) {
  const src = fs.readFileSync(cfgFile, 'utf8');
  const next = src.replace(/PUBLIC_KEY_PEM:\s*(null|`[^`]*`),/, `PUBLIC_KEY_PEM: \`${pub}\`,`);
  if (next === src) { console.error('Could not find PUBLIC_KEY_PEM in config.js; paste it by hand.'); process.exit(1); }
  fs.writeFileSync(cfgFile, next);
  console.log(`Updated ${path.relative(root, cfgFile)}.`);
}
