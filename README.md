# AirBeats

A motion synth in the browser, inspired by gesture instruments like the AUUG Motion Synth.
**Something instant triggers each note** (a pinch in front of the camera, or a finger on the screen).
**Where you are picks the note** (8 in-key columns, so nothing sounds wrong), and **motion shapes the
sound** (hand height or phone tilt = brightness, hand roll or phone roll = vibrato). Shaping is
continuous, so camera delay is not felt; triggers are a single-frame pose, so they don't miss.

## Play
- **Hands (laptop camera):** move left/right to pick a note, pinch thumb + index to play. Hold to
  sustain, slide while pinched to glide, raise your hand for brighter, tilt it for vibrato.
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
- `js/hands.js`: camera + MediaPipe Hand Landmarker (bundled in `vendor/`, no CDN)
- `js/game.js`: pinch detection (thumb-index gap / hand size, with hysteresis), detection on every
  camera frame (`requestVideoFrameCallback`), touch + tilt input, timing judgement
  (Perfect ±80 ms / Good ±170 ms), glass rendering, backing-track scheduler
- `js/audio.js`: every sound is synthesized with Web Audio (no sample files). Synth voices run
  continuously and are gated, so a note starts in one audio block (~3 ms) after the trigger.
- Settings: pinch firmness, and a camera-delay offset to line your notes up with the music

All video stays in the browser. Nothing is uploaded.
