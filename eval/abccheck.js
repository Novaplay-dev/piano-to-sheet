// Validates generated ABC: abcjs parses it with no warnings and every bar of every voice
// (including "&" overlay voices and (3:2:n triplets) adds up to exactly one full bar.
import { readFileSync } from 'node:fs';
import { METERS } from '../notation.js';

globalThis.window = globalThis;
const mod = { exports: {} };
new Function('module', 'exports', readFileSync(new URL('../vendor/abcjs-basic-min.js', import.meta.url), 'utf8'))(mod, mod.exports);
export const ABCJS = mod.exports;

// returns null if fine, else a description of the first problem
export function abcProblem(abc, meter) {
  const [tune] = ABCJS.parseOnly(abc);
  if (tune.warnings) return 'abcjs: ' + tune.warnings.join('; ');
  const bar = METERS[meter].bar;
  for (const line of abc.split('\n').filter((l) => l.startsWith('[V:'))) {
    const body = line.slice(6).replace(/"[^"]*"/g, '').replace(/\[[A-Za-z]:[^\]]*\]/g, ''); // text, inline fields
    for (const b of body.replace('|]', '').split('|').filter((x) => x.trim())) {
      for (const voice of b.split('&')) {
        let total = 0, tripLeft = 0;
        for (const x of voice.matchAll(/\(3:2:(\d+)|(\[[^\]]*\]|[_=^]*[A-Ga-gzx][,']*)(\d*)/g)) {
          if (x[1]) { tripLeft = +x[1]; continue; }
          let d = Number(x[3] || 1);
          if (tripLeft > 0) { d = (d * 2) / 3; tripLeft--; }
          total += d;
        }
        if (Math.abs(total - bar) > 1e-9) return `bar "${voice.trim()}" lasts ${total}, should be ${bar}`;
      }
    }
  }
  return null;
}
