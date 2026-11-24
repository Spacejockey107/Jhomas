// Stand-in for kokoro-js: 1 s of 220 Hz tone per call.
export class KokoroTTS {
  static async from_pretrained() { return new KokoroTTS(); }
  async generate() {
    const rate = 24000, a = new Float32Array(rate);
    for (let i = 0; i < rate; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / rate);
    return { audio: a, sampling_rate: rate };
  }
}
