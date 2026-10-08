const test = require('node:test');
const assert = require('node:assert/strict');
const { playingScript, appLabel, siteOf } = require('../src/server/lib/browser');

function playingOn(els, url, { md = null, state = 'none', title = 'Page' } = {}) {
  const u = new URL(url);
  const doc = { title, querySelectorAll: () => els };
  const nav = { mediaSession: { metadata: md, playbackState: state } };
  return new Function('document', 'location', 'innerWidth', 'innerHeight', 'navigator', `return ${playingScript()}`)(
    doc, { hostname: u.hostname, pathname: u.pathname }, 1920, 1080, nav);
}
const el = (o = {}) => ({ tagName: 'VIDEO', readyState: 4, paused: false, ended: false, muted: false, loop: false,
  getBoundingClientRect: () => ({ width: 1280, height: 720 }), ...o });

test('a playing video is reported as playing', () => {
  assert.equal(playingOn([el()], 'https://www.youtube.com/watch?v=1').playing, true);
});

test('a paused video is still reported (so the card can say "Paused")', () => {
  assert.equal(playingOn([el({ paused: true })], 'https://www.youtube.com/watch?v=1').playing, false);
});

test('audio-only apps (Spotify) count, with the track from the media session', () => {
  const md = { title: 'Song', artist: 'Band', album: 'LP', artwork: [{ src: 'a.png' }, { src: 'b.png' }] };
  const r = playingOn([el({ tagName: 'AUDIO', getBoundingClientRect: () => ({ width: 0, height: 0 }) })], 'https://open.spotify.com/', { md, state: 'playing' });
  assert.deepEqual({ ...r }, { playing: true, host: 'open.spotify.com', title: 'Song', artist: 'Band', art: 'b.png' });
});

test('autoplaying previews and Netflix/Disney+ browse pages are ignored', () => {
  assert.equal(playingOn([el({ muted: true, loop: true })], 'https://example.com/'), null);
  assert.equal(playingOn([el()], 'https://www.netflix.com/browse'), null);
  assert.equal(playingOn([el()], 'https://www.netflix.com/watch/123').playing, true);
  assert.equal(playingOn([el()], 'https://www.disneyplus.com/home'), null);
});

test('a small video without a media session is not "the thing playing"', () => {
  assert.equal(playingOn([el({ getBoundingClientRect: () => ({ width: 200, height: 100 }) })], 'https://example.com/'), null);
});

test('app names and "same app" matching', () => {
  assert.equal(appLabel('www.youtube.com'), 'YouTube');
  assert.equal(appLabel('open.spotify.com'), 'Spotify');
  assert.equal(appLabel('music.youtube.com'), 'YouTube');
  assert.equal(appLabel('vidio.com'), 'vidio.com');
  assert.equal(siteOf('https://open.spotify.com/track/1'), siteOf('https://www.spotify.com/'));
  assert.notEqual(siteOf('https://youtube.com/tv'), siteOf('https://spotify.com'));
  assert.equal(siteOf('nope'), '');
});

test('only checked sites keep the D-pad; every other site is touchpad-only', () => {
  const { noDpad } = require('../src/server/lib/dpad-sites');
  assert.equal(noDpad('https://www.netflix.com/browse'), true);
  assert.equal(noDpad('https://www.disneyplus.com/'), true);
  assert.equal(noDpad('https://open.spotify.com/'), true);
  assert.equal(noDpad('https://notyoutube.com/'), true);
  assert.equal(noDpad('https://www.youtube.com/tv'), false);
  assert.equal(noDpad('http://localhost:3000/'), false);
  assert.equal(noDpad('about:blank'), false);   // not a website: don't touch the mode
  assert.equal(noDpad('not a url'), false);
  assert.match(require('../src/server/lib/tv-nav'), /const DPAD_HOSTS = \["localhost","127\.0\.0\.1","youtube\.com"\]/);
});
