// Windows input through user32!SendInput, called directly with koffi
// (no PowerShell or helper processes, so it works with Smart App Control).
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('PCTV_MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('PCTV_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('PCTV_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_U = koffi.union('PCTV_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('PCTV_INPUT', { type: 'uint32', u: INPUT_U });

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, PCTV_INPUT *pInputs, int cbSize)');
const SIZE = koffi.sizeof(INPUT);

const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const KEY_EXT = 0x1, KEY_UP = 0x2, KEY_UNICODE = 0x4;
const M_MOVE = 0x1, M_LDOWN = 0x2, M_LUP = 0x4, M_RDOWN = 0x8, M_RUP = 0x10, M_WHEEL = 0x800, M_ABS = 0x8000;

// name -> [virtual-key code, extended?]
const KEYS = {
  up: [0x26, 1], down: [0x28, 1], left: [0x25, 1], right: [0x27, 1],
  enter: [0x0d], escape: [0x1b], backspace: [0x08], space: [0x20], tab: [0x09],
  volup: [0xaf, 1], voldown: [0xae, 1], mute: [0xad, 1],
  playpause: [0xb3, 1], next: [0xb0, 1], prev: [0xb1, 1],
  f: [0x46], f11: [0x7a], home: [0x24, 1],
};
const VK_ALT = 0x12;

const kbd = (wVk, wScan, dwFlags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } });
const mouse = (dx, dy, mouseData, dwFlags) => ({ type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } } });
const send = (...inputs) => { for (const i of inputs) SendInput(1, i, SIZE); };
const clamp = (n, lim) => Math.max(-lim, Math.min(lim, Math.round(Number(n) || 0)));

function tap(name) {
  const k = KEYS[name];
  if (!k) return;
  const f = k[1] ? KEY_EXT : 0;
  send(kbd(k[0], 0, f), kbd(k[0], 0, f | KEY_UP));
}
function combo(mod, name) {
  const k = KEYS[name];
  if (!k) return;
  const f = k[1] ? KEY_EXT : 0;
  send(kbd(mod, 0, 0), kbd(k[0], 0, f), kbd(k[0], 0, f | KEY_UP), kbd(mod, 0, KEY_UP));
}

module.exports = {
  start() { console.log('[input] Windows SendInput ready'); },
  stop() {},
  status: () => ({ available: true }),
  key: tap,
  move: (dx, dy) => send(mouse(clamp(dx, 500), clamp(dy, 500), 0, M_MOVE)),
  click: b => b === 'right'
    ? send(mouse(0, 0, 0, M_RDOWN), mouse(0, 0, 0, M_RUP))
    : send(mouse(0, 0, 0, M_LDOWN), mouse(0, 0, 0, M_LUP)),
  wheel: d => send(mouse(0, 0, clamp(d, 2400) >>> 0, M_WHEEL)),
  text(str) {
    for (const ch of String(str || '').slice(0, 500)) {
      if (ch === '\n') { tap('enter'); continue; }
      for (let i = 0; i < ch.length; i++) { // surrogate pairs are sent as two UTF-16 units
        const c = ch.charCodeAt(i);
        send(kbd(0, c, KEY_UNICODE), kbd(0, c, KEY_UNICODE | KEY_UP));
      }
    }
  },
  // bottom-right corner of the primary screen: the arrow is drawn almost fully off-screen
  park: () => send(mouse(65535, 65535, 0, M_MOVE | M_ABS)),
  browserBack: () => combo(VK_ALT, 'left'),
  browserHome: () => combo(VK_ALT, 'home'),
};
