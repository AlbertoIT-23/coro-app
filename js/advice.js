// Turns measured differences into at most two concrete remarks. It stays silent
// when the measurements are too thin: wrong advice trains the wrong habit.

import { t } from './i18n.js';

const MIN_GAP = 0.08;
const MIN_VOICED_FRAMES = 8;
const LOCAL_SEARCH_FRAMES = 15;
const LATE_SECONDS = 0.12;
const MAX_ITEMS = 2;

const round = (v) => Math.round(Math.abs(v));

export function hanziOf(text = '') {
  return [...text].filter((c) => /\p{Script=Han}/u.test(c));
}

function smooth(v, half = 2) {
  return Float32Array.from(v, (_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
      sum += v[k];
      n++;
    }
    return sum / n;
  });
}

// Valleys of loudness, with unvoiced frames counted as deeper: those are where syllables meet.
export function syllableCuts(analysis, count = 0) {
  const { times, energy, f0 } = analysis;
  const level = smooth(Float32Array.from(energy, (e, i) => (Number.isNaN(f0[i]) ? e * 0.3 : e)));
  const valleys = [];
  for (let i = 1; i < level.length - 1; i++) {
    if (level[i] > level[i - 1] || level[i] >= level[i + 1]) continue;
    let left = level[i];
    for (let k = i; k >= 0; k--) left = Math.max(left, level[k]);
    let right = level[i];
    for (let k = i; k < level.length; k++) right = Math.max(right, level[k]);
    valleys.push({ t: times[i], depth: Math.min(left, right) - level[i] });
  }
  valleys.sort((a, b) => b.depth - a.depth);

  const wanted = count > 1 ? count - 1 : Infinity;
  const floor = count > 1 ? 0 : 0.2;
  const picked = [];
  for (const v of valleys) {
    if (picked.length >= wanted || v.depth < floor) break;
    if (picked.every((t) => Math.abs(t - v.t) >= MIN_GAP)) picked.push(v.t);
  }
  picked.sort((a, b) => a - b);

  if (count > 1) {
    const end = times.length ? times[times.length - 1] : 0;
    while (picked.length < count - 1 && end > 0) {
      const edges = [0, ...picked, end];
      let widest = 0;
      for (let i = 1; i < edges.length - 1; i++) {
        if (edges[i + 1] - edges[i] > edges[widest + 1] - edges[widest]) widest = i;
      }
      picked.push((edges[widest] + edges[widest + 1]) / 2);
      picked.sort((a, b) => a - b);
    }
  }
  return picked;
}

function measure(a, from, to) {
  const v = [];
  for (let i = 0; i < a.times.length; i++) {
    if (a.times[i] >= from && a.times[i] < to && !Number.isNaN(a.semis[i])) v.push(a.semis[i]);
  }
  if (v.length < MIN_VOICED_FRAMES) return null;
  const edge = Math.max(2, Math.round(v.length * 0.25));
  const avg = (s) => s.reduce((x, y) => x + y, 0) / s.length;
  const start = avg(v.slice(0, edge));
  const end = avg(v.slice(-edge));
  const low = Math.min(...v);
  return { start, end, move: end - start, mean: avg(v), dip: Math.min(start, end) - low };
}

function toneRemark(label, m, y) {
  const size = Math.abs(m.move);
  const sign = Math.sign(m.move);
  if (size >= 2.5 && y.move * sign < size * 0.4) {
    const n = round(y.move);
    const yours = Math.abs(y.move) < 0.7 ? t('advice.yoursFlat') : y.move * sign < 0 ? t('advice.yoursOpposite', { n }) : t('advice.yoursLess', { n });
    return { text: t(sign > 0 ? 'advice.up' : 'advice.down', { label, a: round(m.move), yours }), severity: Math.abs(m.move - y.move) };
  }
  if (size < 1.5 && Math.abs(y.move) >= 3) {
    return { text: t(y.move > 0 ? 'advice.flatUp' : 'advice.flatDown', { label, n: round(y.move) }), severity: Math.abs(y.move) };
  }
  if (m.dip >= 1.5 && y.dip < m.dip * 0.4) {
    return { text: t('advice.dip', { label }), severity: m.dip - y.dip };
  }
  const gap = y.mean - m.mean;
  if (Math.abs(gap) >= 3) {
    return { text: t(gap > 0 ? 'advice.higher' : 'advice.lower', { label, n: round(gap) }), severity: Math.abs(gap) * 0.8 };
  }
  return null;
}

function percentileSpread(semis) {
  const v = Array.from(semis).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length < 20) return null;
  return v[Math.floor(v.length * 0.95)] - v[Math.floor(v.length * 0.05)];
}

// Only the first part of the syllable: lateness shows at the attack, while the
// endings of a late and an on-time syllable often coincide.
function localLag(model, take, from, to) {
  const frames = [];
  const until = from + (to - from) * 0.6;
  model.times.forEach((t, i) => {
    if (t >= from && t < until) frames.push(i);
  });
  if (frames.length < 12) return null;
  const a = frames.map((i) => model.energy[i]);
  let best = { lag: 0, score: -1 };
  for (let shift = -LOCAL_SEARCH_FRAMES; shift <= LOCAL_SEARCH_FRAMES; shift++) {
    const b = frames.map((i) => take.energy[i + shift]);
    if (b.some((v) => v === undefined)) continue;
    const ma = a.reduce((x, y) => x + y) / a.length;
    const mb = b.reduce((x, y) => x + y) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    a.forEach((v, k) => {
      sab += (v - ma) * (b[k] - mb);
      saa += (v - ma) ** 2;
      sbb += (b[k] - mb) ** 2;
    });
    const score = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
    if (score > best.score) best = { lag: shift * 0.01, score };
  }
  return best.score >= 0.6 ? best.lag : null;
}

export function adviseTake(model, take, cuts, chars) {
  const end = model.times.length ? model.times[model.times.length - 1] + 0.05 : 0;
  const edges = [0, ...cuts, end];
  const named = chars && chars.length === edges.length - 1;
  const items = [];
  const lags = [];
  let measured = 0;
  const spans = edges.length - 1;

  for (let i = 0; i < spans; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    const label = named ? chars[i] : t('advice.stretch', { n: i + 1 });
    const m = measure(model, from, to);
    if (!m) continue;
    const y = measure(take, from, to);
    const lag = localLag(model, take, from, to);
    if (lag !== null) lags.push({ lag, from, to, label });
    if (!y) continue;
    measured++;
    const remark = toneRemark(label, m, y);
    if (remark) items.push({ ...remark, from, to });
  }

  if (measured < Math.max(1, Math.ceil(spans / 2))) {
    return { items: [], note: t('advice.tooQuiet') };
  }

  if (lags.length >= 3) {
    const sorted = lags.map((l) => l.lag).sort((a, b) => a - b);
    const typical = sorted[sorted.length >> 1];
    for (const l of lags) {
      const off = l.lag - typical;
      if (Math.abs(off) < LATE_SECONDS) continue;
      items.push({
        text: t(off > 0 ? 'advice.late' : 'advice.early', { label: l.label, ms: Math.round(Math.abs(off) * 1000) }),
        severity: (Math.abs(off) / LATE_SECONDS) * 1.5,
        from: l.from,
        to: l.to,
      });
    }
  }

  const mSpread = percentileSpread(model.semis);
  const ySpread = percentileSpread(take.semis);
  if (mSpread !== null && ySpread !== null && mSpread >= 5 && ySpread < mSpread * 0.6) {
    items.push({
      text: t('advice.flatOverall', { you: round(ySpread), model: round(mSpread) }),
      severity: (mSpread - ySpread) * 0.6,
    });
  }

  items.sort((a, b) => b.severity - a.severity);
  const top = items.slice(0, MAX_ITEMS);
  return top.length ? { items: top } : { items: [], note: t('advice.noneBig') };
}
