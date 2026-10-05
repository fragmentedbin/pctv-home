(() => {
  const $ = s => document.querySelector(s);
  const row = $('#tiles');
  const addDlg = $('#addDlg');
  const delDlg = $('#delDlg');
  const DEFAULT_COLOR = '#2b2f3a';
  const COLORS = [DEFAULT_COLOR, '#1db954', '#e50914', '#1f80e0', '#7b2cbf', '#ff6d00', '#00897b', '#c2185b'];

  let tiles = [];
  let focused = null;
  let lastMainFocus = 0;
  let pendingDelete = null;
  let addColor = COLORS[0];
  const look = {}; // per tile id: { icon: url|null, plate: bool, accent, color }

  // ---------- clock ----------
  function tick() {
    const d = new Date();
    $('#clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  tick(); setInterval(tick, 10000);

  // ---------- helpers ----------
  const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  const initials = name => (name.trim().match(/\S/g) || ['?']).slice(0, 1).join('').toUpperCase();

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // Average of the vivid pixels of an icon (same-origin, so canvas is readable).
  function dominantColor(img) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let r = 0, gr = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [R, G, B, A] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        const max = Math.max(R, G, B), min = Math.min(R, G, B);
        if (A < 128 || max - min < 40 || max < 50) continue; // skip transparent / grey / dark
        r += R; gr += G; b += B; n++;
      }
      if (!n) return null;
      const hex = v => Math.round(v / n).toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(gr)}${hex(b)}`;
    } catch { return null; }
  }

  // ---------- data ----------
  async function loadTiles(announce) {
    const prev = tiles.map(t => t.id);
    tiles = await (await fetch('/api/tiles')).json();
    render();
    if (announce) {
      const added = tiles.find(t => !prev.includes(t.id));
      if (added) toast(`“${added.name}” added to Home`);
    }
  }
  async function loadInfo() {
    try {
      const info = await (await fetch('/api/info')).json();
      $('#remoteUrl').textContent = info.remoteUrl.replace(/\?k=.*/, '');
    } catch {}
  }

  function iconNode(t, big) {
    const L = look[t.id];
    if (L && L.icon) {
      const img = new Image();
      img.src = L.icon; img.className = 'icon' + (L.plate && !big ? ' plate' : ''); img.alt = '';
      return img;
    }
    const m = document.createElement('div');
    m.className = 'mono'; m.textContent = initials(t.name);
    return m;
  }

  function applyLook(el, t) {
    const L = look[t.id] || {};
    el.style.setProperty('--c', L.color || t.color || '#1f232c');
    el.style.setProperty('--a', L.accent || t.accent || t.color || '#5f6b80');
  }

  function buildTile(t, i) {
    const el = document.createElement('div');
    el.className = 'tile focusable';
    el.tabIndex = -1;
    el.dataset.index = i;
    const card = document.createElement('div');
    card.className = 'card';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = t.name;
    el.append(card, label);
    applyLook(el, t);

    const paint = () => { card.replaceChildren(iconNode(t)); applyLook(el, t); };
    if (look[t.id]) paint();
    else {
      // first time: try the cached app icon from the server
      look[t.id] = { icon: null };
      paint();
      const img = new Image();
      img.onload = () => {
        const custom = !t.accent && (!t.color || t.color === DEFAULT_COLOR);
        const dom = dominantColor(img);
        look[t.id] = {
          icon: img.src,
          plate: img.naturalWidth < 96,
          accent: custom && dom ? dom : undefined,
          color: custom && dom ? `color-mix(in srgb, ${dom} 28%, #121419)` : undefined,
        };
        paint();
        if (focused === el) updateAmbient(el);
      };
      img.src = `/api/icon/${t.id}`;
    }
    el.addEventListener('click', () => openTile(t));
    el.addEventListener('contextmenu', e => { e.preventDefault(); askDelete(t); });
    return el;
  }

  function render() {
    row.replaceChildren(...tiles.map(buildTile));
    const add = document.createElement('div');
    add.className = 'tile add focusable';
    add.tabIndex = -1;
    add.innerHTML = '<div class="card"><div class="add-inner"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add app</div></div><div class="label">Add app</div>';
    add.addEventListener('click', openAdd);
    row.appendChild(add);
    $('#rowCount').textContent = `${tiles.length} app${tiles.length === 1 ? '' : 's'}`;
    const items = layerItems();
    if (!lastMainFocus) lastMainFocus = items.findIndex(x => x.classList.contains('tile'));
    setFocus(items[Math.min(lastMainFocus, items.length - 1)]);
  }

  // ---------- ambient backdrop + hero ----------
  let bdFront = $('#bdA'), bdBack = $('#bdB'), ambientT = null, heroKey = null;
  function updateAmbient(el) {
    clearTimeout(ambientT);
    ambientT = setTimeout(() => {
      const i = el.dataset.index;
      const t = i !== undefined ? tiles[+i] : null;
      const L = t ? (look[t.id] || {}) : {};
      const a = t ? (L.accent || t.accent || t.color) : '#3b4a66';
      const c = t ? (L.color || t.color) : '#12151c';
      bdBack.style.setProperty('--a', a);
      bdBack.style.setProperty('--c', c);
      bdBack.querySelector('.bd-logo').src = (t && L.icon) || '';
      bdBack.classList.add('show'); bdFront.classList.remove('show');
      [bdFront, bdBack] = [bdBack, bdFront];
    }, 90);

    const i = el.dataset.index;
    const t = i !== undefined ? tiles[+i] : null;
    const key = t ? t.id : 'add';
    if (key === heroKey) return;
    heroKey = key;
    const hero = $('#hero');
    hero.classList.remove('swap'); void hero.offsetWidth; hero.classList.add('swap');
    if (t) {
      $('#heroKicker').textContent = t.builtin ? 'Streaming' : 'Pinned app';
      $('#heroTitle').textContent = t.name;
      const meta = [`<span>${host(t.url)}</span>`];
      if (t.tv) meta.push('<i class="sep"></i><span class="badge">TV mode</span>');
      if (!t.builtin) meta.push('<i class="sep"></i><span>Press <kbd>Del</kbd> to remove</span>');
      $('#heroMeta').innerHTML = meta.join('');
      $('#heroCta').innerHTML = '<kbd>OK</kbd><span>to open</span>';
    } else {
      $('#heroKicker').textContent = 'Customize';
      $('#heroTitle').textContent = 'Add an app';
      $('#heroMeta').textContent = 'Pin any website to your Home screen';
      $('#heroCta').innerHTML = '<kbd>OK</kbd><span>to add</span>';
    }
  }

  // ---------- focus / spatial navigation ----------
  const activeLayer = () => (!addDlg.hidden ? addDlg : !delDlg.hidden ? delDlg : $('#main'));
  const layerItems = () => activeLayer() === $('#main')
    ? [...document.querySelectorAll('.top .focusable'), ...$('#main').querySelectorAll('.focusable')]
    : [...activeLayer().querySelectorAll('.focusable')];

  function setFocus(el) {
    if (!el) return;
    if (focused) focused.classList.remove('focused');
    focused = el;
    el.classList.add('focused');
    el.focus({ preventScroll: true });
    if (el.classList.contains('tile')) {
      row.classList.add('has-focus');
      const r = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const pad = rr.width * 0.12;
      if (r.right > rr.right - pad) row.scrollLeft += r.right - (rr.right - pad);
      else if (r.left < rr.left + pad) row.scrollLeft -= (rr.left + pad) - r.left;
      updateAmbient(el);
    }
    if (!el.classList.contains('tile')) row.classList.remove('has-focus');
    if (activeLayer() === $('#main')) lastMainFocus = Math.max(0, layerItems().indexOf(el));
  }

  function move(dir) {
    const items = layerItems();
    if (!focused || !items.includes(focused)) return setFocus(items[0]);
    const a = focused.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === focused) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const ok = dir === 'ArrowRight' ? dx > 4 : dir === 'ArrowLeft' ? dx < -4 : dir === 'ArrowDown' ? dy > 4 : dy < -4;
      if (!ok) continue;
      const horiz = dir === 'ArrowLeft' || dir === 'ArrowRight';
      const score = Math.abs(horiz ? dx : dy) + Math.abs(horiz ? dy : dx) * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best && (dir === 'ArrowRight' || dir === 'ArrowLeft')) {
      best = items[items.indexOf(focused) + (dir === 'ArrowRight' ? 1 : -1)];
    }
    if (best) setFocus(best);
  }

  // pointer auto-hide on the launcher itself (works without the DevTools hook)
  let idleT = null;
  const idle = on => document.documentElement.classList.toggle('idle', on);
  const wakePointer = () => { idle(false); clearTimeout(idleT); idleT = setTimeout(() => idle(true), 3000); };
  document.addEventListener('mousemove', wakePointer, true);
  document.addEventListener('keydown', () => idle(true), true);
  idleT = setTimeout(() => idle(true), 3000);

  // hovering with the mouse / phone touchpad also focuses (and changes the backdrop)
  document.addEventListener('mousemove', e => {
    const el = e.target.closest?.('.focusable');
    if (el && el !== focused && layerItems().includes(el)) setFocus(el);
  });

  // ---------- actions ----------
  function showSplash(t) {
    const s = $('#splash');
    const L = look[t.id] || {};
    s.style.setProperty('--a', L.accent || t.accent || t.color);
    $('#splashIcon').replaceChildren(iconNode(t, true));
    $('#splashName').textContent = `Opening ${t.name}`;
    s.hidden = false;
    clearTimeout(showSplash.t);
    showSplash.t = setTimeout(() => (s.hidden = true), 8000);
  }
  async function openTile(t) {
    showSplash(t);
    try {
      const r = await (await fetch('/api/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }),
      })).json();
      if (!r.ok) location.href = t.url; // no DevTools connection: plain navigation
    } catch { location.href = t.url; }
  }

  function openAdd() {
    $('#fName').value = ''; $('#fUrl').value = ''; $('#fTv').checked = false;
    addColor = COLORS[0]; renderSwatches();
    addDlg.hidden = false;
    setFocus($('#fName'));
  }
  function renderSwatches() {
    const box = $('#swatches');
    box.replaceChildren(...COLORS.map(c => {
      const s = document.createElement('div');
      s.className = 'swatch focusable' + (c === addColor ? ' sel' : '');
      s.tabIndex = -1;
      s.style.background = c;
      s.dataset.color = c;
      s.title = c === DEFAULT_COLOR ? 'Auto (from icon)' : c;
      s.addEventListener('click', () => { addColor = c; box.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x.dataset.color === c)); });
      return s;
    }));
  }
  async function saveAdd() {
    const url = $('#fUrl').value.trim();
    if (!url) return setFocus($('#fUrl'));
    const r = await fetch('/api/tiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#fName').value, url, color: addColor, tv: $('#fTv').checked }),
    });
    if (!r.ok) { toast('That web address looks invalid'); return setFocus($('#fUrl')); }
    closeDialogs();
    lastMainFocus = document.querySelectorAll('.top .focusable').length + tiles.length; // the new tile
    await loadTiles();
    toast('App added');
  }
  function askDelete(t) {
    if (!t || t.builtin) return;
    pendingDelete = t;
    $('#delTitle').textContent = `Remove “${t.name}”?`;
    delDlg.hidden = false;
    setFocus($('#delNo'));
  }
  async function confirmDelete() {
    const name = pendingDelete?.name;
    if (pendingDelete) await fetch('/api/tiles/' + pendingDelete.id, { method: 'DELETE' });
    pendingDelete = null;
    closeDialogs();
    await loadTiles();
    if (name) toast(`“${name}” removed`);
  }
  function closeDialogs() {
    addDlg.hidden = true; delDlg.hidden = true;
    const items = layerItems();
    setFocus(items[Math.min(lastMainFocus, items.length - 1)]);
  }

  $('#restartBtn').addEventListener('click', async () => {
    toast('Restarting launcher…');
    try {
      const r = await (await fetch('/api/sys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'restart-app' }) })).json();
      if (!r.ok) toast(r.msg);
    } catch {}
  });

  // ---------- PC status: Wi-Fi + battery ----------
  const pingClass = ms => ms == null ? 'bad' : ms < 40 ? 'good' : ms < 100 ? 'ok' : 'bad';
  function wifiIcon(signal) {
    const lvl = signal == null ? 3 : signal >= 70 ? 3 : signal >= 45 ? 2 : signal >= 20 ? 1 : 0;
    return `<svg class="wifi-ico" viewBox="0 0 24 24"><path class="bar ${lvl >= 3 ? 'on' : ''}" d="M2.5 9a14 14 0 0119 0"/><path class="bar ${lvl >= 2 ? 'on' : ''}" d="M5.5 12.5a9.5 9.5 0 0113 0"/><path class="bar ${lvl >= 1 ? 'on' : ''}" d="M8.6 16a5 5 0 016.8 0"/><circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none"/></svg>`;
  }
  function batIcon(pct, charging) {
    const w = Math.max(1.5, 15 * (pct || 0) / 100);
    return `<svg class="bat-ico" viewBox="0 0 26 18"><rect x="1" y="2" width="20" height="14" rx="3"/><path d="M23.5 7v4"/><rect class="lvl" x="3.5" y="4.5" width="${w}" height="9" rx="1.2"/>${charging ? '<path d="M12.5 3.5l-3 6h3l-1.5 5 4-6.5h-3l1.5-4.5z" fill="#0a0b0f" stroke="none"/>' : ''}</svg>`;
  }
  function renderStats(st) {
    const n = st.net || {}, b = st.battery || {};
    const nc = $('#netChip');
    nc.hidden = false;
    const ping = st.pingInternet;
    if (n.type === 'none') nc.innerHTML = `${wifiIcon(0)}<b>Offline</b>`;
    else {
      const name = n.type === 'wifi' ? (n.ssid || 'Wi-Fi') : 'Ethernet';
      const sig = n.type === 'wifi' && n.signal != null ? `<span class="dim">${n.signal}%</span>` : '';
      nc.innerHTML = `${n.type === 'wifi' ? wifiIcon(n.signal) : '<svg viewBox="0 0 24 24"><rect x="4" y="9" width="16" height="10" rx="2"/><path d="M8 9V5h8v4M9 13v2M12 13v2M15 13v2"/></svg>'}<b>${name.replace(/[<>&]/g, '')}</b>${sig}<span class="ping ${pingClass(ping)}">${ping == null ? '—' : ping + ' ms'}</span>`;
    }
    const bc = $('#batChip');
    bc.hidden = !b.present;
    if (b.present) {
      const low = b.percent != null && b.percent <= 20 && !b.plugged;
      bc.className = 'chip ' + (b.charging || b.plugged ? 'bat-chg' : low ? 'bat-low' : '');
      bc.innerHTML = `${batIcon(b.percent, b.charging || b.plugged)}<b>${b.percent ?? '?'}%</b>`;
    }
  }

  $('#addSave').addEventListener('click', saveAdd);
  $('#addCancel').addEventListener('click', closeDialogs);
  $('#delYes').addEventListener('click', confirmDelete);
  $('#delNo').addEventListener('click', closeDialogs);
  $('#fTvWrap').addEventListener('click', e => { e.preventDefault(); $('#fTv').checked = !$('#fTv').checked; });

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    const inInput = e.target.tagName === 'INPUT' && e.target.type !== 'checkbox';
    switch (e.key) {
      case 'ArrowUp': case 'ArrowDown':
        e.preventDefault(); move(e.key); break;
      case 'ArrowLeft': case 'ArrowRight':
        if (inInput) return;
        e.preventDefault(); move(e.key); break;
      case 'Enter':
        e.preventDefault();
        if (inInput) { move('ArrowDown'); break; }
        focused?.click();
        break;
      case 'Escape':
        e.preventDefault(); $('#splash').hidden = true; closeDialogs(); break;
      case 'Backspace':
        if (inInput) return;
        e.preventDefault(); closeDialogs(); break;
      case 'Delete': {
        if (inInput || activeLayer() !== $('#main')) return;
        const i = focused?.dataset.index;
        if (i !== undefined) askDelete(tiles[+i]);
        break;
      }
    }
  });

  // ---------- live updates ----------
  function setRemotes(n) {
    $('#remoteChip').dataset.state = n > 0 ? 'on' : 'off';
    $('#remoteChipText').textContent = n > 0 ? (n === 1 ? 'Remote connected' : `${n} remotes connected`) : 'No remote';
  }
  let bootId = null;
  function connectWs() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'tiles') loadTiles(true);
      if (m.t === 'remotes') setRemotes(m.n);
      if (m.t === 'restarting') toast('Restarting launcher…');
      if (m.t === 'stats') renderStats(m);
      if (m.t === 'reload-ui') location.reload();
      if (m.t === 'hello') { // server restarted with new code -> pick up the new UI
        if (bootId && bootId !== m.boot) location.reload();
        bootId = m.boot;
      }
    };
    ws.onclose = () => setTimeout(connectWs, 2000);
  }

  window.addEventListener('pageshow', () => {
    $('#splash').hidden = true;
    $('#qr').src = '/api/qr.svg?' + Date.now();
    loadInfo();
  });

  loadTiles(); loadInfo(); connectWs();
})();
