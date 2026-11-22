import { $, now, makeLogger, environment, renderEnvironment, audioContext, startVad, copyText, errorText } from './common.js';

const STORE_KEY = 'jhomas-background-log';
const logger = makeLogger($('log'));
let env = null;
let vad = null;
let tickTimer = null;
let beepTimer = null;
let wakeLock = null;

const stats = {
  visible: { ms: 0, frames: 0, speech: 0, maxGap: 0 },
  hidden: { ms: 0, frames: 0, speech: 0, maxGap: 0 },
};
let lastTick = 0;

const bucket = () => (document.hidden ? stats.hidden : stats.visible);

function log(msg) {
  logger.log(msg);
  try { localStorage.setItem(STORE_KEY, logger.lines.join('\n')); } catch { /* storage may be unavailable */ }
}

// A previous run's log survives a reload, in case the browser discarded the tab.
const previous = localStorage.getItem(STORE_KEY);
if (previous) $('log').textContent = '--- previous run ---\n' + previous + '\n--- end of previous run ---\n';
if (document.wasDiscarded) log('NOTE: the browser discarded and reloaded this tab while it was in the background');

function render() {
  for (const [key, prefix] of [['visible', 'vis'], ['hidden', 'hid']]) {
    const s = stats[key];
    const secs = s.ms / 1000;
    $(prefix + 'Time').textContent = `${secs.toFixed(0)} s`;
    $(prefix + 'Rate').textContent = secs > 0 ? (s.frames / secs).toFixed(1) : '—';
    $(prefix + 'Speech').textContent = String(s.speech);
    $(prefix + 'Timer').textContent = s.maxGap ? `${(s.maxGap / 1000).toFixed(1)} s` : '—';
  }
}

function tick() {
  const t = now();
  const gap = t - lastTick;
  lastTick = t;
  const b = bucket();
  b.ms += gap;
  b.maxGap = Math.max(b.maxGap, gap);
  render();
}

function beep() {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.value = 0.08;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  log(`beep (${document.hidden ? 'hidden' : 'visible'})`);
}

async function requestWakeLock() {
  if (!$('wake').checked || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('screen wake lock on');
  } catch (e) {
    log(`wake lock refused: ${e.message}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (lastTick) tick(); // close the time slice under the previous state
  log(document.hidden ? 'page hidden' : 'page visible');
  if (!document.hidden && vad) requestWakeLock();
});

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    await audioContext().resume();
    $('status').textContent = 'Starting the mic…';
    vad = await startVad({
      onFrameProcessed: () => { bucket().frames++; },
      onSpeechStart: () => { bucket().speech++; log(`speech start (${document.hidden ? 'hidden' : 'visible'})`); },
      onSpeechEnd: () => log(`speech end (${document.hidden ? 'hidden' : 'visible'})`),
    });
    lastTick = now();
    tickTimer = setInterval(tick, 1000);
    if ($('beep').checked) beepTimer = setInterval(beep, 30000);
    await requestWakeLock();
    $('status').textContent = 'Listening';
    $('stop').disabled = false;
    log('started');
  } catch (e) {
    $('status').textContent = 'Failed';
    log(errorText(e));
    $('start').disabled = false;
  }
};

$('stop').onclick = async () => {
  clearInterval(tickTimer);
  clearInterval(beepTimer);
  try {
    if (vad?.destroy) await vad.destroy();
    else vad?.pause?.();
  } catch { /* ignore */ }
  vad = null;
  try { await wakeLock?.release(); } catch { /* ignore */ }
  tick();
  log('stopped');
  $('status').textContent = 'Stopped';
  $('stop').disabled = true;
  $('start').disabled = false;
};

$('copy').onclick = (ev) => {
  const fmt = (s) => {
    const secs = s.ms / 1000;
    return `${secs.toFixed(0)} s, ${secs ? (s.frames / secs).toFixed(1) : '-'} frames/s, ${s.speech} speech starts, slowest timer ${(s.maxGap / 1000).toFixed(1)} s`;
  };
  const lines = [
    'Background test results',
    `Visible: ${fmt(stats.visible)}`,
    `Hidden: ${fmt(stats.hidden)}`,
    '', 'Log:', ...logger.lines,
    '', 'Environment: ' + JSON.stringify(env),
  ];
  copyText(lines.join('\n'), ev.target);
};

env = await environment();
renderEnvironment($('env'), env);
