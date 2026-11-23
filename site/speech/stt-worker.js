// Speech-to-text in a background thread, so the page stays responsive while Whisper runs.

let pipe = null;
let options = {};

const post = (message, transfer) => self.postMessage(message, transfer ?? []);

async function importFirst(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      return await import(url);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error('could not load transformers.js: ' + errors.join('; '));
}

async function hasWebGpu() {
  try {
    return Boolean(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load({ libs, model, device, webgpuDtype, wasmDtype }) {
  const lib = await importFirst(libs);
  lib.env.allowLocalModels = false;
  let chosen = device === 'auto' ? ((await hasWebGpu()) ? 'webgpu' : 'wasm') : device;

  const open = (dev) => lib.pipeline('automatic-speech-recognition', model, {
    device: dev,
    dtype: dev === 'webgpu' ? webgpuDtype : wasmDtype,
    progress_callback: (p) => {
      if (p.status === 'progress') post({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });

  try {
    pipe = await open(chosen);
  } catch (e) {
    if (chosen !== 'webgpu') throw e;
    post({ type: 'warning', message: `Speech recognition couldn't use the GPU (${e.message}); using the CPU instead.` });
    chosen = 'wasm';
    pipe = await open(chosen);
  }

  // Multilingual Whisper models need the language; .en and Moonshine models don't.
  options = /whisper/i.test(model) && !/\.en$/i.test(model) ? { language: 'english', task: 'transcribe' } : {};

  // Warm-up: the first run compiles GPU shaders, which would otherwise delay your first sentence.
  await pipe(new Float32Array(16000), options);
  post({ type: 'ready', device: chosen });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data);
    } else if (data.type === 'transcribe') {
      const t0 = performance.now();
      const out = await pipe(data.audio, options);
      post({ type: 'result', id: data.id, text: (out?.text ?? '').trim(), ms: performance.now() - t0 });
    }
  } catch (e) {
    post({ type: 'error', id: data.id, message: e?.message ?? String(e) });
  }
};
