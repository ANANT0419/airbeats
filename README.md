# AirBeats

A motion synth in the browser, inspired by gesture instruments like the AUUG Motion Synth.
**Something instant triggers each note** (a pinch in front of the camera, or a finger on the screen).
**Where you are picks the note** (8 in-key columns, so nothing sounds wrong), and **motion shapes the
sound** (hand height or phone tilt = brightness, hand roll or phone roll = vibrato). Shaping is
continuous, so camera delay is not felt; triggers are a single-frame pose, so they don't miss.

## Play
- **Hands (laptop camera):** hand height is the pitch, pinch thumb + index to play. Hold to
  sustain, move up/down while pinched to glide, move right for brighter, tilt for vibrato.
  Pitch snapping is adjustable (snap / soft / free theremin).
- **Relaxed play (default):** the song waits at each note until you play it. **Timed** play keeps
  up with the band; a Speed slider sets the tempo for both.
- **Teach AirBeats my hands:** 20 seconds of open / pinched poses at several angles, both hands
  at once. It trains a small pinch classifier for you in the browser (nothing is uploaded).
- **Touch & tilt (phone):** touch a column to play (multi-touch chords), slide to glide,
  tip the phone toward you for brighter, roll it for vibrato.

## Modes
- **Synth:** sustained lead voice with glide (the motion-synth experience)
- **Piano:** struck notes, re-pinch / re-tap for each note
- **Drums:** 7 pads, pinch or tap to hit
- **Song mode** for each: glass tiles fall to the line (or rings close on pads); the backing band
  gets louder the better you play. **Free Play** has no chart.

## Songs
| Piano (public domain) | Drums (original grooves) |
|---|---|
| Twinkle Twinkle, Mary Had a Little Lamb, Ode to Joy, Jingle Bells | First Steps, Backbeat, Tom Tour |

Charts are in `js/songs.js`. Write a melody as `"E D C D E E E_"` (suffixes: `_`=2 beats, `.`=1.5, `/`=½, `==`4)
or a drum groove as an 8-step grid per bar.

## Run locally
The camera needs `localhost` or HTTPS:
```bash
python3 -m http.server 8080
```
Then open http://localhost:8080.

## How it works
- `js/hands.js` + `js/tracker-worker.js`: camera + MediaPipe Hand Landmarker in a background
  worker (bundled in `vendor/`), which times GPU vs CPU on your machine and keeps the faster one.
  Falls back to the main thread if workers are unavailable.
- `js/pinch.js`: pinch recognition. No ready-made open-source pinch recognizer exists for
  MediaPipe on the web (its Gesture Recognizer has no pinch class), so: a forgiving rule that
  blends 3D and image distances and adapts to each hand, plus an optional per-user logistic
  regression on landmark-distance features trained during calibration.
- `js/game.js`: two-hand cursor matching (position + left/right label), early trigger on a fast
  close, 3-frame release; One Euro filtering plus frame-rate
  interpolation; touch + tilt input; timing judgement
  (Perfect ±80 ms / Good ±170 ms), glass rendering, backing-track scheduler
- `js/audio.js`: every sound is synthesized with Web Audio (no sample files). Synth voices run
  continuously and are gated, so a note starts in one audio block (~3 ms) after the trigger.
- Settings: pinch firmness, and a camera-delay offset to line your notes up with the music

All video stays in the browser. Nothing is uploaded.
