import { AudioEngine } from './audio.js';
import { startCamera, createHandTracker, createWorkerTracker } from './hands.js';
import { Game, PINCH_PRESETS } from './game.js';
import { SONGS } from './songs.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const audio = new AudioEngine();
const game = new Game($('stage'), audio, { onStats, onEnd, onTrack });
window.__airbeats = { game, audio }; // handy for debugging in devtools
let mode = 'synth';
let current = null; // current song (null = free play)
let handsOn = false;

// Melody modes share the same in-key songs.
const SONG_SET = { synth: SONGS.piano, piano: SONGS.piano, drums: SONGS.drums };
const HINTS = {
  hands: {
    synth: 'Your hand height is the pitch. Pinch thumb and index finger to play and hold to sustain. Move up or down while pinched to glide through the notes. Move right for a brighter sound, tilt your hand for vibrato.',
    piano: 'Your hand height picks the note. Pinch to strike it. Keep pinching and move up or down to run through the notes.',
    drums: 'Move your hand over a pad, then pinch thumb and index finger to hit it. Use both hands.',
  },
  touch: {
    synth: 'Touch a row to play, hold to sustain, slide up or down to glide. Tilt the phone toward you for a brighter sound, roll it for vibrato.',
    piano: 'Tap a row to play its note. Use several fingers for chords.',
    drums: 'Tap the pads. Use both thumbs.',
  },
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
  video.classList.add('live');
  $('status').textContent = 'Loading hand tracking (first time takes a few seconds)…';
  try {
    // Preferred: tracking in a background worker, so drawing and sound never wait for it.
    await createWorkerTracker(video, (hands, info) => game.onHands(hands, info));
    handsOn = true;
  } catch (e) {
    console.warn('Worker tracking unavailable, using main thread', e);
    try {
      game.setSource(video, await createHandTracker());
      handsOn = true;
    } catch (e2) {
      console.warn(e2);
      $('notice').textContent = 'Hand tracking could not load, so mouse / touch is on instead.';
    }
  }
  if (handsOn) {
    $('notice').textContent = '';
    show($('btn-calibrate'));
  }
  openMenu();
});

$('btn-mouse').addEventListener('click', async () => {
  audio.init();
  // Phone tilt shapes the sound. iOS asks for permission, and it must be asked from this tap.
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') await DOE.requestPermission();
    window.addEventListener('deviceorientation', (e) => game.setTilt(e.beta, e.gamma));
  } catch (e) {
    console.warn(e);
  }
  $('notice').textContent = '';
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
  $('mode-hint').textContent = HINTS[handsOn ? 'hands' : 'touch'][mode];
  const wrap = $('songs');
  wrap.innerHTML = '';
  for (const s of SONG_SET[mode]) {
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

$('set-pinch').addEventListener('change', (e) => {
  game.settings.pinch = e.target.value;
  store('pinch', e.target.value);
});
$('set-snap').addEventListener('change', (e) => {
  game.settings.snap = e.target.value;
  store('snap', e.target.value);
});

// Restore saved settings and a saved hand calibration
{
  const cal = store('calibration');
  if (cal && Array.isArray(cal)) {
    game.settings.calibrated = cal;
    $('opt-mine').disabled = false;
  }
  const pinch = store('pinch');
  if (pinch && (pinch !== 'mine' || cal)) game.settings.pinch = pinch;
  $('set-pinch').value = game.settings.pinch;
  const snap = store('snap');
  if (snap) game.settings.snap = snap;
  $('set-snap').value = game.settings.snap;
}

function onTrack({ hands, ms, delegate }) {
  const chip = $('track-chip');
  if (!chip) return;
  chip.textContent = hands ? `${hands} hand${hands > 1 ? 's' : ''} · ${Math.round(ms || 0)} ms${delegate ? ' · ' + delegate : ''}` : 'Show your hand';
  chip.classList.toggle('lost', !hands);
}

// ---------- hand calibration: learn this person's open and pinched hand from several angles ----------
const CAL_STEPS = [
  { kind: 'open', text: 'Hold one hand up, open, palm facing the camera.' },
  { kind: 'pinch', text: 'Pinch thumb and index finger together and hold.' },
  { kind: 'open', text: 'Turn your hand sideways and open it.' },
  { kind: 'pinch', text: 'Still sideways: pinch and hold.' },
  { kind: 'open', text: 'Tip your fingers toward the camera and open.' },
  { kind: 'pinch', text: 'Still tipped: pinch and hold.' },
];
let calTimer = null;

$('btn-calibrate').addEventListener('click', () => {
  show($('menu'), false);
  show($('calibrate'));
  const samples = { open: [], pinch: [] };
  let step = 0;
  let stepStart = performance.now();
  const STEP_MS = 2200;
  clearInterval(calTimer);
  calTimer = setInterval(() => {
    const s = CAL_STEPS[step];
    const r = game.probe.ratio;
    const elapsed = performance.now() - stepStart;
    $('cal-step').textContent = `Step ${step + 1} of ${CAL_STEPS.length}`;
    $('cal-text').textContent = s.text;
    $('cal-meter').style.width = `${Math.round(Math.min(1, elapsed / STEP_MS) * 100)}%`;
    $('cal-live').textContent = r == null ? 'No hand seen yet' : `Finger gap: ${r.toFixed(2)}`;
    // Ignore the first moment of each step while the hand changes pose.
    if (r != null && elapsed > 700) samples[s.kind].push(r);
    if (r == null) stepStart = performance.now() - Math.min(elapsed, 700);
    if (elapsed >= STEP_MS) {
      step++;
      stepStart = performance.now();
      if (step >= CAL_STEPS.length) finishCalibration(samples);
    }
  }, 50);
});

function percentile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function finishCalibration(samples) {
  clearInterval(calTimer);
  const ok = samples.open.length > 10 && samples.pinch.length > 10;
  const closed = ok ? percentile(samples.pinch, 0.9) : 0;
  const open = ok ? percentile(samples.open, 0.1) : 0;
  if (!ok || open - closed < 0.15) {
    $('cal-text').textContent = 'That did not work: I could not tell your open and pinched hand apart. Try again with your hand clearly in view and good light.';
    $('cal-live').textContent = '';
    return;
  }
  const on = Math.max(0.12, closed + (open - closed) * 0.3);
  const off = Math.max(on + 0.08, closed + (open - closed) * 0.5);
  game.settings.calibrated = [on, off];
  game.settings.pinch = 'mine';
  store('calibration', [on, off]);
  store('pinch', 'mine');
  $('opt-mine').disabled = false;
  $('set-pinch').value = 'mine';
  $('cal-step').textContent = 'Done';
  $('cal-text').textContent = `Learned your hand. Pinch now triggers at ${on.toFixed(2)} and releases at ${off.toFixed(2)} (standard is ${PINCH_PRESETS.normal[0]} / ${PINCH_PRESETS.normal[1]}).`;
  $('cal-live').textContent = '';
}

$('btn-cal-done').addEventListener('click', () => {
  clearInterval(calTimer);
  show($('calibrate'), false);
  show($('menu'));
});
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
  show($('track-chip'), handsOn);
  const names = { synth: 'Synth', piano: 'Piano', drums: 'Drums' };
  $('hud-song').textContent = song ? `${song.title} · ${names[mode]}` : `Free Play · ${names[mode]}`;
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
