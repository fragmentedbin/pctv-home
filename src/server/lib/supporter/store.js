// supporter.json in the app's data folder:
//   { launchCount, firstRunAt, lastNagAt, unlockToken, thankedAt, fallbackId }
// Only the signed token is kept; it is verified again on every launch and every
// check. There is no "paid" flag.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(file, now) {
  const defaults = () => ({ launchCount: 0, firstRunAt: now(), lastNagAt: 0, unlockToken: null, thankedAt: 0 });
  let state;
  try { state = { ...defaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { state = defaults(); }
  if (!Number.isFinite(state.firstRunAt) || state.firstRunAt > now()) state.firstRunAt = now(); // clock games
  if (!Number.isFinite(state.launchCount) || state.launchCount < 0) state.launchCount = 0;
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { console.warn('[supporter] could not save state:', e.message); }
  }
  return {
    get: () => state,
    update(patch) { Object.assign(state, patch); save(); return state; },
    // stable random id for machines whose OS id can't be read
    fallbackId() {
      if (!state.fallbackId) { state.fallbackId = crypto.randomUUID(); save(); }
      return state.fallbackId;
    },
  };
}

module.exports = { createStore };
