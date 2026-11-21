// Camera + MediaPipe hand tracking.
// MediaPipe Tasks Vision 0.10.14: use the copy bundled in /vendor when present, otherwise the public CDN.
const SOURCES = [
  {
    vision: new URL('../vendor/mediapipe', import.meta.url).href,
    model: new URL('../vendor/models/hand_landmarker.task', import.meta.url).href,
  },
  {
    vision: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
];

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    // A smaller frame is tracked faster; a higher frame rate means less delay per gesture.
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

async function pickSource() {
  for (const src of SOURCES) {
    try {
      const head = await fetch(src.model, { method: 'HEAD' });
      if (!head.ok) continue;
      const lib = await import(`${src.vision}/vision_bundle.mjs`);
      return { ...src, lib };
    } catch {
      // try the next source
    }
  }
  throw new Error('Could not load hand tracking');
}

export async function createHandTracker() {
  const { vision: VISION, model: MODEL, lib } = await pickSource();
  const { FilesetResolver, HandLandmarker } = lib;
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.3, // keep hold of the hand through fast, blurry swings
  });
  let landmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  let lastTime = -1;
  return {
    // Returns [{ side: 'Left'|'Right', landmarks: [{x,y,z}x21] }] or null if no new frame
    detect(video) {
      if (video.readyState < 2 || video.currentTime === lastTime) return null;
      lastTime = video.currentTime;
      const res = landmarker.detectForVideo(video, performance.now());
      return (res.landmarks || []).map((landmarks, i) => ({
        side: res.handedness?.[i]?.[0]?.categoryName || String(i),
        landmarks,
        world: res.worldLandmarks?.[i] || null,
      }));
    },
  };
}

// Preferred tracker: a background worker. Each new camera frame is copied to an ImageBitmap and
// sent over; while the worker is busy, newer frames replace older ones, so results never queue up.
// onResult(hands, info) is called with the same shape as detect() above.
export function createWorkerTracker(video, onResult) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./tracker-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Hand tracking worker timed out'));
    }, 30000);
    let busy = false;
    let running = false;
    const pump = () => {
      if (!running) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        const ts = performance.now();
        createImageBitmap(video)
          .then((bitmap) => worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]))
          .catch(() => (busy = false));
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(pump);
      else requestAnimationFrame(pump);
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        clearTimeout(timer);
        if (!m.ok) {
          worker.terminate();
          reject(new Error(m.error || 'Hand tracking failed to start'));
          return;
        }
        running = true;
        pump();
        resolve({ delegate: m.delegate, worker: true, stop: () => ((running = false), worker.terminate()) });
      } else if (m.type === 'result') {
        busy = false;
        onResult(m.hands, { ts: m.ts, ms: m.ms, latency: performance.now() - m.ts });
      } else if (m.type === 'error') {
        busy = false;
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
    worker.postMessage({ type: 'init', sources: SOURCES });
  });
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
