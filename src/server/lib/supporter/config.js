// PCTV Home "pay what you want" settings. Everything a maintainer may want to
// change lives here.
module.exports = {
  // Payment page. The phone adds ?did=<device id> so the page can show/prefill it.
  // The minimum amount (Rp 20.000) is enforced by the payment page, not the app.
  SUPPORT_URL: 'https://example.com/pctv-home/support', // TODO: real payment page

  // Ed25519 public key used to verify unlock codes. Generate a pair with
  //   node scripts/gen-keys.js
  // and paste the printed public key here. null = supporter feature switched off
  // (no watermark, no prompts), so a fork without keys is never nagged.
  PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAVGFARVv+NJIWjf2SgvvmWa6CjjXsZEM9Y08iGOm9vSM=
-----END PUBLIC KEY-----`,

  // Salt for the device id hash. Changing it changes every device id and
  // invalidates every code issued so far.
  DEVICE_SALT: 'pctv-home/device-id/v1',

  // TV watermark (click-through, never blocks anything)
  WATERMARK_TEXT: 'Dukung the developer',
  WATERMARK: {
    graceDays: 7,            // shown once 7 days have passed since the first run…
    graceLaunches: 15,       // …or after 15 launches, whichever comes first
    moveEveryMs: 5 * 60e3,   // OLED safety: switch to the other bottom corner every ~5 min
  },

  // Support prompt on the phone remote
  PROMPT: {
    minLaunches: 10,         // eligible after 10 launches…
    minDays: 3,              // …or 3 days since the first run
    everyDays: 3,            // then at most once every 3 days
    chance: 0.6,             // and not on every eligible phone connection
  },
};
