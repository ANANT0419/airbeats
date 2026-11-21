import { PIANO_LANES, DRUM_LANES, CHORDS } from './songs.js';
import { HAND_CONNECTIONS } from './hands.js';

// Gesture model (inspired by motion synths such as the AUUG Motion Synth):
//   * A note is TRIGGERED by something instant and unambiguous: a pinch (thumb + index) in
//     front of the camera, or a finger touch on screen.
//   * Where you are picks WHICH note (a column of an in-key scale, or a drum pad).
//   * Motion only SHAPES a note that is already sounding: hand height = brightness,
//     hand / phone tilt = vibrato. Shaping is continuous, so camera delay is not felt.

const TAU = Math.PI * 2;
const PERFECT = 0.08;
const GOOD = 0.17;
const LEAD_BEATS = 4;
const HUD_H = 96;
// Pinch thresholds: thumb-index gap divided by hand size (wrist to middle knuckle).
const PINCH = { easy: [0.36, 0.5], normal: [0.28, 0.42], firm: [0.2, 0.34] };

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

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

export class Game {
  constructor(canvas, audio, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = audio;
    this.hooks = hooks; // { onStats, onEnd }
    this.settings = { pinch: 'normal', latency: 0.05, skeleton: true };
    this.blur = document.createElement('canvas');
    this.blur.width = 160;
    this.blur.height = 90;
    this.bctx = this.blur.getContext('2d');
    this.mode = null; // 'synth' | 'piano' | 'drums'
    this.lanes = [];
    this.flash = [];
    this.hover = new Set();
    this.cursors = []; // tracked hands
    this.touches = new Map(); // pointerId -> handle
    this.hands = [];
    this.tilt = null;
    this.popups = [];
    this.particles = [];
    this.playing = false;
    this.song = null;
    this.notes = [];
    this.lastHud = 0;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bindPointer();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.md = Math.min(this.w, this.h);
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.layout();
  }

  // Run hand detection as soon as each camera frame arrives (not on the next screen refresh).
  setSource(video, tracker) {
    this.video = video;
    this.tracker = tracker;
    if (!tracker) return;
    const run = () => {
      try {
        const raw = tracker.detect(video);
        if (raw) this.processHands(raw, performance.now() / 1000);
      } catch (e) {
        console.warn(e);
      }
    };
    if (video.requestVideoFrameCallback) {
      const loop = () => {
        run();
        video.requestVideoFrameCallback(loop);
      };
      video.requestVideoFrameCallback(loop);
    } else {
      const loop = () => {
        run();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
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

  layout() {
    const { w, h } = this;
    const left = w * 0.04;
    const width = w * 0.92;
    const top = HUD_H + 8;
    const bottom = h - 20;
    if (this.mode === 'drums') {
      const cols = w < h ? 3 : 4;
      const rows = Math.ceil(DRUM_LANES.length / cols);
      const gap = 14;
      const cw = (width - gap * (cols - 1)) / cols;
      const rh = (bottom - top - gap * (rows - 1)) / rows;
      // Kit-like arrangement (cymbals and toms on top, snare / kick / floor below).
      // Lane indices stay as in songs.js; only the on-screen slot changes.
      const order = ['crash', 'hihat', 'tom1', 'tom2', 'snare', 'kick', 'floor'];
      this.lanes = DRUM_LANES.map((l) => {
        const i = order.indexOf(l.id);
        const r = Math.floor(i / cols);
        const inRow = r === rows - 1 ? DRUM_LANES.length - r * cols : cols;
        const offset = ((cols - inRow) * (cw + gap)) / 2; // centre a short last row
        const x0 = left + offset + (i % cols) * (cw + gap);
        const y0 = top + r * (rh + gap);
        return { ...l, x0, y0, x1: x0 + cw, y1: y0 + rh, cx: x0 + cw / 2, cy: y0 + rh / 2 };
      });
    } else if (this.mode) {
      const n = PIANO_LANES.length;
      const kw = width / n;
      this.hitY = top + (bottom - top) * 0.62;
      this.lanes = PIANO_LANES.map((l, i) => ({
        ...l,
        x0: left + i * kw + 4,
        x1: left + (i + 1) * kw - 4,
        y0: top,
        y1: bottom,
        cx: left + (i + 0.5) * kw,
        cy: this.hitY,
      }));
    } else {
      this.lanes = [];
    }
    this.flash = this.lanes.map(() => 0);
  }

  // Columns span the full height, so for melody only left/right matters.
  laneAt(x, y) {
    if (!this.mode || y < HUD_H) return -1;
    if (this.mode === 'drums') {
      return this.lanes.findIndex((l) => x >= l.x0 - 7 && x <= l.x1 + 7 && y >= l.y0 - 7 && y <= l.y1 + 7);
    }
    const first = this.lanes[0];
    const last = this.lanes[this.lanes.length - 1];
    if (x < first.x0 - 4 || x > last.x1 + 4) return -1;
    let best = 0;
    let bd = Infinity;
    this.lanes.forEach((l, i) => {
      const d = Math.abs(x - l.cx);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  // ---------- playing notes (shared by pinch and touch) ----------
  // A handle is one finger / one hand holding a note: { lane, voice }.
  press(handle, lane, expr, source) {
    handle.lane = lane;
    if (lane < 0 || !this.mode || this.paused) return;
    this.audio.init();
    const l = this.lanes[lane];
    if (this.mode === 'drums') this.audio.drum(l.id, 0.95);
    else if (this.mode === 'piano') this.audio.piano(l.midi, 0.85);
    else {
      handle.voice = handle.voice || this.audio.voice();
      handle.voice.expr(expr.bright, expr.vib);
      handle.voice.on(l.midi);
    }
    this.flash[lane] = 1;
    this.judge(lane, source);
  }

  move(handle, lane, expr, source) {
    if (handle.voice) handle.voice.expr(expr.bright, expr.vib);
    // In synth mode, sliding a held note into another column glides to that note.
    if (this.mode === 'synth' && handle.voice && lane !== -1 && lane !== handle.lane) {
      handle.lane = lane;
      handle.voice.glide(this.lanes[lane].midi);
      this.flash[lane] = 1;
      this.judge(lane, source);
    }
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

  // ---------- touch / mouse (phone mode) ----------
  pointerExpr(x, y) {
    let bright = clamp(1 - (y - HUD_H) / (this.h - HUD_H));
    let vib = 0;
    if (this.tilt) {
      // Tip the phone toward you for a brighter sound, roll it left/right for vibrato.
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
      this.press(handle, this.laneAt(e.clientX, e.clientY), this.pointerExpr(e.clientX, e.clientY), 'touch');
      if (handle.lane !== -1) this.burst(e.clientX, e.clientY, this.lanes[handle.lane].color, 8);
    });
    c.addEventListener('pointermove', (e) => {
      const handle = this.touches.get(e.pointerId);
      if (!handle) return;
      handle.x = e.clientX;
      handle.y = e.clientY;
      this.move(handle, this.laneAt(e.clientX, e.clientY), this.pointerExpr(e.clientX, e.clientY), 'touch');
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

  // ---------- hands (camera mode) ----------
  processHands(raw, now) {
    const v = this.video;
    const vw = v.videoWidth || 640;
    const vh = v.videoHeight || 480;
    const s = Math.max(this.w / vw, this.h / vh);
    const dw = vw * s;
    const dh = vh * s;
    const ox = (this.w - dw) / 2;
    const oy = (this.h - dh) / 2;
    const toScreen = (p) => ({ x: this.w - (ox + p.x * dw), y: oy + p.y * dh });
    const d3 = (a, b) => Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh, (a.z - b.z) * vw);

    this.hands = raw.map((hand) => {
      const lm = hand.landmarks;
      const pts = lm.map(toScreen);
      const size = d3(lm[0], lm[9]) || 1;
      const gap = d3(lm[4], lm[8]) / size;
      const cur = { x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
      // Hand roll: angle of wrist -> middle knuckle away from straight up.
      const roll = Math.atan2(pts[9].x - pts[0].x, pts[0].y - pts[9].y);
      return { pts, gap, cur, roll };
    });

    const [onT, offT] = PINCH[this.settings.pinch] || PINCH.normal;
    const free = new Set(this.cursors);
    for (const hd of this.hands) {
      let c = null;
      let bd = this.md * 0.3;
      for (const k of free) {
        const d = Math.hypot(k.rx - hd.cur.x, k.ry - hd.cur.y);
        if (d < bd) {
          bd = d;
          c = k;
        }
      }
      if (!c) {
        c = { x: hd.cur.x, y: hd.cur.y, rx: hd.cur.x, ry: hd.cur.y, pinched: false, lane: -1, voice: null, gap: hd.gap };
        this.cursors.push(c);
      }
      free.delete(c);
      // Light smoothing: steady when still, follows quickly when moving.
      const jump = Math.hypot(hd.cur.x - c.x, hd.cur.y - c.y);
      const a = Math.min(1, 0.45 + jump / (this.md * 0.04));
      c.x += (hd.cur.x - c.x) * a;
      c.y += (hd.cur.y - c.y) * a;
      c.rx = hd.cur.x;
      c.ry = hd.cur.y;
      c.gap = hd.gap;
      c.seen = now;
      c.on = onT;
      c.off = offT;
      c.hand = hd;
      const expr = {
        bright: clamp(1 - (c.y - HUD_H) / (this.h - HUD_H)),
        vib: clamp((Math.abs(hd.roll) - 0.3) / 0.5),
      };
      const lane = this.laneAt(c.x, c.y);
      c.hover = lane;
      if (!c.pinched && hd.gap < onT) {
        c.pinched = true;
        c.pop = 1;
        this.press(c, lane, expr, 'hand');
      } else if (c.pinched && hd.gap > offT) {
        c.pinched = false;
        this.release(c);
      } else if (c.pinched) {
        this.move(c, lane, expr, 'hand');
      }
    }
    // A hand that disappears for a moment keeps its note; gone for longer, the note stops.
    this.cursors = this.cursors.filter((c) => {
      if (!free.has(c) || now - c.seen < 0.25) return true;
      if (c.pinched) this.release(c);
      return false;
    });
    this.hover = new Set(this.cursors.map((c) => c.hover).filter((l) => l !== -1 && l != null));
  }

  // ---------- song lifecycle ----------
  start(song) {
    this.audio.init();
    this.audio.warmUp();
    this.song = song;
    this.paused = false;
    const spb = 60 / (song?.bpm || 100);
    this.spb = spb;
    this.approach = this.mode === 'drums' ? 1.6 : 2.2;
    this.stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0, wrong: 0 };
    this.recent = [1, 0.5, 1, 0.5];
    this.popups = [];
    this.particles = [];
    this.startTime = this.audio.now + 0.5;
    this.events = [];
    this.schedIdx = 0;
    if (song) {
      this.notes = song.notes
        .map((n) => ({ t: (n.beat + LEAD_BEATS) * spb, lane: n.lane, state: null }))
        .sort((a, b) => a.t - b.t);
      this.endTime = this.notes[this.notes.length - 1].t + 2;
      this.buildBacking(song);
      this.audio.setBackingLevel(0.6);
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
    return this.audio.now - this.startTime;
  }

  judge(lane, source) {
    const l = this.lanes[lane];
    if (!this.song || !this.playing) {
      this.burst(l.cx, l.cy, l.color, 6);
      return;
    }
    const t = this.songTime - (source === 'hand' ? this.settings.latency : 0);
    let best = null;
    let bd = Infinity;
    for (const n of this.notes) {
      if (n.t - t > GOOD) break;
      if (n.state || n.lane !== lane) continue;
      const d = Math.abs(n.t - t);
      if (d <= GOOD && d < bd) {
        bd = d;
        best = n;
      }
    }
    const s = this.stats;
    const py = this.mode === 'drums' ? l.y0 + 26 : this.hitY - 40;
    if (best) {
      const perfect = bd <= PERFECT;
      best.state = perfect ? 'perfect' : 'good';
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s[best.state]++;
      const mult = Math.min(4, 1 + Math.floor(s.combo / 10) * 0.5);
      s.score += Math.round((perfect ? 100 : 50) * mult);
      this.recent.push(perfect ? 1 : 0.8);
      this.popup(l.cx, py, perfect ? 'PERFECT' : 'GOOD', perfect ? '#7dffcf' : '#9ad7ff');
      this.burst(l.cx, this.mode === 'drums' ? l.cy : this.hitY, l.color, perfect ? 22 : 12);
    } else {
      s.wrong++;
      s.combo = 0;
      this.recent.push(0);
      this.popup(l.cx, py, '✕', '#ff7a8a');
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
        const l = this.lanes[n.lane];
        this.popup(l.cx, this.mode === 'drums' ? l.y0 + 26 : this.hitY - 40, 'MISS', '#ffb3c0');
      }
    }
  }

  popup(x, y, text, color) {
    this.popups.push({ x, y, text, color, born: performance.now() });
  }

  burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 120 + Math.random() * 280;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
    }
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

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(now);
    this.bctx.drawImage(this.canvas, 0, 0, this.blur.width, this.blur.height);

    let songT = 0;
    if (this.playing && this.song && !this.paused) {
      this.schedule();
      this.checkMisses();
      const acc = this.recent.slice(-8);
      const level = 0.1 + 0.9 * (acc.reduce((a, b) => a + b, 0) / acc.length);
      this.audio.setBackingLevel(level);
      this.bandLevel = level;
      songT = this.songTime;
      if (songT > this.endTime) {
        this.playing = false;
        this.releaseAll();
        this.audio.setBackingLevel(0);
        this.hooks.onEnd?.(this.results());
      }
    } else if (this.song) {
      songT = this.songTime;
    }

    if (this.mode === 'drums') this.drawPads(songT);
    else if (this.mode) this.drawColumns(songT);
    this.drawHands(dt);
    this.drawEffects(dt);
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

  drawBackground(now) {
    const { ctx, w, h, video } = this;
    if (video && video.readyState >= 2) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.max(w / vw, h / vh);
      const dw = vw * s;
      const dh = vh * s;
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
      ctx.restore();
      ctx.fillStyle = 'rgba(8,6,24,0.42)';
      ctx.fillRect(0, 0, w, h);
    } else {
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
  }

  // Shared "mirror glass" surface: frosted background + tint + sheen + rim
  glass(pathFn, box, color, glow, flash) {
    const ctx = this.ctx;
    ctx.save();
    pathFn();
    ctx.clip();
    ctx.drawImage(this.blur, 0, 0, this.w, this.h);
    ctx.fillStyle = `rgba(255,255,255,${0.05 + flash * 0.25})`;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = rgba(color, 0.08 + glow * 0.3 + flash * 0.45);
    ctx.fillRect(box.x, box.y, box.w, box.h);
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h * 0.6);
    g.addColorStop(0, 'rgba(255,255,255,0.4)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.08)');
    g.addColorStop(0.48, 'rgba(255,255,255,0)');
    g.addColorStop(0.52, 'rgba(255,255,255,0.1)');
    g.addColorStop(0.62, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.15)');
    ctx.fillStyle = g;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();

    ctx.save();
    const lit = Math.max(glow, flash);
    if (lit > 0.05) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 + 30 * lit;
    }
    pathFn();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.5 * lit})`;
    ctx.stroke();
    ctx.restore();
  }

  upcomingGlow(songT) {
    const glow = this.lanes.map((_, i) => (this.hover.has(i) ? 0.3 : 0));
    if (!this.song) return glow;
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      glow[n.lane] = Math.max(glow[n.lane], 1 - Math.max(0, d) / this.approach);
    }
    return glow;
  }

  label(text, x, y, size, alpha = 0.95) {
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.font = `700 ${size}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  drawColumns(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    this.lanes.forEach((l, i) => {
      const wd = l.x1 - l.x0;
      const ht = l.y1 - l.y0;
      this.glass(() => roundRectPath(ctx, l.x0, l.y0, wd, ht, 18), { x: l.x0, y: l.y0, w: wd, h: ht }, l.color, glow[i], this.flash[i]);
      this.label(l.name, l.cx, l.y1 - 34, Math.max(16, wd * 0.24));
    });
    // "Play now" line
    const a = this.lanes[0];
    const b = this.lanes[this.lanes.length - 1];
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(a.x0, this.hitY - 1, b.x1 - a.x0, 2);

    if (!this.song) return;
    const th = Math.max(24, this.h * 0.05);
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      const l = this.lanes[n.lane];
      const p = 1 - d / this.approach;
      const yb = l.y0 + 10 + p * (this.hitY - l.y0 - 10);
      const x = l.x0 + 8;
      const wd = l.x1 - l.x0 - 16;
      this.glass(() => roundRectPath(ctx, x, yb - th, wd, th, 10), { x, y: yb - th, w: wd, h: th }, l.color, 0.95, 0);
    }
  }

  drawPads(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    this.lanes.forEach((l, i) => {
      const wd = l.x1 - l.x0;
      const ht = l.y1 - l.y0;
      this.glass(() => roundRectPath(ctx, l.x0, l.y0, wd, ht, 22), { x: l.x0, y: l.y0, w: wd, h: ht }, l.color, glow[i], this.flash[i]);
      this.label(l.name, l.cx, l.cy, Math.max(15, Math.min(wd, ht) * 0.16));
    });
    if (!this.song) return;
    // A ring closes in on the pad to hit next
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      const l = this.lanes[n.lane];
      const s = Math.max(0, d / this.approach);
      const grow = 40 * s;
      roundRectPath(ctx, l.x0 - grow, l.y0 - grow, l.x1 - l.x0 + grow * 2, l.y1 - l.y0 + grow * 2, 22 + grow);
      ctx.lineWidth = 2 + 4 * (1 - s);
      ctx.strokeStyle = rgba(l.color, 0.25 + 0.75 * (1 - s));
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  drawHands(dt) {
    const ctx = this.ctx;
    if (this.settings.skeleton) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const hand of this.hands) {
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(hand.pts[a].x, hand.pts[a].y);
          ctx.lineTo(hand.pts[b].x, hand.pts[b].y);
        }
      }
      ctx.stroke();
    }
    // Pinch cursor: the inner dot grows as your fingers close; solid when the note is on.
    for (const c of this.cursors) {
      const color = c.hover >= 0 && this.lanes[c.hover] ? this.lanes[c.hover].color : '#ffffff';
      const closeness = clamp((c.off - c.gap) / (c.off - c.on + 0.12));
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = c.pinched ? 30 : 10;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 22, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.pinched ? color : 'rgba(255,255,255,0.85)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.pinched ? 16 : 4 + 10 * closeness, 0, TAU);
      ctx.fillStyle = c.pinched ? color : 'rgba(255,255,255,0.6)';
      ctx.fill();
      if (c.pop > 0) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 22 + (1 - c.pop) * 30, 0, TAU);
        ctx.strokeStyle = rgba(color === '#ffffff' ? '#ffffff' : color, c.pop);
        ctx.stroke();
        c.pop = Math.max(0, c.pop - dt * 4);
      }
      ctx.restore();
    }
  }

  drawEffects(dt) {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => (p.life -= dt * 1.8) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
      ctx.fillStyle = rgba(p.color, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * p.life + 1, 0, TAU);
      ctx.fill();
    }
    const now = performance.now();
    this.popups = this.popups.filter((p) => now - p.born < 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.popups) {
      const k = (now - p.born) / 700;
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = p.color;
      ctx.font = `800 ${22 + 6 * (1 - k)}px Outfit, system-ui, sans-serif`;
      ctx.fillText(p.text, p.x, p.y - k * 30);
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
    ctx.globalAlpha = clamp(frac + 0.2);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#7b6cff';
    ctx.shadowBlur = 40;
    ctx.font = `800 ${this.md * 0.18}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.w / 2, this.h * 0.3);
    ctx.restore();
  }
}
