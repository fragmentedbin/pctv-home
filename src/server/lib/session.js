// "Continue where you left off": remembers the page (and the video position) the TV browser was
// on, so after the app restarts (an update, a restart) it can open it again. Never used in
// incognito. Stored as session.json next to the other app data.
const fs = require('fs');
const path = require('path');

const MAX_AGE = 24 * 3600 * 1000;

/** The address to reopen: YouTube watch pages get the position added so the video continues. */
function resumeUrl(s) {
  try {
    const u = new URL(s.url);
    const yt = /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch';
    const pos = Math.floor(Number(s.pos) || 0), dur = Math.floor(Number(s.dur) || 0);
    if (yt && pos > 15 && (!dur || pos < dur - 20)) { u.searchParams.set('t', pos + 's'); return u.toString(); }
    return s.url;
  } catch { return s.url; }
}

function createSession(dir) {
  const file = path.join(dir, 'session.json');
  const flag = path.join(dir, 'resume.flag');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  return {
    resumeUrl,
    /** Save a snapshot ({url,title,pos,dur,tv}); returns true when it changed enough to write. */
    save(s) {
      if (!s || !/^https?:/.test(s.url || '')) return false;
      const old = read();
      if (old && old.url === s.url && Math.abs((old.pos || 0) - (s.pos || 0)) < 5) return false;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...s, at: Date.now() })); return true; } catch { return false; }
    },
    /** The saved page, or null when there is none or it is too old. */
    load() {
      const s = read();
      return s && s.url && Date.now() - (s.at || 0) < MAX_AGE ? s : null;
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch {} },
    /** Called right before the app restarts itself: the next start should reopen the page. */
    markResume() { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(flag, String(Date.now())); } catch {} },
    /** True once if the last shutdown asked for a resume. */
    takeResume() {
      let ok = false;
      try { ok = Date.now() - Number(fs.readFileSync(flag, 'utf8')) < 10 * 60 * 1000; } catch {}
      try { fs.rmSync(flag, { force: true }); } catch {}
      return ok;
    },
  };
}

module.exports = { createSession, resumeUrl };
