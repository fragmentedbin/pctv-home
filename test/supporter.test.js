// Supporter: unlock code verification + reminder timing (fake clock).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sign, verify } = require('../src/server/lib/supporter/code');
const { watermarkDue, promptDue, DAY } = require('../src/server/lib/supporter/nag');
const { createSupporter } = require('../src/server/lib/supporter');
const baseConfig = require('../src/server/lib/supporter/config');

const keys = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const DID = 'ABCD-1234-EF56-7890-AB12';
const payload = (o = {}) => ({ v: 1, id: 'ORDER-1', did: DID, amt: 25000, iat: 1760000000, ...o });

// ---------- verify ----------
test('verify: valid code', () => {
  const r = verify(sign(payload(), keys.privateKey), { publicKey: keys.publicKey, deviceId: DID });
  assert.equal(r.ok, true);
  assert.equal(r.payload.amt, 25000);
});

test('verify: device id is compared without dashes / case', () => {
  const r = verify(sign(payload(), keys.privateKey), { publicKey: keys.publicKey, deviceId: 'abcd1234ef567890ab12' });
  assert.equal(r.ok, true);
});

test('verify: tampered payload', () => {
  const code = sign(payload({ amt: 20000 }), keys.privateKey);
  const [, sig] = code.split('.');
  const forged = Buffer.from(JSON.stringify(payload({ amt: 999999 }))).toString('base64url') + '.' + sig;
  assert.deepEqual(verify(forged, { publicKey: keys.publicKey, deviceId: DID }), { ok: false, reason: 'bad-signature' });
  // flip one byte of the signature too
  const s = Buffer.from(sig, 'base64url'); s[10] ^= 1;
  const bad = code.split('.')[0] + '.' + s.toString('base64url');
  assert.equal(verify(bad, { publicKey: keys.publicKey, deviceId: DID }).reason, 'bad-signature');
});

test('verify: wrong device id', () => {
  const code = sign(payload(), keys.privateKey);
  assert.deepEqual(verify(code, { publicKey: keys.publicKey, deviceId: 'FFFF-1234-EF56-7890-AB12' }), { ok: false, reason: 'wrong-device' });
});

test('verify: signed with another key', () => {
  const code = sign(payload(), other.privateKey);
  assert.equal(verify(code, { publicKey: keys.publicKey, deviceId: DID }).reason, 'bad-signature');
});

test('verify: malformed strings', () => {
  const v = c => verify(c, { publicKey: keys.publicKey, deviceId: DID }).reason;
  for (const c of [undefined, null, 42, '', 'abc', 'a.b.c', 'not base64!.xx', '.', 'eyJ2IjoxfQ.', 'eyJ2IjoxfQ.AAAA']) {
    assert.equal(v(c), 'malformed', `for ${JSON.stringify(c)}`);
  }
  // valid signature over something that isn't the right shape
  const notJson = Buffer.from('hello');
  const c = notJson.toString('base64url') + '.' + crypto.sign(null, notJson, keys.privateKey).toString('base64url');
  assert.equal(v(c), 'malformed');
  assert.equal(v(sign({ v: 2, id: 'x', did: DID }, keys.privateKey)), 'unsupported');
  // spaces / line breaks from copy-paste are fine
  const good = sign(payload(), keys.privateKey);
  assert.equal(verify(` ${good.slice(0, 30)}\n${good.slice(30)} `, { publicKey: keys.publicKey, deviceId: DID }).ok, true);
});

test('verify: no key configured', () => {
  assert.equal(verify(sign(payload(), keys.privateKey), { publicKey: null, deviceId: DID }).reason, 'no-key');
});

// ---------- timing (fake clock) ----------
const W = baseConfig.WATERMARK, P = baseConfig.PROMPT;
const T0 = Date.UTC(2026, 9, 1);

test('watermark: grace period by days or launches', () => {
  const st = { launchCount: 1, firstRunAt: T0 };
  assert.equal(watermarkDue(st, T0, W), false);
  assert.equal(watermarkDue(st, T0 + 6.9 * DAY, W), false);
  assert.equal(watermarkDue(st, T0 + 7 * DAY, W), true);
  assert.equal(watermarkDue({ launchCount: 14, firstRunAt: T0 }, T0 + DAY, W), false);
  assert.equal(watermarkDue({ launchCount: 15, firstRunAt: T0 }, T0 + DAY, W), true);
});

test('prompt: eligibility, 3-day spacing and randomness', () => {
  const yes = () => 0, no = () => 0.99;
  const st = { launchCount: 2, firstRunAt: T0, lastNagAt: 0 };
  assert.equal(promptDue(st, T0 + 2 * DAY, P, yes), false);          // too early
  assert.equal(promptDue(st, T0 + 3 * DAY, P, yes), true);           // 3 days in
  assert.equal(promptDue({ ...st, launchCount: 10 }, T0 + DAY, P, yes), true); // 10 launches
  assert.equal(promptDue(st, T0 + 3 * DAY, P, no), false);           // dice said no
  const after = { ...st, lastNagAt: T0 + 3 * DAY };
  assert.equal(promptDue(after, T0 + 5.9 * DAY, P, yes), false);     // shown < 3 days ago
  assert.equal(promptDue(after, T0 + 6 * DAY, P, yes), true);
});

// ---------- supporter module ----------
function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pctv-sup-'));
  let t = T0;
  const clock = { now: () => t, advance: d => (t += d) };
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const config = { ...baseConfig, PUBLIC_KEY_PEM: pem, ...extra };
  const make = () => createSupporter({ dataDir: dir, config, now: clock.now, rand: () => 0, deviceId: DID });
  return { dir, clock, make };
}

test('supporter: watermark + prompt follow the clock, unlock stops both', async () => {
  const { clock, make } = setup();
  let s = make();
  s.recordLaunch();
  assert.equal(s.watermarkVisible(), false);
  assert.equal(s.takePrompt(), false);
  clock.advance(3 * DAY);
  assert.equal(s.takePrompt(), true);
  assert.equal(s.takePrompt(), false);                 // just shown
  clock.advance(4 * DAY);
  assert.equal(s.watermarkVisible(), true);            // 7 days

  assert.deepEqual(await s.redeem('garbage'), { ok: false, reason: 'malformed' });
  assert.equal((await s.redeem(sign(payload({ did: 'FFFF-0000-0000-0000-0000' }), keys.privateKey))).reason, 'wrong-device');
  const r = await s.redeem(sign(payload(), keys.privateKey));
  assert.deepEqual(r, { ok: true, reason: 'unlocked' });
  assert.equal(s.watermarkVisible(), false);
  clock.advance(30 * DAY);
  assert.equal(s.takePrompt({ force: true }), false);
  assert.equal(s.status().showThanks, true);
  s.markThanked();
  assert.equal(s.status().showThanks, false);

  // next launch: token is re-verified from disk
  s = make(); s.recordLaunch();
  assert.equal(s.isUnlocked(), true);
  assert.equal(s._state().paid, undefined);           // no plain flag is stored
});

test('supporter: a token that no longer verifies (key change) is not trusted', async () => {
  const { dir, make } = setup();
  const s = make();
  await s.redeem(sign(payload(), keys.privateKey));
  const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' });
  const s2 = createSupporter({ dataDir: dir, config: { ...baseConfig, PUBLIC_KEY_PEM: otherPem }, deviceId: DID });
  assert.equal(s2.isUnlocked(), false);
  // hand-edited state file can't unlock either
  const f = path.join(dir, 'supporter.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f)), unlockToken: 'x.y', paid: true }));
  assert.equal(make().isUnlocked(), false);
});

test('supporter: switched off without a public key', () => {
  const { make } = setup({ PUBLIC_KEY_PEM: null });
  const s = make();
  for (let i = 0; i < 50; i++) s.recordLaunch();
  assert.equal(s.enabled, false);
  assert.equal(s.watermarkVisible(), false);
  assert.equal(s.takePrompt({ force: true }), false);
});
