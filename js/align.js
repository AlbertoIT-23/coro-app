// Finds a single time shift between the model and a recording by matching their
// loudness envelopes. Deliberately one number, not a time-warp: the delay from
// Bluetooth and the audio stack should vanish, real rhythm mistakes should not.

const HOP = 0.01;

export function envelope(x, rate) {
  const size = Math.max(1, Math.round(HOP * rate));
  const n = Math.floor(x.length / size);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < size; j++) sum += x[i * size + j] ** 2;
    // The fourth root keeps quiet consonants from being drowned by loud vowels.
    out[i] = Math.pow(sum / size, 0.25);
  }
  return out;
}

function pearson(a, b, offset) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i + offset];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const cov = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den > 1e-12 ? cov / den : 0;
}

// `recording` must be longer than `model`. Returns where the model best fits,
// in seconds from the start of `recording`.
export function findLag(model, recording, rate) {
  const a = envelope(model, rate);
  const b = envelope(recording, rate);
  const span = b.length - a.length;
  if (span < 0 || a.length < 5) return { lag: 0, score: 0 };
  const scores = new Float32Array(span + 1);
  let best = 0;
  for (let k = 0; k <= span; k++) {
    scores[k] = pearson(a, b, k);
    if (scores[k] > scores[best]) best = k;
  }
  let shift = 0;
  if (best > 0 && best < span) {
    const curve = scores[best - 1] - 2 * scores[best] + scores[best + 1];
    if (curve < 0) shift = (0.5 * (scores[best - 1] - scores[best + 1])) / curve;
  }
  return { lag: (best + shift) * HOP, score: scores[best] };
}
