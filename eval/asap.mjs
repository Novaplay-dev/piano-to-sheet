// Evaluate the engine on real human performances from the ASAP dataset.
//   node eval/asap.mjs <asap-dir> [performances-per-piece=1] [--worst] [--diag] [--fast] [--set k=v,...]
//   (--set overrides TRIPLET / HANDS costs, e.g. --set switch=8,dist=.5)
import { transcribe, TRIPLET, HANDS } from '../notation.js';
import { abcProblem } from './abccheck.js';
import { load } from './asap-data.js';

const [root, perPieceArg] = process.argv.slice(2);
const flag = (f) => process.argv.includes(f);
const FAST = flag('--fast'); // skip baseline + notation check
if (flag('--set')) for (const kv of process.argv[process.argv.indexOf('--set') + 1].split(',')) {
  const [k, v] = kv.split('=');
  (k in TRIPLET ? TRIPLET : HANDS)[k] = +v;
}

const { items, skipped } = load(root, +perPieceArg || 1);
const tot = { n: 0, notes: 0, matched: 0, hand: 0, fixed: 0, onsetN: 0, onset: 0, keyN: 0, key: 0, abcBad: 0 };
const rows = [], diff = {}, trip = { tp: 0, fn: 0, fp: 0, tn: 0 }, handErr = {};

for (const it of items) {
  const { meter, perf, match } = it;
  const r = transcribe(perf, { bpm: 60, meter, barsPerLine: 4, triplets: true });
  const fx = FAST ? r : transcribe(perf, { bpm: 60, meter, hands: 'fixed', splitPoint: 60, barsPerLine: 4, triplets: true });
  const handOf = (res) => { const h = new Map(); for (const x of ['rh', 'lh']) for (const n of res[x]) h.set(n.id, { h: x, s: n.s }); return h; };
  const app = handOf(r), fix = handOf(fx);
  let matched = 0, hand = 0, fixed = 0, onsetN = 0, onset = 0;
  const beats = new Map();
  for (const [id, t] of match) {
    const a = app.get(id);
    if (!a) continue; // dropped (before bar 0)
    matched++;
    if (a.h === t.staff) hand++;
    else { const k = `${t.staff} ${t.p < 48 ? '<C3' : t.p < 60 ? 'C3-B3' : t.p < 72 ? 'C4-B4' : '>=C5'}`; handErr[k] = (handErr[k] || 0) + 1; }
    if (fix.get(id).h === t.staff) fixed++;
    const tt = Math.round(t.tick);
    if (Math.abs(t.tick - tt) < 0.01 && (tt % 3 === 0 || tt % 4 === 0)) {
      onsetN++;
      if (a.s === tt) onset++;
      else { const k = `${tt % 12}->${((a.s - tt) % 12 + 12) % 12}`; diff[k] = (diff[k] || 0) + 1; }
      const b = Math.floor(tt / 12);
      if (!beats.has(b)) beats.set(b, { t: new Set(), app: false });
      beats.get(b).t.add(tt % 12);
    }
  }
  if (!['3/8', '6/8', '9/8', '12/8'].includes(meter)) {
    for (const n of [...r.rh, ...r.lh]) { const b = beats.get(Math.floor(n.s / 12)); if (b && n.s % 3) b.app = true; }
    for (const b of beats.values()) {
      const ps = [...b.t];
      if (!ps.some((x) => x)) continue;
      if (ps.every((x) => x % 4 === 0)) trip[b.app ? 'tp' : 'fn']++;
      else if (ps.every((x) => x % 3 === 0)) trip[b.app ? 'fp' : 'tn']++;
    }
  }
  const prob = FAST ? null : abcProblem(r.abc, meter);
  if (prob) tot.abcBad++;
  let keyOk = null;
  if (it.key !== null) { tot.keyN++; keyOk = r.key.fifths === it.key; if (keyOk) tot.key++; }
  Object.assign(tot, { n: tot.n + 1, notes: tot.notes + perf.length, matched: tot.matched + matched, hand: tot.hand + hand, fixed: tot.fixed + fixed, onsetN: tot.onsetN + onsetN, onset: tot.onset + onset });
  rows.push({ name: it.name, meter, n: matched, ratio: matched / perf.length, hand, fixed, onset, onsetN, keyOk, prob });
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
if (flag('--worst'))
  for (const r of [...rows].sort((a, b) => a.hand / a.n - b.hand / b.n).slice(0, 15))
    console.log(`${r.name.padEnd(60)} ${r.meter.padEnd(5)} notes ${String(r.n).padStart(5)}  staff ${pct(r.hand, r.n)}  (C4 split ${pct(r.fixed, r.n)})  onsets ${pct(r.onset, r.onsetN)}  key ${r.keyOk}${r.prob ? '  ABC: ' + r.prob : ''}`);
if (flag('--diag')) {
  console.log('onset errors "true position in beat -> app offset" (12 = quarter):');
  console.log(Object.entries(diff).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}: ${v}`).join('   '));
  console.log('triplet beats found', trip.tp, 'missed', trip.fn, '| straight beats wrongly made triplet', trip.fp, 'of', trip.fp + trip.tn);
  console.log('wrong-staff notes by (true staff, register):', JSON.stringify(handErr));
}
const good = rows.filter((r) => r.ratio >= 0.8), sum = (k) => good.reduce((s, r) => s + r[k], 0);
console.log(`\nperformances evaluated: ${tot.n}   skipped: ${JSON.stringify(skipped)}`);
console.log(`notes played: ${tot.notes}, matched to the printed score: ${tot.matched}`);
console.log(`correct staff (left/right hand), app:         ${pct(tot.hand, tot.matched)}`);
console.log(`correct staff, naive split at middle C:        ${pct(tot.fixed, tot.matched)}`);
console.log(`onset on the right 16th/triplet position:      ${pct(tot.onset, tot.onsetN)}  (of ${tot.onsetN} notes on that grid)`);
console.log(`key signature = the printed one:               ${pct(tot.key, tot.keyN)}  (${tot.keyN} pieces without key changes)`);
console.log(`sheets with any notation error (abcjs / bar):  ${tot.abcBad} of ${tot.n}`);
console.log(`well-aligned performances (>=80% matched): ${good.length}: staff app ${pct(sum('hand'), sum('n'))} vs C4 split ${pct(sum('fixed'), sum('n'))}, onsets ${pct(sum('onset'), sum('onsetN'))}`);
