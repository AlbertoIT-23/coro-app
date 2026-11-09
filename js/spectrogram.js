function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = next;
      }
    }
  }
}

// A short window, so vowel bands and consonant noise read better than single harmonics.
export function spectrogram(x, rate = 16000, { win = 0.012, hop = 0.004, nfft = 512 } = {}) {
  const N = Math.round(win * rate);
  const H = Math.round(hop * rate);
  const frames = Math.max(0, Math.floor((x.length - N) / H));
  const bins = nfft / 2;
  const db = new Float32Array(frames * bins);
  const w = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let top = -Infinity;
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[f * H + i] * w[i];
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const v = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
      db[f * bins + b] = v;
      if (v > top) top = v;
    }
  }
  for (let i = 0; i < db.length; i++) db[i] -= top;
  return { db, frames, bins, maxHz: rate / 2 };
}
