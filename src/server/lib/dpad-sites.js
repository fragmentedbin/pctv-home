// Which sites really work with the remote's D-pad. Most sites don't (their own menus and
// pop-ups fight our focus handling), so everywhere else the phone remote switches itself to
// the touchpad and the D-pad is turned off, both on the phone and in tv-nav.js.
// Add a hostname here once its D-pad navigation has been checked.
const DPAD_HOSTS = [
  'localhost', '127.0.0.1',  // PCTV's own screens
  'youtube.com',             // YouTube's TV interface handles the remote itself
];

/** True when the D-pad should be off for this page (a normal website that isn't on the list). */
function noDpad(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false; // about:blank, browser pages: leave the mode alone
    const h = u.hostname;
    return !DPAD_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

module.exports = { DPAD_HOSTS, noDpad };
