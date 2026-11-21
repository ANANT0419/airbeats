import { AudioEngine } from './audio.js';
import { startCamera, createHandTracker, createWorkerTracker } from './hands.js';
import { Game } from './game.js';
import { PinchModel } from './pinch.js';
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
  if (e.target.value === 'mine' && !game.model) return;
  game.settings.pinch = e.target.value;
  store('pinch', e.target.value);
});
$('set-snap').addEventListener('change', (e) => {
  game.settings.snap = e.target.value;
  store('snap', e.target.value);
});

// Restore saved settings and a saved personal pinch model
{
  const model = store('pinchModel');
  if (model && Array.isArray(model.w)) {
    game.setModel(model);
    $('opt-mine').disabled = false;
  }
  const pinch = store('pinch');
  if (pinch && (pinch !== 'mine' || model)) game.settings.pinch = pinch;
  $('set-pinch').value = game.settings.pinch;
  for (const [id, key] of [['set-snap', 'snap'], ['set-style', 'style'], ['set-speed', 'speed']]) {
    const v = store(key);
    if (v != null) game.settings[key] = v;
    $(id).value = game.settings[key];
  }
  $('speed-val').textContent = `${Math.round(game.settings.speed * 100)}%`;
}
$('set-style').addEventListener('change', (e) => {
  game.settings.style = e.target.value;
  store('style', e.target.value);
});
$('set-speed').addEventListener('input', (e) => {
  game.settings.speed = Number(e.target.value);
  $('speed-val').textContent = `${Math.round(game.settings.speed * 100)}%`;
  store('speed', game.settings.speed);
});
$('set-nums').addEventListener('change', (e) => (game.settings.numbers = e.target.checked));
// Diagnostics: copy the last few seconds of raw pinch readings to paste into a bug report.
$('btn-copylog').addEventListener('click', () => {
  const log = game.pinchLog || [];
  const text = JSON.stringify({
    pinch: game.settings.pinch, model: !!game.model, track: $('track-chip').textContent, entries: log.length,
    cols: 't side event gap world img on off held', rows: log.map((e) => [e.t, e.side, e.ev, e.gap, e.w, e.img, e.on, e.off, e.held].join(' ')),
  });
  const out = $('log-out');
  out.value = text;
  show(out);
  out.select();
  navigator.clipboard?.writeText(text).then(
    () => ($('btn-copylog').textContent = 'Copied. Paste it in the chat.'),
    () => ($('btn-copylog').textContent = 'Select the text below and copy it.')
  );
});

function onTrack({ hands, ms, delegate }) {
  const chip = $('track-chip');
  if (!chip) return;
  chip.textContent = hands ? `${hands} hand${hands > 1 ? 's' : ''} · ${Math.round(ms || 0)} ms${delegate ? ' · ' + delegate : ''}` : 'Show your hand';
  chip.classList.toggle('lost', !hands);
}

// ---------- hand calibration: record both hands open and pinched from several angles, then
// train a small pinch classifier for this person (runs in the browser, nothing is uploaded).
const CAL_STEPS = [
  { y: 0, text: 'Hold up both hands, open, palms facing the camera.' },
  { y: 1, text: 'Pinch thumb and index finger on both hands, and hold.' },
  { y: 0, text: 'Turn both hands sideways, open.' },
  { y: 1, text: 'Still sideways: pinch and hold.' },
  { y: 0, text: 'Tip your fingers toward the camera, open.' },
  { y: 1, text: 'Still tipped: pinch and hold.' },
  { y: 0, text: 'Relax your hands, fingers loosely curled but NOT touching.' },
  { y: 1, text: 'Pinch with your other fingers curled in, and hold.' },
];
let calTimer = null;

$('btn-calibrate').addEventListener('click', () => {
  show($('menu'), false);
  show($('calibrate'));
  const samples = [];
  let step = 0;
  let stepStart = performance.now();
  const STEP_MS = 2400;
  clearInterval(calTimer);
  calTimer = setInterval(() => {
    const s = CAL_STEPS[step];
    const { hands, feats } = game.probe;
    let elapsed = performance.now() - stepStart;
    if (!hands) {
      // Wait for hands before the step's time runs.
      stepStart = performance.now() - Math.min(elapsed, 700);
      elapsed = performance.now() - stepStart;
    }
    $('cal-step').textContent = `Step ${step + 1} of ${CAL_STEPS.length}`;
    $('cal-text').textContent = s.text;
    $('cal-meter').style.width = `${Math.round(Math.min(1, elapsed / STEP_MS) * 100)}%`;
    $('cal-live').textContent = hands ? `${hands} hand${hands > 1 ? 's' : ''} seen · ${samples.length} samples` : 'No hands seen yet';
    if (hands && elapsed > 800) for (const f of feats) samples.push({ f, y: s.y });
    if (elapsed >= STEP_MS) {
      step++;
      stepStart = performance.now();
      if (step >= CAL_STEPS.length) finishCalibration(samples);
    }
  }, 50);
});

function finishCalibration(samples) {
  clearInterval(calTimer);
  const pos = samples.filter((s) => s.y).length;
  if (pos < 20 || samples.length - pos < 20) {
    $('cal-step').textContent = 'Try again';
    $('cal-text').textContent = 'I did not see your hands clearly enough. Try again with both hands in view and good, even light.';
    $('cal-live').textContent = '';
    return;
  }
  const model = PinchModel.train(samples);
  if (model.acc < 0.8) {
    $('cal-step').textContent = 'Try again';
    $('cal-text').textContent = `I could only tell open from pinched ${Math.round(model.acc * 100)}% of the time. Try again and make the pinch clear: fingertips touching.`;
    $('cal-live').textContent = '';
    return;
  }
  game.setModel(model.toJSON());
  game.settings.pinch = 'mine';
  store('pinchModel', model.toJSON());
  store('pinch', 'mine');
  $('opt-mine').disabled = false;
  $('set-pinch').value = 'mine';
  $('cal-step').textContent = 'Done';
  $('cal-text').textContent = `Learned your hands from ${samples.length} samples. It tells open from pinched ${Math.round(model.acc * 100)}% of the time.`;
  $('cal-live').textContent = 'Pinch is now set to "My hands". You can switch back in Settings.';
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
