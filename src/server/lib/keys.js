// Turn text into DevTools key events that look exactly like a physical keyboard
// (key + code + Windows virtual-key code). YouTube's TV app only reacts to those;
// it ignores "Unicode packet" keys and pasted text.

// US-layout symbols: char -> [code, virtual key, needs shift]
const SYMBOLS = {
  ' ': ['Space', 32, false], '-': ['Minus', 189, false], '_': ['Minus', 189, true],
  '=': ['Equal', 187, false], '+': ['Equal', 187, true], '.': ['Period', 190, false], '>': ['Period', 190, true],
  ',': ['Comma', 188, false], '<': ['Comma', 188, true], '/': ['Slash', 191, false], '?': ['Slash', 191, true],
  ';': ['Semicolon', 186, false], ':': ['Semicolon', 186, true], "'": ['Quote', 222, false], '"': ['Quote', 222, true],
  '[': ['BracketLeft', 219, false], '{': ['BracketLeft', 219, true], ']': ['BracketRight', 221, false], '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220, false], '|': ['Backslash', 220, true], '`': ['Backquote', 192, false], '~': ['Backquote', 192, true],
};
const SHIFT_DIGITS = { '!': 1, '@': 2, '#': 3, '$': 4, '%': 5, '^': 6, '&': 7, '*': 8, '(': 9, ')': 0 };
const SHIFT = 8; // DevTools modifier bit

/** @returns {Array<object>} Input.dispatchKeyEvent params (keyDown/keyUp pairs) */
function keyEventsFor(text) {
  const out = [];
  for (const ch of String(text)) {
    let code = '', vk = 0, shift = false;
    if (/^[a-z]$/.test(ch)) { code = 'Key' + ch.toUpperCase(); vk = ch.toUpperCase().charCodeAt(0); }
    else if (/^[A-Z]$/.test(ch)) { code = 'Key' + ch; vk = ch.charCodeAt(0); shift = true; }
    else if (/^[0-9]$/.test(ch)) { code = 'Digit' + ch; vk = ch.charCodeAt(0); }
    else if (ch in SHIFT_DIGITS) { const d = SHIFT_DIGITS[ch]; code = 'Digit' + d; vk = 48 + d; shift = true; }
    else if (SYMBOLS[ch]) [code, vk, shift] = SYMBOLS[ch];
    else if (ch === '\n') { out.push(...keyEventsForKey('Enter')); continue; }
    const modifiers = shift ? SHIFT : 0;
    out.push(
      { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers },
      { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers },
    );
  }
  return out;
}

function keyEventsForKey(name) {
  const map = { Enter: ['Enter', 13, '\r'], Backspace: ['Backspace', 8, ''] };
  const [code, vk, text] = map[name];
  return [
    { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text && { text }) },
    { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
  ];
}

module.exports = { keyEventsFor, keyEventsForKey };
