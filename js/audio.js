import { findLag } from './align.js';
import { median } from './pitch.js';

let context = null;
let workletReady = null;

export async function getContext() {
  if (!context) {
    context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    workletReady = context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
  }
  if (context.state === 'suspended') await context.resume();
  await workletReady;
  return context;
}

export function toMono(buffer) {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

export function isBluetoothLabel(label = '') {
  return /bluetooth|buds|hands-?free/i.test(label);
}

export async function listMics() {
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  probe.getTracks().forEach((t) => t.stop());
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

// Bluetooth microphones force the "phone call" profile: narrow audio and worse delay.
export function preferredMic(mics) {
  const wired = mics.filter((m) => !isBluetoothLabel(m.label));
  return (
    wired.find((m) => /speakerphone|built-?in|integrat|interno/i.test(m.label)) ||
    wired.find((m) => m.deviceId !== 'default' && m.deviceId !== 'communications') ||
    wired[0] ||
    mics[0] ||
    null
  );
}

export async function openMic(deviceId) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const track = stream.getAudioTracks()[0];
  return { stream, label: track.label, settings: track.getSettings() };
}

const PRE_ROLL = 0.4;
const TAIL = 1.0;
const FADE_STEPS = [1, 0.6, 0.3, 0];
export const MAX_SESSION_SECONDS = 15 * 60;

export function periodFor(mode, dur, gap) {
  return mode === 'after' ? dur * 2 + 0.8 : dur + gap;
}

export class Session {
  constructor({ ctx, mic, buffer, model, start, dur, mode, gap, reps }) {
    Object.assign(this, { ctx, mic, buffer, model, start, dur, mode, gap, reps });
    this.rate = ctx.sampleRate;
    this.period = periodFor(mode, dur, gap);
    this.gains = Array.from({ length: reps }, (_, i) => (mode === 'fade' ? FADE_STEPS[i % 4] : 1));
    this.takes = [];
    this.manualShift = 0;
    this.running = false;
    this.peak = 0;
    this.nextRep = 0;
    this.nodes = [];
  }

  begin() {
    const { ctx, rate } = this;
    this.t0 = ctx.currentTime + 0.8;
    this.endTime = this.t0 + this.reps * this.period + TAIL;
    this.frame0 = Math.round((this.t0 - PRE_ROLL) * rate);
    this.rec = new Float32Array(Math.ceil((this.endTime - this.t0 + PRE_ROLL + 1) * rate));
    this.written = 0;

    this.source = ctx.createMediaStreamSource(this.mic.stream);
    this.capture = new AudioWorkletNode(ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.capture.port.onmessage = (e) => this.store(e.data.frame, e.data.data);
    // Silent route so the browser keeps pulling the capture node.
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.capture).connect(this.mute).connect(ctx.destination);

    const edge = 0.005;
    this.gains.forEach((level, i) => {
      if (!level) return;
      const at = this.t0 + i * this.period;
      const node = ctx.createBufferSource();
      node.buffer = this.buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(level, at + edge);
      gain.gain.setValueAtTime(level, at + this.dur - edge);
      gain.gain.linearRampToValueAtTime(0, at + this.dur);
      node.connect(gain).connect(ctx.destination);
      node.start(at, this.start, this.dur);
      this.nodes.push({ node, gain });
    });
    this.running = true;
  }

  store(frame, data) {
    if (!this.running) return;
    let from = 0;
    let at = frame - this.frame0;
    if (at < 0) {
      from = -at;
      at = 0;
    }
    const count = Math.min(data.length - from, this.rec.length - at);
    if (count <= 0) return;
    this.rec.set(from ? data.subarray(from, from + count) : data.subarray(0, count), at);
    this.written = Math.max(this.written, at + count);
    for (let i = from; i < from + count; i++) {
      const v = Math.abs(data[i]);
      if (v > this.peak) this.peak = v;
    }
  }

  repTime(i) {
    return this.t0 + i * this.period;
  }

  // The stretch of recording searched for this repetition's voice.
  searchWindow(i) {
    const t = this.repTime(i);
    if (this.mode === 'after') return { from: t + this.dur, to: t + this.period + 0.25, own: true };
    if (this.gains[i] === 0) return { from: t - 0.3, to: t + this.dur + Math.min(0.9, this.gap + 0.35), own: true };
    return { from: t - 0.15, to: t + this.dur + 0.7, own: false };
  }

  index(t) {
    return Math.round((t - this.t0 + PRE_ROLL) * this.rate);
  }

  poll() {
    if (!this.running) return { changed: false, done: false };
    const now = this.ctx.currentTime;
    let changed = false;
    while (this.nextRep < this.reps && now >= this.searchWindow(this.nextRep).to + 0.05) {
      this.finishRep(this.nextRep);
      this.nextRep++;
      changed = true;
    }
    return { changed, done: now >= this.endTime };
  }

  finishRep(i) {
    const win = this.searchWindow(i);
    const t = this.repTime(i);
    const a = Math.max(0, this.index(win.from));
    const b = Math.min(this.rec.length, this.index(win.to));
    const { lag, score } = findLag(this.model, this.rec.subarray(a, b), this.rate);
    const found = win.from + lag - t;
    const reliable = score >= 0.4;
    this.takes.push({
      i,
      t,
      gain: this.gains[i],
      solo: this.gains[i] === 0 || this.mode === 'after',
      own: win.own,
      lag: reliable ? found : null,
      score,
      cache: null,
    });
  }

  get autoOffset() {
    const v = median(this.takes.filter((k) => !k.own && k.lag !== null).map((k) => k.lag));
    return Number.isFinite(v) ? v : 0;
  }

  takeStart(take) {
    let lag = take.own ? take.lag : this.autoOffset;
    if (lag === null) lag = this.mode === 'after' ? this.dur + 0.1 : this.autoOffset;
    return take.t + lag + this.manualShift;
  }

  sliceFrom(startTime) {
    const len = Math.round(this.dur * this.rate);
    const out = new Float32Array(len);
    const at = this.index(startTime);
    const from = Math.max(0, at);
    const end = Math.min(this.written, at + len);
    if (end > from) out.set(this.rec.subarray(from, end), from - at);
    return out;
  }

  slice(take) {
    return this.sliceFrom(this.takeStart(take));
  }

  // What the "live" lane should show right now.
  liveView() {
    const now = this.ctx.currentTime;
    const i = Math.max(0, Math.min(this.reps - 1, Math.floor((now - this.t0) / this.period)));
    const lag = this.mode === 'after' ? this.dur + 0.1 : this.autoOffset;
    const start = this.repTime(i) + lag + this.manualShift;
    const filled = Math.max(0, Math.min(1, (now - start) / this.dur));
    return { i, gain: this.gains[i], samples: this.sliceFrom(start), filled };
  }

  stop() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    while (this.nextRep < this.reps && now >= this.searchWindow(this.nextRep).to) {
      this.finishRep(this.nextRep);
      this.nextRep++;
    }
    this.running = false;
    this.nodes.forEach(({ node, gain }) => {
      try {
        node.stop();
      } catch {}
      gain.disconnect();
    });
    this.source.disconnect();
    this.capture.disconnect();
    this.capture.port.onmessage = null;
    this.mute.disconnect();
    this.mic.stream.getTracks().forEach((t) => t.stop());
  }
}

// A session reopened from the history: same shape as a live one, nothing to align.
export class StoredSession {
  constructor(meta, takes) {
    this.meta = meta;
    this.mode = meta.mode;
    this.rate = meta.rate;
    this.running = false;
    this.stored = true;
    this.dbId = meta.id;
    this.manualShift = 0;
    this.autoOffset = meta.offset;
    this.takes = takes.map((t) => ({ ...t, cache: null, saved: true }));
  }

  takeStart() {
    return 0;
  }

  slice(take) {
    return Float32Array.from(take.samples, (v) => v / 32767);
  }
}

let current = null;

export function stopPlayback() {
  if (!current) return;
  try {
    current.stop();
  } catch {}
  current = null;
}

// Each channel is normalised so that a quiet take is still audible beside the model.
export function play(ctx, left, right = left, onEnd, rate = ctx.sampleRate) {
  stopPlayback();
  const norm = (x) => {
    let top = 1e-6;
    for (const v of x) top = Math.max(top, Math.abs(v));
    return 0.85 / top;
  };
  const buffer = ctx.createBuffer(2, Math.max(left.length, right.length), rate);
  [left, right].forEach((x, c) => {
    const g = norm(x);
    const data = buffer.getChannelData(c);
    for (let i = 0; i < x.length; i++) data[i] = x[i] * g;
  });
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = () => {
    if (current === node) current = null;
    onEnd?.();
  };
  node.start();
  current = node;
}
