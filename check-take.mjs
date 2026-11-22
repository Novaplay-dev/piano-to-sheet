// node check-take.mjs my-song-raw.json  -> prints the transcription of a saved real take
import { readFileSync } from 'node:fs';
import { transcribe } from './notation.js';
const { settings, notes } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = transcribe(notes, settings);
console.log(r.abc);
console.log(`RH ${r.rh.length} notes, LH ${r.lh.length} notes`);
