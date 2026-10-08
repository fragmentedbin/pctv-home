// Auto-update state machine, against a fake electron-updater. Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createUpdater } = require('../src/main/updater');

function fake({ packaged = true, platform = 'win32', store = false, enabled = true, version = '1.3.0' } = {}) {
  const au = Object.assign(new EventEmitter(), {
    calls: [],
    checkForUpdates() { this.calls.push('check'); return Promise.resolve(); },
    downloadUpdate() { this.calls.push('download'); return Promise.resolve(); },
    quitAndInstall(...a) { this.calls.push(['install', ...a]); },
  });
  const opened = [];
  const u = createUpdater({
    autoUpdater: au, app: { isPackaged: packaged, getVersion: () => version }, platform, isStore: store,
    isEnabled: () => enabled, openExternal: url => opened.push(url), log: { log() {}, warn() {} },
  });
  const seen = [];
  u.events.on('state', s => seen.push(s.status));
  return { au, u, opened, seen };
}

test('found -> downloads -> ready, and waits for the person to restart', () => {
  const { au, u, seen } = fake();
  u.check();
  au.emit('checking-for-update');
  au.emit('update-available', { version: '1.4.0' });
  assert.deepEqual(au.calls, ['check', 'download']);
  au.emit('download-progress', { percent: 42.4 });
  assert.equal(u.state().percent, 42);
  au.emit('update-downloaded', { version: '1.4.0' });
  assert.equal(u.state().status, 'ready');
  assert.equal(u.state().version, '1.4.0');
  assert.ok(!au.calls.some(c => Array.isArray(c)), 'must not restart by itself');
  assert.deepEqual(u.install(), { ok: true });
  assert.deepEqual(au.calls.at(-1), ['install', true, true]);
  assert.ok(seen.includes('downloading') && seen.at(-1) === 'ready');
});

test('with auto-update off, a background check only announces; a manual check downloads', () => {
  const off = fake({ enabled: false });
  off.u.check(false);
  off.au.emit('update-available', { version: '1.4.0' });
  assert.equal(off.u.state().status, 'available');
  assert.deepEqual(off.au.calls, ['check']);
  assert.deepEqual(off.u.install(), { ok: true });          // tapping "Update" downloads it
  assert.equal(off.au.calls.at(-1), 'download');
  const man = fake({ enabled: false });
  man.u.check(true);
  man.au.emit('update-available', { version: '1.4.0' });
  assert.equal(man.au.calls.at(-1), 'download');
});

test('up to date, and quiet background failures', () => {
  const { au, u } = fake();
  u.check(false);
  au.emit('update-not-available');
  assert.equal(u.state().status, 'idle');
  assert.ok(u.state().lastChecked);
  u.check(false);
  au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\nstack...'));
  assert.equal(u.state().status, 'idle');                    // offline: no scary message
  assert.equal(u.state().error, 'net::ERR_INTERNET_DISCONNECTED');
});

test('a manual check or a failed download shows the error', () => {
  const a = fake();
  a.u.check(true);
  a.au.emit('error', new Error('Cannot reach GitHub'));
  assert.deepEqual([a.u.state().status, a.u.state().error], ['error', 'Cannot reach GitHub']);
  const b = fake();
  b.u.check(false);
  b.au.emit('update-available', { version: '1.4.0' });
  b.au.emit('error', new Error('checksum mismatch'));
  assert.equal(b.u.state().status, 'error');
});

test('a downloaded update survives a later failed check', () => {
  const { au, u } = fake();
  u.check(); au.emit('update-available', { version: '1.4.0' }); au.emit('update-downloaded', { version: '1.4.0' });
  const before = au.calls.length;
  u.check(false);                                            // already ready: no new check
  assert.equal(au.calls.length, before);
  au.emit('error', new Error('x'));
  assert.equal(u.state().status, 'ready');
});

test('macOS only announces and opens the download page', () => {
  const { au, u, opened } = fake({ platform: 'darwin' });
  assert.equal(u.state().canInstall, false);
  u.check(true);
  au.emit('update-available', { version: '1.4.0' });
  assert.equal(u.state().status, 'available');
  assert.ok(!au.calls.includes('download'));
  assert.deepEqual(u.install(), { ok: true, opened: true });
  assert.match(opened[0], /github\.com\/fragmentedbin\/pctv-home\/releases/);
});

test('store builds, dev runs and a missing package never update', () => {
  for (const [opts, why] of [[{ store: true }, 'store'], [{ packaged: false }, 'dev']]) {
    const { au, u } = fake(opts);
    assert.deepEqual([u.state().status, u.state().reason], ['unsupported', why]);
    u.check(true);
    assert.deepEqual(au.calls, []);
    assert.equal(u.install().ok, false);
  }
  const none = createUpdater({ autoUpdater: null, app: { isPackaged: true, getVersion: () => '1.3.0' }, log: { log() {} } });
  assert.equal(none.state().reason, 'missing');
});
