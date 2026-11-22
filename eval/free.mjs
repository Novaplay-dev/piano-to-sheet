// Free playing (no metronome): beat tracking + full transcription on real ASAP performances
// WITH their rubato, compared to the annotated beats and the printed score.
//   node eval/free.mjs <asap-dir> [perPiece=1] [--hint=true|80] [--set alpha=..,prior=..]
import { transcribe, trackBeats, FREE } from '../notation.js';
import { load } from './asap-data.js';

const [root, perPieceArg] = process.argv.slice(2);
const hintMode = (process.argv.find((a) => a.startsWith('--hint=')) || '--hint=true').slice(7);
const setI = process.argv.indexOf('--set');
if (setI > 0) for (const kv of process.argv[setI + 1].split(',')) { const [k, v] = kv.split('='); FREE[k] = +v; }
const { items } = load(root, +perPieceArg || 1);
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const T = { n: 0, f: 0, level: { same: 0, double: 0, half: 0, other: 0 }, ioi: 0, ioiN: 0, ioiOct: 0, ioiOracle: 0 };

for (const it of items) {
  const ann = it.beatsMs, annBeat = med(ann.slice(1).map((b, i) => b - ann[i]));
  const hint = hintMode === 'true' ? (60000 / annBeat) * (0.8 + 0.45 * rnd()) : +hintMode;
  // beat F-measure (+-70 ms) against the annotated beats
  const { beats } = trackBeats(it.rawPerf, { bpm: hint });
  const inRange = beats.filter((b) => b >= ann[0] - 100 && b <= ann[ann.length - 1] + 100);
  let hit = 0; const used = new Set();
  for (const b of inRange) { let j = -1, d = 70; ann.forEach((a, i) => { if (!used.has(i) && Math.abs(a - b) <= d) { d = Math.abs(a - b); j = i; } }); if (j >= 0) { used.add(j); hit++; } }
  const P = hit / inRange.length, R = hit / ann.length, F = P + R ? (2 * P * R) / (P + R) : 0;
  const ratio = med(inRange.slice(1).map((b, i) => b - inRange[i])) / annBeat;
  const lv = Math.abs(ratio - 1) < 0.15 ? 'same' : Math.abs(ratio - 0.5) < 0.08 ? 'half' : Math.abs(ratio - 2) < 0.3 ? 'double' : 'other';
  T.level[lv]++; T.f += F; T.n++;
  // rhythm: consecutive score onsets -> are the written distances right?
  const ioiAcc = (res) => {
    const app = new Map(); for (const h of ['rh', 'lh']) for (const n of res[h]) app.set(n.id, n.s);
    const groups = new Map();
    for (const [id, t] of it.match) { const tt = Math.round(t.tick); if (Math.abs(t.tick - tt) > 0.01 || !app.has(id)) continue; if (!groups.has(tt)) groups.set(tt, app.get(id)); }
    const g = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    let ok = 0, oct = 0;
    for (let i = 1; i < g.length; i++) {
      const dt = g[i][0] - g[i - 1][0], ds = g[i][1] - g[i - 1][1];
      if (ds === dt) ok++; else if (ds * 2 === dt || ds === dt * 2) oct++;
    }
    return { ok, oct, n: g.length - 1 };
  };
  const free = ioiAcc(transcribe(it.rawPerf, { free: true, bpm: hint, meter: it.meter }));
  const oracle = ioiAcc(transcribe(it.perf, { bpm: 60, meter: it.meter }));
  T.ioi += free.ok; T.ioiOct += free.oct; T.ioiN += free.n; T.ioiOracle += oracle.ok;
}
const pct = (a, b) => ((100 * a) / b).toFixed(1) + '%';
console.log(`performances: ${T.n}, tempo hint: ${hintMode === 'true' ? 'true tempo x0.8-1.25 (user roughly right)' : hintMode + ' bpm fixed'}`);
console.log(`beat tracking F-measure (+-70ms): ${(T.f / T.n * 100).toFixed(1)}%   tempo level: ${JSON.stringify(T.level)}`);
console.log(`written note distances correct: free playing ${pct(T.ioi, T.ioiN)} (+${pct(T.ioiOct, T.ioiN)} right but at double/half note values)   vs metronome-locked ${pct(T.ioiOracle, T.ioiN)}`);
