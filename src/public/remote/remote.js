(() => {
  const $ = s => document.querySelector(s);

  // ---------- key from QR (?k=...) remembered for the home-screen app ----------
  const params = new URLSearchParams(location.search);
  let key = params.get('k');
  try {
    if (key) localStorage.setItem('tvkey', key);
    else key = localStorage.getItem('tvkey');
  } catch {}
  if (!key) { $('#noKey').hidden = false; return; }

  // ---------- websocket ----------
  let ws = null, retry = null, bootId = null;
  function setStatus(on, text) {
    $('#dot').classList.toggle('on', on);
    $('#statusText').textContent = on ? '' : text; // connected = just the green dot (room for buttons)
    $('#dot').title = text;
  }
  function connect() {
    clearTimeout(retry);
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(`ws://${location.host}/ws?k=${encodeURIComponent(key)}`);
    ws.onopen = () => setStatus(true, 'Connected');
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'hello' && !m.input) setStatus(true, 'Connected (dev)');
      if (m.t === 'hello' && m.version) $('#appVersion').textContent = 'v' + m.version;
      if (m.t === 'focus') onTvFocus(m);
      if (m.t === 'hello') setIncognito(m.incognito);
      if (m.t === 'incognito') setIncognito(m.on);
      if (m.t === 'sys-ack') onSysAck(m);
      if (m.t === 'voice-ack') $('#kbLabel').textContent = m.ok ? 'Listening on the TV… speak now' : 'Voice search works in YouTube';
      if (m.t === 'restarting') setStatus(false, 'Restarting…');
      if (m.t === 'stats') renderStats(m);
      if (m.t === 'reload-ui') location.reload();
      if (m.t === 'hello') { // new server code -> reload the remote too
        if (bootId && bootId !== m.boot) location.reload();
        bootId = m.boot;
      }
      if (m.t === 'tiles' && !$('#appsSheet').hidden) loadApps();
    };
    ws.onclose = e => {
      if (e.code === 4001) { setStatus(false, 'Bad key - rescan QR'); try { localStorage.removeItem('tvkey'); } catch {} return; }
      setStatus(false, 'Reconnecting…');
      retry = setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }
  const send = obj => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  // iOS drops sockets in the background; reconnect when we come back
  document.addEventListener('visibilitychange', () => { if (!document.hidden) connect(); });
  setInterval(() => send({ t: 'ping' }), 20000);
  connect();

  // ---------- buttons (with hold-to-repeat) ----------
  function bindButton(btn) {
    const k = btn.dataset.key, cmd = btn.dataset.cmd;
    const repeat = k && !('norepeat' in btn.dataset);
    let delayT = null, repT = null;
    const fire = () => k ? send({ t: 'key', k }) : send({ t: cmd });
    const stop = () => { clearTimeout(delayT); clearInterval(repT); btn.classList.remove('pressed'); };
    if ('hold' in btn.dataset) { // OK: tap = select, hold = options (fires on release, like a TV remote)
      let held = false, down = false;
      btn.addEventListener('pointerdown', e => {
        e.preventDefault(); btn.classList.add('pressed'); held = false; down = true;
        delayT = setTimeout(() => { held = true; navigator.vibrate?.(25); send({ t: 'hold' }); }, 550);
      });
      btn.addEventListener('pointerup', () => { if (down && !held) fire(); down = false; stop(); });
      ['pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, () => { down = false; stop(); }));
      btn.addEventListener('contextmenu', e => e.preventDefault());
      return;
    }
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      btn.classList.add('pressed');
      fire();
      if (repeat) delayT = setTimeout(() => { repT = setInterval(fire, 110); }, 420);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }
  document.querySelectorAll('[data-key],[data-cmd]').forEach(bindButton);

  // ---------- D-pad / touchpad toggle ----------
  function setMode(m) {
    $('#dpadView').hidden = m !== 'dpad';
    $('#padView').hidden = m !== 'pad';
    $('#segDpad').classList.toggle('on', m === 'dpad');
    $('#segPad').classList.toggle('on', m === 'pad');
    try { localStorage.setItem('tvmode', m); } catch {}
  }
  $('#segDpad').addEventListener('click', () => setMode('dpad'));
  $('#segPad').addEventListener('click', () => setMode('pad'));
  let savedMode = 'dpad';
  try { savedMode = localStorage.getItem('tvmode') || 'dpad'; } catch {}
  setMode(savedMode);

  // ---------- touchpad ----------
  const pad = $('#padView');
  const SENS = 2.2;
  let last = null, startT = 0, travel = 0, maxFingers = 0;
  let accX = 0, accY = 0, accWheel = 0, raf = 0;

  const centroid = touches => {
    let x = 0, y = 0;
    for (const t of touches) { x += t.clientX; y += t.clientY; }
    return { x: x / touches.length, y: y / touches.length, n: touches.length };
  };
  function flush() {
    raf = 0;
    if (accX || accY) { send({ t: 'move', dx: Math.round(accX), dy: Math.round(accY) }); accX = accY = 0; }
    if (Math.abs(accWheel) >= 40) { send({ t: 'wheel', d: Math.round(accWheel) }); accWheel = 0; }
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };

  pad.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === e.changedTouches.length) { // new gesture (no fingers were down)
      startT = performance.now(); travel = 0; maxFingers = 0;
    }
    maxFingers = Math.max(maxFingers, e.touches.length);
    last = centroid(e.touches);
    pad.classList.add('active');
  }, { passive: false });

  pad.addEventListener('touchmove', e => {
    e.preventDefault();
    const c = centroid(e.touches);
    if (!last || c.n !== last.n) { last = c; return; }
    const dx = c.x - last.x, dy = c.y - last.y;
    last = c;
    travel += Math.abs(dx) + Math.abs(dy);
    if (c.n === 1) {
      const speed = Math.hypot(dx, dy);
      const gain = SENS * (1 + Math.min(speed, 40) * 0.06); // simple acceleration
      accX += dx * gain; accY += dy * gain;
    } else {
      accWheel += dy * 5; // natural scrolling: drag up = scroll down
    }
    schedule();
  }, { passive: false });

  pad.addEventListener('touchend', e => {
    e.preventDefault();
    if (e.touches.length) { last = centroid(e.touches); return; }
    const quick = performance.now() - startT < 260 && travel < 12;
    if (quick) send({ t: 'click', b: maxFingers >= 2 ? 'right' : 'left' });
    last = null; maxFingers = 0;
    pad.classList.remove('active');
  }, { passive: false });
  pad.addEventListener('touchcancel', () => { last = null; maxFingers = 0; pad.classList.remove('active'); });

  // ---------- sheets ----------
  const openSheet = s => { s.hidden = false; setTimeout(() => s.querySelector('input')?.focus(), 50); };
  const closeSheets = () => { document.querySelectorAll('.sheet').forEach(s => (s.hidden = true)); document.activeElement?.blur(); autoOpened = false; };
  $('#kbBtn').addEventListener('click', () => { configureKb(null); openKb(false); });
  $('#addBtn').addEventListener('click', () => { $('#tMsg').textContent = ''; openSheet($('#addSheet')); });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => {
    if (!$('#kbSheet').hidden) dismissedField = currentField; // don't re-pop for the same TV field
    closeSheets();
  }));
  document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => {
    if (e.target === s) { if (s.id === 'kbSheet') dismissedField = currentField; closeSheets(); }
  }));

  // ---------- keyboard: auto-pops when a text field is focused on the TV ----------
  const kb = $('#kbInput');
  let sent = '';            // what we've typed into the TV field so far
  let composing = false;
  let currentField = null;  // id of the focused TV field
  let dismissedField = null;
  let autoOpened = false;

  function classify(f) {
    if (!f) return 'text';
    const hay = `${f.name} ${f.label} ${f.autocomplete}`.toLowerCase();
    if (f.autocomplete === 'one-time-code' || /\b(otp|one.?time|verif\w*|2fa|mfa|pin|passcode|kode|code)\b/.test(hay) ||
        (f.maxlength > 0 && f.maxlength <= 8 && (f.inputmode === 'numeric' || f.type === 'tel' || f.type === 'number'))) return 'otp';
    if (f.type === 'password') return 'password';
    if (f.type === 'email' || /e-?mail|username|login/.test(hay)) return 'email';
    if (f.type === 'tel') return 'tel';
    if (f.type === 'number' || f.inputmode === 'numeric' || f.inputmode === 'decimal') return 'number';
    if (f.type === 'search' || /search|cari/.test(hay)) return 'search';
    if (f.type === 'url') return 'url';
    return 'text';
  }
  const KINDS = {
    otp:      { title: 'Verification code', type: 'text', mode: 'numeric', ac: 'one-time-code', ph: 'Enter code' },
    password: { title: 'Password', type: 'password', mode: '', ac: 'off', ph: 'Enter password' },
    email:    { title: 'Email', type: 'email', mode: 'email', ac: 'off', ph: 'name@example.com' },
    tel:      { title: 'Phone number', type: 'tel', mode: 'tel', ac: 'off', ph: 'Enter number' },
    number:   { title: 'Number', type: 'text', mode: 'numeric', ac: 'off', ph: 'Enter number' },
    search:   { title: 'Search', type: 'search', mode: 'search', ac: 'off', ph: 'Search…' },
    url:      { title: 'Web address', type: 'url', mode: 'url', ac: 'off', ph: 'https://' },
    text:     { title: 'Type on TV', type: 'text', mode: 'text', ac: 'off', ph: 'Tap here and type…' },
  };
  function configureKb(f) {
    const kind = classify(f);
    const k = KINDS[kind];
    // YouTube search: offer its voice search (uses the PC's microphone)
    const yt = !!(f && f.name === 'tv-search');
    $('#voiceBtn').hidden = !yt;
    $('#tabBtn').hidden = yt;
    $('#kbTitle').textContent = k.title;
    $('#kbLabel').textContent = f && f.label && f.label.toLowerCase() !== k.title.toLowerCase() ? f.label : '';
    kb.type = k.type;
    kb.inputMode = k.mode;
    kb.setAttribute('autocomplete', k.ac);
    kb.placeholder = k.ph;
    kb.removeAttribute('maxlength');
    if (f && f.maxlength > 1 && f.maxlength <= 64) kb.maxLength = f.maxlength;
    kb.value = ''; sent = '';
  }
  function openKb(auto) {
    autoOpened = auto;
    $('#addSheet').hidden = true;
    $('#kbSheet').classList.toggle('auto', auto);
    $('#kbSheet').hidden = false;
    kb.focus(); // iOS only raises its keyboard on a real tap, so this may just select the field
  }
  function onTvFocus(f) {
    if (f.editable) {
      const id = [f.type, f.name, f.label, f.maxlength].join('|');
      if (id === currentField && !$('#kbSheet').hidden) return; // same field, keep what's typed
      currentField = id;
      if (id === dismissedField) return;
      dismissedField = null;
      configureKb(f);
      openKb(true);
    } else {
      currentField = null; dismissedField = null;
      if (autoOpened && !$('#kbSheet').hidden) closeSheets();
      autoOpened = false;
    }
  }

  // Live typing: send only the difference between what the TV has and the input.
  function syncText() {
    if (composing) return;
    const v = kb.value;
    let p = 0;
    while (p < v.length && p < sent.length && v[p] === sent[p]) p++;
    const del = sent.length - p, add = v.slice(p);
    if (del > 0) send({ t: 'bs', n: del });
    if (add) send({ t: 'text', s: add });
    sent = v;
  }
  kb.addEventListener('input', syncText);
  $('#voiceBtn').addEventListener('click', () => { send({ t: 'voice' }); kb.blur(); });
  kb.addEventListener('compositionstart', () => { composing = true; });
  kb.addEventListener('compositionend', () => { composing = false; syncText(); });
  kb.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); syncText(); send({ t: 'key', k: 'enter' }); kb.value = ''; sent = ''; }
    else if (e.key === 'Backspace' && kb.value === '') send({ t: 'key', k: 'backspace' }); // delete text already on the TV
  });
  // the ⌫ / Enter buttons act on the TV directly, so reset our local mirror
  document.querySelectorAll('#kbSheet [data-key]').forEach(b => b.addEventListener('pointerdown', () => {
    if (b.dataset.key === 'backspace' && kb.value) { kb.value = kb.value.slice(0, -1); sent = kb.value; }
    else if (b.dataset.key !== 'backspace') { kb.value = ''; sent = ''; }
  }));

  // ---------- apps sheet (launch from phone) ----------
  async function loadApps() {
    try {
      const tiles = await (await fetch(`/api/tiles?k=${encodeURIComponent(key)}`)).json();
      $('#appsGrid').replaceChildren(...tiles.map(t => {
        const b = document.createElement('button');
        b.className = 'app';
        const img = new Image();
        img.alt = '';
        img.onerror = () => { const m = document.createElement('div'); m.className = 'mono'; m.textContent = t.name[0].toUpperCase(); img.replaceWith(m); };
        img.src = `/api/icon/${t.id}?k=${encodeURIComponent(key)}`;
        const label = document.createElement('span'); label.textContent = t.name;
        b.append(img, label);
        let holdT = null, held = false;
        b.addEventListener('pointerdown', () => { held = false; holdT = setTimeout(() => { held = true; navigator.vibrate?.(25); openOptions(t); }, 500); });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => clearTimeout(holdT)));
        b.addEventListener('contextmenu', e => e.preventDefault());
        b.addEventListener('click', () => { if (!held) openApp(t); });
        return b;
      }));
    } catch {}
  }
  const api = (url, body, method = 'POST') => fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Remote-Key': key }, body: body ? JSON.stringify(body) : undefined,
  });
  async function openApp(t) { closeSheets(); await api('/api/open', { id: t.id }); }

  // ---------- app options (long-press) ----------
  let optTile = null, removeArmed = false;
  function openOptions(t) {
    optTile = t; removeArmed = false;
    $('#optTitle').textContent = t.name;
    $('#optMsg').textContent = '';
    document.querySelector('[data-opt="remove"]').classList.remove('armed');
    $('#appsSheet').hidden = true;
    $('#optSheet').hidden = false;
  }
  document.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', async () => {
    const t = optTile; if (!t) return;
    const o = b.dataset.opt;
    if (o === 'open') return openApp(t);
    if (o === 'remove') {
      if (!removeArmed) { removeArmed = true; b.classList.add('armed'); $('#optMsg').textContent = `Tap again to remove “${t.name}”`; return; }
      await api('/api/tiles/' + t.id, null, 'DELETE');
      closeSheets(); return;
    }
    const body = o === 'first' ? { to: 0 } : { by: o === 'left' ? -1 : 1 };
    await api(`/api/tiles/${t.id}/move`, body);
    $('#optMsg').textContent = 'Moved';
    setTimeout(() => { if (!$('#optSheet').hidden) $('#optMsg').textContent = ''; }, 1200);
  }));

  $('#restoreApps').addEventListener('click', async () => {
    const r = await (await api('/api/tiles/restore', {})).json().catch(() => ({}));
    $('#restoreApps').textContent = r.restored?.length ? `Restored ${r.restored.join(', ')}` : 'Nothing to restore';
    setTimeout(() => ($('#restoreApps').textContent = 'Restore removed built-in apps'), 2500);
    loadApps();
  });

  // ---------- one-tap restart ----------
  $('#restartBtn').addEventListener('click', () => {
    $('#restartBtn').classList.add('spin');
    send({ t: 'sys', a: 'restart-app' });
    setTimeout(() => $('#restartBtn').classList.remove('spin'), 6000);
  });

  // ---------- PC status strip ----------
  const pingClass = ms => ms == null ? 'bad' : ms < 40 ? 'good' : ms < 100 ? 'ok' : 'bad';
  const esc = t => String(t).replace(/[<>&"]/g, '');
  function wifiIcon(signal) {
    const lvl = signal == null ? 3 : signal >= 70 ? 3 : signal >= 45 ? 2 : signal >= 20 ? 1 : 0;
    return `<svg class="wifi-ico" viewBox="0 0 24 24"><path class="bar ${lvl >= 3 ? 'on' : ''}" d="M2.5 9a14 14 0 0119 0"/><path class="bar ${lvl >= 2 ? 'on' : ''}" d="M5.5 12.5a9.5 9.5 0 0113 0"/><path class="bar ${lvl >= 1 ? 'on' : ''}" d="M8.6 16a5 5 0 016.8 0"/><circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none"/></svg>`;
  }
  function batIcon(pct, charging) {
    const w = Math.max(1.5, 15 * (pct || 0) / 100);
    return `<svg class="bat-ico" viewBox="0 0 26 18"><rect x="1" y="2" width="20" height="14" rx="3"/><path d="M23.5 7v4"/><rect class="lvl" x="3.5" y="4.5" width="${w}" height="9" rx="1.2"/>${charging ? '<path d="M12.5 3.5l-3 6h3l-1.5 5 4-6.5h-3l1.5-4.5z" fill="#0d0f13" stroke="none"/>' : ''}</svg>`;
  }
  function renderStats(st) {
    const n = st.net || {}, b = st.battery || {};
    const ping = st.pingInternet;
    if (n.type === 'none') $('#psNet').innerHTML = `${wifiIcon(0)}<b>PC offline</b>`;
    else {
      const name = n.type === 'wifi' ? (n.ssid || 'Wi-Fi') : 'Ethernet';
      const sig = n.type === 'wifi' && n.signal != null ? `${n.signal}%` : '';
      $('#psNet').innerHTML = `${n.type === 'wifi' ? wifiIcon(n.signal) : '<svg viewBox="0 0 24 24"><rect x="4" y="9" width="16" height="10" rx="2"/><path d="M8 9V5h8v4"/></svg>'}<b>${esc(name)}</b><span>${sig}</span><span class="ping ${pingClass(ping)}">${ping == null ? '—' : ping + ' ms'}</span>`;
    }
    if (b.present) {
      const low = b.percent != null && b.percent <= 20 && !b.plugged;
      const el = $('#psBat');
      el.className = 'ps ' + (b.charging || b.plugged ? 'bat-chg' : low ? 'bat-low' : '');
      const left = !b.plugged && b.minutesLeft ? `<span>${Math.floor(b.minutesLeft / 60)}h ${b.minutesLeft % 60}m</span>` : (b.plugged ? '<span>Plugged in</span>' : '');
      el.innerHTML = `${batIcon(b.percent, b.charging || b.plugged)}<b>${b.percent ?? '?'}%</b>${left}`;
    } else $('#psBat').innerHTML = '';
  }

  // ---------- system menu ----------
  let armed = null, armT = null;
  document.querySelectorAll('[data-sys]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.sys;
    if (b.dataset.confirm && armed !== b) { // dangerous: tap twice to confirm
      document.querySelectorAll('.sys.armed').forEach(x => x.classList.remove('armed'));
      armed = b; b.classList.add('armed');
      $('#sysMsg').textContent = b.dataset.confirm + ' Tap again to confirm.';
      clearTimeout(armT); armT = setTimeout(() => { b.classList.remove('armed'); armed = null; $('#sysMsg').textContent = ''; }, 4000);
      return;
    }
    armed = null; b.classList.remove('armed');
    $('#sysMsg').textContent = 'Working…';
    send({ t: 'sys', a });
  }));
  function setIncognito(on) {
    $('#incogSys').classList.toggle('on', !!on);
    $('#incogSysTitle').textContent = on ? 'Exit incognito' : 'Incognito mode';
    $('#incogSysSub').textContent = on ? 'Incognito is on. Leaving deletes everything from this session'
      : 'Private session on the TV. No logins or history are kept';
    document.body.classList.toggle('incognito', !!on);
  }
  function onSysAck(m) {
    if (m.a === 'restart-app' && !m.ok) { $('#restartBtn').classList.remove('spin'); setStatus(true, m.msg); }
    $('#sysMsg').textContent = m.ok ? m.msg : 'Failed: ' + m.msg;
    if (m.ok && (m.a === 'reboot' || m.a === 'shutdown')) $('#sysCancel').hidden = false;
    if (m.a === 'cancel-power') $('#sysCancel').hidden = true;
  }
  async function loadScreens() {
    try {
      const ds = await (await fetch(`/api/displays?k=${encodeURIComponent(key)}`)).json();
      $('#sysScreens').hidden = !(ds.length > 1);
      $('#sysScreenList').replaceChildren(...ds.map(d => {
        const b = document.createElement('button');
        b.className = d.current ? 'on' : '';
        b.innerHTML = '<b></b><small></small>';
        b.querySelector('b').textContent = d.name;
        b.querySelector('small').textContent = `${d.width}×${d.height}`;
        b.addEventListener('click', async () => {
          if (d.current) return;
          $('#sysMsg').textContent = `Moving TV Home to ${d.name}…`;
          await fetch('/api/displays', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remote-Key': key }, body: JSON.stringify({ id: d.id }) });
          setTimeout(loadScreens, 1500);
        });
        return b;
      }));
    } catch {}
  }

  $('#sysBtn').addEventListener('click', () => {
    loadScreens();
    document.querySelectorAll('.sheet').forEach(s => (s.hidden = true));
    $('#sysMsg').textContent = '';
    $('#sysSheet').hidden = false;
  });

  $('#appsBtn').addEventListener('click', () => { loadApps(); $('#kbSheet').hidden = true; $('#addSheet').hidden = true; $('#appsSheet').hidden = false; });

  $('#tUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#tOpen').click(); } });
  $('#tOpen').addEventListener('click', async () => {
    const url = $('#tUrl').value.trim();
    if (!url) { $('#tMsg').textContent = 'Type a web address or something to search'; return; }
    const r = await api('/api/open-url', { url, tv: $('#tTv').checked }).catch(() => null);
    if (!r || !r.ok) { $('#tMsg').textContent = 'Type a web address or something to search'; return; }
    closeSheets();
  });
  $('#tSave').addEventListener('click', async () => {
    const url = $('#tUrl').value.trim();
    if (!url) { $('#tMsg').textContent = 'Type a web address or a name'; return; }
    try {
      const r = await fetch('/api/tiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Remote-Key': key },
        body: JSON.stringify({ name: $('#tName').value, url, icon: $('#tIcon').value.trim(), tv: $('#tTv').checked }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      $('#tMsg').textContent = 'Added - it is on the TV now';
      $('#tName').value = ''; $('#tUrl').value = ''; $('#tIcon').value = ''; $('#tTv').checked = false;
    } catch (err) { $('#tMsg').textContent = 'Failed: ' + err.message; }
  });
})();
