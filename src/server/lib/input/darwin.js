// macOS input through CoreGraphics (CGEvent), called directly with koffi.
// Needs the Accessibility permission (System Settings → Privacy & Security →
// Accessibility); the desktop app asks for it on first run.
const koffi = require('koffi');
const { execFile } = require('child_process');

const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
const as = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');

const CGPoint = koffi.struct('PCTV_CGPoint', { x: 'double', y: 'double' });
const CGSize = koffi.struct('PCTV_CGSize', { width: 'double', height: 'double' });
const CGRect = koffi.struct('PCTV_CGRect', { origin: CGPoint, size: CGSize });

const CGEventCreate = cg.func('void *CGEventCreate(void *source)');
const CGEventGetLocation = cg.func('PCTV_CGPoint CGEventGetLocation(void *event)');
const CGEventCreateKeyboardEvent = cg.func('void *CGEventCreateKeyboardEvent(void *source, uint16 key, bool down)');
const CGEventCreateMouseEvent = cg.func('void *CGEventCreateMouseEvent(void *source, uint32 type, PCTV_CGPoint pos, uint32 button)');
const CGEventCreateScrollWheelEvent2 = cg.func('void *CGEventCreateScrollWheelEvent2(void *source, uint32 units, uint32 count, int32 w1, int32 w2, int32 w3)');
const CGEventSetFlags = cg.func('void CGEventSetFlags(void *event, uint64 flags)');
const CGEventSetIntegerValueField = cg.func('void CGEventSetIntegerValueField(void *event, uint32 field, int64 value)');
const CGEventKeyboardSetUnicodeString = cg.func('void CGEventKeyboardSetUnicodeString(void *event, unsigned long len, const uint16 *str)');
const CGEventPost = cg.func('void CGEventPost(uint32 tap, void *event)');
const CGMainDisplayID = cg.func('uint32 CGMainDisplayID()');
const CGDisplayBounds = cg.func('PCTV_CGRect CGDisplayBounds(uint32 display)');
const CFRelease = cf.func('void CFRelease(void *cf)');
const AXIsProcessTrusted = as.func('bool AXIsProcessTrusted()');

const HID_TAP = 0;
const EV = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, moved: 5, leftDragged: 6 };
const FLAG_CMD = 0x100000;
const FIELD_CLICK_STATE = 1;

// name -> macOS virtual key code (US layout positions)
const KEYS = {
  up: 126, down: 125, left: 123, right: 124,
  enter: 36, escape: 53, backspace: 51, space: 49, tab: 48, f: 3, f11: 103, bracketLeft: 33,
};

function post(ev) { if (ev) { CGEventPost(HID_TAP, ev); CFRelease(ev); } }

function keyTap(code, flags = 0) {
  const down = CGEventCreateKeyboardEvent(null, code, true);
  const up = CGEventCreateKeyboardEvent(null, code, false);
  if (flags) { CGEventSetFlags(down, flags); CGEventSetFlags(up, flags); }
  post(down); post(up);
}

function cursor() {
  const ev = CGEventCreate(null);
  const p = CGEventGetLocation(ev);
  CFRelease(ev);
  return p;
}
function screen() {
  const b = CGDisplayBounds(CGMainDisplayID());
  return { x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height };
}

let leftHeld = false;

// Volume/mute: system media keys need private APIs, AppleScript is the supported way.
const osa = script => execFile('osascript', ['-e', script], () => {});
const VOLUME = {
  volup: 'set volume output volume ((output volume of (get volume settings)) + 6)',
  voldown: 'set volume output volume ((output volume of (get volume settings)) - 6)',
  mute: 'set volume output muted (not (output muted of (get volume settings)))',
};

module.exports = {
  start() {
    console.log(`[input] macOS CGEvent ready${AXIsProcessTrusted() ? '' : ' (waiting for Accessibility permission)'}`);
  },
  stop() {},
  status: () => AXIsProcessTrusted() ? { available: true } : { available: false, reason: 'accessibility' },
  key(name) {
    if (VOLUME[name]) return osa(VOLUME[name]);
    if (name === 'playpause') return keyTap(KEYS.space);
    if (KEYS[name] != null) keyTap(KEYS[name]);
  },
  move(dx, dy) {
    const p = cursor(), s = screen();
    const x = Math.min(Math.max(p.x + (Number(dx) || 0), s.x), s.x + s.w - 1);
    const y = Math.min(Math.max(p.y + (Number(dy) || 0), s.y), s.y + s.h - 1);
    post(CGEventCreateMouseEvent(null, leftHeld ? EV.leftDragged : EV.moved, { x, y }, 0));
  },
  click(b) {
    const p = cursor();
    const right = b === 'right';
    const down = CGEventCreateMouseEvent(null, right ? EV.rightDown : EV.leftDown, p, right ? 1 : 0);
    const up = CGEventCreateMouseEvent(null, right ? EV.rightUp : EV.leftUp, p, right ? 1 : 0);
    CGEventSetIntegerValueField(down, FIELD_CLICK_STATE, 1);
    CGEventSetIntegerValueField(up, FIELD_CLICK_STATE, 1);
    post(down); post(up);
  },
  wheel(d) {
    // remote sends Windows-style deltas (120 per notch); CG wants lines
    const lines = Math.max(-20, Math.min(20, Math.round((Number(d) || 0) / 40)));
    if (lines) post(CGEventCreateScrollWheelEvent2(null, 1 /* line */, 1, lines, 0, 0));
  },
  text(str) {
    for (const ch of String(str || '').slice(0, 500)) {
      if (ch === '\n') { keyTap(KEYS.enter); continue; }
      const codes = Uint16Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i)); // UTF-16 units
      const down = CGEventCreateKeyboardEvent(null, 0, true);
      const up = CGEventCreateKeyboardEvent(null, 0, false);
      CGEventKeyboardSetUnicodeString(down, codes.length, codes);
      CGEventKeyboardSetUnicodeString(up, codes.length, codes);
      post(down); post(up);
    }
  },
  park() {
    const s = screen();
    post(CGEventCreateMouseEvent(null, EV.moved, { x: s.x + s.w - 1, y: s.y + s.h - 1 }, 0));
  },
  browserBack: () => keyTap(KEYS.bracketLeft, FLAG_CMD), // Cmd+[
  browserHome: () => {},
};
