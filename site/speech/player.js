// Plays synthesized sentences back to back without gaps or clicks, and stops instantly.

const FADE_S = 0.008;

export class Player {
  constructor() {
    this.ctx = null;
    this.sources = new Set();
    this.playhead = 0;
    this.onEnded = () => {};
  }

  // Must be called from a click (browsers only allow audio to start after a user action).
  unlock() {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
    return this.ctx.resume();
  }

  get playing() {
    return this.sources.size > 0;
  }

  // Queues a sentence right after whatever is already playing. Returns seconds until it starts.
  play(samples, rate) {
    const ctx = this.ctx;
    const data = samples.slice();
    const fade = Math.min(Math.floor(FADE_S * rate), Math.floor(data.length / 2));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      data[i] *= g;
      data[data.length - 1 - i] *= g;
    }
    const buffer = ctx.createBuffer(1, data.length, rate);
    buffer.copyToChannel(data, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.onEnded();
    };
    return startAt - ctx.currentTime;
  }

  // Freezes playback in place (used while checking whether you're interrupting).
  pause() {
    if (this.ctx?.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  stop() {
    this.resume();
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.playhead = 0;
  }
}
