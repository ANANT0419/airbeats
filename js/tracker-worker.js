// Hand tracking runs here, off the main thread, so the picture and the sound never wait for it.
// MediaPipe's loader calls importScripts(), which module workers lack; this shim loads the
// script synchronously (allowed in workers) and evaluates it in the global scope.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    if (xhr.status >= 400) throw new Error(`Could not load ${url}`);
    (0, eval)(xhr.responseText);
  }
};

let landmarker = null;
let delegate = '';
let make = null; // (delegate) => Promise<HandLandmarker>
// Speed check: GPU is usually fastest, but not on every machine. Time it on the first frames and
// switch to CPU if CPU turns out faster.
const bench = { phase: 'gpu', times: [], gpuMedian: 0, gpu: null };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const options = (model, d) => ({
  baseOptions: { modelAssetPath: model, delegate: d },
  runningMode: 'VIDEO',
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.4,
  minTrackingConfidence: 0.3,
});

async function init({ sources }) {
  let lastError = null;
  for (const src of sources) {
    try {
      const head = await fetch(src.model, { method: 'HEAD' });
      if (!head.ok) continue;
      const lib = await import(`${src.vision}/vision_bundle.mjs`);
      const fileset = await lib.FilesetResolver.forVisionTasks(`${src.vision}/wasm`);
      make = (d) => lib.HandLandmarker.createFromOptions(fileset, options(src.model, d));
      for (const d of ['GPU', 'CPU']) {
        try {
          landmarker = await make(d);
          delegate = d;
          if (d === 'CPU') bench.phase = 'done';
          return { ok: true, delegate };
        } catch (e) {
          lastError = e;
        }
      }
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, error: String(lastError) };
}

async function benchmark(ms) {
  if (bench.phase === 'done') return;
  bench.times.push(ms);
  if (bench.times.length < 14) return; // the first frames include warm-up
  const med = median(bench.times.slice(4));
  bench.times = [];
  if (bench.phase === 'gpu') {
    if (med < 30) {
      bench.phase = 'done';
      return;
    }
    try {
      bench.gpu = landmarker;
      bench.gpuMedian = med;
      landmarker = await make('CPU');
      delegate = 'CPU';
      bench.phase = 'cpu';
    } catch {
      landmarker = bench.gpu;
      bench.phase = 'done';
    }
  } else if (bench.phase === 'cpu') {
    if (med >= bench.gpuMedian) {
      landmarker.close?.();
      landmarker = bench.gpu;
      delegate = 'GPU';
    } else {
      bench.gpu.close?.();
    }
    bench.gpu = null;
    bench.phase = 'done';
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    self.postMessage({ type: 'ready', ...(await init(m)) });
  } else if (m.type === 'frame') {
    const t0 = performance.now();
    let res = null;
    try {
      res = landmarker.detectForVideo(m.bitmap, m.ts);
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err) });
    }
    m.bitmap.close();
    const ms = performance.now() - t0;
    await benchmark(ms);
    self.postMessage({
      type: 'result',
      ts: m.ts,
      ms,
      delegate,
      hands: res
        ? res.landmarks.map((lm, i) => ({
            landmarks: lm,
            world: res.worldLandmarks?.[i] || null,
            side: res.handedness?.[i]?.[0]?.categoryName || String(i),
          }))
        : [],
    });
  }
};
