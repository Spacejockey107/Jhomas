import { $, now, ms, sec, makeLogger, environment, renderEnvironment, importFirst, audioContext, copyText, escapeHtml, errorText } from './common.js';
import { KOKORO_URLS } from './libs.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const logger = makeLogger($('log'));
let env = null;
let tts = null;
let loadInfo = null;
const runs = [];

$('speed').oninput = () => ($('speedValue').textContent = `${Number($('speed').value).toFixed(2)}×`);

$('device').onchange = () => {
  $('dtype').value = $('device').value === 'webgpu' ? 'fp32' : 'q8';
};

$('load').onclick = async () => {
  $('load').disabled = true;
  $('speak').disabled = true;
  try {
    $('loadStatus').textContent = 'Loading kokoro-js…';
    const { KokoroTTS } = await importFirst(KOKORO_URLS);
    const device = $('device').value;
    const dtype = $('dtype').value;
    let lastPct = -10;
    const t0 = now();
    const modelId = $('model').value.trim() || MODEL_ID;
    tts = await KokoroTTS.from_pretrained(modelId, {
      device,
      dtype,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.progress - lastPct >= 10) {
          lastPct = p.progress;
          $('loadStatus').textContent = `Downloading ${p.file}: ${Math.round(p.progress)}%`;
        }
      },
    });
    const loadMs = now() - t0;

    // One throwaway generation so shader compilation isn't counted as speech time.
    $('loadStatus').textContent = 'Warming up…';
    const t1 = now();
    await tts.generate('Ready.', { voice: $('voice').value.trim() });
    const warmupMs = now() - t1;

    loadInfo = { modelId, device, dtype, loadMs, warmupMs };
    $('loadStatus').textContent = `Loaded in ${ms(loadMs)}, warm-up ${ms(warmupMs)}`;
    logger.log(`Kokoro loaded: ${device}, ${dtype}, load ${ms(loadMs)}, warm-up ${ms(warmupMs)}`);
    $('speak').disabled = false;
  } catch (e) {
    $('loadStatus').textContent = 'Load failed';
    logger.log(errorText(e));
  } finally {
    $('load').disabled = false;
  }
};

function splitSentences(text) {
  return text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

function samplesOf(audio) {
  // kokoro-js returns a RawAudio object: samples in .audio, rate in .sampling_rate.
  const samples = audio.audio ?? audio.data;
  const rate = audio.sampling_rate ?? audio.sampleRate ?? 24000;
  if (!(samples instanceof Float32Array)) throw new Error('unexpected audio format from kokoro-js');
  return { samples, rate };
}

$('speak').onclick = async () => {
  if (!tts) return;
  $('speak').disabled = true;
  $('results').innerHTML = '';
  $('first').textContent = '…';
  const voice = $('voice').value.trim();
  const sentences = splitSentences($('text').value);
  const ctx = audioContext();
  await ctx.resume();

  const run = { ...loadInfo, voice, speed: Number($('speed').value), sentences: [], firstAudioMs: null, gaps: 0 };
  const start = now();
  let playheadEnd = 0; // AudioContext time when queued audio finishes

  try {
    for (let i = 0; i < sentences.length; i++) {
      $('speakStatus').textContent = `Generating sentence ${i + 1} of ${sentences.length}…`;
      const t0 = now();
      const { samples, rate } = samplesOf(await tts.generate(sentences[i], { voice, speed: run.speed }));
      const genMs = now() - t0;

      // Queue it right after the previous sentence. If the previous one already
      // finished before this one was ready, there was an audible gap.
      const late = i > 0 && ctx.currentTime > playheadEnd;
      if (late) run.gaps++;
      // Fade the first and last 5 ms so clips don't click when they start and stop.
      const fade = Math.min(Math.floor(rate * 0.005), Math.floor(samples.length / 2));
      for (let k = 0; k < fade; k++) {
        const g = k / fade;
        samples[k] *= g;
        samples[samples.length - 1 - k] *= g;
      }
      const buf = ctx.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, playheadEnd);
      src.start(startAt);
      playheadEnd = startAt + buf.duration;

      if (i === 0) {
        run.firstAudioMs = now() - start;
        $('first').textContent = ms(run.firstAudioMs);
        $('first').className = 'big ' + (run.firstAudioMs < 500 ? 'pass' : run.firstAudioMs < 1000 ? '' : 'fail');
      }
      run.sentences.push({ text: sentences[i], genMs, audioSec: buf.duration, late });
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(sentences[i])}</td><td>${ms(genMs)}</td><td>${sec(buf.duration)}</td>
        <td>${i === 0 ? '—' : late ? '<span class="fail">no, gap</span>' : '<span class="pass">yes</span>'}</td>`;
      $('results').appendChild(tr);
    }
    runs.push(run);
    $('speakStatus').textContent = run.gaps ? `Done, ${run.gaps} gap(s)` : 'Done, no gaps';
    logger.log(`Spoke ${sentences.length} sentences: first audio ${ms(run.firstAudioMs)}, gaps ${run.gaps}`);
  } catch (e) {
    $('speakStatus').textContent = 'Failed';
    logger.log(errorText(e));
  } finally {
    $('speak').disabled = false;
  }
};

$('copy').onclick = (ev) => {
  const lines = ['TTS test results'];
  if (loadInfo) lines.push(`${loadInfo.modelId} ${loadInfo.device}, ${loadInfo.dtype}: load ${ms(loadInfo.loadMs)}, warm-up ${ms(loadInfo.warmupMs)}`);
  runs.forEach((r, n) => {
    lines.push(`Run ${n + 1} (${r.device}, ${r.dtype}, ${r.voice}, speed ${r.speed}): first audio ${ms(r.firstAudioMs)}, gaps ${r.gaps}`);
    r.sentences.forEach((s, i) => lines.push(`  ${i + 1}. generate ${ms(s.genMs)}, audio ${sec(s.audioSec)}${s.late ? ', GAP' : ''}`));
  });
  lines.push('', 'Environment: ' + JSON.stringify(env));
  copyText(lines.join('\n'), ev.target);
};

env = await environment();
renderEnvironment($('env'), env);
if (!env.webgpu) {
  $('device').value = 'wasm';
  $('dtype').value = 'q8';
}
