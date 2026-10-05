// D-pad ("spatial") navigation for websites that have no TV mode (Netflix,
// Disney+, Vidio...). Injected into every page; it switches itself off on
// pages that handle the remote themselves (YouTube TV, the launcher) and while
// a video is playing, so the player still gets arrow keys for seeking.
//
// Focus also sends a real hover (through the DevTools binding __tvHover), so
// sites react exactly as if the mouse were over the item: :hover styles,
// Netflix's expanding preview cards, row arrows, etc.
module.exports = String.raw`(() => {
  if (window.__tvNav || window.top !== window) return;
  window.__tvNav = true;

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=menuitem]', '[role=tab]', '[role=option]',
    '[role=checkbox]', '[role=switch]', '[role=radio]', '[tabindex]:not([tabindex="-1"])',
    '[contenteditable=""]', '[contenteditable=true]',
  ].join(',');
  const PAGER_NEXT = /handleNext|arrow-?right|chevron-?right|\bnext\b|more titles|selanjutnya|berikutnya|lainnya|scroll right|forward/i;
  const PAGER_PREV = /handlePrev|arrow-?left|chevron-?left|\bprev(ious)?\b|scroll left|sebelumnya|back/i;
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  let current = null;     // focused element
  let lastRect = null;    // its last known box (it may be re-rendered/covered)
  let ring = null;
  let ringOn = false;
  let busy = false;

  const now = () => Date.now();
  const synthetic = () => now() < (window.__tvSynth || 0); // our own hover moves
  const labelOf = el => ((typeof el.className === 'string' ? el.className : '') + ' ' +
    (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-uia') || '') + ' ' + (el.title || ''));

  const findPagerLike = el => PAGER_NEXT.test(labelOf(el)) || PAGER_PREV.test(labelOf(el));

  // ---------- when to stay out of the way ----------
  function disabled() {
    const de = document.documentElement;
    if (!de || de.hasAttribute('data-tv-launcher')) return true;
    if (/Leanback|SMART-TV|Tizen|Web0S|Cobalt/i.test(navigator.userAgent)) return true;
    if (/netflix\.com$/.test(location.hostname) && location.pathname.startsWith('/watch')) return true;
    const area = innerWidth * innerHeight;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (!v.paused && !v.ended && r.width * r.height > area * 0.45) return true;
    }
    return false;
  }

  // ---------- geometry ----------
  // Visible part of an element, clipped by the viewport and overflow-hidden ancestors.
  function visibleRect(el, r) {
    let L = Math.max(r.left, 0), T = r.top, R = Math.min(r.right, innerWidth), B = r.bottom;
    let p = el.parentElement;
    for (let i = 0; p && i < 12; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        if (cs.overflowX !== 'visible') { L = Math.max(L, pr.left); R = Math.min(R, pr.right); }
        if (cs.overflowY !== 'visible' && p !== document.scrollingElement && p !== document.body) { T = Math.max(T, pr.top); B = Math.min(B, pr.bottom); }
      }
    }
    return { left: L, top: T, right: R, bottom: B, width: Math.max(0, R - L), height: Math.max(0, B - T) };
  }
  const sameRow = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.height, b.height) * 0.5;

  function usable(el, r, band) {
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.05) return false;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"],[inert]')) return false;
    const v = visibleRect(el, r);
    if (v.width < Math.min(r.width, innerWidth) * 0.6) return false;      // mostly clipped (row peek)
    if (r.bottom < -innerHeight * 1.5 || r.top > innerHeight * 2.5) return false;
    // covered by something else (modal, hover card)? Items in the current row are
    // allowed to be covered: an expanded hover card overlaps its neighbours.
    if (r.top >= 0 && r.bottom <= innerHeight && !(band && sameRow(r, band))) {
      const hit = document.elementFromPoint((v.left + v.right) / 2, (r.top + r.bottom) / 2);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return false;
    }
    return true;
  }

  function scope() { // an open dialog keeps focus inside it
    const ds = [...document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]')]
      .filter(d => { const r = d.getBoundingClientRect(); return r.width > 120 && r.height > 120 && getComputedStyle(d).visibility !== 'hidden' && !d.closest('[aria-hidden="true"]'); });
    return ds[ds.length - 1] || document;
  }

  function candidates(band) {
    const out = [];
    for (const el of scope().querySelectorAll(SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (usable(el, r, band)) out.push({ el, r, pager: findPagerLike(el) });
    }
    return out.filter(a => !out.some(b => b !== a && a.el.contains(b.el) &&
      Math.abs(a.r.width - b.r.width) < 12 && Math.abs(a.r.height - b.r.height) < 12));
  }

  function best(dir, f, list) {
    let pick = null, score = Infinity;
    for (const c of list) {
      const r = c.r;
      if (c.el === current || c.pager) continue; // row arrows are only used for paging
      let gap, overlap, cross;
      if (dir === 'right' || dir === 'left') {
        gap = dir === 'right' ? r.left - f.right : f.left - r.right;
        if (gap < -Math.min(f.width, r.width) * 0.3) continue;
        overlap = Math.min(f.bottom, r.bottom) - Math.max(f.top, r.top);
        if (overlap <= 0) continue;                       // left/right never jumps rows
        cross = Math.abs((r.top + r.height / 2) - (f.top + f.height / 2));
      } else {
        gap = dir === 'down' ? r.top - f.bottom : f.top - r.bottom;
        if (gap < -Math.min(f.height, r.height) * 0.3) continue;
        overlap = Math.min(f.right, r.right) - Math.max(f.left, r.left);
        cross = Math.abs((r.left + r.width / 2) - (f.left + f.width / 2));
      }
      const s = Math.max(gap, 0) + (overlap > 0 ? cross * 0.25 : cross * 2 + 400);
      if (s < score) { score = s; pick = c; }
    }
    return pick;
  }

  // ---------- real hover via DevTools ----------
  function hover(el) {
    if (typeof window.__tvHover !== 'function' || !el.isConnected) return;
    const v = visibleRect(el, el.getBoundingClientRect());
    if (v.width <= 0) return;
    window.__tvSynth = now() + 500;
    window.__tvHover(JSON.stringify({ x: Math.round((v.left + v.right) / 2), y: Math.round((v.top + v.bottom) / 2) }));
  }

  // ---------- focus ring ----------
  function ensureRing() {
    if (ring && ring.isConnected) return ring;
    ring = document.createElement('div');
    const st = ring.style;
    st.position = 'fixed'; st.zIndex = '2147483647'; st.pointerEvents = 'none';
    st.transition = 'left .18s cubic-bezier(.2,.8,.2,1), top .18s cubic-bezier(.2,.8,.2,1), width .18s cubic-bezier(.2,.8,.2,1), height .18s cubic-bezier(.2,.8,.2,1)';
    st.boxShadow = '0 0 0 3px #fff, 0 0 0 6px rgba(0,0,0,.45), 0 12px 36px rgba(0,0,0,.5)';
    st.display = 'none';
    (document.body || document.documentElement).appendChild(ring);
    return ring;
  }
  // If the item has grown into a hover card (Netflix), outline the card instead.
  function ringBox() {
    const r = current.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = r.top + r.height / 2;
    if (cy < 0 || cy > innerHeight) return r;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === ring || current.contains(hit) || hit.contains(current)) return r;
    let box = null;
    for (let p = hit; p && p !== document.body; p = p.parentElement) {
      const pr = p.getBoundingClientRect();
      if (pr.width * pr.height > r.width * r.height * 8) break;
      if (pr.left <= cx && pr.right >= cx && pr.top <= cy && pr.bottom >= cy) box = pr;
    }
    return box && box.width * box.height >= r.width * r.height * 0.9 ? box : r;
  }
  function drawRing() {
    if (!ringOn || !current || !current.isConnected) { if (ring) ring.style.display = 'none'; return; }
    const r = ringBox();
    const g = ensureRing().style;
    g.display = 'block';
    g.left = r.left - 2 + 'px'; g.top = r.top - 2 + 'px';
    g.width = r.width + 4 + 'px'; g.height = r.height + 4 + 'px';
    g.borderRadius = (parseFloat(getComputedStyle(current).borderRadius) || 6) + 2 + 'px';
  }
  (function loop() { drawRing(); requestAnimationFrame(loop); })();
  addEventListener('mousemove', () => { if (!synthetic()) ringOn = false; }, true); // touchpad hides the ring

  function setCurrent(el) {
    current = el;
    ringOn = true;
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const r = el.getBoundingClientRect();
    lastRect = r;
    const margin = innerHeight * 0.2;
    if (r.top < margin || r.bottom > innerHeight - margin) {
      window.scrollBy({ top: r.top + r.height / 2 - innerHeight * 0.45, behavior: 'smooth' });
      setTimeout(() => { if (current === el) { lastRect = el.getBoundingClientRect(); hover(el); } }, 380);
    } else hover(el);
  }

  function startPoint(list) {
    const ae = document.activeElement;
    if (ae && ae !== document.body && list.some(c => c.el === ae)) return ae;
    const onScreen = list.filter(c => c.r.top >= 0 && c.r.bottom <= innerHeight && !findPagerLike(c.el))
      .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
    return (onScreen[0] || list[0] || {}).el || null;
  }

  // ---------- carousels ----------
  function findPager(from, dir) {
    const re = dir === 'right' ? PAGER_NEXT : PAGER_PREV;
    for (let p = from.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      for (const c of p.querySelectorAll('[class*="handle"], [role=button], button, [aria-label]')) {
        if (c === from || c.contains(from)) continue;
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && re.test(labelOf(c)) && sameRow(r, lastRect)) return c;
      }
    }
    return null;
  }
  function findScroller(from) {
    for (let p = from.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 4) return p;
    }
    return null;
  }
  // Move the row along, then focus the next item that slid into view.
  function pageRow(dir) {
    const from = current;
    const band = lastRect;
    const pager = findPager(from, dir);
    const scroller = !pager && findScroller(from);
    if (!pager && !scroller) return false;
    busy = true;
    if (pager) {
      hover(pager); // some carousels only page while hovered
      pager.click();
    } else {
      scroller.scrollBy({ left: (dir === 'right' ? 1 : -1) * scroller.clientWidth * 0.75, behavior: 'smooth' });
    }
    setTimeout(() => {
      busy = false;
      const row = candidates(band).filter(c => sameRow(c.r, band) && !findPagerLike(c.el));
      row.sort((a, b) => dir === 'right' ? a.r.left - b.r.left : b.r.right - a.r.right);
      // the item right after the one we were on: first one past the old position
      const next = dir === 'right'
        ? row.find(c => c.el !== from && c.r.left >= 0 && (!from.isConnected || c.r.left > from.getBoundingClientRect().left + 4)) || row[0]
        : row.find(c => c.el !== from && c.r.right <= innerWidth && (!from.isConnected || c.r.right < from.getBoundingClientRect().right - 4)) || row[0];
      if (next) setCurrent(next.el);
    }, 560);
    return true;
  }

  function move(dir) {
    const horizontal = dir === 'left' || dir === 'right';
    const alive = current && current.isConnected;
    if (alive) lastRect = current.getBoundingClientRect();
    const list = candidates(horizontal && lastRect ? lastRect : null);
    if (!ringOn || !lastRect || (!alive && !horizontal)) {
      const s = startPoint(list);
      if (s) setCurrent(s);
      return;
    }
    const pick = best(dir, lastRect, list);
    if (horizontal && !pick && pageRow(dir)) return; // end of the visible row: page the carousel
    if (!pick) {
      if (!horizontal) window.scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.6, behavior: 'smooth' });
      return;
    }
    setCurrent(pick.el);
  }

  function activate() {
    const el = current;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
      el.focus(); // focusing a text field pops the keyboard on the phone remote
      if (el.type === 'checkbox' || el.type === 'radio') el.click();
      return;
    }
    el.click();
  }

  addEventListener('keydown', e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = KEYS[e.key];
    if (!dir && e.key !== 'Enter') return;
    if (disabled()) { ringOn = false; return; }
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable ||
      (ae.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(ae.type)));
    if (typing && (e.key === 'Enter' || dir === 'left' || dir === 'right')) return;
    if (ae && ae.tagName === 'SELECT') return;
    if (e.key === 'Enter') {
      if (!current || !current.isConnected || !ringOn) return;
      e.preventDefault(); e.stopImmediatePropagation();
      activate();
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (!busy) move(dir);
  }, true);
})();`;
