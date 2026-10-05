// When to remind people. Pure functions: pass the clock (and dice) in, so tests
// can fake them. Whether the copy is unlocked is checked by the caller with a
// fresh signature check every time; these functions only look at time.
const DAY = 24 * 60 * 60 * 1000;

/** TV watermark: after the grace period. */
function watermarkDue(state, now, cfg) {
  return state.launchCount >= cfg.graceLaunches || now - state.firstRunAt >= cfg.graceDays * DAY;
}

/** Phone prompt: eligible, not shown in the last few days, and not every time. */
function promptDue(state, now, cfg, rand = Math.random) {
  const eligible = state.launchCount >= cfg.minLaunches || now - state.firstRunAt >= cfg.minDays * DAY;
  if (!eligible) return false;
  if (state.lastNagAt && now - state.lastNagAt < cfg.everyDays * DAY) return false;
  return rand() < cfg.chance;
}

module.exports = { DAY, watermarkDue, promptDue };
