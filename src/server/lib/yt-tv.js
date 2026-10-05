// Page script for YouTube's TV app (youtube.com/tv), injected before YouTube's own code.
//
// We load the TV app with a PS4 identity (the only way YouTube serves it to a
// browser). Left like that, YouTube's player also *plays* like a PS4: it can list
// 4K but then falls back to 1080p. This script tells YouTube's API and player the
// truth — a desktop Chrome/Edge — so it picks formats this PC can actually play.
//
// Ported from VacuumTube (https://github.com/shy1132/VacuumTube), MIT License,
// Copyright (c) 2025-2026 shy. See THIRD_PARTY_NOTICES.md.
const os = require('os');

function osInfo() {
  if (process.platform === 'win32') return { name: 'Windows', version: os.release().split('.').slice(0, 2).join('.') };
  if (process.platform === 'darwin') return { name: 'Macintosh', version: '10_15_7' }; // frozen in Chrome's UA
  return { name: 'X11', version: '' };
}

/** @param {{browserVersion?: string, version: string}} o */
module.exports = function ytTvScript(o) {
  const cfg = {
    brand: 'PCTV Home',
    model: o.version,
    browserVersion: o.browserVersion || '140.0.0.0',
    os: osInfo(),
    label: `PCTV Home on ${os.hostname().replace(/\.local$/, '')}`,
  };
  return String.raw`(() => {
  if (!location.hostname.endsWith('youtube.com') || !location.pathname.startsWith('/tv')) return;
  if (window.top !== window || window.__pctvYt) return;
  window.__pctvYt = true;
  const C = ${JSON.stringify(cfg)};

  // Client-side UA: an older Cobalt keeps the TV app from assuming console-only features
  // (the request header keeps the newer one so YouTube still serves the TV app).
  try {
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      get: () => 'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/19.lts.0-qa; compatible; PCTVHome/' + C.model,
      configurable: true,
    });
  } catch (e) {}

  function deepMerge(cur, upd) {
    for (const k of Object.keys(upd)) {
      if (!Object.prototype.hasOwnProperty.call(cur, k) || typeof upd[k] !== 'object' || upd[k] === null) {
        if (upd[k] === '__DELETE__') delete cur[k]; else cur[k] = upd[k];
      } else deepMerge(cur[k], upd[k]);
    }
    return cur;
  }

  const client = {
    platform: 'DESKTOP', platformDetail: '__DELETE__', clientFormFactor: 'UNKNOWN_FORM_FACTOR',
    deviceMake: C.brand, deviceModel: C.model, browserName: 'Chrome', browserVersion: C.browserVersion,
    osName: C.os.name, osVersion: C.os.version, tvAppInfo: { releaseVehicle: '__DELETE__' },
  };
  const device = {
    platform: 'DESKTOP', brand: C.brand, model: C.model, browser: 'Chrome', browserVersion: C.browserVersion,
    os: C.os.name, cobaltReleaseVehicle: '__DELETE__',
  };

  // 1) YouTube's in-page configs, as soon as they exist
  const pending = {
    environment: {
      platform: 'DESKTOP', platform_detail: '__DELETE__', brand: C.brand, model: C.model,
      engine: 'WebKit', browser_engine: 'WebKit', browser_engine_version: '537.36',
      browser: 'Chrome', browser_version: C.browserVersion, os: C.os.name, os_version: C.os.version,
      feature_switches: { mdx_device_label: C.label },
    },
    ytcfg: {
      INNERTUBE_CONTEXT: { client },
      WEB_PLAYER_CONTEXT_CONFIGS: { WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH: { device } },
    },
  };
  const cfgTimer = setInterval(() => {
    if (pending.environment && window.environment) { deepMerge(window.environment, pending.environment); pending.environment = null; }
    if (pending.ytcfg && window.ytcfg && window.ytcfg.data_) {
      deepMerge(window.ytcfg.data_, pending.ytcfg); window.ytcfg.set(window.ytcfg.data_); pending.ytcfg = null;
    }
    if (!pending.environment && !pending.ytcfg) clearInterval(cfgTimer);
  }, 10);
  setTimeout(() => clearInterval(cfgTimer), 60000);

  // 2) API requests/responses that may go out before the configs are patched
  const Orig = window.XMLHttpRequest;
  function patchRequest(url, body) {
    if (typeof url !== 'string' || !url.startsWith('/youtubei/') || typeof body !== 'string') return body;
    try {
      const j = JSON.parse(body);
      if (j && j.context && j.context.client) { deepMerge(j.context.client, client); return JSON.stringify(j); }
    } catch (e) {}
    return body;
  }
  function patchResponse(url, text) {
    if (typeof url !== 'string' || !url.startsWith('/tv_config')) return text;
    try {
      const parts = text.split('\n');
      const j = JSON.parse(parts[parts.length - 1]);
      deepMerge(j.webPlayerContextConfig.WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH.device, device);
      return JSON.stringify(j);
    } catch (e) { return text; }
  }
  window.XMLHttpRequest = function () {
    const xhr = new Orig();
    const open = xhr.open, send = xhr.send;
    xhr.open = function (method, url) { this.__url = url; return open.apply(this, arguments); };
    xhr.send = function (body) { return send.call(this, patchRequest(this.__url, body)); };
    let done = false, text = null;
    const fix = () => {
      if (done || xhr.readyState !== 4 || (xhr.responseType && xhr.responseType !== 'text')) return;
      done = true;
      text = patchResponse(xhr.__url, xhr.responseText);
      if (text !== xhr.responseText) {
        Object.defineProperty(xhr, 'responseText', { get: () => text });
        Object.defineProperty(xhr, 'response', { get: () => text });
      }
    };
    xhr.addEventListener('readystatechange', fix); // runs before handlers added later by the page
    const add = xhr.addEventListener;
    xhr.addEventListener = function (type, fn, opt) {
      if (type === 'load' || type === 'readystatechange') {
        const wrapped = function () { fix(); return fn.apply(this, arguments); };
        return add.call(this, type, wrapped, opt);
      }
      return add.apply(this, arguments);
    };
    for (const prop of ['onload', 'onreadystatechange']) {
      let handler = null;
      Object.defineProperty(xhr, prop, {
        get: () => handler,
        set: fn => {
          if (handler) xhr.removeEventListener(prop.slice(2), handler.__w);
          handler = fn;
          if (fn) { fn.__w = function () { fix(); return fn.apply(xhr, arguments); }; add.call(xhr, prop.slice(2), fn.__w); }
        },
      });
    }
    return xhr;
  };
  window.XMLHttpRequest.prototype = Orig.prototype;
  for (const k of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) window.XMLHttpRequest[k] = Orig[k];
})();`;
};
