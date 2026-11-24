// Checks the time-stretcher: length scales with the rate, output is finite and keeps its loudness and pitch.
import assert from 'node:assert/strict';
import { timeStretch } from '../site/speech/stretch.js';

const rate = 24000;
const seconds = 2;
const input = new Float32Array(rate * seconds);
for (let i = 0; i < input.length; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate) * (0.6 + 0.4 * Math.sin(i / 3000));

function rms(a) {
  let s = 0;
  for (const x of a) s += x * x;
  return Math.sqrt(s / a.length);
}
function zeroCrossingsPerSecond(a) {
  let z = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  return z / (a.length / rate);
}

for (const r of [1.2, 1.4, 1.6]) {
  const out = timeStretch(input, r, rate);
  const expected = input.length / r;
  assert.ok(Math.abs(out.length - expected) / expected < 0.05, `length at ${r}x: ${out.length} vs ${expected}`);
  assert.ok(out.every(Number.isFinite), 'finite');
  assert.ok(Math.abs(rms(out) / rms(input) - 1) < 0.15, `loudness at ${r}x`);
  // Pitch: a 220 Hz tone crosses zero ~440 times a second whatever the speed.
  assert.ok(Math.abs(zeroCrossingsPerSecond(out) / 440 - 1) < 0.05, `pitch at ${r}x: ${zeroCrossingsPerSecond(out)}`);
}
assert.equal(timeStretch(input, 1, rate), input);

const t0 = performance.now();
timeStretch(input, 1.4, rate);
console.log(`time-stretch: all checks passed (2 s of audio in ${Math.round(performance.now() - t0)} ms)`);
