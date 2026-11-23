// Per-device voice settings, kept in this browser.

const KEY = 'jhomas.settings';

export function loadSettings(config) {
  const defaults = {
    sttModel: config.stt.model,
    sttDevice: config.stt.device,
    ttsModel: config.tts.model,
    ttsDevice: config.tts.device,
    voice: config.tts.voice,
    speed: config.tts.speed,
    speakReplies: true,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

function save(settings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

const STT_MODELS = [
  ['onnx-community/whisper-small.en', 'Whisper small.en (most accurate)'],
  ['onnx-community/whisper-base.en', 'Whisper base.en (lighter)'],
  ['onnx-community/distil-small.en', 'Distil-Whisper small.en'],
];
const DEVICES = [['auto', 'Automatic'], ['webgpu', 'GPU (WebGPU)'], ['wasm', 'CPU (WASM)']];
const VOICES = ['am_michael', 'am_fenrir', 'am_puck', 'af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'bm_george', 'bm_fable', 'bm_daniel', 'bf_emma'];

function select(options, value) {
  const s = document.createElement('select');
  for (const [v, label] of options) s.add(new Option(label, v));
  if (![...s.options].some((o) => o.value === value)) s.add(new Option(value, value));
  s.value = value;
  return s;
}

function row(labelText, control, note) {
  const label = document.createElement('label');
  label.className = 'setting';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(span, control);
  if (note) {
    const n = document.createElement('span');
    n.className = 'muted';
    n.textContent = note;
    label.append(n);
  }
  return label;
}

// Builds the settings controls into `root`. Changes are saved and applied at once where
// possible; model and device changes apply the next time the mic is turned on.
export function renderSettings(root, settings) {
  root.textContent = '';

  const sttModel = select(STT_MODELS, settings.sttModel);
  sttModel.onchange = () => { settings.sttModel = sttModel.value; save(settings); };

  const sttDevice = select(DEVICES, settings.sttDevice);
  sttDevice.onchange = () => { settings.sttDevice = sttDevice.value; save(settings); };

  const ttsModel = document.createElement('input');
  ttsModel.type = 'text';
  ttsModel.value = settings.ttsModel;
  ttsModel.size = 38;
  ttsModel.onchange = () => { settings.ttsModel = ttsModel.value.trim() || settings.ttsModel; save(settings); };

  const ttsDevice = select(DEVICES, settings.ttsDevice);
  ttsDevice.onchange = () => { settings.ttsDevice = ttsDevice.value; save(settings); };

  const voice = select(VOICES.map((v) => [v, v]), settings.voice);
  voice.onchange = () => { settings.voice = voice.value; save(settings); };

  const speed = document.createElement('input');
  speed.type = 'range';
  speed.min = '0.8';
  speed.max = '1.6';
  speed.step = '0.05';
  speed.value = String(settings.speed);
  const speedValue = document.createElement('span');
  speedValue.textContent = `${Number(settings.speed).toFixed(2)}×`;
  speed.oninput = () => {
    settings.speed = Number(speed.value);
    speedValue.textContent = `${settings.speed.toFixed(2)}×`;
    save(settings);
  };
  const speedBox = document.createElement('span');
  speedBox.append(speed, speedValue);

  const speak = document.createElement('input');
  speak.type = 'checkbox';
  speak.checked = settings.speakReplies;
  speak.onchange = () => { settings.speakReplies = speak.checked; save(settings); };

  root.append(
    row('Speak replies', speak),
    row('Voice', voice),
    row('Speed', speedBox),
    row('Speech recognition', sttModel),
    row('Recognition runs on', sttDevice),
    row('Speech model', ttsModel),
    row('Speech runs on', ttsDevice),
  );
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Model and device changes apply the next time you turn the mic on.';
  root.append(note);
}
