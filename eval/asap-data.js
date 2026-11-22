// Loads ASAP performances (https://github.com/fosfrancesco/asap-dataset) for evaluation.
// Each performance's tempo swings are removed via its annotated beats (the app records
// against a metronome); timing inside a beat stays exactly as the pianist played it.
// Every performed note is matched to a printed-score note (same pitch, <= 1/4 beat away),
// which gives its true staff (score MIDI track 0 = upper, 1 = lower) and true position.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMidi } from './midi.js';
import { METERS } from '../notation.js';

const ann = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => {
  const [t, , lab] = l.split('\t');
  const [kind, ts, key] = lab.split(',');
  return { t: +t, kind, ts, key };
});
function* pieceDirs(d) {
  if (existsSync(join(d, 'midi_score.mid'))) yield d;
  for (const f of readdirSync(d).sort()) if (statSync(join(d, f)).isDirectory()) yield* pieceDirs(join(d, f));
}
// seconds -> fractional beat index, piecewise linear between annotated beats
const beatPos = (times) => (x) => {
  let lo = 0, hi = times.length - 1;
  if (x <= times[0]) return (x - times[0]) / (times[1] - times[0]);
  if (x >= times[hi]) return hi + (x - times[hi]) / (times[hi] - times[hi - 1]);
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= x) lo = mid; else hi = mid; }
  return lo + (x - times[lo]) / (times[lo + 1] - times[lo]);
};

export const MS_PER_BEAT = 1000; // simulated metronome at 60 bpm; only ratios matter

// -> { items: [{name, meter, key|null, perf: [{id,p,t,off}], match: Map(id -> {staff, tick})}], skipped }
export function load(root, perPiece = 1) {
  const items = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const dir of pieceDirs(root)) {
    const sa = ann(join(dir, 'midi_score_annotations.txt'));
    const tss = [...new Set(sa.map((a) => a.ts).filter(Boolean))];
    if (tss.length !== 1 || !METERS[tss[0]]) { skip(tss.length > 1 ? 'time signature changes' : `meter ${tss[0]} not supported`); continue; }
    const meter = tss[0], m = METERS[meter];
    const keys = [...new Set(sa.map((a) => a.key).filter((k) => k !== undefined && k !== ''))];
    const dbs = sa.map((a, i) => (a.kind === 'db' ? i : -1)).filter((i) => i >= 0);
    const gaps = dbs.slice(1).map((d, i) => d - dbs[i]).sort((a, b) => a - b);
    const bpb = gaps[gaps.length >> 1];
    if (m.bar % bpb) { skip('beat grid'); continue; }
    const tpb = m.bar / bpb, first = dbs[0];
    const toTick = (bi) => (bi - first) * tpb + m.bar; // bar 0 holds any pickup

    const score = readMidi(readFileSync(join(dir, 'midi_score.mid')));
    const tracks = [...new Set(score.map((n) => n.track))].sort();
    if (tracks.length !== 2) { skip('score not 2 staves'); continue; }
    const sPos = beatPos(sa.map((a) => a.t));
    const truth = score.map((n) => ({ p: n.p, b: sPos(n.t), staff: n.track === tracks[0] ? 'rh' : 'lh', tick: toTick(sPos(n.t)) }));
    const byPitch = new Map();
    truth.forEach((t, i) => { if (!byPitch.has(t.p)) byPitch.set(t.p, []); byPitch.get(t.p).push(i); });

    const perfs = readdirSync(dir).filter((f) => f.endsWith('.mid') && f !== 'midi_score.mid' && existsSync(join(dir, f.replace('.mid', '_annotations.txt')))).sort().slice(0, perPiece);
    for (const pf of perfs) {
      const pa = ann(join(dir, pf.replace('.mid', '_annotations.txt')));
      if (pa.length !== sa.length) { skip('annotation mismatch'); continue; }
      const pPos = beatPos(pa.map((a) => a.t));
      const msPerTick = MS_PER_BEAT / m.beat;
      const perf = readMidi(readFileSync(join(dir, pf))).map((n, id) => ({
        id, p: n.p, b: pPos(n.t), t: toTick(pPos(n.t)) * msPerTick, off: toTick(pPos(n.off)) * msPerTick,
      }));
      const used = new Set(), match = new Map();
      for (const n of perf) {
        let best = -1, bd = 0.25;
        for (const i of byPitch.get(n.p) || []) { const d = Math.abs(truth[i].b - n.b); if (d < bd && !used.has(i)) { bd = d; best = i; } }
        if (best >= 0) { used.add(best); match.set(n.id, truth[best]); }
      }
      items.push({ name: dir.slice(root.length + 1) + '/' + pf, meter, key: keys.length === 1 ? +keys[0] : null, perf, match });
    }
  }
  return { items, skipped };
}
