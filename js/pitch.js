// Pitch tracking in the style of Boersma (1993), the method behind Praat:
// normalised cross-correlation candidates per frame, then a Viterbi path that
// penalises octave jumps and voiced/unvoiced flips.

export const ANALYSIS_RATE = 16000;

export function downsample(x, from, to = ANALYSIS_RATE) {
  if (from === to) return Float32Array.from(x);
  const ratio = from / to;
  const k = Math.max(1, Math.round(ratio));
  const smooth = new Float32Array(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= k) sum -= x[i - k];
    smooth[i] = sum / Math.min(i + 1, k);
  }
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const delay = (k - 1) / 2; // the boxcar shifts the signal by half its length
  for (let i = 0; i < n; i++) {
    const pos = Math.min(i * ratio + delay, x.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, x.length - 1);
    out[i] = smooth[i0] + (smooth[i1] - smooth[i0]) * (pos - i0);
  }
  return out;
}

function removeDrift(x, rate) {
  const out = new Float32Array(x.length);
  const a = Math.exp((-2 * Math.PI * 40) / rate);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < x.length; i++) {
    prevOut = x[i] - prevIn + a * prevOut;
    prevIn = x[i];
    out[i] = prevOut;
  }
  return out;
}

const DEFAULTS = {
  fmin: 65,
  fmax: 500,
  hop: 0.01,
  win: 0.04,
  voicingThreshold: 0.45,
  silenceThreshold: 0.03,
  octaveCost: 0.01,
  octaveJumpCost: 0.35,
  voicedUnvoicedCost: 0.14,
  maxCandidates: 6,
  minVoicedFrames: 4,
};

export function trackPitch(input, rate = ANALYSIS_RATE, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const N = Math.round(o.win * rate);
  const H = Math.round(o.hop * rate);
  const lagMin = Math.floor(rate / o.fmax);
  const lagMax = Math.ceil(rate / o.fmin);

  const clean = removeDrift(input, rate);
  const x = new Float32Array(clean.length + N + lagMax + 1);
  x.set(clean);

  const frames = Math.max(0, Math.floor(clean.length / H));
  let globalPeak = 1e-9;
  for (let i = 0; i < clean.length; i++) globalPeak = Math.max(globalPeak, Math.abs(clean[i]));

  const times = new Float32Array(frames);
  const energy = new Float32Array(frames);
  const candidates = new Array(frames);
  const r = new Float64Array(lagMax + 2);
  const transitionScale = 0.01 / o.hop;

  for (let f = 0; f < frames; f++) {
    const start = f * H;
    times[f] = (start + N / 2) / rate;

    let e0 = 0;
    let localPeak = 0;
    for (let j = 0; j < N; j++) {
      const v = x[start + j];
      e0 += v * v;
      localPeak = Math.max(localPeak, Math.abs(v));
    }
    energy[f] = Math.sqrt(e0 / N);

    const unvoicedStrength =
      o.voicingThreshold +
      Math.max(0, 2 - localPeak / globalPeak / (o.silenceThreshold / (1 + o.voicingThreshold)));
    const list = [{ f0: 0, strength: unvoicedStrength }];

    if (e0 > 1e-10) {
      let eLag = 0;
      for (let j = 0; j < N; j++) eLag += x[start + lagMin - 1 + j] ** 2;
      r[lagMin - 1] = 0;
      for (let lag = lagMin; lag <= lagMax + 1; lag++) {
        eLag += x[start + lag + N - 1] ** 2 - x[start + lag - 1] ** 2;
        let cross = 0;
        for (let j = 0; j < N; j++) cross += x[start + j] * x[start + lag + j];
        r[lag] = cross / Math.sqrt(e0 * Math.max(eLag, 1e-12));
      }
      const peaks = [];
      for (let lag = lagMin; lag <= lagMax; lag++) {
        if (r[lag] > 0.3 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
          const curve = r[lag - 1] - 2 * r[lag] + r[lag + 1];
          const shift = curve < 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / curve : 0;
          const f0 = rate / (lag + shift);
          peaks.push({ f0, strength: r[lag] + o.octaveCost * Math.log2(f0 / o.fmin) });
        }
      }
      peaks.sort((a, b) => b.strength - a.strength);
      list.push(...peaks.slice(0, o.maxCandidates));
    }
    candidates[f] = list;
  }

  const f0 = viterbi(candidates, o, transitionScale);
  dropShortRuns(f0, o.minVoicedFrames);
  const smoothed = medianVoiced(f0);

  let top = 1e-9;
  for (const v of energy) top = Math.max(top, v);
  for (let i = 0; i < energy.length; i++) energy[i] /= top;

  return { times, f0: smoothed, energy };
}

function viterbi(candidates, o, scale) {
  const n = candidates.length;
  const out = new Float32Array(n).fill(NaN);
  if (!n) return out;
  const score = candidates.map((c) => new Float64Array(c.length));
  const back = candidates.map((c) => new Int32Array(c.length));
  candidates[0].forEach((c, i) => (score[0][i] = c.strength));

  for (let t = 1; t < n; t++) {
    for (let i = 0; i < candidates[t].length; i++) {
      const cur = candidates[t][i];
      let best = -Infinity;
      let bestFrom = 0;
      for (let j = 0; j < candidates[t - 1].length; j++) {
        const prev = candidates[t - 1][j];
        let cost = 0;
        if (cur.f0 && prev.f0) cost = o.octaveJumpCost * Math.abs(Math.log2(cur.f0 / prev.f0));
        else if (cur.f0 || prev.f0) cost = o.voicedUnvoicedCost;
        const value = score[t - 1][j] - cost * scale;
        if (value > best) {
          best = value;
          bestFrom = j;
        }
      }
      score[t][i] = best + cur.strength;
      back[t][i] = bestFrom;
    }
  }

  let at = 0;
  score[n - 1].forEach((v, i) => {
    if (v > score[n - 1][at]) at = i;
  });
  for (let t = n - 1; t >= 0; t--) {
    const value = candidates[t][at].f0;
    out[t] = value || NaN;
    at = back[t][at];
  }
  return out;
}

function dropShortRuns(f0, minFrames) {
  let i = 0;
  while (i < f0.length) {
    if (Number.isNaN(f0[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < f0.length && !Number.isNaN(f0[end])) end++;
    if (end - i < minFrames) f0.fill(NaN, i, end);
    i = end;
  }
}

function medianVoiced(f0) {
  const out = Float32Array.from(f0);
  for (let i = 2; i < f0.length - 2; i++) {
    const w = [f0[i - 2], f0[i - 1], f0[i], f0[i + 1], f0[i + 2]];
    if (w.every((v) => !Number.isNaN(v))) out[i] = w.sort((a, b) => a - b)[2];
  }
  return out;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Semitones around each voice's own median: different voices become comparable,
// but a flatter-than-model range stays visibly flat (z-scoring would hide it).
export function toSemitones(f0) {
  const ref = median(Array.from(f0));
  const out = new Float32Array(f0.length).fill(NaN);
  if (!Number.isFinite(ref)) return { semis: out, ref: NaN };
  for (let i = 0; i < f0.length; i++) {
    if (!Number.isNaN(f0[i])) out[i] = 12 * Math.log2(f0[i] / ref);
  }
  return { semis: out, ref };
}

export function analyze(samples, rate) {
  const x16 = downsample(samples, rate);
  const { times, f0, energy } = trackPitch(x16);
  const { semis, ref } = toSemitones(f0);
  let voiced = 0;
  for (const v of f0) if (!Number.isNaN(v)) voiced++;
  return { x16, times, f0, energy, semis, ref, voicedRatio: f0.length ? voiced / f0.length : 0 };
}
