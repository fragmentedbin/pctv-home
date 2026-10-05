// Supporter ("pay what you want") state for PCTV Home. Runs in the main process
// only; the phone remote and the TV just ask for status() / redeem() and get
// {ok, reason} back.
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const defaultConfig = require('./config');
const { verify } = require('./code');
const { deviceId: makeDeviceId } = require('./device');
const { createStore } = require('./store');
const { watermarkDue, promptDue } = require('./nag');
const { createManualSource } = require('./sources');

/**
 * @param {{dataDir: string, config?: object, now?: () => number, rand?: () => number, deviceId?: string}} o
 */
function createSupporter(o) {
  const config = o.config || defaultConfig;
  const now = o.now || Date.now;
  const rand = o.rand || Math.random;
  const events = new EventEmitter();
  const store = createStore(path.join(o.dataDir, 'supporter.json'), now);
  const did = o.deviceId || makeDeviceId(config.DEVICE_SALT, () => store.fallbackId());

  let publicKey = null;
  if (config.PUBLIC_KEY_PEM) {
    try { publicKey = crypto.createPublicKey(config.PUBLIC_KEY_PEM); }
    catch (e) { console.warn('[supporter] PUBLIC_KEY_PEM is invalid, supporter features are off:', e.message); }
  }
  const enabled = !!publicKey;

  // Every caller gets a fresh signature check of the stored token.
  const check = token => !!token && verify(token, { publicKey, deviceId: did }).ok;
  const unlocked = () => enabled && check(store.get().unlockToken);

  async function deliver(code, source) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    const r = verify(code, { publicKey, deviceId: did });
    if (!r.ok) return { ok: false, reason: r.reason };
    const token = String(code).replace(/\s+/g, '');
    const wasUnlocked = unlocked();
    store.update({ unlockToken: token });
    if (!unlocked()) return { ok: false, reason: 'save-failed' }; // second check, against what was stored
    console.log(`[supporter] unlocked via ${source} (order ${r.payload.id})`);
    if (!wasUnlocked) events.emit('unlocked', r.payload);
    return { ok: true, reason: wasUnlocked ? 'already' : 'unlocked' };
  }
  const manual = createManualSource();
  manual.start(deliver);

  return {
    enabled,
    events,
    deviceId: did,
    supportUrl: config.SUPPORT_URL,
    watermarkText: config.WATERMARK_TEXT,
    watermarkConfig: config.WATERMARK,

    /** once per app start; also re-verifies the stored token */
    recordLaunch() {
      const st = store.update({ launchCount: store.get().launchCount + 1 });
      if (st.unlockToken && enabled && !check(st.unlockToken)) {
        console.warn('[supporter] stored unlock code is not valid for this device');
      }
      return st.launchCount;
    },
    isUnlocked: unlocked,
    status() {
      const ok = unlocked();
      return {
        enabled, unlocked: ok, deviceId: did,
        supportUrl: config.SUPPORT_URL,
        showThanks: ok && !store.get().thankedAt,
      };
    },
    redeem: code => manual.submit(code),
    markThanked() { if (unlocked()) store.update({ thankedAt: now() }); },

    /** TV watermark: unlock is re-checked here, independently of the phone prompt */
    watermarkVisible() {
      if (!enabled || unlocked()) return false;
      return watermarkDue(store.get(), now(), config.WATERMARK);
    },
    /** phone prompt: checked when a phone connects; records the time when it says yes */
    takePrompt({ force = false } = {}) {
      if (!enabled || unlocked()) return false;
      if (!force && !promptDue(store.get(), now(), config.PROMPT, rand)) return false;
      store.update({ lastNagAt: now() });
      return true;
    },
    _state: () => ({ ...store.get() }), // tests
  };
}

module.exports = { createSupporter };
