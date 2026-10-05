// Fallback used on unsupported platforms (and in development on Linux):
// logs what would be sent so the rest of the app can be tested anywhere.
const log = (...a) => { if (process.env.PCTV_DEBUG_INPUT) console.log('[input:noop]', ...a); };

module.exports = {
  start() { console.log('[input] no native input on this platform (development mode)'); },
  stop() {},
  status: () => ({ available: false, reason: 'unsupported-platform' }),
  key: k => log('key', k),
  move: (dx, dy) => log('move', dx, dy),
  click: b => log('click', b),
  wheel: d => log('wheel', d),
  text: s => log('text', s),
  park: () => log('park'),
  browserBack: () => log('browser-back'),
  browserHome: () => log('browser-home'),
};
