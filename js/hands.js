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
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
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
      }));
    },
  };
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
