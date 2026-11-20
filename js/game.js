import { PIANO_LANES, DRUM_LANES, CHORDS } from './songs.js';
import { HAND_CONNECTIONS } from './hands.js';

const TAU = Math.PI * 2;
const PERFECT = 0.075; // seconds
const GOOD = 0.16;
const LEAD_BEATS = 4; // count-in
// Strike speed thresholds (fraction of the short screen side per second)
// Downward stroke speed needed for a hit (fraction of the short screen side per second)
const SENS = { low: 0.9, medium: 0.6, high: 0.38 };

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
    this.settings = { sensitivity: 'medium', latency: 0.06, skeleton: true };
    this.blur = document.createElement('canvas');
    this.blur.width = 160;
    this.blur.height = 90;
    this.bctx = this.blur.getContext('2d');
    this.mode = null;
    this.lanes = [];
    this.flash = [];
    this.ptrList = [];
    this.hover = new Set();
    this.hands = [];
    this.popups = [];
    this.particles = [];
    this.playing = false;
    this.song = null;
    this.lastHud = 0;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.bindMouse();
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

  setSource(video, tracker) {
    this.video = video;
    this.tracker = tracker;
  }

  setMode(mode) {
    this.mode = mode;
    this.ptrList = [];
    this.layout();
  }

  layout() {
    const { w, h, md } = this;
    if (this.mode === 'drums') {
      this.lanes = DRUM_LANES.map((l) => ({ ...l, cx: l.x * w, cy: l.y * h, rad: l.r * md }));
    } else if (this.mode === 'piano') {
      const left = w * 0.05;
      const kw = (w * 0.9) / PIANO_LANES.length;
      // Keys sit mid-screen so your wrist stays in the camera view while you tap.
      const top = h * 0.5;
      const bottom = h * 0.76;
      this.lanes = PIANO_LANES.map((l, i) => ({
        ...l,
        x0: left + i * kw + 4,
        x1: left + (i + 1) * kw - 4,
        top,
        bottom,
        cx: left + (i + 0.5) * kw,
        cy: (top + bottom) / 2,
      }));
    } else {
      this.lanes = [];
    }
    this.flash = this.lanes.map(() => 0);
  }

  laneAt(x, y) {
    if (this.mode === 'drums') {
      let best = -1;
      let bd = Infinity;
      this.lanes.forEach((l, i) => {
        const d = Math.hypot(x - l.cx, y - l.cy);
        if (d < l.rad * 1.3 && d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    }
    if (this.mode === 'piano') {
      return this.lanes.findIndex((l) => x >= l.x0 - 4 && x <= l.x1 + 4 && y >= l.top - 20 && y <= l.bottom + 30);
    }
    return -1;
  }

  // ---------- song lifecycle ----------
  start(song) {
    this.audio.init();
    this.song = song;
    this.paused = false;
    const spb = 60 / (song?.bpm || 100);
    this.spb = spb;
    this.approach = this.mode === 'piano' ? 2.0 : 1.5;
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
      if (this.mode === 'piano') {
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
    this.playing = false;
    this.song = null;
    this.notes = [];
    this.events = [];
    this.audio.setBackingLevel(0);
  }

  pause(on) {
    this.paused = on;
    if (!this.audio.ctx) return;
    if (on) this.audio.ctx.suspend();
    else this.audio.ctx.resume();
  }

  get songTime() {
    return this.audio.now - this.startTime;
  }

  // ---------- input ----------
  bindMouse() {
    let lastLane = -1;
    this.canvas.addEventListener('pointerdown', (e) => {
      const lane = this.laneAt(e.clientX, e.clientY);
      lastLane = lane;
      if (lane !== -1) this.hit(lane, 0.9, 'mouse');
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!e.buttons || this.mode !== 'piano') return;
      const lane = this.laneAt(e.clientX, e.clientY);
      if (lane !== -1 && lane !== lastLane) this.hit(lane, 0.8, 'mouse');
      lastLane = lane;
    });
    this.canvas.addEventListener('pointerup', () => (lastLane = -1));
  }

  toScreen(p) {
    const v = this.video;
    const vw = v.videoWidth || 1280;
    const vh = v.videoHeight || 720;
    const s = Math.max(this.w / vw, this.h / vh);
    const dw = vw * s;
    const dh = vh * s;
    const ox = (this.w - dw) / 2;
    const oy = (this.h - dh) / 2;
    return { x: this.w - (ox + p.x * dw), y: oy + p.y * dh };
  }

  processHands(raw, now) {
    const md = this.md;
    this.hands = raw.map((h) => {
      const pts = h.landmarks.map((p) => this.toScreen(p));
      // Knuckle centre is the steadiest part of a fist. The stick head sits a short, fixed
      // distance above it, so wrist wobble does not swing the hit point around.
      const k = [5, 9, 13].reduce((a, i) => ({ x: a.x + pts[i].x / 3, y: a.y + pts[i].y / 3 }), { x: 0, y: 0 });
      const tip = { x: k.x, y: k.y - md * 0.06 };
      return { side: h.side, pts, base: pts[0], tip };
    });
    const points = this.hands.map((h) => (this.mode === 'drums' ? { ...h.tip } : { ...h.pts[8] }));
    this.updatePointers(points, now);
  }

  // Pointers are matched to last frame's by distance, not by the tracker's left/right label,
  // which can flip or repeat between frames.
  updatePointers(points, now) {
    const md = this.md;
    const th = SENS[this.settings.sensitivity] * md * (this.mode === 'piano' ? 0.6 : 1);
    if (!Array.isArray(this.ptrList)) this.ptrList = [];
    const free = new Set(this.ptrList);
    this.hover = new Set();

    for (const p of points) {
      let st = null;
      let bd = md * 0.35;
      for (const s of free) {
        const d = Math.hypot(s.rx - p.x, s.ry - p.y);
        if (d < bd) {
          bd = d;
          st = s;
        }
      }
      if (!st) {
        st = { x: p.x, y: p.y, rx: p.x, ry: p.y, t: now, vx: 0, vy: 0, armed: false, flash: 0 };
        this.ptrList.push(st);
        continue;
      }
      free.delete(st);
      const dt = Math.max(1 / 120, now - st.t);
      if (dt > 0.2) {
        // Tracking dropped for a while: restart cleanly instead of reading the jump as a strike.
        Object.assign(st, { x: p.x, y: p.y, rx: p.x, ry: p.y, t: now, vx: 0, vy: 0, armed: false });
        continue;
      }
      // Adaptive smoothing: steady when still, responsive when swinging.
      const jump = Math.hypot(p.x - st.x, p.y - st.y);
      const a = Math.min(0.9, 0.35 + jump / (md * 0.05));
      const nx = st.x + (p.x - st.x) * a;
      const ny = st.y + (p.y - st.y) * a;
      const keep = dt > 0.05 ? 0 : 0.4; // after a skipped frame, trust the fresh motion
      st.vx = st.vx * keep + ((nx - st.x) / dt) * (1 - keep);
      st.vy = st.vy * keep + ((ny - st.y) / dt) * (1 - keep);

      const lane = this.laneAt(nx, ny);
      const prevLane = this.laneAt(st.x, st.y);
      if (lane !== -1) this.hover.add(lane);

      // A strike = a quick downward stroke. Re-arms once the stroke stops or reverses,
      // so you can hit the same pad again and again.
      if (st.vy < th * 0.3) st.armed = true;
      const downward = st.vy > th && st.vy > Math.abs(st.vx) * 0.6;
      if (st.armed && downward) {
        const target = lane !== -1 ? lane : prevLane;
        st.armed = false;
        st.flash = 1;
        if (target !== -1) this.hit(target, st.vy / (th * 2.5), 'hand');
      }
      st.x = nx;
      st.y = ny;
      st.rx = p.x;
      st.ry = p.y;
      st.t = now;
    }
    // A hand that vanishes mid-downstroke was almost always lost to motion blur during a strike:
    // count it as a hit where the stroke was heading.
    for (const s of free) {
      if (s.armed && s.vy > th * 0.7) {
        s.armed = false;
        s.flash = 1;
        const lane = this.laneAt(s.x + s.vx * 0.04, s.y + s.vy * 0.04);
        const target = lane !== -1 ? lane : this.laneAt(s.x, s.y);
        if (target !== -1) this.hit(target, s.vy / (th * 2.5), 'hand');
      }
    }
    // Keep briefly-lost pointers so a missed frame mid-swing does not reset them.
    this.ptrList = this.ptrList.filter((s) => !free.has(s) || now - s.t < 0.3);
  }

  hit(lane, vel, source) {
    if (!this.mode || lane < 0 || this.paused) return;
    this.audio.init();
    const l = this.lanes[lane];
    if (this.mode === 'drums') this.audio.drum(l.id, vel);
    else this.audio.piano(l.midi, vel);
    this.flash[lane] = 1;

    if (!this.song || !this.playing) {
      this.burst(l.cx, l.cy, l.color, 8);
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
    const py = this.mode === 'drums' ? l.cy - l.rad - 18 : l.top - 24;
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
      this.burst(l.cx, l.cy, l.color, perfect ? 22 : 12);
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
        this.popup(l.cx, this.mode === 'drums' ? l.cy - l.rad - 18 : l.top - 24, 'MISS', '#ffb3c0');
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

    if (this.tracker && this.video) {
      try {
        const raw = this.tracker.detect(this.video);
        if (raw) this.processHands(raw, now);
      } catch (e) {
        console.warn(e);
      }
    }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(now);

    // Frosted copy of the background for the glass surfaces
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
        this.audio.setBackingLevel(0);
        this.hooks.onEnd?.(this.results());
      }
    } else if (this.song) {
      songT = this.songTime;
    }

    if (this.mode) {
      if (this.mode === 'drums') this.drawDrums(songT);
      else this.drawPiano(songT);
    }
    this.drawHands();
    this.drawStrikes(dt);
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
        progress: Math.max(0, Math.min(1, songT / this.endTime)),
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
      ctx.fillStyle = 'rgba(8,6,24,0.38)';
      ctx.fillRect(0, 0, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#120b2e');
      g.addColorStop(1, '#05111f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const blobs = [['#7b6cff', 0.3, 0.3], ['#ff6bd6', 0.7, 0.6], ['#06d6a0', 0.5, 0.9]];
      blobs.forEach(([c, x, y], i) => {
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

  // Shared "mirror glass" surface: frosted background + tint + sheen + specular rim
  glass(pathFn, box, color, glow, flash) {
    const ctx = this.ctx;
    ctx.save();
    pathFn();
    ctx.clip();
    ctx.drawImage(this.blur, 0, 0, this.w, this.h);
    ctx.fillStyle = `rgba(255,255,255,${0.06 + flash * 0.25})`;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = rgba(color, 0.12 + glow * 0.3 + flash * 0.45);
    ctx.fillRect(box.x, box.y, box.w, box.h);
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.1)');
    g.addColorStop(0.48, 'rgba(255,255,255,0)');
    g.addColorStop(0.52, 'rgba(255,255,255,0.12)');
    g.addColorStop(0.62, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();

    ctx.save();
    if (glow > 0.05 || flash > 0.05) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10 + 30 * Math.max(glow, flash);
    }
    pathFn();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255,255,255,${0.45 + 0.4 * Math.max(glow, flash)})`;
    ctx.stroke();
    ctx.restore();
  }

  upcomingGlow(songT) {
    const glow = this.lanes.map(() => 0);
    if (!this.song) return glow;
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      glow[n.lane] = Math.max(glow[n.lane], 1 - Math.max(0, d) / this.approach);
    }
    return glow;
  }

  drawDrums(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    this.lanes.forEach((l, i) => {
      const { cx, cy, rad } = l;
      if (this.hover.has(i)) glow[i] = Math.max(glow[i], 0.35);
      const path = () => {
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, TAU);
      };
      this.glass(path, { x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 }, l.color, glow[i], this.flash[i]);
      // inner tinted ring + specular arc
      ctx.beginPath();
      ctx.arc(cx, cy, rad - 6, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(l.color, 0.55 + glow[i] * 0.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, rad * 0.8, Math.PI * 1.08, Math.PI * 1.42);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `600 ${Math.max(11, rad * 0.24)}px Outfit, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.name, cx, cy);
    });

    if (!this.song) return;
    // Approach rings close in on the pad you need to hit
    for (const n of this.notes) {
      const d = n.t - songT;
      if (d > this.approach) break;
      if (n.state || d < -GOOD) continue;
      const l = this.lanes[n.lane];
      const s = Math.max(0, d / this.approach);
      ctx.beginPath();
      ctx.arc(l.cx, l.cy, l.rad * (1 + 1.4 * s), 0, TAU);
      ctx.lineWidth = 2 + 4 * (1 - s);
      ctx.strokeStyle = rgba(l.color, 0.3 + 0.7 * (1 - s));
      ctx.shadowColor = l.color;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  drawPiano(songT) {
    const ctx = this.ctx;
    const glow = this.upcomingGlow(songT);
    const topY = 96; // below the HUD bar
    // lane guides
    this.lanes.forEach((l) => {
      const g = ctx.createLinearGradient(0, topY, 0, l.top);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, rgba(l.color, 0.12));
      ctx.fillStyle = g;
      ctx.fillRect(l.x0, topY, l.x1 - l.x0, l.top - topY);
    });

    // falling glass tiles
    if (this.song) {
      const th = Math.max(26, this.h * 0.06);
      for (const n of this.notes) {
        const d = n.t - songT;
        if (d > this.approach) break;
        if (n.state || d < -GOOD) continue;
        const l = this.lanes[n.lane];
        const p = 1 - d / this.approach;
        const yb = topY + p * (l.top - topY);
        const x = l.x0 + 6;
        const wd = l.x1 - l.x0 - 12;
        const y = yb - th;
        this.glass(() => roundRectPath(ctx, x, y, wd, th, 10), { x, y, w: wd, h: th }, l.color, 0.9, 0);
      }
    }

    this.lanes.forEach((l, i) => {
      const x = l.x0;
      const y = l.top;
      const wd = l.x1 - l.x0;
      const ht = l.bottom - l.top;
      const press = this.flash[i] * 6;
      if (this.hover.has(i)) glow[i] = Math.max(glow[i], 0.35);
      this.glass(() => roundRectPath(ctx, x, y + press, wd, ht, 14), { x, y, w: wd, h: ht + press }, l.color, glow[i], this.flash[i]);
      ctx.beginPath();
      ctx.moveTo(x + 12, y + press + 8);
      ctx.lineTo(x + wd * 0.55, y + press + 8);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = `700 ${Math.max(14, wd * 0.22)}px Outfit, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l.name, l.cx, l.bottom - ht * 0.22 + press);
    });

    // hit line
    const l0 = this.lanes[0];
    const lN = this.lanes[this.lanes.length - 1];
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(l0.x0, l0.top - 2, lN.x1 - l0.x0, 2);
  }

  drawHands() {
    const ctx = this.ctx;
    for (const hand of this.hands) {
      const { pts } = hand;
      if (this.settings.skeleton) {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(pts[a].x, pts[a].y);
          ctx.lineTo(pts[b].x, pts[b].y);
        }
        ctx.stroke();
      }
      if (this.mode === 'drums') {
        const { tip } = hand;
        // Draw the stick from below the fist up through the head.
        const base = { x: tip.x + (hand.pts[0].x - tip.x) * 0.6, y: tip.y + (hand.pts[0].y - tip.y) * 0.6 };
        const g = ctx.createLinearGradient(base.x, base.y, tip.x, tip.y);
        g.addColorStop(0, '#b0763c');
        g.addColorStop(1, '#f5d7a8');
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(7, this.md * 0.014);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        this.dot(tip.x, tip.y, Math.max(7, this.md * 0.014), '#ffffff');
      } else if (this.mode === 'piano') {
        this.dot(pts[8].x, pts[8].y, 10, '#ffffff');
      }
    }
  }

  drawStrikes(dt) {
    const ctx = this.ctx;
    for (const s of this.ptrList) {
      if (s.flash <= 0) continue;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 10 + (1 - s.flash) * 30, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(255,255,255,${s.flash})`;
      ctx.stroke();
      s.flash = Math.max(0, s.flash - dt * 4);
    }
  }

  dot(x, y, r, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = '#9ad7ff';
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.restore();
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
    ctx.globalAlpha = Math.max(0, Math.min(1, frac + 0.2));
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#7b6cff';
    ctx.shadowBlur = 40;
    ctx.font = `800 ${this.md * 0.18}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.w / 2, this.h * 0.2);
    ctx.restore();
  }
}
