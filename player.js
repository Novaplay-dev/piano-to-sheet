// Plays a Standard MIDI File on a MIDI output (the piano's own sound).
// Everything goes to channel 1 (pianos play channel 1 with the piano sound); drums (channel 10) are dropped.

// SMF bytes -> { events: [{t (seconds), data: [status, a, b]}], duration }
export function midiEvents(buf) {
  buf = new Uint8Array(buf);
  let i = 0;
  const u32 = () => ((buf[i++] << 24) | (buf[i++] << 16) | (buf[i++] << 8) | buf[i++]) >>> 0;
  const u16 = () => (buf[i++] << 8) | buf[i++];
  const vlq = () => { let v = 0, b; do { b = buf[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (u32() !== 0x4d546864) throw new Error('This is not a MIDI file');
  const hdr = u32(); u16(); const nTracks = u16(), div = u16(); i += hdr - 6;
  if (div & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which is not supported');
  const raw = []; // {tick, tempo} | {tick, data}
  for (let tr = 0; tr < nTracks && i < buf.length; tr++) {
    while (u32() !== 0x4d54726b) { const len = u32(); i += len; if (i >= buf.length) break; }
    const end = u32() + i;
    let tick = 0, status = 0;
    while (i < end) {
      tick += vlq();
      if (buf[i] & 0x80) status = buf[i++];
      const cmd = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {
        const type = buf[i++], len = vlq();
        if (type === 0x51) raw.push({ tick, tempo: (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2] });
        i += len;
      } else if (status === 0xf0 || status === 0xf7) i += vlq();
      else if (cmd === 0xc0 || cmd === 0xd0) i += 1; // program change / pressure: keep the piano sound
      else {
        const a = buf[i++], b = buf[i++];
        if (ch === 9) continue; // drums
        if (cmd === 0x90 && b === 0) raw.push({ tick, data: [0x80, a, 0] });
        else if (cmd === 0x90 || cmd === 0x80) raw.push({ tick, ch, data: [cmd, a, b] });
        else if (cmd === 0xb0 && a === 7) raw.push({ tick, ch, vol: b }); // channel volume
        else if (cmd === 0xb0 && [64, 66, 67].includes(a)) raw.push({ tick, data: [0xb0, a, b] }); // pedals
      }
    }
    i = end;
  }
  // stable sort; at equal ticks: tempo first, note-offs before note-ons (repeated notes re-strike)
  const rank = (e) => (e.tempo || e.vol !== undefined ? 0 : e.data[0] === 0x80 ? 1 : 2);
  raw.sort((x, y) => x.tick - y.tick || rank(x) - rank(y));
  let lastTick = 0, sec = 0, tempo = 500000;
  // Files from notation programs (e.g. LilyPond) strike every note equally hard and put the
  // dynamics in the channel volume: then the volume becomes how hard each key is struck.
  const vels = new Set(raw.filter((e) => e.data?.[0] === 0x90).map((e) => e.data[2]));
  const volAsVel = vels.size === 1 && raw.some((e) => e.vol !== undefined);
  const vol = new Map(), events = [];
  for (const e of raw) {
    sec += ((e.tick - lastTick) * tempo) / div / 1e6; lastTick = e.tick;
    if (e.tempo) tempo = e.tempo;
    else if (e.vol !== undefined) vol.set(e.ch, e.vol);
    else if (volAsVel && e.data[0] === 0x90) events.push({ t: sec, data: [0x90, e.data[1], Math.max(1, vol.get(e.ch) ?? 100)] });
    else events.push({ t: sec, data: e.data });
  }
  return { events, duration: events.length ? events[events.length - 1].t : 0 };
}

// Schedules events a little ahead so timing stays exact; pause/seek-safe.
export class Player {
  constructor() { this.out = null; this.song = null; this.pos = 0; this.timer = null; this.speed = 1; this.onEnd = null; this.at = 0; }
  get playing() { return !!this.timer; }
  load(song) { this.stop(); this.song = song; this.pos = 0; }
  // current position in seconds of the song
  time() { return this.timer ? Math.min(this.song.duration, (performance.now() - this.t0) * this.speed / 1000) : this.at; }
  play(out) {
    if (!this.song || this.timer) return;
    this.out = out;
    const ev = this.song.events;
    this.at = this.pos < ev.length ? ev[this.pos].t : 0;
    this.t0 = performance.now() - (this.at * 1000) / this.speed;
    // sustain pedal state at the start point (when resuming in the middle)
    let ped = 0;
    for (let k = 0; k < this.pos; k++) if (ev[k].data[0] === 0xb0 && ev[k].data[1] === 64) ped = ev[k].data[2];
    if (ped) out.send([0xb0, 64, ped]);
    this.on = new Set();
    const tick = () => {
      const horizon = performance.now() + 400; // ponytail: 0.4 s look-ahead; Android throttles timers when the screen is off
      while (this.pos < ev.length) {
        const e = ev[this.pos], at = this.t0 + (e.t * 1000) / this.speed;
        if (at > horizon) break;
        out.send(e.data, Math.max(at, performance.now()));
        if (e.data[0] === 0x90) this.on.add(e.data[1]); else if (e.data[0] === 0x80) this.on.delete(e.data[1]);
        this.pos++;
      }
      if (this.pos >= ev.length && performance.now() > this.t0 + (this.song.duration * 1000) / this.speed + 300) {
        this.stop(); this.onEnd?.();
      }
    };
    tick();
    this.timer = setInterval(tick, 100);
  }
  pause() {
    if (!this.timer) return;
    this.at = this.time();
    clearInterval(this.timer); this.timer = null;
    this.silence();
    // continue from the first event not yet heard
    const ev = this.song.events;
    this.pos = ev.findIndex((e) => e.t >= this.at); if (this.pos < 0) this.pos = ev.length;
  }
  stop() { this.pause(); this.pos = 0; this.at = 0; }
  seek(t) {
    const was = this.playing; this.pause();
    const ev = this.song.events;
    this.pos = ev.findIndex((e) => e.t >= t); if (this.pos < 0) this.pos = ev.length;
    this.at = t;
    if (was) this.play(this.out);
  }
  silence() {
    const out = this.out; if (!out) return;
    out.clear?.(); // drop events already queued (Chrome)
    for (const p of this.on || []) out.send([0x80, p, 0]);
    out.send([0xb0, 64, 0]); out.send([0xb0, 66, 0]); out.send([0xb0, 67, 0]);
    out.send([0xb0, 123, 0]); // all notes off
    this.on = new Set();
  }
}
