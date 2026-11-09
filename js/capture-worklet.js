// Runs on the audio thread. MediaRecorder is avoided because it compresses and
// starts at an unknown moment; `currentFrame` ties each sample to the playback clock.
const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BLOCK);
    this.filled = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (this.filled === 0) this.startFrame = currentFrame + i;
      this.buffer[this.filled++] = channel[i];
      if (this.filled === BLOCK) {
        this.port.postMessage({ frame: this.startFrame, data: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
