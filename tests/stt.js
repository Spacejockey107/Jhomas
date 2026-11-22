import { $, now, ms, sec, makeLogger, environment, renderEnvironment, importFirst, recordClip, playSamples, copyText, escapeHtml, errorText } from './common.js';
import { TRANSFORMERS_URLS } from './libs.js';

const MODELS = [
  { id: 'onnx-community/moonshine-tiny-ONNX', note: 'Moonshine tiny, 27M, English' },
  { id: 'onnx-community/moonshine-base-ONNX', note: 'Moonshine base, 61M, English' },
  { id: 'onnx-community/whisper-tiny.en', note: 'Whisper tiny, 39M, English' },
  { id: 'onnx-community/whisper-base.en', note: 'Whisper base, 74M, English' },
];

const logger = makeLogger($('log'));
const results = [];
let clip = null;
let env = null;
let transformers = null;

$('models').innerHTML = MODELS.map((m, i) => `
  <label><input type="checkbox" value="${m.id}" ${i < 2 ? 'checked' : ''}> ${m.id} <span class="muted">(${m.note})</span></label><br>`).join('');

$('device').onchange = () => {
  $('dtype').value = $('device').value === 'webgpu' ? 'mixed' : 'q8';
};

$('record').onclick = async () => {
  $('record').disabled = true;
  try {
    clip = await recordClip(5, 16000, (left) => ($('recStatus').textContent = `Recording… ${left}`));
    $('recStatus').textContent = `Recorded ${sec(clip.length / 16000)}`;
    $('play').disabled = false;
    $('run').disabled = false;
  } catch (e) {
    $('recStatus').textContent = 'Recording failed';
    logger.log(errorText(e));
  } finally {
    $('record').disabled = false;
  }
};

$('play').onclick = () => clip && playSamples(clip, 16000);

function dtypeOption(value) {
  return value === 'mixed' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : value;
}

function transcribeOptions(modelId) {
  // Multilingual Whisper models need to be told the language; .en and Moonshine models don't.
  if (/whisper/i.test(modelId) && !/\.en$/i.test(modelId)) return { language: 'english', task: 'transcribe' };
  return {};
}

function addRow(r) {
  const tr = document.createElement('tr');
  tr.innerHTML = r.error
    ? `<td>${escapeHtml(r.model)}</td><td colspan="5" class="fail">${escapeHtml(r.error)}</td>`
    : `<td>${escapeHtml(r.model)}<br><span class="muted">${r.device}, ${r.dtype}</span></td>
       <td>${ms(r.loadMs)}</td><td>${ms(r.firstMs)}</td>
       <td class="${r.warmMs < 1000 ? 'pass' : r.warmMs < 2000 ? '' : 'fail'}">${ms(r.warmMs)}</td>
       <td>${r.ratio.toFixed(2)}</td><td>${escapeHtml(r.text)}</td>`;
  $('results').appendChild(tr);
}

$('run').onclick = async () => {
  const selected = [...document.querySelectorAll('#models input:checked')].map((el) => el.value);
  const custom = $('customModel').value.trim();
  if (custom) selected.push(custom);
  if (!selected.length || !clip) return;

  $('run').disabled = true;
  const device = $('device').value;
  const dtypeName = $('dtype').value;
  const audioSeconds = clip.length / 16000;

  try {
    if (!transformers) {
      $('runStatus').textContent = 'Loading transformers.js…';
      transformers = await importFirst(TRANSFORMERS_URLS);
      logger.log('transformers.js loaded');
    }
    for (const model of selected) {
      $('runStatus').textContent = `Loading ${model}…`;
      logger.log(`${model}: loading on ${device} (${dtypeName})`);
      let pipe = null;
      try {
        let lastPct = -10;
        const t0 = now();
        pipe = await transformers.pipeline('automatic-speech-recognition', model, {
          device,
          dtype: dtypeOption(dtypeName),
          progress_callback: (p) => {
            if (p.status === 'progress' && p.progress - lastPct >= 10) {
              lastPct = p.progress;
              $('runStatus').textContent = `Downloading ${p.file}: ${Math.round(p.progress)}%`;
            }
          },
        });
        const loadMs = now() - t0;
        const opts = transcribeOptions(model);

        $('runStatus').textContent = `Transcribing with ${model}…`;
        const t1 = now();
        await pipe(clip, opts);
        const firstMs = now() - t1;

        const t2 = now();
        const out = await pipe(clip, opts);
        const warmMs = now() - t2;

        const r = { model, device, dtype: dtypeName, loadMs, firstMs, warmMs, ratio: warmMs / 1000 / audioSeconds, text: (out.text ?? '').trim() };
        results.push(r);
        addRow(r);
        logger.log(`${model}: load ${ms(loadMs)}, first ${ms(firstMs)}, warm ${ms(warmMs)}`);
      } catch (e) {
        const r = { model, device, dtype: dtypeName, error: e.message || String(e) };
        results.push(r);
        addRow(r);
        logger.log(`${model} failed:\n${errorText(e)}`);
      } finally {
        try { await pipe?.dispose?.(); } catch { /* ignore */ }
      }
    }
    $('runStatus').textContent = 'Done';
  } catch (e) {
    $('runStatus').textContent = 'Failed';
    logger.log(errorText(e));
  } finally {
    $('run').disabled = false;
  }
};

$('copy').onclick = (ev) => {
  const lines = ['STT test results', `Audio: ${sec(clip ? clip.length / 16000 : 0)}`];
  for (const r of results) {
    lines.push(r.error
      ? `${r.model} (${r.device}, ${r.dtype}): ERROR ${r.error}`
      : `${r.model} (${r.device}, ${r.dtype}): load ${ms(r.loadMs)}, first ${ms(r.firstMs)}, warm ${ms(r.warmMs)} | "${r.text}"`);
  }
  lines.push('', 'Environment: ' + JSON.stringify(env));
  copyText(lines.join('\n'), ev.target);
};

env = await environment();
renderEnvironment($('env'), env);
if (!env.webgpu) {
  $('device').value = 'wasm';
  $('dtype').value = 'q8';
}
