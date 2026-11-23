// Client settings. Per-device overrides can come later; these are the defaults.

export const config = {
  apiBase: '/api',
  agent: 'voice',

  // Text-to-speech (Milestone 2). The patched export works on AMD WebGPU, where the
  // stock Kokoro export produces noise.
  tts: {
    model: 'DevAmarnadh/Kokoro-82M-v1.0-ONNX-webgpu',
    device: 'webgpu',
    dtype: 'fp32',
    voice: 'am_michael',
    speed: 1.3,
  },

  // Speech-to-text (Milestone 2). Most accurate in the desktop test; base.en is the lighter option.
  stt: {
    model: 'onnx-community/whisper-small.en',
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
};
