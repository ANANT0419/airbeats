import { AudioEngine } from './audio.js';
import { startCamera, createHandTracker } from './hands.js';
import { Game } from './game.js';
import { SONGS } from './songs.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const audio = new AudioEngine();
const game = new Game($('stage'), audio, { onStats, onEnd });
window.__airbeats = { game, audio }; // handy for debugging in devtools
let mode = 'drums';
let current = null; // current song (null = free play)
let handsOn = false;

const HINTS = {
  drums: 'Hold a fist like you are gripping sticks. Swing down onto a pad to hit it. Hit the pad when its ring closes in.',
  piano: 'Point with your index finger and tap down onto a key. Hit each key as its glass tile reaches it.',
};

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    return null;
  }
}

// ---------- intro ----------
$('btn-camera').addEventListener('click', async () => {
  audio.init();
  const btn = $('btn-camera');
  btn.disabled = true;
  const video = $('video');
  try {
    $('status').textContent = 'Starting camera…';
    await startCamera(video);
    game.setSource(video, null);
  } catch (e) {
    console.warn(e);
    $('status').textContent = 'Camera blocked or not found. You can still play with mouse / touch.';
    btn.disabled = false;
    return;
  }
  try {
    $('status').textContent = 'Loading hand tracking (first time takes a few seconds)…';
    const tracker = await createHandTracker();
    game.setSource(video, tracker);
    handsOn = true;
  } catch (e) {
    console.warn(e);
    $('notice').textContent = 'Hand tracking could not load, so mouse / touch is on instead.';
  }
  openMenu();
});

$('btn-mouse').addEventListener('click', () => {
  audio.init();
  $('notice').textContent = 'Mouse / touch mode: click or tap the pads and keys.';
  openMenu();
});

// ---------- menu ----------
function openMenu() {
  show($('intro'), false);
  show($('results'), false);
  show($('pause'), false);
  show($('hud'), false);
  game.stop();
  game.setMode(null);
  renderSongs();
  show($('menu'));
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    mode = t.dataset.mode;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    renderSongs();
  })
);

function renderSongs() {
  $('mode-hint').textContent = HINTS[mode] + (handsOn ? '' : ' (Or just click / tap.)');
  const wrap = $('songs');
  wrap.innerHTML = '';
  for (const s of SONGS[mode]) {
    const best = store(`best:${mode}:${s.id}`);
    const b = document.createElement('button');
    b.className = 'song';
    b.innerHTML = `<b></b><small></small><div class="meta"><span class="lvl"></span><span></span></div>`;
    b.querySelector('b').textContent = s.title;
    b.querySelector('small').textContent = s.subtitle;
    b.querySelector('.lvl').textContent = '●'.repeat(s.level) + '○'.repeat(3 - s.level);
    b.querySelector('.meta span:last-child').textContent = best ? `Best ${best.score} ${'★'.repeat(best.stars)}` : `${s.bpm} BPM`;
    b.addEventListener('click', () => play(s));
    wrap.appendChild(b);
  }
  const f = document.createElement('button');
  f.className = 'song free';
  f.innerHTML = '<b>Free Play</b><small>No song, just jam</small><div class="meta"><span>∞</span><span></span></div>';
  f.addEventListener('click', () => play(null));
  wrap.appendChild(f);
}

$('set-sens').addEventListener('change', (e) => (game.settings.sensitivity = e.target.value));
$('set-lat').addEventListener('input', (e) => {
  game.settings.latency = Number(e.target.value) / 1000;
  $('lat-val').textContent = `${e.target.value} ms`;
});
$('set-skel').addEventListener('change', (e) => (game.settings.skeleton = e.target.checked));

// ---------- play ----------
function play(song) {
  current = song;
  show($('menu'), false);
  show($('results'), false);
  show($('pause'), false);
  show($('hud'));
  show($('hud-stats'), !!song);
  $('hud-song').textContent = song ? song.title : `Free Play · ${mode === 'drums' ? 'Drums' : 'Piano'}`;
  $('hud-combo').textContent = '';
  $('hud-progress').style.width = '0';
  game.setMode(mode);
  game.start(song);
}

function onStats({ score, combo, accuracy, progress, band }) {
  $('hud-score').textContent = score;
  $('hud-acc').textContent = `${Math.round(accuracy * 100)}%`;
  $('hud-progress').style.width = `${progress * 100}%`;
  $('hud-band').style.width = `${band * 100}%`;
  $('hud-combo').textContent = combo >= 5 ? `${combo} combo` : '';
}

function onEnd(r) {
  show($('hud'), false);
  const key = `best:${r.mode}:${r.song.id}`;
  const prev = store(key);
  const isBest = !prev || r.score > prev.score;
  if (isBest) store(key, { score: r.score, stars: r.stars });
  $('res-song').textContent = r.song.title;
  $('res-stars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < r.stars ? '' : 'off'}">★</span>`).join('');
  $('res-title').textContent =
    r.stars === 3 ? 'You nailed the song!' : r.stars === 2 ? 'Sounding great!' : r.stars === 1 ? 'Getting there!' : 'Keep practicing!';
  $('res-score').textContent = r.score + (isBest && r.score > 0 ? ' 🏆' : '');
  $('res-perfect').textContent = r.perfect;
  $('res-good').textContent = r.good;
  $('res-miss').textContent = r.miss;
  $('res-wrong').textContent = r.wrong;
  $('res-combo').textContent = r.maxCombo;
  $('res-acc').textContent = `${Math.round(r.accuracy * 100)}%`;
  show($('results'));
}

$('btn-pause').addEventListener('click', () => {
  if (!current) return openMenu();
  game.pause(true);
  show($('pause'));
});
$('btn-resume').addEventListener('click', () => {
  show($('pause'), false);
  game.pause(false);
});
$('btn-restart').addEventListener('click', () => {
  game.pause(false);
  play(current);
});
$('btn-quit').addEventListener('click', () => {
  game.pause(false);
  openMenu();
});
$('btn-again').addEventListener('click', () => play(current));
$('btn-menu').addEventListener('click', openMenu);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && current && game.playing && !game.paused) {
    game.pause(true);
    show($('pause'));
  }
});
