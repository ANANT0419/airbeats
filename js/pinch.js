// Pinch recognition.
//
// There is no ready-made open-source pinch recognizer for MediaPipe on the web: Google's
// Gesture Recognizer has no pinch class, and custom models need Python training. So AirBeats
// uses two layers:
//   1. A forgiving rule (always on): thumb-index gap relative to palm size, blending the 3D
//      world estimate with the image estimate, adapting to each hand's own open size.
//   2. A small classifier trained on YOUR hands during "Teach AirBeats my hand" (logistic
//      regression on landmark-distance features, the approach used in landmark-based gesture
//      classifiers). When present it replaces the rule.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

// Features that describe "thumb meets index" from several angles. All are ratios to palm
// length, so they do not depend on hand size or distance from the camera.
export function handFeatures(lm, world, vw, vh) {
  const img = lm.map((p) => ({ x: p.x * vw, y: p.y * vh, z: p.z * vw }));
  const sets = world ? [world, img] : [img, img];
  const f = [];
  for (const P of sets) {
    const palm = dist(P[0], P[9]) || 1;
    f.push(
      dist(P[4], P[8]) / palm, // thumb tip - index tip
      dist(P[4], P[7]) / palm, // thumb tip - index last joint
      dist(P[3], P[8]) / palm, // thumb joint - index tip
      dist(P[8], P[5]) / palm, // index curl
      dist(P[4], P[12]) / palm // thumb tip - middle tip (a fist brings this in too)
    );
  }
  return f;
}

// Rule-based gap: half the 3D estimate, half the image one (each fails at different angles).
export function ruleGap(f) {
  return 0.5 * f[0] + 0.5 * f[5];
}

export class PinchModel {
  constructor(data) {
    Object.assign(this, data); // { mu, sd, w, b, acc }
  }

  prob(f) {
    let z = this.b;
    for (let i = 0; i < f.length; i++) z += this.w[i] * ((f[i] - this.mu[i]) / this.sd[i]);
    return 1 / (1 + Math.exp(-z));
  }

  // samples: [{ f: number[], y: 0|1 }]
  static train(samples) {
    const n = samples.length;
    const d = samples[0].f.length;
    const mu = Array(d).fill(0);
    const sd = Array(d).fill(0);
    for (const s of samples) s.f.forEach((v, i) => (mu[i] += v / n));
    for (const s of samples) s.f.forEach((v, i) => (sd[i] += (v - mu[i]) ** 2 / n));
    for (let i = 0; i < d; i++) sd[i] = Math.sqrt(sd[i]) || 1;
    const X = samples.map((s) => s.f.map((v, i) => (v - mu[i]) / sd[i]));
    const pos = samples.filter((s) => s.y).length;
    const wPos = n / (2 * Math.max(1, pos));
    const wNeg = n / (2 * Math.max(1, n - pos));
    const w = Array(d).fill(0);
    let b = 0;
    const lr = 0.3;
    const l2 = 0.01;
    for (let it = 0; it < 600; it++) {
      const gw = Array(d).fill(0);
      let gb = 0;
      for (let k = 0; k < n; k++) {
        let z = b;
        for (let i = 0; i < d; i++) z += w[i] * X[k][i];
        const p = 1 / (1 + Math.exp(-z));
        const err = (p - samples[k].y) * (samples[k].y ? wPos : wNeg);
        for (let i = 0; i < d; i++) gw[i] += (err * X[k][i]) / n;
        gb += err / n;
      }
      for (let i = 0; i < d; i++) w[i] -= lr * (gw[i] + l2 * w[i]);
      b -= lr * gb;
    }
    const model = new PinchModel({ mu, sd, w, b });
    let right = 0;
    for (const s of samples) if ((model.prob(s.f) > 0.5) === !!s.y) right++;
    model.acc = right / n;
    return model;
  }

  toJSON() {
    return { mu: this.mu, sd: this.sd, w: this.w, b: this.b, acc: this.acc };
  }
}
