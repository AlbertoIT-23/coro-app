function prepare(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h, dpr };
}

export function colors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    model: v('--model'),
    you: v('--you'),
    ghost: v('--ink-3'),
    grid: v('--line'),
    ink2: v('--ink-2'),
    surface: v('--card'),
    specLow: v('--spec-low'),
    specHigh: v('--spec-high'),
    dim: v('--dim'),
    accent: v('--accent'),
    band: v('--band'),
  };
}

function waveColumns(g, x, from, to, w, h, color, gain) {
  g.fillStyle = color;
  const mid = h / 2;
  const perPx = (to - from) / w;
  for (let px = 0; px < w; px++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(from + px * perPx);
    const b = Math.min(x.length, Math.floor(from + (px + 1) * perPx) + 1);
    for (let i = a; i < b; i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    const top = Math.max(1, mid - hi * gain * (mid - 2));
    const bottom = Math.min(h - 1, mid - lo * gain * (mid - 2));
    g.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
}

function peakOf(x, from = 0, to = x.length) {
  let top = 1e-4;
  for (let i = from; i < to; i++) {
    const v = Math.abs(x[i]);
    if (v > top) top = v;
  }
  return top;
}

export function drawWave(canvas, x, color, filled = 1) {
  const { g, w, h } = prepare(canvas);
  const c = colors();
  g.fillStyle = c.grid;
  g.fillRect(0, h / 2, w, 1);
  if (!x || !x.length) return;
  const to = Math.floor(x.length * filled);
  if (!to) return;
  const gain = 1 / peakOf(x, 0, to);
  const span = Math.max(1, Math.round(w * filled));
  waveColumns(g, x, 0, to, span, h, color, gain);
}

export function drawEditor(canvas, x, rate, view, sel) {
  const { g, w, h } = prepare(canvas);
  const c = colors();
  const from = Math.floor(view.a * rate);
  const to = Math.ceil(view.b * rate);
  waveColumns(g, x, from, to, w, h, c.model, 1 / peakOf(x, from, to));
  const toX = (t) => ((t - view.a) / (view.b - view.a)) * w;
  const xa = toX(sel.a);
  const xb = toX(sel.b);
  g.fillStyle = c.dim;
  g.fillRect(0, 0, Math.max(0, xa), h);
  g.fillRect(xb, 0, Math.max(0, w - xb), h);
  g.fillStyle = c.accent;
  for (const px of [xa, xb]) {
    g.fillRect(px - 1, 0, 2, h);
    g.beginPath();
    g.roundRect(px - 7, h / 2 - 16, 14, 32, 5);
    g.fill();
  }
  return { toTime: (px) => view.a + (px / w) * (view.b - view.a), xa, xb };
}

const PITCH_RANGE = 10;

// Line weight follows loudness, so quiet neutral syllables recede on their own.
export function drawPitch(canvas, dur, series, { cuts = [], labels = null, bands = [] } = {}) {
  const { g, w, h } = prepare(canvas);
  const c = colors();
  const left = 26;
  const bottom = 18;
  const top = 22;
  const plotW = w - left - 6;
  const plotH = h - top - bottom;
  const X = (t) => left + (t / dur) * plotW;
  const Y = (s) => top + ((PITCH_RANGE - s) / (2 * PITCH_RANGE)) * plotH;

  g.fillStyle = c.band;
  for (const b of bands) g.fillRect(X(b.from), top, X(Math.min(dur, b.to)) - X(b.from), plotH);

  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  for (let s = -9; s <= 9; s += 3) {
    g.fillStyle = c.grid;
    g.fillRect(left, Math.round(Y(s)), plotW, 1);
    g.fillStyle = c.ink2;
    g.fillText(s > 0 ? `+${s}` : `${s}`, left - 5, Y(s));
  }
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const step = dur <= 3 ? 0.5 : dur <= 10 ? 1 : 5;
  for (let t = step; t < dur - step / 3; t += step) {
    g.fillStyle = c.ink2;
    g.fillText(`${Number(t.toFixed(1))}s`, X(t), h - 4);
  }

  g.fillStyle = c.ghost;
  for (const t of cuts) g.fillRect(Math.round(X(t)), top - 8, 1, plotH + 8);
  if (labels) {
    g.font = '14px system-ui, sans-serif';
    g.fillStyle = c.ink2;
    const edges = [0, ...cuts, dur];
    labels.forEach((text, i) => g.fillText(text, X((edges[i] + edges[i + 1]) / 2), 14));
  }

  g.save();
  g.beginPath();
  g.rect(left, top, plotW, plotH);
  g.clip();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of series) {
    if (!s.data) continue;
    const { times, semis, energy } = s.data;
    g.strokeStyle = s.color;
    g.setLineDash(s.dash ? [4, 5] : []);
    for (let i = 1; i < times.length; i++) {
      if (Number.isNaN(semis[i]) || Number.isNaN(semis[i - 1])) continue;
      g.lineWidth = s.dash ? 1.5 : 1.2 + 2.4 * Math.sqrt(energy[i]);
      g.beginPath();
      g.moveTo(X(times[i - 1]), Y(semis[i - 1]));
      g.lineTo(X(times[i]), Y(semis[i]));
      g.stroke();
    }
  }
  g.restore();
  return { X, toTime: (px) => ((px - left) / plotW) * dur };
}

function hex(c) {
  const v = c.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

export function drawSpectrogram(canvas, spec, floorDb = -70) {
  const { g, w, h, dpr } = prepare(canvas);
  if (!spec || !spec.frames) return;
  const c = colors();
  const low = hex(c.specLow);
  const high = hex(c.specHigh);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  const image = g.createImageData(pw, ph);
  for (let y = 0; y < ph; y++) {
    const bin = Math.min(spec.bins - 1, Math.floor(((ph - 1 - y) / ph) * spec.bins));
    for (let x = 0; x < pw; x++) {
      const frame = Math.min(spec.frames - 1, Math.floor((x / pw) * spec.frames));
      const amount = Math.min(1, Math.max(0, 1 - spec.db[frame * spec.bins + bin] / floorDb));
      const at = (y * pw + x) * 4;
      for (let k = 0; k < 3; k++) image.data[at + k] = low[k] + (high[k] - low[k]) * amount ** 1.4;
      image.data[at + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
}
