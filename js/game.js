import { PIANO_LANES, DRUM_LANES, CHORDS } from './songs.js';
import { HAND_CONNECTIONS } from './hands.js';
import { handFeatures, ruleGap, PinchModel } from './pinch.js';

// Gesture model (see README for the research behind it):
//   * TRIGGER: a pinch (thumb + index), measured in real 3D distance so it works at any hand
//     angle, with separate on/off points and a short debounce. Or a finger touch on screen.
//   * PITCH: hand height, continuously, snapped toward the scale (adjustable, like a
//     pitch-corrected theremin). Sliding while pinched glides between notes.
//   * EXPRESSION: hand left/right = brightness, hand roll = vibrato.
//   * SMOOTHING: One Euro filter on the tracked point, then frame-rate interpolation with a
//     little prediction, so movement is drawn and heard at screen refresh rate, not camera rate.

const TAU = Math.PI * 2;
// Timing windows (seconds) for Timed play. Relaxed play waits for you instead.
const PERFECT = 0.12;
const GOOD = 0.26;
const EARLY_OK = 0.6; // Relaxed: how early a pinch still counts for the next note
const LEAD_BEATS = 4;
const HUD_H = 96;
// Pinch thresholds as thumb-index gap / palm length (wrist to middle knuckle), in 3D.
// About 0.30 is roughly 2.5-3 cm on an adult hand.
// Starting points; each hand's thresholds then adapt to its own open size.
export const PINCH_PRESETS = { easy: [0.5, 0.66], normal: [0.42, 0.58], firm: [0.32, 0.48] };
const SNAP = { snap: 1, soft: 0.75, free: 0 };

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// One Euro filter (Casiez et al.): heavy smoothing when still, little lag when moving fast.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.012, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null });
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (TAU * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x == null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawDx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

export class Game {
  constructor(canvas, audio, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = audio;
    this.hooks = hooks; // { onStats, onEnd, onTrack }
    this.settings = { pinch: 'normal', snap: 'snap', style: 'relaxed', speed: 0.8, latency: 0.05, skeleton: true, numbers: false };
    this.mode = null; // 'synth' | 'piano' | 'drums'
    this.lanes = [];
    this.flash = [];
    this.hover = new Set();
    this.cursors = [];
    this.touches = new Map();
    this.hands = [];
    this.tilt = null;
    this.popups = [];
    this.sparks = [];
    this.playing = false;
    this.song = null;
    this.notes = [];
    this.lastHud = 0;
    this.probe = { hands: 0, feats: [] };
    this.model = null; // personal pinch classifier, from calibration
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bindPointer();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.md = Math.min(this.w, this.h);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.layout();
  }

  // video: the <video> element (shown directly by the browser, behind the canvas).
  // tracker: optional main-thread tracker (fallback when the worker cannot run).
  setSource(video, tracker) {
    this.video = video;
    if (!tracker) return;
    const loop = () => {
      try {
        const raw = tracker.detect(video);
        if (raw) this.onHands(raw, { ms: 0 });
      } catch (e) {
        console.warn(e);
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    loop();
  }

  setModel(data) {
    this.model = data ? new PinchModel(data) : null;
  }

  setTilt(beta, gamma) {
    if (beta == null || gamma == null) return;
    if (!this.tiltBase) this.tiltBase = { beta, gamma };
    this.tilt = { beta: beta - this.tiltBase.beta, gamma: gamma - this.tiltBase.gamma };
  }

  setMode(mode) {
    this.releaseAll();
    this.mode = mode;
    this.layout();
  }

  get rows() {
    return this.mode === 'synth' || this.mode === 'piano';
  }

  layout() {
    const { w, h } = this;
    const top = HUD_H + 12;
    const bottom = h - 16;
    if (this.mode === 'drums') {
      const left = w * 0.04;
      const width = w * 0.92;
      const cols = w < h ? 3 : 4;
      const rows = Math.ceil(DRUM_LANES.length / cols);
      const gap = 14;
      const cw = (width - gap * (cols - 1)) / cols;
      const rh = (bottom - top - gap * (rows - 1)) / rows;
      const order = ['crash', 'hihat', 'tom1', 'tom2', 'snare', 'kick', 'floor'];
      this.lanes = DRUM_LANES.map((l) => {
        const i = order.indexOf(l.id);
        const r = Math.floor(i / cols);
        const inRow = r === rows - 1 ? DRUM_LANES.length - r * cols : cols;
        const offset = ((cols - inRow) * (cw + gap)) / 2;
        const x0 = left + offset + (i % cols) * (cw + gap);
        const y0 = top + r * (rh + gap);
        return { ...l, x0, y0, x1: x0 + cw, y1: y0 + rh, cx: x0 + cw / 2, cy: y0 + rh / 2 };
      });
    } else if (this.rows) {
      // One horizontal band per scale note, low notes at the bottom.
      const n = PIANO_LANES.length;
      this.rowTop = top;
      this.rowBottom = bottom;
      this.rowH = (bottom - top) / n;
      this.nowX = w * 0.2;
      this.lanes = PIANO_LANES.map((l, i) => {
        const y1 = bottom - i * this.rowH;
        const y0 = y1 - this.rowH;
        return { ...l, x0: w * 0.03, x1: w * 0.97, y0, y1, cx: this.nowX, cy: (y0 + y1) / 2 };
      });
    } else {
      this.lanes = [];
    }
    this.flash = this.lanes.map(() => 0);
  }

  // Continuous row position: 0 = centre of the lowest note, n-1 = centre of the highest.
  rowPos(y) {
    return (this.rowBottom - y) / this.rowH - 0.5;
  }

  laneAt(x, y, prev = -1) {
    if (!this.mode || y < HUD_H) return -1;
    if (this.mode === 'drums') {
      return this.lanes.findIndex((l) => x >= l.x0 - 7 && x <= l.x1 + 7 && y >= l.y0 - 7 && y <= l.y1 + 7);
    }
    const s = clamp(this.rowPos(y), 0, this.lanes.length - 1);
    let lane = Math.round(s);
    // Hysteresis: stay on the current note until you are clearly into the next one.
    if (prev >= 0 && Math.abs(s - prev) < 0.62) lane = prev;
    return lane;
  }

  // Fractional MIDI pitch for a height, pulled toward the nearest scale note by the snap setting.
  pitchAt(y, lane) {
    const s = clamp(this.rowPos(y), 0, this.lanes.length - 1);
    const i = Math.min(this.lanes.length - 2, Math.floor(s));
    const free = lerp(this.lanes[i].midi, this.lanes[i + 1].midi, s - i);
    return lerp(free, this.lanes[lane].midi, SNAP[this.settings.snap] ?? 1);
  }

  // ---------- playing notes (pinch and touch share this) ----------
  press(handle, lane, expr, source, x, y) {
    handle.lane = lane;
    if (lane < 0 || !this.mode || this.paused) return;
    this.audio.init();
    const l = this.lanes[lane];
    if (this.mode === 'drums') this.audio.drum(l.id, 0.95);
    else if (this.mode === 'piano') this.audio.piano(l.midi, 0.85);
    else {
      handle.voice = handle.voice || this.audio.voice();
      handle.voice.expr(expr.bright, expr.vib);
      handle.voice.on(this.pitchAt(y, lane));
    }
    this.flash[lane] = 1;
    this.sparkle(x, y, l.color, 16);
    this.judge(lane, source);
  }

  // Called every screen frame while a note is held.
  hold(handle, x, y, expr, source) {
    if (this.mode === 'drums') return;
    const lane = this.laneAt(x, y, handle.lane);
    if (handle.voice) {
      handle.voice.expr(expr.bright, expr.vib);
      handle.voice.bend(this.pitchAt(y, lane));
    }
    if (lane !== handle.lane && lane !== -1) {
      handle.lane = lane;
      if (this.mode === 'piano') this.audio.piano(this.lanes[lane].midi, 0.8);
      this.flash[lane] = 1;
      this.judge(lane, source);
    }
    // A faint trail of glints while a synth note sings
    if (this.mode === 'synth' && Math.random() < 0.5) this.sparkle(x, y, this.lanes[handle.lane]?.color || '#ffffff', 1, 0.5);
  }

  release(handle) {
    if (handle.voice) {
      this.audio.freeVoice(handle.voice);
      handle.voice = null;
    }
    handle.lane = -1;
  }

  releaseAll() {
    for (const c of this.cursors) if (c.pinched) this.release(c);
    for (const t of this.touches.values()) this.release(t);
    this.touches.clear();
    this.cursors.forEach((c) => (c.pinched = false));
  }

  // ---------- touch / mouse ----------
  pointerExpr(x) {
    let bright = clamp(0.15 + (x / this.w) * 0.85);
    let vib = 0;
    if (this.tilt) {
      bright = clamp(0.55 - this.tilt.beta / 50);
      vib = clamp((Math.abs(this.tilt.gamma) - 6) / 30);
    }
    return { bright, vib };
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.mode) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      const handle = { lane: -1, voice: null, x: e.clientX, y: e.clientY };
      this.touches.set(e.pointerId, handle);
      this.press(handle, this.laneAt(e.clientX, e.clientY), this.pointerExpr(e.clientX), 'touch', e.clientX, e.clientY);
    });
    c.addEventListener('pointermove', (e) => {
      const handle = this.touches.get(e.pointerId);
      if (!handle) return;
      handle.x = e.clientX;
      handle.y = e.clientY;
    });
    const end = (e) => {
      const handle = this.touches.get(e.pointerId);
      if (!handle) return;
      this.release(handle);
      this.touches.delete(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  // ---------- hands ----------
  videoMap() {
    const v = this.video;
    const vw = v?.videoWidth || 640;
    const vh = v?.videoHeight || 480;
    const s = Math.max(this.w / vw, this.h / vh);
    const dw = vw * s;
    const dh = vh * s;
    return { vw, vh, dw, dh, ox: (this.w - dw) / 2, oy: (this.h - dh) / 2 };
  }

  // Raw tracker output arrives here (from the worker or the fallback), once per camera frame.
  onHands(raw, info = {}) {
    const now = performance.now() / 1000;
    const { vw, vh, dw, dh, ox, oy } = this.videoMap();
    const toScreen = (p) => ({ x: this.w - (ox + p.x * dw), y: oy + p.y * dh });

    this.hands = raw.map((hand) => {
      const lm = hand.landmarks;
      const pts = lm.map(toScreen);
      const f = handFeatures(lm, hand.world, vw, vh);
      const cur = { x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
      const roll = Math.atan2(pts[9].x - pts[0].x, pts[0].y - pts[9].y);
      return { pts, f, gap: ruleGap(f), cur, roll, side: hand.side };
    });

    const model = this.settings.pinch === 'mine' ? this.model : null;
    const [presetOn] = PINCH_PRESETS[this.settings.pinch] || PINCH_PRESETS.normal;
    const free = new Set(this.cursors);
    // Match each hand to last frame's cursor: nearest, preferring the same left/right label,
    // so two hands close together do not swap.
    for (const hd of this.hands) {
      let c = null;
      let bd = this.md * 0.35;
      for (const k of free) {
        const dd = Math.hypot(k.tx - hd.cur.x, k.ty - hd.cur.y) + (k.side === hd.side ? 0 : this.md * 0.12);
        if (dd < bd) {
          bd = dd;
          c = k;
        }
      }
      if (!c) {
        c = {
          fx: new OneEuro(),
          fy: new OneEuro(),
          tx: hd.cur.x, ty: hd.cur.y, x: hd.cur.x, y: hd.cur.y, vx: 0, vy: 0,
          pinched: false, onCount: 0, offCount: 0, lane: -1, voice: null, seenAt: now,
          openRef: 0.9, prevGap: hd.gap,
        };
        this.cursors.push(c);
      }
      free.delete(c);
      c.side = hd.side;
      const dt = Math.max(1 / 120, now - c.seenAt);
      const fx = c.fx.filter(hd.cur.x, now);
      const fy = c.fy.filter(hd.cur.y, now);
      if (dt < 0.2) {
        c.vx = lerp(c.vx, (fx - c.tx) / dt, 0.5);
        c.vy = lerp(c.vy, (fy - c.ty) / dt, 0.5);
      } else {
        c.vx = c.vy = 0;
      }
      c.tx = fx;
      c.ty = fy;
      c.seenAt = now;
      c.roll = lerp(c.roll ?? hd.roll, hd.roll, 0.4);

      // How pinched is this hand? 0 = wide open, 1 = clearly pinched.
      let on, off, closing;
      if (model) {
        const p = model.prob(hd.f);
        c.gap = 1 - p;
        on = 0.4; // p > 0.6
        off = 0.65; // p < 0.35
        closing = false;
      } else {
        const g = hd.gap;
        // Learn this hand's open size (rises fast, decays slowly), and scale the thresholds to it.
        c.openRef = g > c.openRef ? lerp(c.openRef, g, 0.3) : lerp(c.openRef, g, 0.003);
        on = clamp(Math.max(presetOn, c.openRef * 0.45), presetOn, presetOn + 0.15);
        off = on + 0.16;
        // A fast closing movement counts as a pinch a frame early.
        closing = g < off && c.prevGap - g > 0.22 * c.openRef;
        c.prevGap = g;
        c.gap = g;
      }
      c.on = on;
      c.off = off;

      if (!c.pinched) {
        c.onCount = c.gap < on || closing ? c.onCount + 1 : 0;
        if (c.onCount >= 1) {
          c.pinched = true;
          c.offCount = 0;
          c.x = fx;
          c.y = fy;
          c.lane = -1;
          this.press(c, this.laneAt(fx, fy), this.handExpr(c), 'hand', fx, fy);
          c.pop = 1;
        }
      } else {
        // Release needs three frames in a row: brief tracking wobble never chops a note.
        c.offCount = c.gap > off ? c.offCount + 1 : 0;
        if (c.offCount >= 3) {
          c.pinched = false;
          c.onCount = 0;
          this.release(c);
        }
      }
    }
    // Briefly-lost hands keep their note (edge-on hands and motion blur drop frames).
    this.cursors = this.cursors.filter((c) => {
      if (!free.has(c) || now - c.seenAt < 0.35) return true;
      if (c.pinched) this.release(c);
      return false;
    });
    this.probe = { hands: this.hands.length, feats: this.hands.map((h) => h.f) };
    this.hooks.onTrack?.({ hands: this.hands.length, ms: info.ms, delegate: info.delegate });
  }

  handExpr(c) {
    return {
      bright: clamp(0.15 + (c.x / this.w) * 0.85),
      vib: clamp((Math.abs(c.roll || 0) - 0.3) / 0.5),
    };
  }

  // Every screen frame: glide drawn cursors toward the filtered position (with a touch of
  // prediction to hide camera delay) and update held notes from them.
  updateCursors(dt) {
    const now = performance.now() / 1000;
    const k = 1 - Math.exp(-dt * 28);
    this.hover = new Set();
    for (const c of this.cursors) {
      const ahead = Math.min(0.04, now - c.seenAt);
      c.x += (c.tx + c.vx * ahead - c.x) * k;
      c.y += (c.ty + c.vy * ahead - c.y) * k;
      const lane = c.pinched ? c.lane : this.laneAt(c.x, c.y, c.hover ?? -1);
      c.hover = lane;
      if (lane !== -1) this.hover.add(lane);
      if (c.pinched) this.hold(c, c.x, c.y, this.handExpr(c), 'hand');
    }
    for (const t of this.touches.values()) {
      if (t.lane !== -1 || this.rows) this.hold(t, t.x, t.y, this.pointerExpr(t.x), 'touch');
    }
  }

  // ---------- songs ----------
  start(song) {
    this.audio.init();
    this.audio.warmUp();
    this.song = song;
    this.paused = false;
    this.relaxed = this.settings.style !== 'timed';
    // Relaxed plays a little slower by default; Timed uses the Speed setting.
    const tempo = this.relaxed ? Math.min(this.settings.speed, 0.85) : this.settings.speed;
    const spb = 60 / ((song?.bpm || 100) * tempo);
    this.spb = spb;
    this.approach = this.mode === 'drums' ? 2.0 : 3.0;
    this.clock = -0.5;
    this.waiting = false;
    this.lastChord = -1;
    this.stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, wrong: 0 };
    this.recent = [1, 0.5, 1, 0.5];
    this.popups = [];
    this.sparks = [];
    this.startTime = this.audio.now + 0.5;
    this.events = [];
    this.schedIdx = 0;
    if (song) {
      this.notes = song.notes
        .map((n) => ({ t: (n.beat + LEAD_BEATS) * spb, lane: n.lane, state: null }))
        .sort((a, b) => a.t - b.t);
      this.endTime = this.notes[this.notes.length - 1].t + 2;
      this.buildBacking(song);
      this.audio.setBackingLevel(this.relaxed ? 0.85 : 0.6);
    } else {
      this.notes = [];
      this.audio.setBackingLevel(0);
    }
    this.playing = true;
  }

  buildBacking(song) {
    const spb = this.spb;
    const ev = [];
    for (let b = 0; b < LEAD_BEATS; b++) ev.push({ t: b * spb, type: 'count', accent: b === 0 });
    if (this.relaxed) {
      this.events = ev;
      return;
    }
    let beat = LEAD_BEATS;
    for (const ch of song.chords) {
      const c = CHORDS[ch.name];
      ev.push({ t: beat * spb, type: 'pad', notes: c.notes, dur: ch.beats * spb });
      if (this.mode !== 'drums') {
        for (let b = 0; b < ch.beats; b += 2) {
          ev.push({ t: (beat + b) * spb, type: 'bass', midi: c.root, dur: Math.min(2, ch.beats - b) * spb * 0.9 });
        }
        for (let b = 0.5; b < ch.beats; b += 1) ev.push({ t: (beat + b) * spb, type: 'shaker' });
      } else {
        for (let b = 0; b < ch.beats; b += 0.5) {
          const oct = b % 2 === 1.5 ? 12 : 0;
          ev.push({ t: (beat + b) * spb, type: 'bass', midi: c.root + oct, dur: spb * 0.42 });
        }
      }
      beat += ch.beats;
    }
    this.events = ev.sort((a, b) => a.t - b.t);
  }

  schedule() {
    const a = this.audio;
    while (this.schedIdx < this.events.length && this.startTime + this.events[this.schedIdx].t < a.now + 0.2) {
      const e = this.events[this.schedIdx++];
      const t = this.startTime + e.t;
      if (t < a.now - 0.05) continue;
      if (e.type === 'count') a.drum(e.accent ? 'tom1' : 'hihat', 0.8, t);
      else if (e.type === 'pad') a.pad(e.notes, t, e.dur);
      else if (e.type === 'bass') a.bass(e.midi, t, e.dur);
      else if (e.type === 'shaker') a.shaker(t);
    }
  }

  stop() {
    this.releaseAll();
    this.playing = false;
    this.song = null;
    this.notes = [];
    this.events = [];
    this.audio.setBackingLevel(0);
  }

  pause(on) {
    this.paused = on;
    if (on) this.releaseAll();
    if (!this.audio.ctx) return;
    if (on) this.audio.ctx.suspend();
    else this.audio.ctx.resume();
  }

  get songTime() {
    return this.clock;
  }

  // The song clock. Timed: follows the audio clock. Relaxed: also moves in real time, but
  // stops at the next note until you play it, so you are never rushed.
  tick(dt) {
    const audioT = this.audio.now - this.startTime;
    const lead = LEAD_BEATS * this.spb;
    if (!this.relaxed || audioT < lead) {
      this.clock = audioT;
      this.waiting = false;
      return;
    }
    this.clock += dt;
    const next = this.notes.find((n) => !n.state);
    this.waiting = !!next && this.clock >= next.t;
    if (this.waiting) this.clock = next.t;
  }

  // Relaxed accompaniment: chords and bass follow your playing instead of a fixed clock.
  accompany(note) {
    if (!this.song) return;
    const beat = note.t / this.spb - LEAD_BEATS;
    let acc = 0;
    let idx = -1;
    for (let i = 0; i < this.song.chords.length; i++) {
      if (beat < acc + this.song.chords[i].beats) {
        idx = i;
        break;
      }
      acc += this.song.chords[i].beats;
    }
    if (idx < 0 || idx === this.lastChord) return;
    this.lastChord = idx;
    const c = CHORDS[this.song.chords[idx].name];
    const t = this.audio.now;
    const dur = Math.max(1.2, this.song.chords[idx].beats * this.spb);
    this.audio.pad(c.notes, t, dur);
    this.audio.bass(c.root, t, Math.min(dur, 1.6));
  }

  judgeSpot(l) {
    return this.mode === 'drums' ? { x: l.cx, y: l.y0 + 26 } : { x: this.nowX + 70, y: l.cy };
  }

  judge(lane, source) {
    if (!this.song || !this.playing) return;
    const l = this.lanes[lane];
    const t = this.songTime - (source === 'hand' && !this.relaxed ? this.settings.latency : 0);
    const early = this.relaxed ? EARLY_OK : GOOD;
    let best = null;
    let bd = Infinity;
    for (const n of this.notes) {
      if (n.t - t > early) break;
      if (n.state || n.lane !== lane) continue;
      const d = Math.abs(n.t - t);
      if ((d <= GOOD || (this.relaxed && n.t - t <= EARLY_OK)) && d < bd) {
        bd = d;
        best = n;
      }
    }
    const s = this.stats;
    const spot = this.judgeSpot(l);
    if (best) {
      const perfect = bd <= (this.relaxed ? 0.3 : PERFECT);
      best.state = perfect ? 'perfect' : 'good';
      if (this.relaxed) this.accompany(best);
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s[best.state]++;
      const mult = Math.min(4, 1 + Math.floor(s.combo / 10) * 0.5);
      s.score += Math.round((perfect ? 100 : 50) * mult);
      this.recent.push(perfect ? 1 : 0.8);
      this.popup(spot.x, spot.y, perfect ? 'PERFECT' : 'GOOD', perfect ? '#7dffcf' : '#9ad7ff');
    } else {
      // Relaxed: a pinch with no note coming up is just you playing; no penalty.
      if (this.relaxed && !this.notes.some((n) => !n.state && Math.abs(n.t - t) <= EARLY_OK)) return;
      s.wrong++;
      s.combo = 0;
      this.recent.push(0);
      this.popup(spot.x, spot.y, '✕', '#ff7a8a');
    }
  }

  checkMisses() {
    const t = this.songTime - this.settings.latency;
    for (const n of this.notes) {
      if (n.t > t) break;
      if (!n.state && t - n.t > GOOD) {
        n.state = 'miss';
        this.stats.miss++;
        this.stats.combo = 0;
        this.recent.push(0);
        const spot = this.judgeSpot(this.lanes[n.lane]);
        this.popup(spot.x, spot.y, 'MISS', '#ffb3c0');
      }
    }
  }

  popup(x, y, text, color) {
    this.popups.push({ x, y, text, color, born: performance.now() });
  }

  // Subtle glints: tiny, soft, mostly warm white, drifting up and twinkling as they fade.
  sparkle(x, y, color, n, strength = 1) {
    if (x == null) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (20 + Math.random() * 70) * strength;
      const pick = Math.random();
      this.sparks.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 25,
        life: 1,
        decay: 0.9 + Math.random() * 0.8,
        size: (0.8 + Math.random() * 1.8) * (strength < 1 ? 0.8 : 1),
        phase: Math.random() * TAU,
        color: pick < 0.45 ? '#fff4d6' : pick < 0.75 ? '#ffffff' : color,
        star: Math.random() < 0.3,
      });
    }
    if (n > 4) this.sparks.push({ ring: true, x, y, life: 1, decay: 2.2, color });
  }

  results() {
    const s = this.stats;
    const total = this.notes.length;
    const accuracy = total ? (s.perfect + s.good * 0.7) / total : 0;
    const stars = accuracy >= 0.95 ? 3 : accuracy >= 0.8 ? 2 : accuracy >= 0.6 ? 1 : 0;
    return { ...s, total, accuracy, stars, song: this.song, mode: this.mode };
  }

  // ---------- main loop ----------
  frame(ts) {
    requestAnimationFrame((t) => this.frame(t));
    const now = ts / 1000;
    const dt = Math.min(0.05, now - (this.lastFrame || now));
    this.lastFrame = now;

    this.updateCursors(dt);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(now);

    let songT = 0;
    if (this.playing && this.song && !this.paused) {
      this.tick(dt);
      this.schedule();
      if (!this.relaxed) this.checkMisses();
      const acc = this.recent.slice(-8);
      const level = this.relaxed ? 0.85 : 0.1 + 0.9 * (acc.reduce((a, b) => a + b, 0) / acc.length);
      this.audio.setBackingLevel(level);
      this.bandLevel = level;
      songT = this.songTime;
      if (songT > this.endTime && this.notes.every((n) => n.state)) {
        this.playing = false;
        this.releaseAll();
        this.audio.setBackingLevel(0);
        this.hooks.onEnd?.(this.results());
      }
    } else if (this.song) {
      songT = this.songTime;
    }

    if (this.mode === 'drums') this.drawPads(songT);
    else if (this.rows) this.drawRows(songT);
    this.drawHands(dt);
    this.drawSparks(dt);
    this.drawPopups();
    if (this.song && this.playing) this.drawCountdown(songT);

    for (let i = 0; i < this.flash.length; i++) this.flash[i] = Math.max(0, this.flash[i] - dt * 4);

    if (this.song && now - this.lastHud > 0.08) {
      this.lastHud = now;
      const judged = this.notes.filter((n) => n.state).length;
      const s = this.stats;
      this.hooks.onStats?.({
        score: s.score,
        combo: s.combo,
        accuracy: judged ? (s.perfect + s.good * 0.7) / judged : 1,
        progress: clamp(songT / this.endTime),
        band: this.bandLevel || 0,
      });
    }
  }

  // The camera is shown by the browser as a <video> behind this canvas, so here we only
  // clear (keeping it fully visible) or paint a backdrop when there is no camera.
  drawBackground(now) {
    const { ctx, w, h, video } = this;
    ctx.clearRect(0, 0, w, h);
    if (video && video.readyState >= 2) {
      const g = ctx.createRadialGradient(w / 2, h / 2, this.md * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(6,4,20,0)');
      g.addColorStop(1, 'rgba(6,4,20,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#120b2e');
    g.addColorStop(1, '#05111f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    [['#7b6cff', 0.3, 0.3], ['#ff6bd6', 0.7, 0.6], ['#06d6a0', 0.5, 0.9]].forEach(([c, x, y], i) => {
      const bx = (x + Math.sin(now * 0.3 + i) * 0.08) * w;
      const by = (y + Math.cos(now * 0.25 + i * 2) * 0.08) * h;
      const rg = ctx.createRadialGradient(bx, by, 0, bx, by, this.md * 0.6);
      rg.addColorStop(0, rgba(c, 0.35));
      rg.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
    });
  }

  // Clear "mirror glass": almost no fill, a thin bright rim and a faint diagonal sheen.
  // Lights up in its colour when active. No blur or shadow passes (they are slow).
  glass(pathFn, box, color, glow, flash) {
    const ctx = this.ctx;
    const lit = Math.max(glow, flash);
    pathFn();
    ctx.fillStyle = rgba(color, 0.04 + glow * 0.16 + flash * 0.3);
    ctx.fill();
    ctx.save();
    pathFn();
    ctx.clip();
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w * 0.6, box.y + box.h);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.03)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.06)');
    ctx.fillStyle = g;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    pathFn();
    if (lit > 0.05) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = rgba(color, 0.25 * lit);
      ctx.stroke();
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = lit > 0.05 ? rgba(color, 0.5 + 0.5 * lit) : 'rgba(255,255,255,0.32)';
    ctx.stroke();
  }

  upcomingGlow(songT) {
    const glow = this.lanes.map((_, i) => (this.hover.has(i) ? 0.35 : 0));
    if (!this.song) return glow;
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      glow[n.lane] = Math.max(glow[n.lane], 1 - Math.max(0, d) / this.approach);
      // The note the song is waiting on breathes gently.
      if (this.waiting && d <= 0.001) glow[n.lane] = 0.75 + 0.25 * Math.sin(performance.now() / 160);
    }
    return glow;
  }

  text(t, x, y, size, alpha = 0.95, align = 'center', weight = 700) {
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.font = `${weight} ${size}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y);
  }

  drawRows(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    this.lanes.forEach((l, i) => {
      const box = { x: l.x0, y: l.y0 + 3, w: l.x1 - l.x0, h: l.y1 - l.y0 - 6 };
      this.glass(() => roundRectPath(ctx, box.x, box.y, box.w, box.h, 14), box, l.color, glow[i], this.flash[i]);
      const size = Math.max(14, Math.min(26, this.rowH * 0.36));
      this.text(l.name, l.x0 + 22, l.cy, size, 0.9);
      this.text(l.name, l.x1 - 22, l.cy, size, 0.5);
    });

    if (!this.song) return;
    // "Now" line, and notes flowing toward it along their row
    const top = this.rowTop;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(this.nowX - 1, top, 2, this.rowBottom - top);
    const pillW = Math.max(46, this.w * 0.05);
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      const l = this.lanes[n.lane];
      const x = this.nowX + (d / this.approach) * (l.x1 - 40 - this.nowX) - pillW / 2;
      const ph = (l.y1 - l.y0) * 0.56;
      const box = { x, y: l.cy - ph / 2, w: pillW, h: ph };
      this.glass(() => roundRectPath(ctx, box.x, box.y, box.w, box.h, ph / 2), box, l.color, 1, 0);
    }
  }

  drawPads(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    this.lanes.forEach((l, i) => {
      const box = { x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 };
      this.glass(() => roundRectPath(ctx, box.x, box.y, box.w, box.h, 22), box, l.color, glow[i], this.flash[i]);
      this.text(l.name, l.cx, l.cy, Math.max(15, Math.min(box.w, box.h) * 0.15), 0.9);
    });
    if (!this.song) return;
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      const l = this.lanes[n.lane];
      const s = Math.max(0, d / this.approach);
      const grow = 40 * s;
      roundRectPath(ctx, l.x0 - grow, l.y0 - grow, l.x1 - l.x0 + grow * 2, l.y1 - l.y0 + grow * 2, 22 + grow);
      ctx.lineWidth = 1.5 + 3 * (1 - s);
      ctx.strokeStyle = rgba(l.color, 0.25 + 0.75 * (1 - s));
      ctx.stroke();
    }
  }

  drawHands(dt) {
    const ctx = this.ctx;
    if (this.settings.skeleton && this.hands.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const hand of this.hands) {
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(hand.pts[a].x, hand.pts[a].y);
          ctx.lineTo(hand.pts[b].x, hand.pts[b].y);
        }
      }
      ctx.stroke();
    }
    for (const c of this.cursors) {
      const lane = this.lanes[c.pinched ? c.lane : c.hover];
      const color = lane ? lane.color : '#ffffff';
      const closeness = clamp((c.off - c.gap) / (c.off - c.on + 0.12));
      // outer ring
      ctx.beginPath();
      ctx.arc(c.x, c.y, 20, 0, TAU);
      ctx.lineWidth = c.pinched ? 2.5 : 1.5;
      ctx.strokeStyle = c.pinched ? color : 'rgba(255,255,255,0.8)';
      ctx.stroke();
      // closeness dot: grows as fingers close, solid when the note is on
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.pinched ? 9 : 2.5 + 6 * closeness, 0, TAU);
      ctx.fillStyle = c.pinched ? color : `rgba(255,255,255,${0.45 + 0.4 * closeness})`;
      ctx.fill();
      if (c.pinched) {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 46);
        g.addColorStop(0, rgba(color === '#ffffff' ? '#ffffff' : color, 0.35));
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 46, 0, TAU);
        ctx.fill();
      }
      if (this.settings.numbers) {
        this.text(`${c.side?.[0] || ''} ${c.gap.toFixed(2)} / on<${c.on.toFixed(2)}`, c.x, c.y + 36, 12, 0.9, 'center', 600);
      }
      if (c.pop > 0) c.pop = Math.max(0, c.pop - dt * 4);
    }
  }

  drawSparks(dt) {
    const ctx = this.ctx;
    if (!this.sparks.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const t = performance.now() / 1000;
    this.sparks = this.sparks.filter((p) => (p.life -= dt * p.decay) > 0);
    for (const p of this.sparks) {
      if (p.ring) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14 + (1 - p.life) * 34, 0, TAU);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(p.color, p.life * 0.6);
        ctx.stroke();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 2.2;
      p.vy = p.vy * (1 - dt * 2.2) - 10 * dt;
      const tw = 0.6 + 0.4 * Math.sin(t * 18 + p.phase);
      const a = p.life * tw;
      const r = p.size * (0.6 + 0.4 * p.life);
      ctx.fillStyle = rgba(p.color, a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      if (p.star) {
        ctx.strokeStyle = rgba(p.color, a * 0.7);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x - r * 3.5, p.y);
        ctx.lineTo(p.x + r * 3.5, p.y);
        ctx.moveTo(p.x, p.y - r * 3.5);
        ctx.lineTo(p.x, p.y + r * 3.5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawPopups() {
    const ctx = this.ctx;
    const now = performance.now();
    this.popups = this.popups.filter((p) => now - p.born < 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.popups) {
      const k = (now - p.born) / 700;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = p.color;
      ctx.font = `800 ${20 + 6 * (1 - k)}px Outfit, system-ui, sans-serif`;
      ctx.fillText(p.text, p.x, p.y - k * 26);
    }
    ctx.globalAlpha = 1;
  }

  drawCountdown(songT) {
    const lead = LEAD_BEATS * this.spb;
    if (songT > lead + this.spb * 0.6) return;
    const ctx = this.ctx;
    const left = lead - songT;
    const text = left > 0 ? String(Math.min(LEAD_BEATS, Math.ceil(left / this.spb))) : 'GO!';
    const frac = left > 0 ? (left / this.spb) % 1 : 1 - (songT - lead) / (this.spb * 0.6);
    ctx.save();
    ctx.globalAlpha = clamp(frac + 0.2) * 0.9;
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${this.md * 0.16}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.w / 2, this.h * 0.45);
    ctx.restore();
  }
}
