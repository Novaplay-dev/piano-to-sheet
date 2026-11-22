// Run: node test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METERS, metricPieces, spell, transcribe, splitHands, quantize, detectKey } from './notation.js';

const m44 = METERS['4/4'], m34 = METERS['3/4'], m68 = METERS['6/8'];
const P = (o, L, m, r) => metricPieces(o, L, m, r);

// --- meter rules (16ths) ---
assert.deepEqual(P(0, 16, m44), [16]);        // whole note
assert.deepEqual(P(4, 8, m44), [4, 4]);       // half on beat 2 hides bar middle -> tied quarters
assert.deepEqual(P(8, 8, m44), [8]);          // half on beat 3 ok
assert.deepEqual(P(0, 12, m44), [12]);        // dotted half from beat 1
assert.deepEqual(P(0, 6, m44), [6]);          // dotted quarter on the beat
assert.deepEqual(P(2, 4, m44), [2, 2]);       // syncopated quarter across beat -> tied 8ths
assert.deepEqual(P(0, 5, m44), [4, 1]);       // quarter tied 16th
assert.deepEqual(P(0, 10, m44), [8, 2]);
assert.deepEqual(P(1, 2, m44), [2]);          // 16th-8th-16th syncopation inside a beat is fine
assert.deepEqual(P(1, 3, m44), [3]);          // 16th + dotted 8th
assert.deepEqual(P(4, 8, m34), [8]);          // 3/4: half on beat 2 is fine
assert.deepEqual(P(0, 8, m68), [6, 2]);       // 6/8: no half note across the beat
assert.deepEqual(P(0, 12, m68), [12]);        // dotted half fills 6/8
assert.deepEqual(P(4, 12, m44, true), [4, 8]); // rests: quarter rest + half rest on beat 3
assert.deepEqual(P(0, 12, m44, true), [8, 4]); // rests never dotted-half
assert.deepEqual(P(2, 6, m44, true), [2, 4]);
assert.deepEqual(P(0, 12, m34, true), [12]);   // full-bar rest

// --- spelling ---
assert.deepEqual(spell(66, 1), { l: 'F', acc: 1, octave: 4 });   // F# in G
assert.deepEqual(spell(70, 0), { l: 'B', acc: -1, octave: 4 });  // Bb in C
assert.deepEqual(spell(61, 0), { l: 'C', acc: 1, octave: 4 });   // C# in C
assert.deepEqual(spell(71, -1), { l: 'B', acc: 0, octave: 4 });  // B natural in F
assert.deepEqual(spell(65, 6), { l: 'E', acc: 1, octave: 4 });   // E# in F#
assert.deepEqual(spell(60, 6), { l: 'C', acc: 0, octave: 4 });   // C natural in F# (not B#)
assert.deepEqual(spell(63, -3), { l: 'E', acc: -1, octave: 4 }); // Eb in Eb

// --- helpers to fake a performance ---
const bpm = 120, q = 500; // ms per quarter
const N = (p, beat, len = 1, jitter = 0) => ({ p, t: beat * q + jitter, off: (beat + len) * q - 30 });

// --- accidentals carry through the bar, reset at the barline ---
{
  const notes = [N(66, 0), N(66, 1), N(65, 2), N(72, 3), N(66, 4, 4), N(48, 0, 4), N(48, 4, 4)];
  const { abc } = transcribe(notes, { bpm, meter: '4/4', key: { fifths: 0, minor: false } });
  const rh = abc.split('\n').find((l) => l.startsWith('[V:RH]'));
  assert.match(rh, /\^F4 F4 =F4 c4 \| \^F16 \|\]/, rh);
}

// --- tie over barline: no accidental on continuation; later same note in bar gets one ---
{
  const notes = [N(48, 0, 8), N(60, 0, 3), N(66, 3, 2), N(66, 5, 1), N(67, 6, 1), N(72, 7, 1)];
  const { abc } = transcribe(notes, { bpm, meter: '4/4', key: { fifths: 0, minor: false } });
  const rh = abc.split('\n').find((l) => l.startsWith('[V:RH]'));
  assert.match(rh, /\^F4- \| F4 \^F4 G4 c4/, rh);
}

// --- hand separation ---
{
  // LH: C3-E3-G3 block chords; RH: scale running C5 down to A3 (crosses middle C) and back
  const run = [72, 71, 69, 67, 65, 64, 62, 60, 59, 57, 59, 60, 62, 64, 65, 67];
  const notes = [];
  run.forEach((p, i) => notes.push(N(p, i / 2, 0.5, (i % 3) * 12)));
  for (let b = 0; b < 8; b += 2) for (const p of [48, 52, 55]) notes.push(N(p, b, 2, -8));
  const qn = quantize(notes, { bpm, meter: '4/4' });
  const { lh, rh } = splitHands(qn);
  assert.deepEqual(rh.map((n) => n.p), run, 'RH keeps the whole run incl. notes below middle C');
  assert.equal(lh.length, 12);
  assert.ok(lh.every((n) => n.p <= 55));

  // Wide LH stride (C2 bass then chord) while RH holds melody
  const s2 = [N(36, 0), N(52, 1), N(55, 1), N(60, 1), N(36, 2), N(52, 3), N(55, 3), N(60, 3), N(76, 0, 2), N(79, 2, 2)];
  const r2 = splitHands(quantize(s2, { bpm, meter: '4/4' }));
  assert.deepEqual(r2.rh.map((n) => n.p).sort(), [76, 79]);
}

// --- key detection ---
{
  const gmaj = [67, 71, 74, 66, 69, 72, 67, 62, 59, 55].map((p, i) => N(p, i));
  assert.deepEqual(detectKey(quantize(gmaj, { bpm, meter: '4/4' })), { fifths: 1, minor: false });
}

// --- abcjs parses the output without warnings ---
{
  globalThis.window = globalThis;
  const mod = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('./vendor/abcjs-basic-min.js', import.meta.url), 'utf8'))(mod, mod.exports);
  const ABCJS = mod.exports;
  const notes = [];
  for (let b = 0; b < 12; b++) { notes.push(N(60 + (b * 5) % 12, b, 1, 15)); if (b % 2 === 0) notes.push(N(43, b, 2)); }
  notes.push(N(61, 12.5, 2.5));
  for (const meter of ['4/4', '3/4', '6/8', '2/4']) {
    const { abc } = transcribe(notes, { bpm, meter });
    const [tune] = ABCJS.parseOnly(abc);
    assert.equal(tune.warnings, undefined, meter + '\n' + abc + '\n' + tune.warnings);
    // every bar has exactly a full measure of duration in both voices
    const bar = METERS[meter].bar;
    for (const line of abc.split('\n').filter((l) => l.startsWith('[V:'))) {
      for (const b of line.slice(6).replace('|]', '').split('|').filter((x) => x.trim())) {
        const total = [...b.matchAll(/(\[[^\]]*\]|[_=^]*[A-Ga-gz][,']*)(\d*)/g)].reduce((s, x) => s + Number(x[2] || 1), 0);
        assert.equal(total, bar, `${meter} bar "${b}"`);
      }
    }
  }
}

// --- early release before a rest snaps to the beat; 8ths beam in fours; long chromatic note can't flip key ---
{
  const ev = [];
  [60, 62, 64, 65, 67, 69, 71, 72].forEach((p, i) => ev.push({ p, t: i * 250, off: i * 250 + 200 }));
  ev.push({ p: 74, t: 2000, off: 2950 }, { p: 73, t: 3000, off: 3950 });
  ev.push(...[48, 52, 55].map((p) => ({ p, t: 0, off: 1950 })), ...[43, 50].map((p) => ({ p, t: 2000, off: 3950 })));
  const { abc, key } = transcribe(ev, { bpm, meter: '4/4' });
  assert.deepEqual(key, { fifths: 0, minor: false });
  const [rh, lh] = abc.split('\n').filter((l) => l.startsWith('[V:'));
  assert.match(rh, /\[V:RH\] C2D2E2F2 G2A2B2c2 \| d8 \^c8 \|\]/, rh);
  assert.match(lh, /\[V:LH\] \[C,E,G,\]16 \| \[G,,D,\]16 \|\]/, lh);
}

console.log('all tests passed');
