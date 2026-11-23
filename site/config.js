// Client settings. Values marked "user setting" can be changed per device in the page's
// Voice settings panel; these are the defaults.

export const config = {
  apiBase: '/api',
  agent: 'voice',

  // Libraries load from jsDelivr for now; later they'll be served from spacejockey.
  libs: {
    transformers: [
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm',
    ],
    kokoro: [
      'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
      'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm',
    ],
    ortScript: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js',
    ortWasmBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
    vadScript: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js',
    vadAssetBase: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/',
  },

  // Voice activity detection: how long a pause ends your turn.
  vad: {
    endSilenceMs: 600,
    minSpeechMs: 250,
  },

  // Speech-to-text. small.en was most accurate in the desktop test; base.en is lighter.
  stt: {
    model: 'onnx-community/whisper-small.en',        // user setting
    device: 'auto',                                    // user setting: auto | webgpu | wasm
    webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    wasmDtype: 'q8',
    // Words recognition gets wrong, fixed before the text is sent.
    corrections: [
      [/\b(?:Jama|Jamas|Jammus|Jamis|Jomis|Jarmus|Jamaus|Jamus|Jomas)\b/gi, 'Jhomas'],
      [/\bradar and sonar\b/gi, 'Radarr and Sonarr'],
      [/\bsonar and radar\b/gi, 'Sonarr and Radarr'],
      [/\b(?:llama|lama|lumb|loma|lamb)[ -]?swap\b/gi, 'llama-swap'],
      [/\bjelly[ -]?fin+\b/gi, 'Jellyfin'],
      [/\bopen code\b/gi, 'OpenCode'],
    ],
  },

  // Text-to-speech. The patched export works on AMD WebGPU, where stock Kokoro produces noise.
  tts: {
    model: 'DevAmarnadh/Kokoro-82M-v1.0-ONNX-webgpu', // user setting
    device: 'auto',                                    // user setting
    webgpuDtype: 'fp32',
    wasmDtype: 'q8',
    voice: 'am_michael',                               // user setting
    speed: 1.3,                                        // user setting
  },

  // Said by the page itself when the agent can't (it ends the turn silently after a denial).
  lines: {
    denied: "Okay, I won't run it.",
  },
};
