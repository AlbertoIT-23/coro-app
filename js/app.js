import {
  MAX_SESSION_SECONDS,
  Session,
  StoredSession,
  getContext,
  isBluetoothLabel,
  listMics,
  openMic,
  periodFor,
  play,
  preferredMic,
  stopPlayback,
  toMono,
} from './audio.js';
import { analyze, downsample } from './pitch.js';
import { spectrogram } from './spectrogram.js';
import { colors, drawEditor, drawPitch, drawSpectrogram, drawWave } from './draw.js';
import { adviseTake, hanziOf, syllableCuts } from './advice.js';
import { encodeWav } from './wav.js';
import * as db from './db.js';
import { detectLang, getLang, setLang, t, translatePage } from './i18n.js';

const $ = (id) => document.getElementById(id);
const MIN_SELECTION = 0.3;
const MAX_SELECTION = 30;
const HANDLE_REACH = 30;
const CUT_REACH = 20;
const CUT_MARGIN = 0.06;
const SAVE_RATE = 16000;
const VIEW_DEFAULTS = { pitch: true, waves: true, spec: false, ghost: false, advice: true };

const prefs = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const state = {
  clip: null,
  clipId: null,
  text: '',
  savedCuts: null,
  sel: { a: 0, b: 0 },
  view: { a: 0, b: 0 },
  editor: null,
  model: null,
  session: null,
  replay: false,
  micSettings: null,
  micLabel: '',
  shown: null,
  follow: true,
  firstEver: null,
  pitchGeom: null,
  views: { ...VIEW_DEFAULTS, ...prefs.read('coro.views', {}) },
  drag: null,
  cutDrag: null,
};

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let lastStatus = null;

function setStatus(key, params = {}, isError = false) {
  lastStatus = { key, params };
  const el = $('status');
  el.textContent = t(key, params);
  el.classList.toggle('error', isError);
}

const setError = (key, params = {}) => setStatus(key, params, true);

function startLabel() {
  $('start').textContent = t(state.session?.running ? 'start.stop' : 'start.go');
}

// ---- Loading the clip ------------------------------------------------------

async function loadArrayBuffer(data, name) {
  if (state.session?.running) finish();
  stopPlayback();
  setStatus('status.reading');
  const ctx = await getContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    setError('status.badFile');
    return;
  }
  const mono = toMono(decoded);
  useClip({ name, mono, ctx });
  state.sel = { a: 0, b: Math.min(decoded.duration, decoded.duration <= 8 ? decoded.duration : 5) };
  state.text = '';
  $('text').value = '';
  $('clip').hidden = false;
  refreshEditor();
  selectionChanged();
  setStatus('status.clipReady');
}

function useClip({ name, mono, ctx }) {
  const buffer = ctx.createBuffer(1, mono.length, ctx.sampleRate);
  buffer.copyToChannel(mono, 0);
  state.clip = { name, mono, buffer, rate: ctx.sampleRate, dur: mono.length / ctx.sampleRate };
  state.view = { a: 0, b: state.clip.dur };
  state.model = null;
  state.replay = false;
  $('clip-name').textContent = name;
}

function refreshEditor() {
  if (!state.clip) return;
  state.editor = drawEditor($('editor'), state.clip.mono, state.clip.rate, state.view, state.sel);
  const { a, b } = state.sel;
  $('sel-info').textContent = `${a.toFixed(2)} – ${b.toFixed(2)} s · ${(b - a).toFixed(2)} s`;
  const wide = state.view.b - state.view.a >= state.clip.dur - 1e-3;
  $('zoom').textContent = t(wide ? 'clip.zoomIn' : 'clip.zoomOut');
}

function selectionChanged() {
  state.model = null;
  state.clipId = null;
  state.savedCuts = null;
  state.firstEver = null;
  state.replay = false;
  updateEstimate();
  if (state.session?.running) return;
  state.session = null;
  state.shown = null;
  renderTakes();
  renderStage();
}

function getModel() {
  if (state.model || !state.clip) return state.model;
  const { rate, mono } = state.clip;
  const samples = mono.slice(Math.round(state.sel.a * rate), Math.round(state.sel.b * rate));
  const analysis = analyze(samples, rate);
  const cuts = state.savedCuts || syllableCuts(analysis, hanziOf(state.text).length);
  state.savedCuts = null;
  state.model = { samples, rate, analysis, cuts, spec: null };
  return state.model;
}

function textChanged() {
  state.text = $('text').value;
  if (state.model) state.model.cuts = syllableCuts(state.model.analysis, hanziOf(state.text).length);
  renderStage();
}

async function saveClipDetails() {
  if (!state.clipId || !state.model) return;
  const clip = await db.getClip(state.clipId);
  if (clip) await db.putClip({ ...clip, text: state.text, cuts: state.model.cuts });
}

function bindEditor() {
  const canvas = $('editor');
  const pointerX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  let before = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.editor || state.session?.running) return;
    const x = pointerX(e);
    const toA = Math.abs(x - state.editor.xa);
    const toB = Math.abs(x - state.editor.xb);
    // Only a touch on a handle counts, so a stray tap can't wipe the results below.
    if (Math.min(toA, toB) > HANDLE_REACH) return;
    state.drag = toA <= toB ? 'a' : 'b';
    before = { ...state.sel };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state.drag) moveHandle(pointerX(e));
  });
  const end = () => {
    if (!state.drag) return;
    state.drag = null;
    if (before.a !== state.sel.a || before.b !== state.sel.b) selectionChanged();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function moveHandle(x) {
  const t = Math.max(0, Math.min(state.clip.dur, state.editor.toTime(x)));
  const s = state.sel;
  if (state.drag === 'a') s.a = Math.max(s.b - MAX_SELECTION, Math.min(t, s.b - MIN_SELECTION));
  else s.b = Math.min(s.a + MAX_SELECTION, Math.max(t, s.a + MIN_SELECTION));
  refreshEditor();
}

function bindCuts() {
  const canvas = $('pitch');
  const pointerX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  canvas.addEventListener('pointerdown', (e) => {
    const model = state.model;
    if (!model || !state.pitchGeom || state.session?.running) return;
    const x = pointerX(e);
    let best = -1;
    let bestDistance = CUT_REACH;
    model.cuts.forEach((t, i) => {
      const distance = Math.abs(state.pitchGeom.X(t) - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    if (best < 0) return;
    state.cutDrag = best;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state.cutDrag === null) return;
    const model = state.model;
    const i = state.cutDrag;
    const dur = model.samples.length / model.rate;
    const low = (i ? model.cuts[i - 1] : 0) + CUT_MARGIN;
    const high = (i < model.cuts.length - 1 ? model.cuts[i + 1] : dur) - CUT_MARGIN;
    model.cuts[i] = Math.max(low, Math.min(high, state.pitchGeom.toTime(pointerX(e))));
    renderStage();
  });
  const end = () => {
    if (state.cutDrag === null) return;
    state.cutDrag = null;
    saveClipDetails().catch(() => {});
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

// ---- Exercise settings -----------------------------------------------------

function readConfig() {
  const dur = state.sel.b - state.sel.a;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const gap = Number($('gap').value);
  const period = periodFor(mode, dur, gap);
  const amount = Math.max(1, Number($('amount').value) || 1);
  let reps = $('unit').value === 'min' ? Math.ceil((amount * 60) / period) : Math.round(amount);
  reps = Math.max(1, Math.min(reps, Math.floor(MAX_SESSION_SECONDS / period)));
  return { dur, mode, gap, reps, period };
}

function updateEstimate() {
  if (!state.clip) return;
  const { reps, period } = readConfig();
  const total = reps * period;
  const mins = Math.floor(total / 60);
  const secs = Math.round(total % 60);
  const time = `${mins ? `${mins} min ` : ''}${secs} s`;
  $('estimate').textContent = t(reps === 1 ? 'setup.estimateOne' : 'setup.estimateMany', { n: reps, time });
}

async function refreshMics() {
  const mics = await listMics();
  const select = $('mic');
  const saved = prefs.read('coro.mic', null);
  select.replaceChildren(
    ...mics.map((m, i) => {
      const o = document.createElement('option');
      o.value = m.deviceId;
      o.textContent = m.label || t('setup.micN', { n: i + 1 });
      return o;
    }),
  );
  const pick = mics.find((m) => m.deviceId === saved) || preferredMic(mics);
  if (pick) select.value = pick.deviceId;
  select.disabled = false;
  $('mic-ask').hidden = true;
  micWarning();
}

function micWarning() {
  const label = $('mic').selectedOptions[0]?.textContent || '';
  $('mic-warn').hidden = !isBluetoothLabel(label);
}

// ---- Running a session -----------------------------------------------------

// A long loop with the phone untouched would otherwise let the screen sleep.
let wakeLock = null;

async function keepScreenOn() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function start() {
  try {
    if (state.replay) await trainAgain();
    if (!state.clip) {
      setError('status.needClip');
      return;
    }
    stopPlayback();
    const ctx = await getContext();
    if ($('mic').disabled) await refreshMics();
    const mic = await openMic($('mic').value || undefined);
    const model = getModel();
    const cfg = readConfig();
    state.micLabel = mic.label;
    state.micSettings = mic.settings;
    state.session = new Session({
      ctx,
      mic,
      buffer: state.clip.buffer,
      model: model.samples,
      start: state.sel.a,
      dur: cfg.dur,
      mode: cfg.mode,
      gap: cfg.gap,
      reps: cfg.reps,
    });
    state.shown = null;
    state.follow = true;
    $('shift').value = 0;
    $('shift-value').textContent = '0 ms';
    state.session.begin();
    keepScreenOn();
    startLabel();
    $('start').classList.add('stop');
    renderTakes();
    renderStage();
    refreshFirstEver();
    $('s-stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(tick);
  } catch (err) {
    if (err?.name === 'NotAllowedError') setError('status.needMic');
    else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') setError('status.noMic');
    else setError('status.cantStart', { error: err?.message || String(err) });
  }
}

function finish() {
  const s = state.session;
  if (!s) return;
  s.stop();
  releaseScreen();
  startLabel();
  $('start').classList.remove('stop');
  if (s.takes.length) setStatus('status.done', { n: s.takes.length });
  else setStatus('status.stoppedEarly');
  renderTakes();
  renderStage();
  renderDiagnostics();
  persistSession(s);
}

function tick() {
  const s = state.session;
  if (!s || !s.running) return;
  const { changed, done } = s.poll();
  if (changed) {
    if (state.follow) state.shown = s.takes[s.takes.length - 1];
    renderTakes();
    renderStage();
    renderDiagnostics();
  }
  if (done) {
    finish();
    return;
  }
  const live = s.liveView();
  if (state.views.waves) drawWave($('wave-you'), live.samples, colors().you, live.filled);
  const volume = s.mode === 'after' ? '' : live.gain === 0 ? t('status.solo') : live.gain < 1 ? t('status.volume', { pct: Math.round(live.gain * 100) }) : '';
  $('status').textContent = t('status.rep', { n: live.i + 1, total: s.reps }) + volume;
  requestAnimationFrame(tick);
}

// ---- Saving and the history ------------------------------------------------

// Long sessions add up, so by default only the takes worth comparing are kept.
function keptIndexes(takes, keepAll) {
  if (keepAll) return new Set(takes.map((t) => t.i));
  const solo = takes.filter((t) => t.solo);
  return new Set([takes[0], takes[takes.length - 1], solo[0], solo[solo.length - 1]].filter(Boolean).map((t) => t.i));
}

function takeRow(s, take, sessionId) {
  const samples = s.stored
    ? take.samples
    : Int16Array.from(downsample(s.slice(take), s.rate, SAVE_RATE), (v) => Math.max(-1, Math.min(1, v)) * 32767);
  return { sessionId, i: take.i, gain: take.gain, solo: take.solo, starred: Boolean(take.starred), auto: Boolean(take.auto), samples };
}

async function persistSession(s) {
  if (!s.takes.length) return;
  try {
    const model = getModel();
    if (!state.clipId) {
      const id = newId();
      await db.putClip({ id, name: state.clip.name, text: state.text, rate: model.rate, mono: model.samples, cuts: model.cuts, createdAt: Date.now() });
      state.clipId = id;
    } else {
      await saveClipDetails();
    }
    const id = newId();
    const keep = keptIndexes(s.takes, $('keep-all').checked);
    const kept = s.takes.filter((take) => keep.has(take.i));
    kept.forEach((take) => (take.auto = true));
    await db.saveSession(
      { id, clipId: state.clipId, createdAt: Date.now(), mode: s.mode, rate: SAVE_RATE, offset: s.autoOffset, reps: s.takes.length },
      kept.map((take) => takeRow(s, take, id)),
    );
    kept.forEach((take) => (take.saved = true));
    s.dbId = id;
    db.askToKeepData();
    setStatus('status.saved', { n: s.takes.length });
    await refreshHistory();
    await refreshFirstEver();
    renderStage();
  } catch {
    setError('status.saveFailed');
  }
}

async function toggleStar() {
  const s = state.session;
  const take = state.shown;
  if (!s?.dbId || !take || take.auto) return;
  take.starred = !take.starred;
  if (take.starred) {
    await db.putTake(takeRow(s, take, s.dbId));
    take.saved = true;
  } else {
    await db.deleteTake(s.dbId, take.i);
    take.saved = false;
  }
  renderStage();
}

async function refreshFirstEver() {
  state.firstEver = null;
  if (!state.clipId) return;
  const oldest = await db.oldestSessionOf(state.clipId);
  if (!oldest || oldest.id === state.session?.dbId) return;
  const rows = await db.takesOf(oldest.id);
  if (!rows.length) return;
  state.firstEver = analyze(Float32Array.from(rows[0].samples, (v) => v / 32767), SAVE_RATE);
}

async function refreshHistory() {
  let sessions = [];
  try {
    sessions = await db.listSessions();
  } catch {
    return;
  }
  const names = new Map();
  for (const s of sessions) {
    if (!names.has(s.clipId)) {
      const clip = await db.getClip(s.clipId);
      names.set(s.clipId, clip ? clip.text || clip.name : t('history.unnamed'));
    }
  }
  $('s-history').hidden = sessions.length === 0;
  $('history').replaceChildren(
    ...sessions.map((s) => {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'history-open';
      const title = document.createElement('b');
      title.textContent = names.get(s.clipId);
      const when = new Date(s.createdAt).toLocaleString(getLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const line = document.createElement('span');
      const reps = t(s.reps === 1 ? 'history.repsOne' : 'history.repsMany', { n: s.reps });
      line.textContent = t('history.line', { when, mode: t(`mode.${s.mode}`), reps });
      open.append(title, line);
      open.addEventListener('click', () => openStored(s.id));
      const del = document.createElement('button');
      del.className = 'btn small-btn';
      del.textContent = t('history.delete');
      del.addEventListener('click', async () => {
        if (!confirm(t('history.confirm'))) return;
        if (state.session?.dbId === s.id) closeReplay();
        await db.deleteSession(s.id);
        refreshHistory();
      });
      row.append(open, del);
      return row;
    }),
  );
}

function closeReplay() {
  if (!state.replay) return;
  state.replay = false;
  state.model = null;
  state.session = null;
  state.shown = null;
  renderTakes();
  renderStage();
}

async function openStored(id) {
  if (state.session?.running) return;
  stopPlayback();
  const meta = await db.getSession(id);
  const clip = meta && (await db.getClip(meta.clipId));
  if (!clip) {
    setError('status.notFound');
    return;
  }
  const rows = await db.takesOf(id);
  const samples = downsample(clip.mono, clip.rate, SAVE_RATE);
  state.model = { samples, rate: SAVE_RATE, analysis: analyze(samples, SAVE_RATE), cuts: [...clip.cuts], spec: null };
  state.replay = true;
  state.clipId = meta.clipId;
  state.text = clip.text || '';
  $('text').value = state.text;
  state.session = new StoredSession(meta, rows);
  state.shown = state.session.takes[state.session.takes.length - 1] || null;
  state.follow = false;
  await refreshFirstEver();
  renderTakes();
  renderStage();
  setStatus('status.reopened', { name: clip.text || clip.name });
  $('s-stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Brings a saved phrase back as the current clip, ready for a new session.
async function trainAgain() {
  const clip = await db.getClip(state.clipId);
  if (!clip) return;
  const ctx = await getContext();
  const mono = clip.rate === ctx.sampleRate ? clip.mono : downsample(clip.mono, clip.rate, ctx.sampleRate);
  const id = state.clipId;
  useClip({ name: clip.name, mono, ctx });
  state.clipId = id;
  state.sel = { a: 0, b: state.clip.dur };
  state.savedCuts = clip.cuts;
  state.text = clip.text || '';
  $('text').value = state.text;
  state.session = null;
  state.shown = null;
  $('clip').hidden = false;
  refreshEditor();
  updateEstimate();
  renderTakes();
  renderStage();
}

// ---- Showing results -------------------------------------------------------

function takeAnalysis(take) {
  const s = state.session;
  const key = Math.round(s.takeStart(take) * 1000);
  if (take.cache?.key !== key) {
    const samples = s.slice(take);
    take.cache = { key, samples, analysis: analyze(samples, s.rate), spec: null };
  }
  return take.cache;
}

function renderTakes() {
  const row = $('takes');
  const takes = state.session?.takes || [];
  $('takes-wrap').hidden = takes.length === 0;
  row.replaceChildren(
    ...takes.map((take) => {
      const b = document.createElement('button');
      b.className = 'take' + (take === state.shown ? ' on' : '') + (take.solo ? ' solo' : '');
      b.textContent = take.i + 1;
      b.title = t(take.solo ? 'take.solo' : 'take.withModel');
      b.setAttribute('aria-pressed', take === state.shown);
      b.addEventListener('click', () => {
        state.shown = take;
        state.follow = take === takes[takes.length - 1];
        renderTakes();
        renderStage();
      });
      return b;
    }),
  );
  if (state.follow) row.scrollLeft = row.scrollWidth;
}

function renderAdvice(model, shown) {
  const box = $('panel-advice');
  const list = $('advice');
  const note = $('advice-note');
  if (!state.views.advice || !shown) {
    box.hidden = true;
    return [];
  }
  const result = adviseTake(model.analysis, shown.analysis, model.cuts, hanziOf(state.text));
  list.replaceChildren(
    ...result.items.map((item) => {
      const li = document.createElement('li');
      li.textContent = item.text;
      return li;
    }),
  );
  list.hidden = result.items.length === 0;
  note.hidden = !result.note;
  note.textContent = result.note || '';
  box.hidden = false;
  return result.items.filter((i) => i.from !== undefined);
}

function renderStage() {
  const hasContent = Boolean(state.clip || state.replay);
  $('s-stage').hidden = !hasContent;
  if (!hasContent) return;
  const v = state.views;
  document.querySelectorAll('[data-view]').forEach((el) => {
    const on = v[el.dataset.view];
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on);
  });
  $('panel-pitch').hidden = !v.pitch;
  $('panel-waves').hidden = !v.waves;
  $('panel-spec').hidden = !v.spec;
  $('legend-ghost').hidden = !v.ghost;

  const s = state.session;
  const model = getModel();
  const take = state.shown;
  const shown = take ? takeAnalysis(take) : null;
  const c = colors();
  const dur = model.samples.length / model.rate;
  const running = Boolean(s?.running);

  $('take-title').textContent = take
    ? t(take.solo ? 'title.repSolo' : 'title.rep', { n: take.i + 1 })
    : t(running ? 'title.speak' : 'title.empty');
  $('play-row').hidden = !take || running;
  $('again').hidden = !state.replay;
  $('shift-row').hidden = Boolean(s?.stored);
  $('you-label').textContent = t(running ? 'lane.youLive' : 'lane.you');
  const autoSaved = Boolean(take?.auto);
  $('star').disabled = !s?.dbId || autoSaved;
  $('star').textContent = t(autoSaved ? 'star.auto' : take?.starred ? 'star.on' : 'star.off');
  $('star').classList.toggle('kept', Boolean(take?.starred));

  const bands = renderAdvice(model, shown);

  if (v.pitch) {
    let ghost = null;
    if (v.ghost) {
      if (state.firstEver) ghost = state.firstEver;
      else if (s?.takes.length && take !== s.takes[0]) ghost = takeAnalysis(s.takes[0]).analysis;
    }
    const chars = hanziOf(state.text);
    state.pitchGeom = drawPitch(
      $('pitch'),
      dur,
      [
        { data: ghost, color: c.ghost, dash: true },
        { data: shown?.analysis, color: c.you },
        { data: model.analysis, color: c.model },
      ],
      { cuts: model.cuts, labels: chars.length === model.cuts.length + 1 ? chars : null, bands },
    );
    $('pitch-note').hidden = !(shown && shown.analysis.voicedRatio < 0.08);
  }
  if (v.waves) {
    drawWave($('wave-model'), model.samples, c.model);
    if (!running) drawWave($('wave-you'), shown?.samples, c.you);
  }
  if (v.spec) {
    model.spec ??= spectrogram(model.analysis.x16);
    drawSpectrogram($('spec-model'), model.spec);
    if (shown) {
      shown.spec ??= spectrogram(shown.analysis.x16);
      drawSpectrogram($('spec-you'), shown.spec);
    } else {
      drawSpectrogram($('spec-you'), null);
    }
  }
}

function renderDiagnostics() {
  const s = state.session;
  if (!s || s.stored) return;
  const ms = (v) => (typeof v === 'number' ? `${Math.round(v * 1000)} ms` : t('diag.unavailable'));
  const yn = (v) => t(v === undefined ? 'diag.undeclared' : v ? 'diag.on' : 'diag.off');
  const m = state.micSettings || {};
  const valid = s.takes.filter((k) => !k.own && k.lag !== null).length;
  const shown = state.shown?.cache?.analysis;
  const lines = [
    [t('diag.mic'), state.micLabel || t('diag.unknown')],
    [t('diag.echo'), yn(m.echoCancellation)],
    [t('diag.noise'), yn(m.noiseSuppression)],
    [t('diag.gain'), yn(m.autoGainControl)],
    [t('diag.rate'), `${s.rate} Hz`],
    [t('diag.latency'), `${ms(s.ctx.baseLatency)} + ${ms(s.ctx.outputLatency)}`],
    [t('diag.delay'), t('diag.delayValue', { ms: Math.round(s.autoOffset * 1000), n: valid })],
    [t('diag.peak'), `${Math.round(s.peak * 100)}%`],
  ];
  if (shown) lines.push([t('diag.voiced'), `${Math.round(shown.voicedRatio * 100)}%`]);
  $('diag').replaceChildren(
    ...lines.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  $('level-warn').hidden = s.peak > 0.02 && s.peak < 0.98;
  $('level-warn').textContent = t(s.peak >= 0.98 ? 'diag.clipping' : 'diag.silent');
}

async function playKind(kind) {
  const s = state.session;
  const take = state.shown;
  if (!s || !take) return;
  const ctx = await getContext();
  const model = getModel();
  const you = takeAnalysis(take).samples;
  const rate = model.rate;
  if (kind === 'model') play(ctx, model.samples, model.samples, undefined, rate);
  if (kind === 'you') play(ctx, you, you, undefined, rate);
  if (kind === 'ears') play(ctx, model.samples, you, undefined, rate);
  if (kind === 'turns') play(ctx, model.samples, model.samples, () => play(ctx, you, you, undefined, rate), rate);
}

function downloadTake() {
  const s = state.session;
  const take = state.shown;
  if (!s || !take) return;
  const url = URL.createObjectURL(new Blob([encodeWav(takeAnalysis(take).samples, s.rate)], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `coro-giro-${take.i + 1}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- Wiring ----------------------------------------------------------------

function bind() {
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await loadArrayBuffer(await f.arrayBuffer(), f.name);
    e.target.value = '';
  });
  $('sample').addEventListener('click', async () => {
    const r = await fetch('assets/esempio.wav');
    await loadArrayBuffer(await r.arrayBuffer(), t('clip.sampleName'));
    $('text').value = '妈麻马骂';
    textChanged();
  });
  $('text').addEventListener('input', textChanged);
  $('text').addEventListener('change', () => saveClipDetails().catch(() => {}));
  $('preview').addEventListener('click', async () => {
    const ctx = await getContext();
    const m = getModel();
    play(ctx, m.samples, m.samples, undefined, m.rate);
  });
  $('zoom').addEventListener('click', () => {
    const wide = state.view.b - state.view.a >= state.clip.dur - 1e-3;
    if (wide) {
      const pad = Math.max(0.5, (state.sel.b - state.sel.a) * 0.25);
      state.view = { a: Math.max(0, state.sel.a - pad), b: Math.min(state.clip.dur, state.sel.b + pad) };
    } else {
      state.view = { a: 0, b: state.clip.dur };
    }
    refreshEditor();
  });
  ['gap', 'amount', 'unit'].forEach((id) => $(id).addEventListener('input', updateEstimate));
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      $('gap-row').hidden = r.value === 'after' && r.checked;
      updateEstimate();
    }),
  );
  $('mic-ask').addEventListener('click', async () => {
    try {
      await refreshMics();
    } catch {
      setError('status.needMicList');
    }
  });
  $('mic').addEventListener('change', () => {
    prefs.write('coro.mic', $('mic').value);
    micWarning();
  });
  $('keep-all').checked = prefs.read('coro.keepAll', false);
  $('keep-all').addEventListener('change', () => prefs.write('coro.keepAll', $('keep-all').checked));
  document.querySelectorAll('[data-lang]').forEach((el) =>
    el.addEventListener('click', () => {
      setLang(el.dataset.lang);
      prefs.write('coro.lang', getLang());
      applyLanguage();
    }),
  );
  $('start').addEventListener('click', () => (state.session?.running ? finish() : start()));
  $('again').addEventListener('click', trainAgain);
  $('star').addEventListener('click', toggleStar);
  $('download').addEventListener('click', downloadTake);
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.view;
      state.views[key] = !state.views[key];
      prefs.write('coro.views', state.views);
      renderStage();
    });
  });
  document.querySelectorAll('[data-play]').forEach((el) => el.addEventListener('click', () => playKind(el.dataset.play)));
  $('shift').addEventListener('input', () => {
    const ms = Number($('shift').value);
    $('shift-value').textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    if (state.session) {
      state.session.manualShift = ms / 1000;
      renderStage();
    }
  });
  // The saved takes must match the alignment the user settled on.
  $('shift').addEventListener('change', async () => {
    const s = state.session;
    if (!s?.dbId || s.stored) return;
    await Promise.all(s.takes.filter((t) => t.saved).map((t) => db.putTake(takeRow(s, t, s.dbId))));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session?.running) keepScreenOn();
  });
  const redraw = () => {
    refreshEditor();
    renderStage();
  };
  window.addEventListener('resize', redraw);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
}

function applyLanguage() {
  translatePage();
  document.querySelectorAll('[data-lang]').forEach((el) => {
    const on = el.dataset.lang === getLang();
    el.classList.toggle('on', on);
    el.setAttribute('aria-pressed', on);
  });
  const number = new Intl.NumberFormat(getLang());
  [...$('gap').options].forEach((o) => (o.textContent = `${number.format(Number(o.value))} s`));
  startLabel();
  if (lastStatus && !state.session?.running) $('status').textContent = t(lastStatus.key, lastStatus.params);
  updateEstimate();
  refreshEditor();
  renderTakes();
  renderStage();
  renderDiagnostics();
  refreshHistory();
}

setLang(detectLang(prefs.read('coro.lang', null), navigator.language));
setStatus('status.idle');
if (!window.isSecureContext) {
  $('https-warn').hidden = false;
}
if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
  setError('status.unsupported');
  $('start').disabled = true;
}
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
bindEditor();
bindCuts();
bind();
applyLanguage();
