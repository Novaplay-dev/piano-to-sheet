// Minimal Standard MIDI File reader: -> [{p, t, off, track}] in seconds (tempo map applied).
export function readMidi(buf) {
  let i = 0;
  const u32 = () => (buf[i++] << 24) | (buf[i++] << 16) | (buf[i++] << 8) | buf[i++];
  const u16 = () => (buf[i++] << 8) | buf[i++];
  const vlq = () => { let v = 0, b; do { b = buf[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (u32() !== 0x4d546864) throw new Error('not a MIDI file');
  u32(); u16(); const nTracks = u16(), div = u16();
  const events = []; // {tick, track, type, ...}
  for (let tr = 0; tr < nTracks; tr++) {
    while (u32() !== 0x4d54726b) { const len = u32(); i += len; }
    const end = u32() + i;
    let tick = 0, status = 0;
    while (i < end) {
      tick += vlq();
      let b = buf[i];
      if (b & 0x80) { status = b; i++; }
      const cmd = status & 0xf0;
      if (status === 0xff) {
        const type = buf[i++], len = vlq();
        if (type === 0x51) events.push({ tick, track: tr, tempo: (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2] });
        i += len;
      } else if (status === 0xf0 || status === 0xf7) { i += vlq(); }
      else if (cmd === 0x90 || cmd === 0x80) {
        const p = buf[i++], v = buf[i++];
        events.push({ tick, track: tr, p, on: cmd === 0x90 && v > 0 });
      } else if (cmd === 0xc0 || cmd === 0xd0) i += 1;
      else i += 2;
    }
    i = end;
  }
  events.sort((a, b) => a.tick - b.tick || (a.tempo ? -1 : 0));
  // tick -> seconds
  let lastTick = 0, sec = 0, tempo = 500000;
  const open = new Map(), notes = [];
  for (const e of events) {
    sec += ((e.tick - lastTick) * tempo) / div / 1e6; lastTick = e.tick;
    if (e.tempo) { tempo = e.tempo; continue; }
    const k = e.track * 128 + e.p;
    if (e.on) { if (open.has(k)) notes.push({ ...open.get(k), off: sec }); open.set(k, { p: e.p, t: sec, track: e.track }); }
    else if (open.has(k)) { notes.push({ ...open.get(k), off: sec }); open.delete(k); }
  }
  return notes.sort((a, b) => a.t - b.t || a.p - b.p);
}
