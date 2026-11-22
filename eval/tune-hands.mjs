// Random search over HANDS costs on half of the ASAP performances; reports the other half.
//   node eval/tune-hands.mjs <asap-dir> [trials=40]
import { quantize, splitHands, HANDS } from '../notation.js';
import { load } from './asap-data.js';

const [root, trialsArg] = process.argv.slice(2);
const { items } = load(root, 1);
// quantize once; only the hand split is re-run per trial
const sets = items.map((it) => ({ q: quantize(it.perf, { bpm: 60, meter: it.meter }), match: it.match }));
const train = sets.filter((_, i) => i % 2 === 0), test = sets.filter((_, i) => i % 2 === 1);
const score = (group) => {
  let ok = 0, n = 0;
  for (const { q, match } of group) {
    const { lh, rh } = splitHands(q);
    for (const [h, ns] of [['lh', lh], ['rh', rh]]) for (const x of ns) { const t = match.get(x.id); if (t) { n++; if (t.staff === h) ok++; } }
  }
  return ok / n;
};

const base = { ...HANDS };
let best = { ...base }, bestScore = score(train);
console.log(`start: train ${(100 * bestScore).toFixed(2)}%  test ${(100 * score(test)).toFixed(2)}%`);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let t = 0; t < (+trialsArg || 40); t++) {
  const cand = { ...best };
  for (const k of Object.keys(cand)) if (rnd() < 0.35) {
    cand[k] = ['window', 'lhTop', 'rhBottom'].includes(k) ? Math.round(cand[k] + (rnd() - 0.5) * 8) : +(cand[k] * Math.exp((rnd() - 0.5) * 1.2)).toFixed(3);
  }
  Object.assign(HANDS, cand);
  const sc = score(train);
  if (sc > bestScore) { best = cand; bestScore = sc; console.log(`trial ${t}: train ${(100 * sc).toFixed(2)}%`, JSON.stringify(cand)); }
}
Object.assign(HANDS, best);
console.log(`best: train ${(100 * bestScore).toFixed(2)}%  test ${(100 * score(test)).toFixed(2)}%`);
console.log(JSON.stringify(best));
