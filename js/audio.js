// All sounds are synthesized with the Web Audio API — no sample files needed.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// A synth voice whose oscillators run all the time. Playing a note only opens its gain gate
// and moves the pitch, so there is no setup cost between your gesture and the sound.
class Voice {
  constructor(engine) {
    const ctx = engine.ctx;
    this.ctx = ctx;
    this.busy = false;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1800;
    this.filter.Q.value = 3;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.filter.connect(this.gate);
    this.gate.connect(engine.sfx);
    this.gate.connect(engine.reverbSend);

    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 5.5;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.connect(this.lfoDepth);

    this.oscs = [
      ['sawtooth', 1, -6, 0.32],
      ['sawtooth', 1, 6, 0.32],
      ['sine', 0.5, 0, 0.5],
    ].map(([type, mult, det, amp]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(this.filter);
      this.lfoDepth.connect(o.detune);
      o.start();
      return { o, mult };
    });
    this.lfo.start();
  }

  setPitch(midi, glide) {
    const t = this.ctx.currentTime;
    const f = mtof(midi);
    for (const { o, mult } of this.oscs) {
      o.frequency.cancelScheduledValues(t);
      if (glide) o.frequency.setTargetAtTime(f * mult, t, 0.035);
      else o.frequency.setValueAtTime(f * mult, t);
    }
  }

  on(midi, vel = 0.9) {
    const t = this.ctx.currentTime;
    this.setPitch(midi, false);
    this.gate.gain.cancelScheduledValues(t);
    this.gate.gain.setValueAtTime(this.gate.gain.value, t);
    this.gate.gain.linearRampToValueAtTime(0.28 * vel, t + 0.006);
  }

  glide(midi) {
    this.setPitch(midi, true);
  }

  // bright 0..1 opens the filter, vib 0..1 adds vibrato
  expr(bright, vib) {
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(250 + bright * bright * 6500, t, 0.03);
    this.lfoDepth.gain.setTargetAtTime(vib * 45, t, 0.06);
  }

  off() {
    const t = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(t);
    this.gate.gain.setTargetAtTime(0, t, 0.07);
  }
}

export class AudioEngine {
  init() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(comp);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);

    this.backing = ctx.createGain();
    this.backing.gain.value = 0;
    this.backing.connect(this.master);

    // Simple generated reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.25;
    this.reverbSend.connect(this.reverb).connect(this.master);

    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  // Borrow a free synth voice (a small pool is created once and reused).
  voice() {
    if (!this.voices) this.voices = [];
    let v = this.voices.find((x) => !x.busy);
    if (!v && this.voices.length < 8) {
      v = new Voice(this);
      this.voices.push(v);
    }
    if (!v) v = this.voices[0];
    v.busy = true;
    return v;
  }

  freeVoice(v) {
    v.off();
    v.busy = false;
  }

  warmUp() {
    const vs = [0, 1, 2, 3].map(() => this.voice());
    vs.forEach((v) => this.freeVoice(v));
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  impulse(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  env(gainNode, t, peak, decay, attack = 0.002) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  noise(t, decay, type, freq, peak, dest, q = 0.7) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  tone(t, type, f0, f1, sweep, peak, decay, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const g = ctx.createGain();
    this.env(g, t, peak, decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  drum(id, vel = 1, t = this.now, dest = this.sfx) {
    if (!this.ctx) return;
    const v = Math.max(0.35, Math.min(1, vel));
    switch (id) {
      case 'kick':
        this.tone(t, 'sine', 160, 42, 0.12, 1.0 * v, 0.45, dest);
        this.noise(t, 0.02, 'lowpass', 2500, 0.3 * v, dest);
        break;
      case 'snare':
        this.tone(t, 'triangle', 220, 160, 0.08, 0.5 * v, 0.12, dest);
        this.noise(t, 0.2, 'highpass', 1500, 0.6 * v, dest);
        this.noise(t, 0.2, 'highpass', 1500, 0.15 * v, this.reverbSend);
        break;
      case 'hihat':
        this.noise(t, 0.06, 'highpass', 8000, 0.45 * v, dest);
        break;
      case 'tom1':
        this.tone(t, 'sine', 260, 170, 0.25, 0.8 * v, 0.4, dest);
        this.noise(t, 0.05, 'bandpass', 1200, 0.15 * v, dest);
        break;
      case 'tom2':
        this.tone(t, 'sine', 190, 125, 0.28, 0.8 * v, 0.45, dest);
        this.noise(t, 0.05, 'bandpass', 900, 0.15 * v, dest);
        break;
      case 'floor':
        this.tone(t, 'sine', 120, 75, 0.35, 0.9 * v, 0.6, dest);
        this.noise(t, 0.06, 'bandpass', 600, 0.15 * v, dest);
        break;
      case 'crash':
        this.noise(t, 1.5, 'highpass', 4500, 0.4 * v, dest);
        this.noise(t, 1.0, 'bandpass', 9000, 0.25 * v, dest, 1.5);
        this.noise(t, 1.5, 'highpass', 4500, 0.15 * v, this.reverbSend);
        break;
      case 'click':
        this.tone(t, 'square', 1800, 0, 0, 0.12, 0.03, dest);
        break;
    }
  }

  piano(midi, vel = 1, t = this.now, dest = this.sfx, length = 1.6) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const f = mtof(midi);
    const v = Math.max(0.4, Math.min(1, vel));
    const out = ctx.createGain();
    this.env(out, t, 0.5 * v, length, 0.004);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + length * 0.6);
    lp.connect(out);
    out.connect(dest);
    out.connect(this.reverbSend);
    [[1, 'sine', 0.7], [2, 'triangle', 0.18], [3, 'sine', 0.08], [4.01, 'sine', 0.04]].forEach(([mult, type, amp]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + length + 0.1);
    });
  }

  bass(midi, t, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.backing);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  pad(midis, t, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.15);
    g.gain.setValueAtTime(0.07, t + Math.max(0.2, dur - 0.2));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(g);
    g.connect(this.backing);
    g.connect(this.reverbSend);
    for (const m of midis) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.2);
      }
    }
  }

  shaker(t) {
    this.noise(t, 0.04, 'highpass', 9000, 0.12, this.backing);
  }

  setBackingLevel(v) {
    if (!this.ctx) return;
    this.backing.gain.setTargetAtTime(v, this.now, 0.25);
  }
}
