# AirBeats

Play drums and piano **in the air** with your webcam. Your hands are tracked live and see-through glass
pads float over your mirrored camera feed. Strike a pad as its guide closes in. Hit the right one and the
song moves forward. Hit the wrong one and you hear that wrong sound. Play well and the backing band fades
in until it's the full song.

## Modes
- **Drums**: virtual sticks come out of your fists. Swing down onto Hi-Hat, Snare, Kick, Toms, Floor or Crash.
  Rings close in on the pad you need to hit next.
- **Piano**: point with your index finger and tap down on 8 glass keys (C to C). Tiles fall toward the key to play.
- **Free Play**: no chart, just jam.

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
- `js/game.js`: layout, strike detection (speed and direction, re-strike on the same pad), timing
  judgement (Perfect ±75 ms / Good ±160 ms), glass rendering, backing-track scheduler
- `js/audio.js`: every sound is synthesized with Web Audio (no sample files)
- Settings: hit sensitivity, and a camera-delay offset to line your hits up with the music

All video stays in the browser. Nothing is uploaded.
