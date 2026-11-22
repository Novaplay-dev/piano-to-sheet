// Run: node test.mjs        (add --verbose to print every transcription)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METERS, metricPieces, spell, transcribe, quantize, keyName } from './notation.js';
import { SONGS, perform } from './songs.js';

const VERBOSE = process.argv.includes('--verbose');
const m44 = METERS['4/4'], m34 = METERS['3/4'], m68 = METERS['6/8'];
const P = (o, L, m, r) => metricPieces(o * 3, L * 3, m, r).map((x) => x / 3); // in 16ths for readability

// --- meter rules (16ths) ---
assert.deepEqual(P(0, 16, m44), [16]);         // whole note
assert.deepEqual(P(4, 8, m44), [4, 4]);        // half on beat 2 hides bar middle -> tied quarters
assert.deepEqual(P(8, 8, m44), [8]);           // half on beat 3 ok
assert.deepEqual(P(0, 12, m44), [12]);         // dotted half from beat 1
assert.deepEqual(P(0, 6, m44), [6]);           // dotted quarter on the beat
assert.deepEqual(P(2, 4, m44), [2, 2]);        // syncopated quarter across beat -> tied 8ths
assert.deepEqual(P(0, 5, m44), [4, 1]);        // quarter tied 16th
assert.deepEqual(P(0, 10, m44), [8, 2]);
assert.deepEqual(P(1, 2, m44), [2]);           // 16th-8th-16th syncopation inside a beat is fine
assert.deepEqual(P(4, 8, m34), [8]);           // 3/4: half on beat 2 is fine
assert.deepEqual(P(0, 8, m68), [6, 2]);        // 6/8: no half note across the beat
assert.deepEqual(P(0, 12, m68), [12]);         // dotted half fills 6/8
assert.deepEqual(P(4, 12, m44, true), [4, 8]); // rests: quarter rest + half rest on beat 3
assert.deepEqual(P(0, 12, m44, true), [8, 4]); // rests never dotted-half
assert.deepEqual(P(2, 6, m44, true), [2, 4]);
assert.deepEqual(P(0, 12, m34, true), [12]);   // full-bar rest
assert.deepEqual(metricPieces(4, 8, m44), [8]);   // triplet quarter on 2nd triplet 8th
assert.deepEqual(metricPieces(8, 8, m44), [4, 4]); // triplet value can't cross the beat

// --- spelling ---
assert.deepEqual(spell(66, 1), { l: 'F', acc: 1, octave: 4 });   // F# in G
assert.deepEqual(spell(70, 0), { l: 'B', acc: -1, octave: 4 });  // Bb in C
assert.deepEqual(spell(61, 0), { l: 'C', acc: 1, octave: 4 });   // C# in C
assert.deepEqual(spell(71, -1), { l: 'B', acc: 0, octave: 4 });  // B natural in F
assert.deepEqual(spell(65, 6), { l: 'E', acc: 1, octave: 4 });   // E# in F#
assert.deepEqual(spell(60, 6), { l: 'C', acc: 0, octave: 4 });   // C natural in F# major
assert.deepEqual(spell(63, -3), { l: 'E', acc: -1, octave: 4 }); // Eb in Eb
assert.deepEqual(spell(60, 4, true), { l: 'B', acc: 1, octave: 3 }); // B# leading tone in C# minor
assert.deepEqual(spell(68, 0, true), { l: 'G', acc: 1, octave: 4 }); // G# in A minor
assert.deepEqual(spell(67, 5, true), { l: 'F', acc: 2, octave: 4 }); // F## in G# minor

const voiceLine = (abc, v) => abc.split('\n').filter((l) => l.startsWith(`[V:${v}]`)).join(' ');
const bpm = 120, q = 500;
const N = (p, beat, len = 1, jitter = 0) => ({ p, t: beat * q + jitter, off: (beat + len) * q - 30 });
const C = { fifths: 0, minor: false };

// --- accidentals carry through the bar, reset at the barline ---
{
  const { abc } = transcribe([N(66, 0), N(66, 1), N(65, 2), N(72, 3), N(66, 4, 4), N(48, 0, 4), N(48, 4, 4)], { bpm, key: C });
  assert.match(voiceLine(abc, 'RH'), /\^F12 F12 =F12 c12 \| \^F48 \|\]/);
}
// --- tie over barline: no accidental on continuation; later same note in bar gets one again ---
{
  const { abc } = transcribe([N(48, 0, 8), N(60, 0, 3), N(66, 3, 2), N(66, 5, 1), N(67, 6, 1), N(72, 7, 1)], { bpm, key: C });
  assert.match(voiceLine(abc, 'RH'), /\^F12- \| F12 \^F12 G12 c12/);
}
// --- early release snaps to the beat; 8ths beam in fours; long chromatic note can't flip the key ---
{
  const ev = [];
  [60, 62, 64, 65, 67, 69, 71, 72].forEach((p, i) => ev.push({ p, t: i * 250, off: i * 250 + 200 }));
  ev.push({ p: 74, t: 2000, off: 2950 }, { p: 73, t: 3000, off: 3950 });
  ev.push(...[48, 52, 55].map((p) => ({ p, t: 0, off: 1950 })), ...[43, 50].map((p) => ({ p, t: 2000, off: 3950 })));
  const { abc, key } = transcribe(ev, { bpm });
  assert.deepEqual(key, C);
  assert.match(voiceLine(abc, 'RH'), /C6D6E6F6 G6A6B6c6 \| d24 \^c24 \|\]/);
  assert.match(voiceLine(abc, 'LH'), /\[C,E,G,\]48 \| \[G,,D,\]48 \|\]/);
}
// --- straight 16ths are not mistaken for triplets, real triplets are found ---
{
  const sixteenths = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ p: 60 + i, t: i * 125 + (i % 2 ? 20 : -15), off: i * 125 + 110 }));
  assert.ok(quantize(sixteenths, { bpm, meter: '4/4' }).every((n) => n.s % 3 === 0));
  const trip = [0, 1, 2, 3, 4, 5].map((i) => ({ p: 60 + i, t: i * 166.7 + (i % 2 ? 18 : -18), off: i * 166.7 + 150 }));
  assert.deepEqual(quantize(trip, { bpm, meter: '4/4' }).map((n) => n.s), [0, 4, 8, 12, 16, 20]);
}

// --- abcjs: parse without warnings, every bar (and each overlay voice) exactly full ---
globalThis.window = globalThis;
const mod = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('./vendor/abcjs-basic-min.js', import.meta.url), 'utf8'))(mod, mod.exports);
const ABCJS = mod.exports;
function checkAbc(abc, meter, label) {
  const [tune] = ABCJS.parseOnly(abc);
  assert.equal(tune.warnings, undefined, `${label}: abcjs warnings ${tune.warnings}\n${abc}`);
  const bar = METERS[meter].bar;
  for (const line of abc.split('\n').filter((l) => l.startsWith('[V:'))) {
    for (const b of line.slice(6).replace('|]', '').split('|').filter((x) => x.trim())) {
      for (const voice of b.split('&')) {
        let total = 0, tripLeft = 0;
        const re = /\(3:2:(\d+)|(\[[^\]]*\]|[_=^]*[A-Ga-gzx][,']*)(\d*)/g;
        for (const x of voice.matchAll(re)) {
          if (x[1]) { tripLeft = +x[1]; continue; }
          let d = Number(x[3] || 1);
          if (tripLeft > 0) { d = (d * 2) / 3; tripLeft--; }
          total += d;
        }
        assert.equal(total, bar, `${label} bar "${voice}"\n${abc}`);
      }
    }
  }
}

// --- round trip on real pieces: score -> humanized performance -> transcription ---
// Checks every note lands in the right hand, at the right time, with the right written length.
const SEEDS = 25;
for (const song of SONGS) {
  let notes = 0, handOk = 0, onsetOk = 0, lenOk = 0, keyOk = 0;
  const truth = new Map();
  for (const [h, ns] of [['rh', song.rh], ['lh', song.lh]])
    for (const n of ns) truth.set(`${n.p}@${Math.round(n.s * 12)}`, { h, len: Math.round(n.len * 12) });
  for (let seed = 1; seed <= SEEDS; seed++) {
    const perf = perform(song, seed);
    const r = transcribe(perf, { bpm: song.bpm, meter: song.meter, barsPerLine: 4 });
    if (keyName(r.key) === song.key) keyOk++;
    checkAbc(r.abc, song.meter, `${song.name} seed ${seed}`);
    for (const h of ['rh', 'lh'])
      for (const n of r[h]) {
        notes++;
        const t = truth.get(`${n.p}@${n.s}`);
        if (!t) { if (VERBOSE) console.log(`  ${song.name} #${seed}: off-grid ${n.p}@${n.s}`); continue; }
        onsetOk++;
        if (t.h === h) handOk++; else if (VERBOSE) console.log(`  ${song.name} #${seed}: ${n.p}@${n.s} in ${h}, should be ${t.h}`);
        const written = r.voices[h].flat().find((c) => c.s === n.s && c.pitches.includes(n.p));
        if (written && written.e - written.s === t.len) lenOk++;
        else if (VERBOSE) console.log(`  ${song.name} #${seed}: ${n.p}@${n.s} len ${written && written.e - written.s}, should be ${t.len}`);
      }
    if (VERBOSE && seed === 1) console.log(r.abc);
  }
  const pct = (x) => ((100 * x) / notes).toFixed(1) + '%';
  console.log(`${song.name.padEnd(30)} hands ${pct(handOk)}  onsets ${pct(onsetOk)}  lengths ${pct(lenOk)}  key ${keyOk}/${SEEDS}`);
  song.result = { hand: handOk / notes, onset: onsetOk / notes, len: lenOk / notes, key: keyOk / SEEDS };
}
// --- engraving details on the real pieces ---
{
  const abcOf = (name) => {
    const s = SONGS.find((x) => x.name.startsWith(name));
    return transcribe(perform(s, 1), { bpm: s.bpm, meter: s.meter, barsPerLine: 99 }).abc;
  };
  const elise = voiceLine(abcOf('Für Elise'), 'RH');
  assert.match(elise, /e3\^d3e3B3=d3c3 \| A6 z3 C3E3A3 \|/); // 3/8 beams the bar, natural cancels D#, rests break beams
  const moon = abcOf('Moonlight');
  assert.match(moon, /K:C#m/);
  assert.match(voiceLine(moon, 'RH'), /^\[V:RH\] \(3:2:3G,6C6E6 \(3:2:3G,6C6E6/); // triplets
  assert.match(voiceLine(moon, 'RH'), /\^B,6/);                                   // B# leading tone
  const chorale = abcOf('Chorale');
  assert.match(voiceLine(chorale, 'RH'), /x24 G24 & \[GB\]12 \[FA\]12 D12 E12/); // held S over moving alto
}

for (const s of SONGS) {
  assert.equal(s.result.hand, 1, `${s.name}: hand separation`);
  assert.equal(s.result.onset, 1, `${s.name}: rhythm (onsets)`);
  assert.equal(s.result.len, 1, `${s.name}: note lengths`);
  assert.equal(s.result.key, 1, `${s.name}: key`);
}

console.log('all tests passed');
