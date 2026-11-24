// Speech engines used by the voice controller. Each has the same small interface, so the
// controller doesn't care which model runs underneath (and tests can substitute fakes):
//   stt: load(onProgress), transcribe(Float32Array 16 kHz) -> text, dispose()
//   tts: load(onProgress), synthesize(text, { voice, speed }) -> { samples, rate }, dispose()
//   vad: start({ onSpeechStart, onSpeechEnd(Float32Array 16 kHz), onMisfire }), pause(), resume(), destroy()

class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.loadWaiter = null;
    this.onProgress = () => {};
    this.onWarning = () => {};
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'speech worker failed to start');
      this.loadWaiter?.reject(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  receive(data) {
    if (data.type === 'progress') return this.onProgress(data);
    if (data.type === 'warning') return this.onWarning(data.message);
    if (data.type === 'ready') return this.loadWaiter?.resolve(data);
    const waiter = data.id != null ? this.pending.get(data.id) : null;
    if (data.type === 'error') {
      if (waiter) {
        this.pending.delete(data.id);
        waiter.reject(new Error(data.message));
      } else {
        this.loadWaiter?.reject(new Error(data.message));
      }
      return;
    }
    if (data.type === 'result' && waiter) {
      this.pending.delete(data.id);
      waiter.resolve(data);
    }
  }

  load(params) {
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.worker.postMessage({ type: 'load', ...params });
    });
  }

  call(type, payload, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...payload }, transfer ?? []);
    });
  }

  dispose() {
    this.worker.terminate();
  }
}

export class SttEngine {
  constructor(config, settings) {
    this.params = {
      libs: config.libs.transformers,
      model: settings.sttModel,
      device: settings.sttDevice,
      webgpuDtype: config.stt.webgpuDtype,
      wasmDtype: config.stt.wasmDtype,
    };
    this.signature = JSON.stringify([this.params.model, this.params.device]);
    this.client = new WorkerClient(new URL('./stt-worker.js', import.meta.url));
    this.device = null;
  }

  async load(onProgress, onWarning) {
    this.client.onProgress = onProgress ?? (() => {});
    this.client.onWarning = onWarning ?? (() => {});
    const { device } = await this.client.load(this.params);
    this.device = device;
  }

  async transcribe(audio) {
    const copy = audio.slice();
    const { text, ms } = await this.client.call('transcribe', { audio: copy }, [copy.buffer]);
    this.lastMs = ms;
    return text;
  }

  dispose() {
    this.client.dispose();
  }
}

export class TtsEngine {
  constructor(config, settings) {
    this.params = {
      libs: config.libs.kokoro,
      model: settings.ttsModel,
      device: settings.ttsDevice,
      webgpuDtype: config.tts.webgpuDtype,
      wasmDtype: config.tts.wasmDtype,
      voice: settings.voice,
    };
    this.signature = JSON.stringify([this.params.model, this.params.device]);
    this.client = new WorkerClient(new URL('./tts-worker.js', import.meta.url));
    this.device = null;
  }

  async load(onProgress, onWarning) {
    this.client.onProgress = onProgress ?? (() => {});
    this.client.onWarning = onWarning ?? (() => {});
    const { device } = await this.client.load(this.params);
    this.device = device;
  }

  async synthesize(text, { voice, speed, playbackRate }) {
    const { samples, rate } = await this.client.call('synthesize', { text, voice, speed, playbackRate });
    return { samples, rate };
  }

  dispose() {
    this.client.dispose();
  }
}

// Silero VAD on the mic, via vad-web. Runs on the page; it's small.
const loadedScripts = new Map();
function loadScript(url) {
  if (!loadedScripts.has(url)) {
    loadedScripts.set(url, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${url}`));
      document.head.appendChild(s);
    }));
  }
  return loadedScripts.get(url);
}

export class MicVad {
  constructor(config, settings = {}) {
    this.config = config;
    this.settings = settings;
    this.instance = null;
  }

  async start({ onSpeechStart, onSpeechEnd, onMisfire }) {
    const { libs, vad } = this.config;
    await loadScript(libs.ortScript);
    await loadScript(libs.vadScript);
    if (!window.vad?.MicVAD) throw new Error('voice detection library loaded without MicVAD');
    const frames = (ms) => Math.max(1, Math.round(ms / 32)); // one Silero v5 frame = 32 ms
    const create = () => window.vad.MicVAD.new({
      model: 'v5',
      baseAssetPath: libs.vadAssetBase,
      onnxWASMBasePath: libs.ortWasmBase,
      // Older releases count frames, newer ones milliseconds; unknown options are ignored.
      redemptionFrames: frames(vad.endSilenceMs),
      redemptionMs: vad.endSilenceMs,
      minSpeechFrames: frames(vad.minSpeechMs),
      minSpeechMs: vad.minSpeechMs,
      getStream: () => navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
      onSpeechStart,
      onSpeechEnd,
      onVADMisfire: onMisfire,
    });
    // Run the detection model in onnxruntime's background worker so it doesn't compete
    // with scrolling and audio on the page's main thread. Fall back if that isn't supported.
    const ort = window.ort;
    // Experimental (off by default): may crash some phones.
    if (ort?.env?.wasm) {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = Boolean(this.settings.vadInWorker);
    }
    try {
      this.instance = await create();
      this.offMainThread = Boolean(ort?.env?.wasm?.proxy);
    } catch (e) {
      if (!ort?.env?.wasm?.proxy) throw e;
      ort.env.wasm.proxy = false;
      this.instance = await create();
      this.offMainThread = false;
    }
    this.instance.start();
  }

  pause() {
    this.instance?.pause();
  }

  resume() {
    this.instance?.start();
  }

  async destroy() {
    try {
      if (this.instance?.destroy) await this.instance.destroy();
      else this.instance?.pause();
    } catch { /* ignore */ }
    this.instance = null;
  }
}
