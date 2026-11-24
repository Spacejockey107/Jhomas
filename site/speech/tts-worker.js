// Text-to-speech (Kokoro) in a background thread.

import { timeStretch } from './stretch.js';

let tts = null;

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
  throw new Error('could not load kokoro-js: ' + errors.join('; '));
}

async function hasWebGpu() {
  try {
    return Boolean(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load({ libs, model, device, webgpuDtype, wasmDtype, voice }) {
  const { KokoroTTS } = await importFirst(libs);
  let chosen = device === 'auto' ? ((await hasWebGpu()) ? 'webgpu' : 'wasm') : device;

  const open = (dev) => KokoroTTS.from_pretrained(model, {
    device: dev,
    dtype: dev === 'webgpu' ? webgpuDtype : wasmDtype,
    progress_callback: (p) => {
      if (p.status === 'progress') post({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });

  try {
    tts = await open(chosen);
  } catch (e) {
    if (chosen !== 'webgpu') throw e;
    post({ type: 'warning', message: `Speech synthesis couldn't use the GPU (${e.message}); using the CPU instead.` });
    chosen = 'wasm';
    tts = await open(chosen);
  }

  await tts.generate('Ready.', { voice }); // warm-up: compiles GPU shaders before the first real sentence
  post({ type: 'ready', device: chosen });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data);
    } else if (data.type === 'synthesize') {
      const t0 = performance.now();
      const audio = await tts.generate(data.text, { voice: data.voice, speed: data.speed });
      const source = audio.audio ?? audio.data;
      if (!(source instanceof Float32Array)) throw new Error('unexpected audio format from kokoro-js');
      const rate = audio.sampling_rate ?? 24000;
      // Extra speed-up happens here, off the page's main thread.
      const stretched = timeStretch(source, data.playbackRate ?? 1, rate);
      const samples = stretched === source ? source.slice() : stretched.slice(); // own copy, so it can be transferred
      post({ type: 'result', id: data.id, samples, rate, ms: performance.now() - t0 }, [samples.buffer]);
    }
  } catch (e) {
    post({ type: 'error', id: data.id, message: e?.message ?? String(e) });
  }
};
