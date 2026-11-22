// Shared helpers for the Milestone 0 test pages.

import { ORT_SCRIPT, ORT_WASM_BASE, VAD_SCRIPT, VAD_ASSET_BASE } from './libs.js';

export const $ = (id) => document.getElementById(id);
export const now = () => performance.now();
export const ms = (x) => `${Math.round(x)} ms`;
export const sec = (x) => `${x.toFixed(2)} s`;

// Appends a timestamped line to a log element and returns the line.
export function makeLogger(el) {
  const start = now();
  const lines = [];
  return {
    lines,
    log(msg) {
      const t = ((now() - start) / 1000).toFixed(1).padStart(6, ' ');
      const line = `${t}s  ${msg}`;
      lines.push(line);
      el.textContent += line + '\n';
      el.scrollTop = el.scrollHeight;
      return line;
    },
    clear() {
      lines.length = 0;
      el.textContent = '';
    },
  };
}

// What this browser and device can do. Shown on every page and included in copied results.
export async function environment() {
  const env = {
    page: location.pathname,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    cpuThreads: navigator.hardwareConcurrency ?? null,
    memoryGB: navigator.deviceMemory ?? null,
    webgpu: false,
    gpu: null,
    userAgent: navigator.userAgent,
  };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        env.webgpu = true;
        const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        if (info) env.gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown';
      }
    } catch (e) {
      env.gpu = `error: ${e.message}`;
    }
  }
  return env;
}

export function renderEnvironment(el, env) {
  const yes = (b) => (b ? '<span class="pass">yes</span>' : '<span class="fail">no</span>');
  el.innerHTML = `
    <table>
      <tr><th>Secure page (HTTPS)</th><td>${yes(env.secureContext)}</td></tr>
      <tr><th>Cross-origin isolated (multithreaded WASM)</th><td>${yes(env.crossOriginIsolated)}</td></tr>
      <tr><th>WebGPU</th><td>${yes(env.webgpu)}${env.gpu ? ' — ' + escapeHtml(env.gpu) : ''}</td></tr>
      <tr><th>CPU threads</th><td>${env.cpuThreads ?? '?'}</td></tr>
      <tr><th>Browser</th><td class="muted">${escapeHtml(env.userAgent)}</td></tr>
    </table>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Loads a classic (non-module) script once.
const loadedScripts = new Map();
export function loadScript(url) {
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

// Imports the first module URL that works.
export async function importFirst(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      return await import(url);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error('could not import library:\n' + errors.join('\n'));
}

// The mic settings the real client will use.
export function micConstraints({ echoCancellation = true } = {}) {
  return {
    audio: {
      channelCount: 1,
      echoCancellation,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

// Records `seconds` of mic audio and returns mono samples at `sampleRate`.
export async function recordClip(seconds, sampleRate = 16000, onTick = () => {}) {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
  try {
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start();
    for (let left = seconds; left > 0; left--) {
      onTick(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const ctx = new AudioContext({ sampleRate });
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      return decoded.getChannelData(0).slice();
    } finally {
      ctx.close();
    }
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// Plays mono samples once. Returns a promise that resolves when playback ends.
let sharedCtx = null;
export function audioContext() {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
  return sharedCtx;
}
export async function playSamples(samples, sampleRate) {
  const ctx = audioContext();
  await ctx.resume();
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const ended = new Promise((r) => (src.onended = r));
  src.start();
  return ended;
}

// Starts Silero VAD on the mic. `options` are passed through to MicVAD.new.
export async function startVad(options = {}, { echoCancellation = true } = {}) {
  await loadScript(ORT_SCRIPT);
  await loadScript(VAD_SCRIPT);
  const vadLib = window.vad;
  if (!vadLib?.MicVAD) throw new Error('VAD library loaded but MicVAD is missing');
  const instance = await vadLib.MicVAD.new({
    model: 'v5',
    baseAssetPath: VAD_ASSET_BASE,
    onnxWASMBasePath: ORT_WASM_BASE,
    getStream: () => navigator.mediaDevices.getUserMedia(micConstraints({ echoCancellation })),
    ...options,
  });
  instance.start();
  return instance;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = old), 1500);
    }
  } catch {
    // Clipboard can be blocked; fall back to a prompt the user can copy from.
    window.prompt('Copy this text:', text);
  }
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function errorText(e) {
  return e?.stack || e?.message || String(e);
}
