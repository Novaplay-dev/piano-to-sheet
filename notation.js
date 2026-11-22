// MIDI performance -> engraved piano score (ABC notation, rendered by abcjs).
// Time unit inside the engine: one tick = one 16th note (ABC L:1/16).

export const METERS = {
  '4/4': { bar: 16, beat: 4, strong: [8], q: '1/4' },
  '3/4': { bar: 12, beat: 4, strong: [], q: '1/4' },
  '2/4': { bar: 8, beat: 4, strong: [], q: '1/4' },
  '6/8': { bar: 12, beat: 6, strong: [], q: '3/8', compound: true },
};

// Plain + dotted values in 16ths: 16th, 8th, dotted 8th, quarter, dotted quarter, half, dotted half, whole.
const REP = [1, 2, 3, 4, 6, 8, 12, 16];

// ---------- 1. quantize ----------
// notes: [{p: midi pitch, t: onset ms, off: release ms}] with t=0 at the downbeat of bar 1.
export function quantize(notes, { bpm, meter, grid = 1 }) {
  const m = METERS[meter];
  const msPerTick = 60000 / bpm / m.beat;
  const r = (ms) => Math.round(ms / msPerTick / grid) * grid;
  return notes
    .map((n) => {
      const s = r(n.t);
      return { p: n.p, s, e: Math.max(r(n.off), s + grid) };
    })
    .filter((n) => n.s >= 0)
    .sort((a, b) => a.s - b.s || a.p - b.p);
}

// ---------- 2. left / right hand ----------
// Auto mode walks the piece in onset order and, for every chord/onset group, tries every
// "lowest k notes -> LH, rest -> RH" split. Cost = each note's distance from its hand's recent position
// + penalties for impossible stretches (> 14 semitones incl. notes still held), >5 notes per
// hand, hands crossing, and a mild pull toward the middle-C convention.
// ponytail: greedy per onset, no lookahead; a Viterbi over whole phrases would fix rare flips.
export function splitHands(qnotes, { mode = 'auto', splitPoint = 60 } = {}) {
  if (mode === 'fixed') {
    return {
      lh: qnotes.filter((n) => n.p < splitPoint),
      rh: qnotes.filter((n) => n.p >= splitPoint),
    };
  }
  const hand = () => ({ pos: null, notes: [] });
  const L = hand(), R = hand();
  L.pos = 48; R.pos = 72;
  const mean = (a) => a.reduce((x, n) => x + n.p, 0) / a.length;
  const span = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

  for (const g of groupBy(qnotes, (n) => n.s)) {
    const s = g[0].s;
    const heldL = L.notes.filter((n) => n.e > s).map((n) => n.p);
    const heldR = R.notes.filter((n) => n.e > s).map((n) => n.p);
    let best = null;
    for (let k = 0; k <= g.length; k++) {
      const l = g.slice(0, k), r = g.slice(k);
      if (l.length > 5 || r.length > 5) continue;
      let c = 0;
      const sl = span([...l.map((n) => n.p), ...heldL]);
      const sr = span([...r.map((n) => n.p), ...heldR]);
      if (sl > 14) c += (sl - 14) * 10;
      if (sr > 14) c += (sr - 14) * 10;
      if (l.length) {
        for (const n of l) c += Math.abs(n.p - L.pos);
        if (heldR.length && Math.max(...l.map((n) => n.p)) > Math.min(...heldR)) c += 20;
        for (const n of l) if (n.p > 64) c += (n.p - 64) * 0.3;
      }
      if (r.length) {
        for (const n of r) c += Math.abs(n.p - R.pos);
        if (heldL.length && Math.min(...r.map((n) => n.p)) < Math.max(...heldL)) c += 20;
        for (const n of r) if (n.p < 55) c += (55 - n.p) * 0.3;
      }
      if (!best || c < best.c) best = { c, l, r };
    }
    if (best.l.length) { L.notes.push(...best.l); L.pos = (L.pos + mean(best.l)) / 2; }
    if (best.r.length) { R.notes.push(...best.r); R.pos = (R.pos + mean(best.r)) / 2; }
  }
  return { lh: L.notes, rh: R.notes };
}

// ---------- 3. one voice per hand: chords + rests ----------
// ponytail: one voice per staff; a note held under moving notes in the same hand is cut at
// the next onset. Add a second voice per staff if polyphonic writing within a hand is needed.
export function toVoice(notes, grid = 1, beat = 4) {
  const chords = groupBy(notes, (n) => n.s).map((g) => ({
    s: g[0].s,
    e: Math.max(...g.map((n) => n.e)),
    pitches: [...new Set(g.map((n) => n.p))].sort((a, b) => a - b),
  }));
  chords.forEach((c, i) => {
    const next = i + 1 < chords.length ? chords[i + 1].s : Infinity, ioi = next - c.s;
    if (c.e > next) c.e = next;
    // Close small release gaps (sloppy legato) instead of writing tiny rests.
    const gap = next - c.e;
    if (next < Infinity && gap > 0 && (gap <= grid || gap * 4 <= ioi)) c.e = next;
    // Players release early/late: a note that ends before a rest snaps to the nearest beat.
    if (c.e < next) {
      const b = Math.round(c.e / beat) * beat;
      if (b > c.s && b <= next && Math.abs(b - c.e) <= Math.max(grid, (c.e - c.s) / 4)) c.e = b;
    }
  });
  return chords;
}

// ---------- 4. meter rules: bars, ties, beat grouping ----------
const crosses = (o, end, b) => b > o && b < end;

function noteOk(o, L, m) {
  if (!REP.includes(L)) return false;
  const end = o + L;
  let beatCross = false;
  for (let b = m.beat; b < m.bar; b += m.beat) if (crosses(o, end, b)) beatCross = true;
  if (!beatCross) return true;
  // A note may span beats only when it starts on a beat, does not hide the middle of a
  // 4/4 bar (unless it starts the bar), and in compound time lasts whole beats.
  if (o % m.beat) return false;
  if (o !== 0 && m.strong.some((b) => crosses(o, end, b))) return false;
  if (m.compound && L % m.beat) return false;
  return true;
}

function restOk(o, L, m) {
  if (o === 0 && L === m.bar) return true; // whole-bar rest
  if (!REP.includes(L)) return false;
  if (m.strong.length && L === m.strong[0] && o % L === 0) return true; // half rest on beat 1 or 3
  return Math.floor(o / m.beat) === Math.floor((o + L - 1) / m.beat); // otherwise stay in one beat
}

// Split [o, o+L) inside one bar into legal written values (to be tied for notes).
export function metricPieces(o, L, m, rest = false) {
  if (L <= 0) return [];
  if ((rest ? restOk : noteOk)(o, L, m)) return [L];
  const end = o + L;
  let b = m.strong.find((x) => crosses(o, end, x));
  if (b === undefined) {
    const nb = (Math.floor(o / m.beat) + 1) * m.beat;
    if (nb < end) b = nb;
  }
  if (b === undefined) {
    // Inside one beat: split at the sub-beat (8th) grid first, else largest value that fits.
    const nh = (Math.floor(o / 2) + 1) * 2;
    b = nh < end && o % 2 ? nh : o + Math.max(...REP.filter((v) => v < L));
  }
  return [...metricPieces(o, b - o, m, rest), ...metricPieces(b, end - b, m, rest)];
}

// Voice chords -> bars of events {o, L, pitches|null, tie}
export function toBars(chords, m, nBars) {
  const bars = Array.from({ length: nBars }, () => []);
  // cont = this piece continues a tie (not the first written piece of the note)
  const push = (s, e, pitches) => {
    let first = true;
    while (s < e) {
      const bi = Math.floor(s / m.bar), o = s - bi * m.bar;
      const segEnd = Math.min(e, (bi + 1) * m.bar);
      const pcs = metricPieces(o, segEnd - s, m, !pitches);
      let off = o;
      pcs.forEach((L, i) => {
        const last = i === pcs.length - 1 && segEnd === e;
        bars[bi].push({ o: off, L, pitches, tie: !!pitches && !last, cont: !!pitches && !first });
        first = false;
        off += L;
      });
      s = segEnd;
    }
  };
  let t = 0;
  for (const c of chords) {
    if (c.s > t) push(t, c.s, null);
    push(c.s, c.e, c.pitches);
    t = c.e;
  }
  if (t < nBars * m.bar) push(t, nBars * m.bar, null);
  return bars;
}

// ---------- 5. key + spelling ----------
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJ_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MIN_NAMES = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];

// Key signature = the one that needs the fewest written accidentals (counted per attack);
// ties and major-vs-relative-minor are decided by Krumhansl-Schmuckler profile correlation.
export function detectKey(qnotes) {
  const h = new Array(12).fill(0), attacks = new Array(12).fill(0);
  for (const n of qnotes) { h[n.p % 12] += 1 + Math.min(n.e - n.s, 8) / 4; attacks[n.p % 12]++; }
  const corr = (prof, t) => {
    const y = prof.map((_, i) => prof[(i - t + 12) % 12]);
    const mx = avg(h), my = avg(y);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) { num += (h[i] - mx) * (y[i] - my); dx += (h[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  let best = null;
  for (let f = -6; f <= 6; f++) {
    const tonic = (f * 7 + 120) % 12; // major tonic pc
    const scale = [0, 2, 4, 5, 7, 9, 11].map((i) => (tonic + i) % 12);
    const acc = attacks.reduce((s, c, pc) => s + (scale.includes(pc) ? 0 : c), 0);
    const maj = corr(MAJ, tonic), min = corr(MIN, (tonic + 9) % 12);
    const cand = { acc, r: Math.max(maj, min), fifths: f, minor: min > maj };
    if (!best || acc < best.acc || (acc === best.acc && cand.r > best.r)) best = cand;
  }
  return { fifths: best.fifths, minor: best.minor };
}
export const keyName = (k) => (k.minor ? MIN_NAMES : MAJ_NAMES)[k.fifths + 7];

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function keyAccidentals(fifths) {
  const acc = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) for (const l of 'FCGDAEB'.slice(0, fifths)) acc[l] = 1;
  if (fifths < 0) for (const l of 'BEADGCF'.slice(0, -fifths)) acc[l] = -1;
  return acc;
}

// Pick letter + accidental for a midi pitch: scale note first, then natural, then
// sharps in sharp keys / flats in flat keys (Bb in C major).
export function spell(midi, fifths) {
  const pc = midi % 12, kacc = keyAccidentals(fifths);
  const cands = [];
  for (const l of 'CDEFGAB') {
    const acc = ((pc - LETTER_PC[l] + 18) % 12) - 6;
    if (Math.abs(acc) <= 1) cands.push({ l, acc });
  }
  const rank = (c) =>
    c.acc === kacc[c.l] ? 0 : c.acc === 0 ? 1 : (fifths > 0 || (fifths === 0 && pc !== 10)) === c.acc > 0 ? 2 : 3;
  const c = cands.sort((a, b) => rank(a) - rank(b))[0];
  const octave = Math.floor((midi - c.acc) / 12) - 1;
  return { ...c, octave };
}

function abcPitch({ l, octave }) {
  if (octave >= 5) return l.toLowerCase() + "'".repeat(octave - 5);
  return l + ','.repeat(4 - octave);
}
const ACC = { '-1': '_', '0': '=', '1': '^' };

// ---------- 6. ABC output ----------
// In 4/4, two beats of plain 8ths beam as one group of four (beats 1-2 or 3-4).
function joinBeams(evs, o, m) {
  if (m.bar !== 16 || o % 8 !== 4) return false;
  const span = evs.filter((e) => e.o >= o - 4 && e.o < o + 4);
  return span.length === 4 && span.every((e) => e.pitches && e.L === 2);
}

function voiceAbc(bars, m, fifths) {
  const kacc = keyAccidentals(fifths);
  return bars.map((evs, bi) => {
    // Accidentals last until the barline, per letter+octave (standard engraving rule).
    const state = {};
    let out = '';
    evs.forEach((ev, i) => {
      if (i && ev.o % m.beat === 0 && !joinBeams(evs, ev.o, m)) out += ' '; // beams break at beats
      if (!ev.pitches) {
        out += ev.o === 0 && ev.L === m.bar ? 'z' + m.bar : 'z' + ev.L;
        return;
      }
      const notes = ev.pitches.map((p) => {
        const sp = spell(p, fifths), k = sp.l + sp.octave;
        const cur = k in state ? state[k] : kacc[sp.l];
        let acc = '';
        if (ev.cont && ev.o === 0) {
          // tied over the barline: no accidental, but later notes in this bar need one again
          if (sp.acc !== kacc[sp.l]) state[k] = NaN;
        } else if (!(ev.cont) && sp.acc !== cur) {
          acc = ACC[sp.acc];
          state[k] = sp.acc;
        }
        return acc + abcPitch(sp);
      });
      out += (notes.length > 1 ? `[${notes.join('')}]` : notes[0]) + (ev.L === 1 ? '' : ev.L) + (ev.tie ? '-' : '');
    });
    return out;
  });
}

export function transcribe(rawNotes, opts) {
  const { bpm = 90, meter = '4/4', grid = 1, hands = 'auto', splitPoint = 60, key = 'auto', title = 'My Song', barsPerLine = 3 } = opts;
  const m = METERS[meter];
  const q = quantize(rawNotes, { bpm, meter, grid });
  if (!q.length) return { abc: '', key: null };
  const k = key === 'auto' ? detectKey(q) : key;
  const { lh, rh } = splitHands(q, { mode: hands, splitPoint });
  const vr = toVoice(rh, grid, m.beat), vl = toVoice(lh, grid, m.beat);
  const last = Math.max(...[...vr, ...vl].map((c) => c.e));
  const nBars = Math.max(1, Math.ceil(last / m.bar));
  const R = voiceAbc(toBars(vr, m, nBars), m, k.fifths);
  const Lb = voiceAbc(toBars(vl, m, nBars), m, k.fifths);
  let abc = `X:1\nT:${title}\nM:${meter}\nL:1/16\nQ:${m.q}=${bpm}\nK:${keyName(k)}\n%%score {RH | LH}\nV:RH clef=treble name="RH"\nV:LH clef=bass name="LH"\n`;
  for (let i = 0; i < nBars; i += barsPerLine) {
    const end = i + barsPerLine >= nBars ? ' |]' : ' |';
    abc += `[V:RH] ${R.slice(i, i + barsPerLine).join(' | ')}${end}\n`;
    abc += `[V:LH] ${Lb.slice(i, i + barsPerLine).join(' | ')}${end}\n`;
  }
  return { abc, key: k, lh, rh };
}

// ---------- helpers ----------
function groupBy(sorted, f) {
  const out = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && f(last[0]) === f(x)) last.push(x); else out.push([x]);
  }
  return out;
}
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
