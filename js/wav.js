export function encodeWav(x, rate) {
  const data = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) data[i] = Math.max(-1, Math.min(1, x[i])) * 32767;
  const out = new ArrayBuffer(44 + data.byteLength);
  const v = new DataView(out);
  const tag = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + data.byteLength, true);
  tag(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, data.byteLength, true);
  new Int16Array(out, 44).set(data);
  return new Uint8Array(out);
}
