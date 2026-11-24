// Speeds speech up without raising its pitch (WSOLA time-stretching).
// Kokoro's own speed setting slurs above about 1.3x; generating at a moderate speed and
// stretching the result keeps the words clearer.

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

// rate > 1 makes it faster. Returns a new array (or the input unchanged when rate is ~1).
export function timeStretch(input, rate, sampleRate) {
  if (!(rate > 0) || Math.abs(rate - 1) < 0.01 || input.length < sampleRate * 0.1) return input;
  const frame = Math.round(sampleRate * 0.03);   // 30 ms analysis frames
  const hop = frame >> 1;                         // 50% overlap in the output
  const tolerance = Math.round(sampleRate * 0.01); // search ±10 ms for the best-matching frame
  const window = hann(frame);
  const outLength = Math.ceil(input.length / rate) + frame;
  const out = new Float32Array(outLength);
  const weight = new Float32Array(outLength);

  let previous = 0;
  let end = 0;
  for (let k = 0; ; k++) {
    const outPos = k * hop;
    const nominal = Math.round(outPos * rate);
    if (nominal + frame + tolerance >= input.length || outPos + frame > outLength) break;

    // Pick the frame near the nominal position that best continues the previous one.
    let best = nominal;
    if (k > 0) {
      const target = previous + hop;
      let bestScore = -Infinity;
      for (let d = -tolerance; d <= tolerance; d++) {
        const candidate = nominal + d;
        if (candidate < 0) continue;
        let score = 0;
        for (let i = 0; i < hop; i += 2) score += input[candidate + i] * input[target + i];
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    for (let i = 0; i < frame; i++) {
      out[outPos + i] += input[best + i] * window[i];
      weight[outPos + i] += window[i];
    }
    previous = best;
    end = outPos + frame;
  }

  for (let i = 0; i < end; i++) if (weight[i] > 1e-3) out[i] /= weight[i];
  return out.subarray(0, end);
}
