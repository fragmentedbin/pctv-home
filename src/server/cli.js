#!/usr/bin/env node
// Headless mode, mainly for development:  npm run server  /  npm run server:kiosk
// The desktop app (src/main) is the normal way to run PCTV Home.
const path = require('path');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { createServer } = require('./index');

const args = process.argv.slice(2);
const dataDir = process.env.PCTV_DATA || path.join(__dirname, '..', '..', '.dev-data');

const srv = createServer({
  dataDir,
  port: process.env.PORT,
  host: process.env.HOST,
  kiosk: args.includes('--kiosk'),
  secureDns: process.env.PCTV_SECURE_DNS,
  watchDir: args.includes('--no-watch') ? null : path.join(__dirname, '..'),
  onRestart() {
    spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
    process.exit(0);
  },
});

srv.start().then(async ({ homeUrl, remoteUrl }) => {
  console.log(`\n  PCTV Home    ${homeUrl}`);
  console.log(`  Phone remote ${remoteUrl}\n`);
  try { console.log(await QRCode.toString(remoteUrl, { type: 'terminal', small: true })); } catch {}
}, e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use. Is PCTV Home already running?` : e);
  process.exit(1);
});

process.on('SIGINT', () => { srv.stop(); process.exit(0); });
