// Reference pieces with the true hand for every note, plus a humanizer that turns them
// into a realistic MIDI performance (timing jitter, rolled chords, early/late releases).
// Positions/lengths are in quarter notes. Used by test.mjs and by the app's demo button.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const midi = (name) => {
  const [, l, acc, oct] = name.match(/^([A-G])(#{1,2}|b{1,2})?(-?\d)$/);
  const a = !acc ? 0 : acc[0] === '#' ? acc.length : -acc.length;
  return 12 * (+oct + 1) + PC[l] + a;
};

// seq('C4 1, [E4 G4] .5, - .5, ...') -> [{p, s, len}] ; "-" is a rest
function seq(text, start = 0) {
  const out = [];
  let t = start;
  for (const item of text.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = item.match(/^(\[[^\]]+\]|\S+)\s+([\d./]+)$/);
    const len = eval(m[2]);
    if (m[1] !== '-') for (const n of m[1].replace(/[[\]]/g, '').split(/\s+/)) out.push({ p: midi(n), s: t, len });
    t += len;
  }
  return out;
}
const rep = (s, n) => Array(n).fill(s).join(', ');
const tri = (a, b, c) => `${a} 1/3, ${b} 1/3, ${c} 1/3`;

export const SONGS = [
  {
    name: 'Minuet in G (Petzold)', meter: '3/4', bpm: 100, key: 'G',
    rh: seq(`D5 1, G4 .5, A4 .5, B4 .5, C5 .5, D5 1, G4 1, G4 1, E5 1, C5 .5, D5 .5, E5 .5, F#5 .5, G5 1, G4 1, G4 1,
             C5 1, D5 .5, C5 .5, B4 .5, A4 .5, B4 1, C5 .5, B4 .5, A4 .5, G4 .5, F#4 1, G4 .5, A4 .5, B4 .5, G4 .5, A4 3`),
    lh: seq(`[G3 B3] 2, A3 1, B3 3, C4 3, B3 3, A3 3, G3 3, D4 1, B3 1, G3 1, D4 1, D3 .5, C4 .5, B3 .5, A3 .5`),
  },
  {
    name: 'Für Elise (Beethoven)', meter: '3/8', bpm: 140, key: 'Am',
    rh: seq(`E5 .25, D#5 .25, E5 .25, B4 .25, D5 .25, C5 .25, A4 .5, - .25, C4 .25, E4 .25, A4 .25,
             B4 .5, - .25, E4 .25, G#4 .25, B4 .25, C5 .5, - .25, E4 .25, E5 .25, D#5 .25,
             E5 .25, D#5 .25, E5 .25, B4 .25, D5 .25, C5 .25, A4 .5, - .25, C4 .25, E4 .25, A4 .25,
             B4 .5, - .25, E4 .25, C5 .25, B4 .25, A4 1.5`),
    lh: seq(`- 1.5, A2 .25, E3 .25, A3 .25, - .75, E2 .25, E3 .25, G#3 .25, - .75, A2 .25, E3 .25, A3 .25, - .75,
             - 1.5, A2 .25, E3 .25, A3 .25, - .75, E2 .25, E3 .25, G#3 .25, - .75, A2 .25, E3 .25, A3 .25, - .75`),
  },
  {
    name: 'Sonata K545 (Mozart)', meter: '4/4', bpm: 120, key: 'C',
    rh: seq(`C5 2, E5 1, G5 1, B4 1.5, C5 .25, D5 .25, C5 2, A5 2, G5 1, C6 1, G5 1, F5 .5, E5 .5, F5 1, E5 1`),
    lh: seq(`C4 .5, G4 .5, E4 .5, G4 .5, C4 .5, G4 .5, E4 .5, G4 .5, D4 .5, G4 .5, F4 .5, G4 .5, C4 .5, G4 .5, E4 .5, G4 .5,
             C4 .5, A4 .5, F4 .5, A4 .5, C4 .5, G4 .5, E4 .5, G4 .5, B3 .5, G4 .5, D4 .5, G4 .5, C4 .5, G4 .5, E4 .5, G4 .5`),
  },
  {
    name: 'Moonlight Sonata (Beethoven)', meter: '2/2', bpm: 27, key: 'C#m', triplets: true,
    rh: seq([rep(tri('G#3', 'C#4', 'E4'), 8), rep(tri('A3', 'C#4', 'E4'), 2), rep(tri('A3', 'D4', 'F#4'), 2),
             tri('G#3', 'B#3', 'F#4'), tri('G#3', 'C#4', 'E4'), tri('G#3', 'C#4', 'D#4'), tri('F#3', 'B#3', 'D#4')].join(', ')),
    lh: seq(`[C#2 C#3] 4, [B1 B2] 4, [A1 A2] 2, [F#1 F#2] 2, [G#1 G#2] 4`),
  },
  {
    name: 'Chorale (4 voices)', meter: '4/4', bpm: 80, key: 'G',
    rh: [...seq('B4 1, A4 1, G4 2, A4 1, B4 1, C5 1, B4 1, A4 2, G4 2'),
         ...seq('G4 1, F#4 1, D4 1, E4 1, F#4 1, G4 1, G4 1, G4 1, E4 1, F#4 1, D4 2')],
    lh: [...seq('D4 1, D4 1, B3 2, D4 1, D4 1, E4 1, D4 1, C4 2, B3 2'),
         ...seq('G3 1, D3 1, G3 1, E3 1, D3 1, G3 1, E3 1, G3 1, A3 1, D3 1, G3 2')],
  },
  {
    name: 'Dance in 6/8', meter: '6/8', bpm: 66, key: 'Am',
    rh: seq(`A4 1, C5 .5, D5 .75, E5 .25, D5 .5, C5 1, A4 .5, F4 1, G4 .5, A4 1, G#4 .5, A4 1.5`),
    lh: seq(`A2 .5, E3 .5, A3 .5, A2 .5, E3 .5, A3 .5, F2 .5, C3 .5, F3 .5, G2 .5, D3 .5, G3 .5, A2 1.5, E2 1.5`),
  },
];

function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// -> [{p, t, off, hand}] in ms. Quarter-note length follows the meter's beat (bpm counts beats).
export function perform(song, seed = 1, { jitter = 22, rubato = 0 } = {}) {
  const r = rng(seed), u = (a) => (r() * 2 - 1) * a;
  const beatQ = { '3/8': 0.5, '6/8': 1.5, '9/8': 1.5, '12/8': 1.5, '2/2': 2 }[song.meter] || 1;
  const msQ = 60000 / song.bpm / beatQ;
  // rubato: playing freely, no metronome. Tempo swings +-rubato (period ~6-10 quarters),
  // drifts slowly overall, and the take starts at a random moment.
  const ph = r() * 6.28, per = 6 + r() * 4, drift = u(rubato), lead = rubato ? 500 + r() * 2000 : 0;
  const end = Math.max(...[...song.rh, ...song.lh].map((n) => n.s + n.len)) + 1;
  const T = [0];
  for (let i = 1; i <= end * 100; i++) {
    const q = i / 100, f = 1 + rubato * Math.sin((2 * Math.PI * q) / per + ph) + (drift * q) / end;
    T.push(T[i - 1] + (msQ * f) / 100);
  }
  const at = (q) => lead + T[Math.min(T.length - 1, Math.round(q * 100))];
  const chordShift = new Map(); // same onset in one hand rolls slightly
  const out = [];
  for (const [hand, notes] of [['R', song.rh], ['L', song.lh]]) {
    for (const n of notes) {
      const key = hand + n.s;
      if (!chordShift.has(key)) chordShift.set(key, u(jitter));
      const t = at(n.s) + chordShift.get(key) + u(8);
      const lenMs = at(n.s + n.len) - at(n.s);
      const off = at(n.s) + lenMs * (0.78 + r() * 0.2) + u(jitter);
      out.push({ p: n.p, t, off: Math.max(off, t + 40), hand });
    }
  }
  out.sort((a, b) => a.t - b.t);
  out.quarterTimes = Array.from({ length: Math.floor(end) + 1 }, (_, q) => at(q)); // true beat clock (for tests)
  return out;
}
