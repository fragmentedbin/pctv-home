// Turn what someone typed into a web address, like a browser's address bar:
//   "netflix.com"        -> https://netflix.com
//   "http://192.168.1.5" -> unchanged
//   "google"             -> a web search (or https://google.com for an app shortcut)
//   "lofi hip hop"       -> a web search
const SEARCH = 'https://www.google.com/search?q=';

function looksLikeHost(s) {
  return /^localhost(:\d+)?([/?#].*)?$/i.test(s) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(s) ||
    /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(:\d+)?([/?#].*)?$/iu.test(s);
}

/**
 * @param {string} input
 * @param {{shortcut?: boolean}} o  shortcut: a single word becomes "<word>.com" instead of a search
 * @returns {string|null} an http(s) URL, or null if nothing usable was typed
 */
function resolveAddress(input, o = {}) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).href; } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s:]+:\d+/.test(s)) return SEARCH + encodeURIComponent(s); // javascript:, file: … -> just search the text
  if (!/\s/.test(s) && looksLikeHost(s)) {
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})([:/?#]|$)/i.test(s); // devices on your network rarely have https
    try { return new URL((local ? 'http://' : 'https://') + s).href; } catch {}
  }
  if (o.shortcut && /^[\p{L}\p{N}-]+$/u.test(s)) return `https://${s.toLowerCase()}.com/`;
  return SEARCH + encodeURIComponent(s);
}

module.exports = { resolveAddress };
