// MIDI performance -> engraved piano score (ABC notation, rendered by abcjs).
// Time unit inside the engine: one tick = 1/48 whole note (ABC L:1/48).
// 16th = 3, 8th = 6, quarter = 12; triplet 8th = 4, triplet quarter = 8.

export const METERS = {
  '4/4': { bar: 48, beat: 12, strong: [24], q: '1/4' },
  '3/4': { bar: 36, beat: 12, strong: [], q: '1/4' },
  '2/4': { bar: 24, beat: 12, strong: [], q: '1/4' },
  '2/2': { bar: 48, beat: 24, strong: [], q: '1/2' }, // cut time
  '3/8': { bar: 18, beat: 6, strong: [], q: '1/8', beamBar: true }, // 3/8 beams the whole bar
  '6/8': { bar: 36, beat: 18, strong: [], q: '3/8', compound: true },
  '9/8': { bar: 54, beat: 18, strong: [], q: '3/8', compound: true },
  '12/8': { bar: 72, beat: 18, strong: [36], q: '3/8', compound: true },
};

// Plain + dotted values: 16th, 8th, dotted 8th, quarter, dotted quarter, half, dotted half, whole.
const REP = [3, 6, 9, 12, 18, 24, 36, 48];
const TRIP = [4, 8]; // triplet 8th / triplet quarter (only inside a triplet beat)
// Triplet-detection costs (squared-tick units): switching feel, starting in triplets,
// per-beat triplet prior, extra cost of an off-beat 16th. Tuned on real performances (eval/).
// Hand-split costs (see splitHands). Tuned on real performances (eval/).
export const HANDS = { dist: 0.5, window: 12, busyHand: 4, balance: 3, cross: 15, follow: 0.5, heldSoft: 1.5, busyHard: 2, busySoft: 1, lhTop: 67, rhBottom: 53, reg: 0.6 };
export const TRIPLET = { switch: 8, start: 1, prior: 0.1, odd: 0.8 };

// ---------- 1. quantize ----------
// notes: [{p: midi pitch, t: onset ms, off: release ms}] with t=0 at the downbeat of bar 1.
// Each beat is snapped either to the straight grid (16ths or 8ths) or, in simple meters, to
// triplet 8ths when the onsets in that beat clearly fit thirds better.
export function quantize(notes, { bpm, meter, grid = 1, triplets = true }) {
  const m = METERS[meter], g = grid * 3;
  const msPerTick = 60000 / bpm / m.beat;
  const raw = notes.map((n) => ({ p: n.p, s: n.t / msPerTick, e: n.off / msPerTick, id: n.id }));
  // triplets are decided per quarter note (12 ticks) in every simple meter
  const beatOf = (x) => Math.floor((x + 1.5) / 12);
  const err = (x, gg) => Math.abs(x - Math.round(x / gg) * gg);
  const trip = new Set();
  if (triplets && !m.compound && m.bar % 12 === 0) {
    const off = new Map();
    for (const n of raw) {
      const b = beatOf(n.s), x = n.s - b * 12;
      if (!off.has(b)) off.set(b, []);
      off.get(b).push(x);
    }
    // Per beat: squared snap error to the straight grid (off-beat 16ths cost a little extra,
    // simpler rhythms are likelier) vs to triplet 8ths. A 2-state Viterbi over the beats adds
    // a cost for switching feel, so triplet/straight passages stay consistent.
    const bs = [...off.keys()];
    const lo = Math.min(...bs), hi = Math.max(...bs), T = TRIPLET;
    let cost = [0, T.start], back = [];
    for (let b = lo; b <= hi; b++) {
      const xs = off.get(b) || [];
      const eb = xs.reduce((s, x) => s + err(x, g) ** 2 + (Math.round(x / g) * g % 6 ? T.odd : 0), 0);
      const et = xs.reduce((s, x) => s + err(x, 4) ** 2, 0) + (xs.length ? T.prior : 0);
      const fromB = [cost[0], cost[1] + T.switch], fromT = [cost[0] + T.switch, cost[1]];
      const pb = fromB[0] <= fromB[1] ? 0 : 1, pt = fromT[0] <= fromT[1] ? 0 : 1;
      back.push([pb, pt]);
      cost = [fromB[pb] + eb, fromT[pt] + et];
    }
    for (let st = cost[0] <= cost[1] ? 0 : 1, b = hi; b >= lo; b--) {
      if (st) trip.add(b);
      st = back[b - lo][st];
    }
  }
  const gridAt = (x) => (trip.has(beatOf(x)) ? 4 : g);
  const q = (x) => {
    const b = beatOf(x), gg = gridAt(x);
    return b * 12 + Math.round((x - b * 12) / gg) * gg;
  };
  return raw
    .map((n) => {
      const s = q(n.s);
      // releases come early far more often than late, so round them up a little
      return { p: n.p, s, e: Math.max(q(n.e + 0.15 * gridAt(n.e)), s + gridAt(s)), held: n.e - n.s, id: n.id };
    })
    .filter((n) => n.s >= 0)
    .sort((a, b) => a.s - b.s || a.p - b.p);
}

// ---------- 2. left / right hand ----------
// Every onset group (chord) is split "lowest k notes -> LH, rest -> RH". Costs: each note's
// distance from its hand's recent position, stretches beyond a 10th (incl. notes the hand is
// still holding), >5 notes per hand, crossing the other hand's held notes, and a mild pull
// toward the usual registers. A beam search (Viterbi-like) over the whole piece keeps the
// best few histories, so one awkward chord doesn't flip the hands for a passage.
export function splitHands(qnotes, { mode = 'auto', splitPoint = 60, beam = 24 } = {}) {
  if (mode === 'fixed') {
    return { lh: qnotes.filter((n) => n.p < splitPoint), rh: qnotes.filter((n) => n.p >= splitPoint) };
  }
  const groups = groupBy(qnotes, (n) => n.s);
  // state: {c, lpos, rpos, lheld, rheld, pick: {k, prev}} (pick = linked list of choices)
  const W = HANDS;
  let states = [{ c: 0, lpos: 50, rpos: 70, lheld: [], rheld: [], pick: null }];
  for (const g of groups) {
    const s = g[0].s, next = [];
    for (const st of states) {
      // keep notes that still sound, or were struck within the last quarter (the hand is still there)
      const busyL = st.lheld.filter((n) => n.e > s || n.s + W.window > s), busyR = st.rheld.filter((n) => n.e > s || n.s + W.window > s);
      const heldL = busyL.filter((n) => n.e > s), heldR = busyR.filter((n) => n.e > s);
      for (let k = 0; k <= g.length; k++) {
        const l = g.slice(0, k), r = g.slice(k);
        let c = st.c + (Math.max(0, l.length - 5) + Math.max(0, r.length - 5)) * 50; // max 5 fingers
        c += handCost(l, busyL, heldL, st.lpos, 'L') + handCost(r, busyR, heldR, st.rpos, 'R');
        // attacking while holding a key is harder than using the free hand
        if (l.length && heldL.length && !heldR.length) c += W.busyHand;
        if (r.length && heldR.length && !heldL.length) c += W.busyHand;
        // big chords are shared between the hands (4-part writing: 2 + 2, not 3 + 1)
        if (l.length && r.length) c += Math.max(0, Math.abs(l.length - r.length) - 1) * W.balance;
        // a hand can't play through the other hand's held keys
        if (l.length && heldR.length && l[l.length - 1].p > Math.min(...heldR.map((n) => n.p))) c += W.cross;
        if (r.length && heldL.length && r[0].p < Math.max(...heldL.map((n) => n.p))) c += W.cross;
        next.push({
          c,
          lpos: l.length ? st.lpos + (mean(l) - st.lpos) * W.follow : st.lpos,
          rpos: r.length ? st.rpos + (mean(r) - st.rpos) * W.follow : st.rpos,
          lheld: [...busyL, ...l],
          rheld: [...busyR, ...r],
          pick: { k, prev: st.pick },
        });
      }
    }
    next.sort((a, b) => a.c - b.c);
    states = next.slice(0, beam);
  }
  const picks = [];
  for (let p = states[0].pick; p; p = p.prev) picks.unshift(p.k);
  const lh = [], rh = [];
  groups.forEach((g, i) => { lh.push(...g.slice(0, picks[i])); rh.push(...g.slice(picks[i])); });
  return { lh, rh };
}

function handCost(ns, busy, held, pos, side) {
  if (!ns.length) return 0;
  const ps = ns.map((n) => n.p);
  let c = 0;
  const W = HANDS;
  for (const p of ps) c += Math.abs(p - pos) * W.dist;
  const stretch = (others, hard, soft) => {
    const all = [...ps, ...others.map((n) => n.p)];
    const span = Math.max(...all) - Math.min(...all);
    return span > 16 ? (span - 16) * hard + 4 * soft : span > 12 ? (span - 12) * soft : 0;
  };
  c += stretch(held, 12, W.heldSoft);       // keys held down right now: a hard limit
  c += stretch(busy, W.busyHard, W.busySoft); // keys just played: the hand would have to jump
  for (const p of ps) c += side === 'L' ? Math.max(0, p - W.lhTop) * W.reg : Math.max(0, W.rhBottom - p) * W.reg;
  return c;
}

// ---------- 3. voices per hand ----------
// A note that keeps sounding at least a beat past the hand's next attack is a held note:
// it goes to a second voice on that staff (written with its own stems), everything else
// is one voice of chords + rests. Returns [mainChords, heldChords].
export function handVoices(notes, grid, beat, bar) {
  const onsets = [...new Set(notes.map((n) => n.s))].sort((a, b) => a - b);
  const nextOnset = (s) => onsets.find((o) => o > s) ?? Infinity;
  const held = notes.filter((n) => n.e - nextOnset(n.s) >= beat / 2);
  const main = notes.filter((n) => !held.includes(n));
  return [toVoice(main, grid, beat, bar), toVoice(held, grid, beat, bar)];
}

export function toVoice(notes, grid = 3, beat = 12, bar = 48) {
  const chords = groupBy([...notes].sort((a, b) => a.s - b.s), (n) => n.s).map((g) => ({
    s: g[0].s,
    e: Math.max(...g.map((n) => n.e)),
    raw: Math.max(...g.map((n) => n.held ?? n.e - n.s)), // how long the keys were really down
    pitches: [...new Set(g.map((n) => n.p))].sort((a, b) => a - b),
  }));
  chords.forEach((c, i) => {
    const next = i + 1 < chords.length ? chords[i + 1].s : Infinity;
    if (c.e > next) c.e = next;
    // Keys held for most of the time until the next note (or the barline, if nothing follows
    // in this bar) = legato: no rest. A real rest leaves a gap of at least ~a grid step.
    const to = Math.min(next, (Math.floor(c.s / bar) + 1) * bar), ioi = to - c.s;
    if (c.raw >= 0.7 * ioi || ioi - c.raw < 0.75 * grid) c.e = Math.max(c.e, to);
    // Players release early/late: a note that ends before a rest snaps to the nearest beat.
    if (c.e < next) {
      const b = Math.round(c.e / beat) * beat;
      if (b > c.s && b <= next && Math.abs(b - c.e) <= (b - c.s) / 4) c.e = b;
    }
  });
  return chords;
}

// ---------- 4. meter rules: bars, ties, beat grouping ----------
const crosses = (o, end, b) => b > o && b < end;
const inOneBeat = (o, L, m) => Math.floor(o / m.beat) === Math.floor((o + L - 1) / m.beat);
const tripOk = (o, L) => TRIP.includes(L) && o % 4 === 0 && Math.floor(o / 12) === Math.floor((o + L - 1) / 12);

// anything touching a triplet position must stay inside its quarter note (matters in 2/2)
const tripletish = (o, L) => o % 3 || L % 3;

function noteOk(o, L, m) {
  if (tripletish(o, L)) return tripOk(o, L);
  if (!REP.includes(L)) return false;
  if (inOneBeat(o, L, m)) return true;
  // A note may span beats only when it starts on a beat, does not hide the middle of a
  // 4/4 / 12/8 bar (unless it starts the bar), and in compound time lasts whole beats.
  if (o % m.beat) return false;
  if (o !== 0 && m.strong.some((b) => crosses(o, o + L, b))) return false;
  if (m.compound && L % m.beat) return false;
  return true;
}

function restOk(o, L, m) {
  if (o === 0 && L === m.bar) return true; // whole-bar rest
  if (tripletish(o, L)) return tripOk(o, L);
  if (!REP.includes(L)) return false;
  if (m.strong.length && L === m.strong[0] && o % L === 0) return true; // half rest on beat 1 or 3
  return inOneBeat(o, L, m); // otherwise rests never cross a beat
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
  if (b === undefined && tripletish(o, L)) {
    const nq = (Math.floor(o / 12) + 1) * 12;
    if (nq < end) b = nq;
  }
  if (b === undefined) {
    // Inside one beat: split at the 8th grid first, else the largest value that fits.
    const n8 = (Math.floor(o / 6) + 1) * 6;
    const fits = [...REP, ...TRIP].filter((v) => v < L);
    if (n8 < end && o % 6 && o % 3 === 0) b = n8;
    else if (fits.length) b = o + Math.max(...fits);
    else return [L]; // ponytail: unreachable with 3/4-tick grids
  }
  return [...metricPieces(o, b - o, m, rest), ...metricPieces(b, end - b, m, rest)];
}

// Voice chords -> bars of events {o, L, pitches|null, tie, cont}
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

// Key signature = the one that needs the fewest written accidentals (counted per attack;
// the raised leading tone of the minor key is expected, so it is not counted against it).
// Ties and major-vs-relative-minor are decided by Krumhansl-Schmuckler profile correlation.
export function detectKey(qnotes) {
  const h = new Array(12).fill(0), attacks = new Array(12).fill(0);
  for (const n of qnotes) { h[n.p % 12] += 1 + Math.min(n.e - n.s, 24) / 12; attacks[n.p % 12]++; }
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
    const out = (extra) => attacks.reduce((s, c, pc) => s + (scale.includes(pc) || pc === extra ? 0 : c), 0);
    const maj = corr(MAJ, tonic), min = corr(MIN, (tonic + 9) % 12);
    const minor = min > maj;
    const acc = minor ? out((tonic + 8) % 12) : out(-1); // leading tone of the relative minor
    const cand = { acc, r: Math.max(maj, min), fifths: f, minor };
    // enharmonic twins (B major / Cb major) score identically: keep the one with fewer accidentals
    if (!best || acc < best.acc || (acc === best.acc && (cand.r > best.r + 1e-9 || (Math.abs(cand.r - best.r) <= 1e-9 && Math.abs(f) < Math.abs(best.fifths))))) best = cand;
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

// Pick letter + accidental for a midi pitch: scale note first; in minor keys the raised
// 6th/7th degrees are spelled as such (G# in A minor, B# in C# minor); then natural, then
// sharps in sharp keys / flats in flat keys (Bb in C major).
export function spell(midi, fifths, minor = false) {
  const pc = midi % 12, kacc = keyAccidentals(fifths);
  const tonic = ((fifths * 7 + 120) % 12 + (minor ? 9 : 0)) % 12;
  const minorRaised = minor ? [(tonic + 11) % 12, (tonic + 9) % 12] : [];
  const tonicLetter = minor ? 'ABCDEFG'['ABCDEFG'.indexOf(MIN_NAMES[fifths + 7][0])] : null;
  const L7 = tonicLetter && 'ABCDEFGABCDEFG'['ABCDEFG'.indexOf(tonicLetter) + 6];
  const L6 = tonicLetter && 'ABCDEFGABCDEFG'['ABCDEFG'.indexOf(tonicLetter) + 5];
  const cands = [];
  for (const l of 'CDEFGAB') {
    const acc = ((pc - LETTER_PC[l] + 18) % 12) - 6;
    if (Math.abs(acc) <= 2) cands.push({ l, acc });
  }
  const rank = (c) => {
    if (Math.abs(c.acc) === 2) return minorRaised.includes(pc) && (c.l === L7 || c.l === L6) && c.acc === kacc[c.l] + 1 ? 0.5 : 9;
    if (c.acc === kacc[c.l]) return 0;
    if (minorRaised.includes(pc) && (c.l === L7 || c.l === L6)) return 0.5;
    if (c.acc === 0) return 1;
    return (fifths > 0 || (fifths === 0 && pc !== 10)) === c.acc > 0 ? 2 : 3;
  };
  const c = cands.sort((a, b) => rank(a) - rank(b))[0];
  const octave = Math.floor((midi - c.acc) / 12) - 1;
  return { ...c, octave };
}

function abcPitch({ l, octave }) {
  if (octave >= 5) return l.toLowerCase() + "'".repeat(octave - 5);
  return l + ','.repeat(4 - octave);
}
const ACC = { '-2': '__', '-1': '_', '0': '=', '1': '^', '2': '^^' };

// ---------- 6. ABC output ----------
// In 4/4, two beats of plain 8ths beam as one group of four (beats 1-2 or 3-4).
function joinBeams(evs, o, m) {
  if (m.bar !== 48 || o % 24 !== 12) return false;
  const span = evs.filter((e) => e.o >= o - 12 && e.o < o + 12);
  return span.length === 4 && span.every((e) => e.pitches && e.L === 6);
}
const isTripletBeat = (evs) => evs.some((e) => e.o % 3 || e.L % 3);

// Accidentals hold until the barline, per letter+octave, for the whole staff (both voices),
// so they're decided in time order across voices before writing.
function decideAccidentals(voicesBars, fifths, minor) {
  const kacc = keyAccidentals(fifths);
  voicesBars[0].forEach((_, bi) => {
    const evs = voicesBars.flatMap((bars) => bars[bi]).filter((e) => e.pitches).sort((a, b) => a.o - b.o);
    const state = {};
    for (const ev of evs) {
      ev.acc = ev.pitches.map((p) => {
        const sp = spell(p, fifths, minor), k = sp.l + sp.octave;
        const cur = k in state ? state[k] : kacc[sp.l];
        if (ev.cont) {
          // tied over the barline: no accidental, but later notes in this bar need one again
          if (ev.o === 0 && sp.acc !== kacc[sp.l]) state[k] = NaN;
          return abcPitch(sp);
        }
        if (sp.acc === cur) return abcPitch(sp);
        state[k] = sp.acc;
        return ACC[sp.acc] + abcPitch(sp);
      });
    }
  });
}

function barAbc(evs, m, invisibleRests) {
  let out = '';
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const atBeat = ev.o % m.beat === 0 && !m.beamBar && !joinBeams(evs, ev.o, m);
    if (i && (atBeat || !ev.pitches || !evs[i - 1].pitches)) out += ' '; // beams break at beats and rests
    let scale = 1;
    const quarterEvs = evs.filter((e) => Math.floor(e.o / 12) === Math.floor(ev.o / 12)); // triplet group
    if (isTripletBeat(quarterEvs)) {
      scale = 1.5;
      if (ev === quarterEvs[0]) out += (i && !out.endsWith(' ') ? ' ' : '') + `(3:2:${quarterEvs.length}`;
    }
    const len = ev.L * scale;
    if (!ev.pitches) { out += (invisibleRests ? 'x' : 'z') + len; continue; }
    out += (ev.acc.length > 1 ? `[${ev.acc.join('')}]` : ev.acc[0]) + len + (ev.tie ? '-' : '');
  }
  return out;
}

// one staff = main voice + optional held voice (written as an "&" overlay only in bars that need it)
function staffAbc(main, held, m) {
  const upperFirst = avgPitch(held) <= avgPitch(main);
  return main.map((evs, bi) => {
    if (!held[bi].some((e) => e.pitches)) return barAbc(evs, m, false);
    const [a, b] = upperFirst ? [evs, held[bi]] : [held[bi], evs];
    return `${barAbc(a, m, a === held[bi])} & ${barAbc(b, m, b === held[bi])}`;
  });
}
function avgPitch(bars) {
  const ps = bars.flat().filter((e) => e.pitches).flatMap((e) => e.pitches);
  return ps.length ? avg(ps) : -Infinity;
}

// Pause cut + crossed hands. `cross` = times (ms from bar 1) where the player tapped the
// "cross hands" button; each tap toggles crossed mode for the notes after it.
// Around every tap, whole bars of silence are removed (the player stopped to cross hands),
// so the music after it continues on the next bar.
export function applyCrossMarks(q, cross, msPerTick, bar) {
  const marks = [...cross].sort((x, y) => x - y).map((ms) => ms / msPerTick);
  for (let i = 0; i < marks.length; i++) {
    const M = marks[i];
    const before = q.filter((n) => n.s < M), after = q.filter((n) => n.s >= M);
    if (!after.length) continue;
    const prevEnd = before.length ? Math.max(...before.map((n) => n.e)) : 0;
    const next = Math.min(...after.map((n) => n.s));
    const cut = Math.floor(next / bar) * bar - Math.ceil(prevEnd / bar) * bar;
    if (cut <= 0) continue;
    for (const n of after) { n.s -= cut; n.e -= cut; }
    for (let j = i + 1; j < marks.length; j++) marks[j] -= cut;
    marks[i] = next - cut; // the switch happens at the first note after the pause
  }
  for (const n of q) n.cross = marks.filter((M) => M <= n.s).length % 2 === 1;
  return q;
}

// Clef per bar with hysteresis: a staff switches to bass/treble only when its notes clearly
// live there (crossed hands, very high left hand, very low right hand).
function barClefs(main, held, start) {
  let clef = start;
  return main.map((evs, bi) => {
    const ps = [...evs, ...held[bi]].filter((e) => e.pitches).flatMap((e) => e.pitches);
    if (ps.length) {
      const a = avg(ps);
      if (clef === 'treble' && a < 57) clef = 'bass';
      else if (clef === 'bass' && a > 64) clef = 'treble';
    }
    return clef;
  });
}

export function transcribe(rawNotes, opts) {
  const { bpm = 90, meter = '4/4', grid = 1, hands = 'auto', splitPoint = 60, key = 'auto', title = 'My Song', barsPerLine = 3, cross = [] } = opts;
  const m = METERS[meter], g = grid * 3;
  const q = applyCrossMarks(quantize(rawNotes, { bpm, meter, grid }), cross, 60000 / bpm / m.beat, m.bar);
  if (!q.length) return { abc: '', key: null };
  const k = key === 'auto' ? detectKey(q) : key;
  const split = splitHands(q, { mode: hands, splitPoint });
  // crossed: the left hand plays the upper part, the right hand the lower part
  const bySP = (x, y) => x.s - y.s || x.p - y.p;
  const rh = [...split.rh.filter((n) => !n.cross), ...split.lh.filter((n) => n.cross)].sort(bySP);
  const lh = [...split.lh.filter((n) => !n.cross), ...split.rh.filter((n) => n.cross)].sort(bySP);
  const vR = handVoices(rh, g, m.beat, m.bar), vL = handVoices(lh, g, m.beat, m.bar);
  const last = Math.max(...[...vR, ...vL].flat().map((c) => c.e));
  const nBars = Math.max(1, Math.ceil(last / m.bar));
  const [bR, bR2, bL, bL2] = [...vR, ...vL].map((v) => toBars(v, m, nBars));
  decideAccidentals([bR, bR2], k.fifths, k.minor);
  decideAccidentals([bL, bL2], k.fifths, k.minor);
  const cR = barClefs(bR, bR2, 'treble'), cL = barClefs(bL, bL2, 'bass');
  // bar index where crossed mode starts / ends -> text above the right-hand staff
  const crossBar = new Map();
  let was = false;
  for (const n of [...q].sort(bySP)) if (n.cross !== was) { crossBar.set(Math.floor(n.s / m.bar), n.cross); was = n.cross; }
  // clef changes; abcjs resets to the voice's clef on every new line, so repeat it there
  const decorate = (bars, clefs, text) => bars.map((b, i) => {
    const lineStart = i % barsPerLine === 0;
    let pre = i && (clefs[i] !== clefs[i - 1] || (lineStart && clefs[i] !== clefs[0])) ? `[K:clef=${clefs[i]}] ` : '';
    if (text && crossBar.has(i)) pre += crossBar.get(i) ? '"^hands crossed"' : '"^hands normal"';
    return pre + b;
  });
  const R = decorate(staffAbc(bR, bR2, m), cR, true), L = decorate(staffAbc(bL, bL2, m), cL, false);
  let abc = `X:1\nT:${title}\nM:${meter}\nL:1/48\nQ:${m.q}=${bpm}\nK:${keyName(k)}\n%%score {RH | LH}\nV:RH clef=${cR[0]} name="RH"\nV:LH clef=${cL[0]} name="LH"\n`;
  for (let i = 0; i < nBars; i += barsPerLine) {
    const end = i + barsPerLine >= nBars ? ' |]' : ' |';
    abc += `[V:RH] ${R.slice(i, i + barsPerLine).join(' | ')}${end}\n`;
    abc += `[V:LH] ${L.slice(i, i + barsPerLine).join(' | ')}${end}\n`;
  }
  return { abc, key: k, lh, rh, voices: { rh: vR, lh: vL } };
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
function mean(ns) { return avg(ns.map((n) => n.p)); }
