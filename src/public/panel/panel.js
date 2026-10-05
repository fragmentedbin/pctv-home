(() => {
  const $ = s => document.querySelector(s);
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
  let appState = {};

  function check(state, title, detail, action) {
    const li = document.createElement('li');
    li.className = state;
    li.innerHTML = `<span class="i">${state === 'ok' ? '✓' : '!'}</span><span><b></b><small></small></span>`;
    li.querySelector('b').textContent = title;
    li.querySelector('small').textContent = detail || '';
    if (action) {
      const b = document.createElement('button');
      b.className = 'ghost small'; b.textContent = action.label;
      b.onclick = action.run;
      li.lastChild.appendChild(b);
    }
    return li;
  }

  async function loadDisplays() {
    const ds = await fetch('/api/displays').then(r => r.json()).catch(() => []);
    $('#displayRow').style.display = ds.length > 1 ? '' : 'none';
    const sel = $('#displayPick');
    if (document.activeElement === sel) return;
    sel.replaceChildren(...ds.map(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = `${d.name} (${d.width}×${d.height})${d.primary ? ' · main' : ''}`;
      o.selected = d.current;
      return o;
    }));
  }

  async function refresh() {
    loadDisplays();
    const [info, st] = await Promise.all([fetch('/api/info').then(r => r.json()), fetch('/api/app').then(r => r.json()).catch(() => ({}))]);
    appState = st;
    $('#version').textContent = 'v' + info.version;
    $('#url').textContent = info.remoteUrl.replace(/\?k=.*/, '');
    $('#remotes').textContent = info.remotes ? `${info.remotes} phone${info.remotes > 1 ? 's' : ''} connected` : 'No phone connected yet';
    $('#remotes').classList.toggle('on', info.remotes > 0);

    const list = [];
    list.push(info.browser
      ? check('ok', `Browser: ${info.browser.name}`, 'Used to play your streaming apps in full screen')
      : check('bad', 'Google Chrome or Microsoft Edge is needed', 'Netflix, Disney+ and others need a browser with DRM support.',
          { label: 'Get Google Chrome', run: () => openUrl('https://www.google.com/chrome/') }));
    if (info.input.available) list.push(check('ok', 'Remote control input', 'Your phone can press keys and move the pointer'));
    else if (info.input.reason === 'accessibility') {
      list.push(check('warn', 'Allow Accessibility access', 'macOS needs this so the phone remote can control the screen. Turn on PCTV Home, then restart it.',
        { label: 'Open Accessibility settings', run: () => post('/api/app', { action: 'accessibility' }) }));
    } else list.push(check('warn', 'Remote input unavailable on this system', 'Navigation inside the TV Home still works'));
    list.push(check('ok', 'Phone address', `${info.ip}:${info.port} — phone and PC must be on the same Wi-Fi`));
    $('#checks').replaceChildren(...list);

    $('#startAtLogin').checked = !!st.startAtLogin;
    $('#openOnStart').checked = st.openOnStart !== false;
    if (st.browser) $('#browserPref').value = st.browser;
    if (st.youtubeFill) $('#ytFill').value = st.youtubeFill;
    if (st.uiScale !== undefined) {
      $('#uiScale').value = String(st.uiScale);
      const eff = st.uiScaleEffective ? Math.round(st.uiScaleEffective * 100) + '%' : 'system scaling';
      $('#uiScaleHint').textContent = `Now ${eff} on a ${st.display.width}×${st.display.height} screen. Auto adjusts when you plug in a monitor.`;
    }
    $('#uiScale').closest('.select').style.display = st.uiScale !== undefined ? '' : 'none';
    $('#ytFill').closest('.select').style.display = st.youtubeFill ? '' : 'none';
    $('#browserPref').closest('.select').style.display = st.browser ? '' : 'none';
    $('#startAtLogin').closest('.toggle').classList.toggle('disabled', st.startAtLogin === undefined);
  }
  const openUrl = url => post('/api/app', { action: 'open-url', url });

  $('#qr').src = '/api/qr.svg?' + Date.now();
  $('#open').onclick = () => post('/api/sys', { a: 'open-kiosk' }).then(r => { if (!r.ok) alert(r.msg); });
  $('#restart').onclick = () => { $('#restart').textContent = 'Restarting…'; post('/api/sys', { a: 'restart-app' }); };
  $('#copy').onclick = async () => {
    const info = await fetch('/api/info').then(r => r.json());
    await navigator.clipboard.writeText(info.remoteUrl).catch(() => {});
    $('#copy').textContent = 'Copied'; setTimeout(() => ($('#copy').textContent = 'Copy link'), 1500);
  };
  $('#newKey').onclick = async () => {
    if (!confirm('Create a new pairing code? Phones paired with the old code will need to scan again.')) return;
    await post('/api/app/new-key');
    $('#qr').src = '/api/qr.svg?' + Date.now(); refresh();
  };
  $('#startAtLogin').onchange = e => post('/api/app', { startAtLogin: e.target.checked }).then(refresh);
  $('#displayPick').onchange = e => post('/api/displays', { id: e.target.value }).then(refresh);
  $('#uiScale').onchange = e => {
    const v = e.target.value;
    post('/api/app', { uiScale: v === 'auto' || v === 'system' ? v : Number(v) }).then(refresh);
  };
  $('#ytFill').onchange = e => post('/api/app', { youtubeFill: e.target.value }).then(refresh);
  $('#browserPref').onchange = e => post('/api/app', { browser: e.target.value }).then(refresh);
  $('#openOnStart').onchange = e => post('/api/app', { openOnStart: e.target.checked }).then(refresh);
  document.querySelectorAll('[data-url]').forEach(a => a.onclick = e => { e.preventDefault(); openUrl(a.dataset.url); });

  refresh(); setInterval(refresh, 4000);
})();
