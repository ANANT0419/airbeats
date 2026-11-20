// Song charts, instrument layouts and backing-track progressions.
// Piano songs are public-domain melodies; drum grooves are original patterns.

export const PIANO_LANES = [
  { name: 'C', midi: 60, color: '#ff6b8b' },
  { name: 'D', midi: 62, color: '#ffa26b' },
  { name: 'E', midi: 64, color: '#ffd166' },
  { name: 'F', midi: 65, color: '#06d6a0' },
  { name: 'G', midi: 67, color: '#4cc9f0' },
  { name: 'A', midi: 69, color: '#7b8cff' },
  { name: 'B', midi: 71, color: '#c77dff' },
  { name: 'C', midi: 72, color: '#ff6bd6' },
];

// x, y are fractions of the screen; r is a fraction of the shorter screen side.
export const DRUM_LANES = [
  { id: 'hihat', name: 'Hi-Hat', x: 0.14, y: 0.50, r: 0.10, color: '#06d6a0' },
  { id: 'snare', name: 'Snare', x: 0.30, y: 0.72, r: 0.12, color: '#ef476f' },
  { id: 'tom1', name: 'Tom 1', x: 0.40, y: 0.36, r: 0.10, color: '#4cc9f0' },
  { id: 'kick', name: 'Kick', x: 0.50, y: 0.74, r: 0.11, color: '#ff6bd6' },
  { id: 'tom2', name: 'Tom 2', x: 0.60, y: 0.36, r: 0.10, color: '#7b6cff' },
  { id: 'floor', name: 'Floor', x: 0.70, y: 0.72, r: 0.12, color: '#f78c6b' },
  { id: 'crash', name: 'Crash', x: 0.86, y: 0.42, r: 0.11, color: '#ffd166' },
];
const DL = Object.fromEntries(DRUM_LANES.map((l, i) => [l.id, i]));

const PIANO_INDEX = { C4: 0, D4: 1, E4: 2, F4: 3, G4: 4, A4: 5, B4: 6, C5: 7 };
const LEN = { '': 1, '_': 2, '.': 1.5, '/': 0.5, '=': 4 };

// "E E F G. D/ C_" -> notes. Suffix: none=1 beat, _=2, .=1.5, /=0.5, ==4
function melody(src) {
  const notes = [];
  let beat = 0;
  for (const tok of src.trim().split(/\s+/)) {
    const m = tok.match(/^([A-GR])(\d?)([_./=]?)$/);
    if (!m) throw new Error('Bad token ' + tok);
    const [, n, oct, suf] = m;
    if (n !== 'R') notes.push({ beat, lane: PIANO_INDEX[n + (oct || '4')] });
    beat += LEN[suf];
  }
  return { notes, beats: beat };
}

// bars: [{ hihat: 'x.x.x.x.', ... }] with 8 steps (eighth notes) per bar
function groove(bars) {
  const notes = [];
  bars.forEach((bar, bi) => {
    for (const [id, steps] of Object.entries(bar)) {
      [...steps].forEach((c, i) => {
        if (c === 'x') notes.push({ beat: bi * 4 + i * 0.5, lane: DL[id] });
      });
    }
  });
  notes.sort((a, b) => a.beat - b.beat);
  return { notes, beats: bars.length * 4 };
}

function chords(src) {
  return src.trim().split(/\s+/).map((t) => {
    const [name, beats] = t.split(':');
    return { name, beats: Number(beats) };
  });
}

function repeat(arr, n) {
  return Array.from({ length: n }, () => arr).flat();
}

const ROCK = { hihat: 'x.x.x.x.', kick: 'x...x...', snare: '..x...x.' };
const EIGHTS = { hihat: 'xxxxxxxx', kick: 'x...x...', snare: '..x...x.' };
const END = { crash: 'x.......', kick: 'x.......' };

export const SONGS = {
  piano: [
    {
      id: 'twinkle', title: 'Twinkle Twinkle', subtitle: 'Traditional', bpm: 90, level: 1,
      ...melody('C C G G A A G_ F F E E D D C_ G G F F E E D_ G G F F E E D_ C C G G A A G_ F F E E D D C_'),
      chords: chords('C:4 F:2 C:2 F:2 C:2 G:2 C:2 C:2 F:2 C:2 G:2 C:2 F:2 C:2 G:2 C:4 F:2 C:2 F:2 C:2 G:2 C:2'),
    },
    {
      id: 'mary', title: 'Mary Had a Little Lamb', subtitle: 'Traditional', bpm: 100, level: 1,
      ...melody('E D C D E E E_ D D D_ E G G_ E D C D E E E E D D E D C='),
      chords: chords('C:4 C:4 G:4 C:4 C:4 C:4 G:4 C:4'),
    },
    {
      id: 'ode', title: 'Ode to Joy', subtitle: 'Beethoven', bpm: 100, level: 2,
      ...melody('E E F G G F E D C C D E E. D/ D_ E E F G G F E D C C D E D. C/ C_'),
      chords: chords('C:4 G:4 C:4 C:2 G:2 C:4 G:4 C:4 G:2 C:2'),
    },
    {
      id: 'jingle', title: 'Jingle Bells', subtitle: 'J. Pierpont', bpm: 115, level: 3,
      ...melody('E E E_ E E E_ E G C D E= F F F. F/ F E E E/ E/ E D D E D_ G_'),
      chords: chords('C:4 C:4 C:4 C:4 F:4 C:4 D:4 G:4'),
    },
  ],
  drums: [
    {
      id: 'first', title: 'First Steps', subtitle: 'Kick · hat · snare', bpm: 80, level: 1,
      ...groove([
        ...repeat([{ kick: 'x.......', hihat: '..x...x.', snare: '....x...' }], 7),
        END,
      ]),
      chords: chords(repeat(['Am:4 F:4 C:4 G:4'], 2).join(' ')),
    },
    {
      id: 'backbeat', title: 'Backbeat', subtitle: 'Two-hand rock groove', bpm: 92, level: 2,
      ...groove([
        ...repeat([ROCK], 7),
        { snare: 'x.x.x.xx' },
        END,
      ]),
      chords: chords(repeat(['C:4 G:4 Am:4 F:4'], 2).join(' ') + ' C:4'),
    },
    {
      id: 'tomtour', title: 'Tom Tour', subtitle: 'Groove with tom fills', bpm: 100, level: 3,
      ...groove([
        ...repeat([EIGHTS], 3),
        { tom1: 'xx......', tom2: '..xx....', floor: '....xx..', snare: '......xx' },
        ...repeat([EIGHTS], 3),
        { tom1: 'xx......', tom2: '..xx....', floor: '....xx..', snare: '......xx' },
        END,
      ]),
      chords: chords(repeat(['Am:4 Am:4 F:4 G:4'], 2).join(' ') + ' Am:4'),
    },
  ],
};

// Chord voicings (MIDI) used by the backing track.
export const CHORDS = {
  C: { root: 36, notes: [48, 52, 55] },
  F: { root: 41, notes: [48, 53, 57] },
  G: { root: 43, notes: [47, 50, 55] },
  Am: { root: 45, notes: [45, 48, 52] },
  D: { root: 38, notes: [45, 50, 54] },
  Em: { root: 40, notes: [47, 52, 55] },
};
