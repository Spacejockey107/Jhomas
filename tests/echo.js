import { $, makeLogger, environment, renderEnvironment, recordClip, audioContext, startVad, copyText, errorText } from './common.js';

const PLAY_SECONDS = 18;
const logger = makeLogger($('log'));
const results = [];
let env = null;
let sample = null;
let sampleRate = 48000;

$('record').onclick = async () => {
  $('record').disabled = true;
  try {
    sampleRate = audioContext().sampleRate;
    sample = await recordClip(6, sampleRate, (left) => ($('recStatus').textContent = `Recording… ${left}`));
    $('recStatus').textContent = 'Recorded';
    $('silent').disabled = false;
    $('talk').disabled = false;
  } catch (e) {
    $('recStatus').textContent = 'Recording failed';
    logger.log(errorText(e));
  } finally {
    $('record').disabled = false;
  }
};

// Sends a stream through a pair of local WebRTC connections and returns the received
// stream. Chromium's echo canceller reliably knows about audio played this way.
async function webrtcLoopback(stream) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const received = new Promise((resolve) => (b.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]))));
  stream.getTracks().forEach((t) => a.addTrack(t, stream));
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);
  return { stream: await received, close: () => { a.close(); b.close(); } };
}

// Plays the sample on a loop for PLAY_SECONDS through the chosen path.
async function playLoop(path) {
  const ctx = audioContext();
  await ctx.resume();
  const buf = ctx.createBuffer(1, sample.length, sampleRate);
  buf.copyToChannel(sample, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;

  let cleanup = () => {};
  if (path === 'webrtc') {
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    const loop = await webrtcLoopback(dest.stream);
    const el = new Audio();
    el.srcObject = loop.stream;
    await el.play();
    cleanup = () => { el.pause(); el.srcObject = null; loop.close(); };
  } else {
    src.connect(ctx.destination);
  }
  src.start();
  await new Promise((r) => setTimeout(r, PLAY_SECONDS * 1000));
  src.stop();
  cleanup();
}

async function run(userTalks) {
  const path = $('path').value;
  const echoCancellation = $('ec').checked;
  $('silent').disabled = $('talk').disabled = true;
  let detections = 0;
  let vad = null;
  $('count').textContent = '0';
  try {
    $('runStatus').textContent = 'Starting the mic…';
    let playing = false;
    vad = await startVad({
      onSpeechStart: () => {
        if (!playing) return;
        detections++;
        $('count').textContent = String(detections);
        logger.log('speech detected');
      },
    }, { echoCancellation });

    // Give the echo canceller a moment to settle before playback starts.
    await new Promise((r) => setTimeout(r, 1500));
    $('runStatus').textContent = userTalks ? `Playing for ${PLAY_SECONDS} s — talk over it now` : `Playing for ${PLAY_SECONDS} s — stay silent`;
    logger.log(`run start: path=${path}, echoCancellation=${echoCancellation}, user ${userTalks ? 'talks' : 'silent'}`);
    playing = true;
    await playLoop(path);
    playing = false;

    const pass = userTalks ? detections > 0 : detections === 0;
    const r = { path, echoCancellation, userTalks, detections, pass };
    results.push(r);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${results.length}</td><td>${path === 'webrtc' ? 'WebRTC loopback' : 'Normal page audio'}</td>
      <td>${echoCancellation ? 'on' : 'off'}</td><td>${userTalks ? 'talking' : 'silent'}</td><td>${detections}</td>
      <td class="${pass ? 'pass' : 'fail'}">${pass ? 'pass' : 'fail'}</td>`;
    $('results').appendChild(tr);
    $('runStatus').textContent = 'Done';
    logger.log(`run end: ${detections} detection(s)`);
  } catch (e) {
    $('runStatus').textContent = 'Failed';
    logger.log(errorText(e));
  } finally {
    try {
      if (vad?.destroy) await vad.destroy();
      else vad?.pause?.();
    } catch { /* ignore */ }
    $('silent').disabled = $('talk').disabled = false;
  }
}

$('silent').onclick = () => run(false);
$('talk').onclick = () => run(true);

$('copy').onclick = (ev) => {
  const lines = ['Echo test results'];
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.path}, echo cancellation ${r.echoCancellation ? 'on' : 'off'}, user ${r.userTalks ? 'talking' : 'silent'}: ${r.detections} detection(s) -> ${r.pass ? 'pass' : 'FAIL'}`));
  lines.push('', 'Environment: ' + JSON.stringify(env));
  copyText(lines.join('\n'), ev.target);
};

env = await environment();
renderEnvironment($('env'), env);
