// Library locations for the Milestone 0 test pages.
// The tests load libraries from jsDelivr and models from Hugging Face directly.
// The finished client will serve both from spacejockey instead.

export const TRANSFORMERS_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm',
];

export const KOKORO_URLS = [
  'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
  'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm',
];

// Voice activity detection (Silero VAD) and the ONNX runtime it needs.
export const ORT_SCRIPT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js';
export const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
export const VAD_SCRIPT = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js';
export const VAD_ASSET_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
