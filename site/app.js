// Jhomas client: typed or spoken conversation with streaming replies and approvals.

import { config } from './config.js';
import { OpenCodeV1Adapter } from './agent/opencode-v1.js';
import { Transcript } from './ui/transcript.js';
import { Approvals } from './ui/approvals.js';
import { DebugPanel } from './ui/debug.js';
import { Voice } from './voice.js';
import { loadSettings, renderSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'jhomas.session';

const agent = new OpenCodeV1Adapter({ base: config.apiBase, agent: config.agent });
const transcript = new Transcript($('transcript'));
const approvals = new Approvals($('approvals'), (id, sessionId, reply) => agent.replyApproval(id, sessionId, reply));
const debug = new DebugPanel({ timings: $('timings'), log: $('debugLog') });
const settings = loadSettings(config);
renderSettings($('settings'), settings);

const MIC_LABELS = {
  off: 'Voice off',
  loading: 'Loading…',
  listening: 'Listening',
  hearing: 'Hearing you',
  transcribing: 'Transcribing',
  waiting: 'Thinking',
  speaking: 'Speaking',
};
let loadPercent = null;

const voice = new Voice({
  config,
  settings,
  on: {
    state: (state) => {
      const button = $('mic');
      button.dataset.state = state;
      button.textContent = MIC_LABELS[state] ?? state;
      button.setAttribute('aria-pressed', String(state !== 'off'));
      button.title = state === 'off' ? 'Turn voice on' : 'Turn voice off';
      renderStatus();
    },
    transcript: (text) => sendText(text),
    timing: (name) => debug.mark(name),
    progress: (percent) => {
      loadPercent = percent;
      renderStatus();
    },
    warning: (message) => transcript.note(message),
    error: (message) => transcript.note(message, 'error'),
  },
});

// For debugging from the browser console.
window.jhomas = { agent, voice, settings };

let currentId = null;
let sessions = [];
let workerRunning = false;

// ---------- small helpers ----------

function remember(id) {
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* storage unavailable */ }
}
function remembered() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

function setBusy(busy) {
  $('stop').disabled = !busy;
  renderStatus(busy);
}

function renderStatus(busy = !$('stop').disabled) {
  let text = '';
  if (voice.state === 'loading') text = `Loading speech models${loadPercent != null ? ` (${loadPercent}%)` : '…'} — the first time takes a while`;
  else if (approvals.pending.length) text = 'Waiting for your approval';
  else if (workerRunning) text = 'Worker running…';
  else if (busy) text = 'Working…';
  $('status').textContent = text;
}

function sessionLabel(s) {
  const when = s.updated
    ? new Date(s.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  return `${s.title || 'New conversation'}${when ? ' · ' + when : ''}`;
}

async function refreshSessions() {
  sessions = await agent.listSessions();
  const select = $('sessions');
  select.textContent = '';
  for (const s of sessions.slice(0, 50)) select.add(new Option(sessionLabel(s), s.id));
  if (currentId && !sessions.some((s) => s.id === currentId)) select.add(new Option('Current conversation', currentId));
  if (currentId) select.value = currentId;
}

async function openSession(id) {
  currentId = id;
  remember(id);
  workerRunning = false;
  approvals.clear();
  setBusy(false);
  transcript.clear();
  transcript.note('Loading…');
  try {
    const history = await agent.openSession(id);
    transcript.renderHistory(history);
    for (const a of await agent.pendingApprovals()) approvals.show(a);
    renderStatus();
  } catch (e) {
    transcript.clear();
    transcript.note(`Couldn't load this conversation: ${e.message}`, 'error');
  }
  $('sessions').value = id;
}

// ---------- events from the agent ----------

agent.on('*', (name, payload) => debug.event(name, payload));

agent.on('connection', ({ state, error }) => {
  const dot = $('connection');
  dot.className = 'dot' + (state === 'open' ? ' open' : state === 'reconnecting' ? ' down' : '');
  dot.title = state === 'open' ? 'Connected' : state === 'reconnecting' ? `Reconnecting${error ? ': ' + error : ''}` : 'Connecting';
});

agent.on('resync', () => {
  if (currentId) openSession(currentId);
});

agent.on('sessionUpdated', ({ id, title }) => {
  const option = [...$('sessions').options].find((o) => o.value === id);
  const s = sessions.find((x) => x.id === id);
  if (s) s.title = title;
  if (option) option.textContent = sessionLabel(s ?? { title });
});

agent.on('userMessage', ({ text }) => {
  // A message sent from another device: that device speaks the reply, not this one.
  if (!transcript.confirmUser(text)) voice.notSpeaker();
});

agent.on('textDelta', ({ partId, delta, sessionId, isWorker }) => {
  if (!isWorker) {
    debug.mark('firstText');
    voice.replyDelta(partId, delta);
  }
  transcript.appendText(partId, delta, sessionId, isWorker);
});

agent.on('textDone', ({ partId, text, sessionId, isWorker }) => {
  if (!isWorker) voice.replyDone(partId, text);
  transcript.finishText(partId, text, sessionId, isWorker);
});
agent.on('toolStart', (p) => transcript.toolStart(p));
agent.on('toolEnd', (p) => transcript.toolEnd(p));

agent.on('subtaskStart', ({ sessionId, title }) => {
  workerRunning = true;
  transcript.subtaskStart(sessionId, title);
  renderStatus();
});

agent.on('subtaskEnd', ({ sessionId, ok }) => {
  workerRunning = false;
  transcript.subtaskEnd(sessionId, ok);
  renderStatus();
});

agent.on('approvalRequested', (approval) => {
  approvals.show(approval);
  renderStatus();
});

agent.on('approvalResolved', ({ id, reply }) => {
  const resolved = approvals.resolve(id);
  if (resolved) transcript.note(`${reply === 'reject' ? 'Denied' : 'Approved'}: ${resolved.command}`, '', resolved.sessionId, resolved.isWorker);
  // After a denial OpenCode ends the voice agent's turn without a reply, so say something.
  if (resolved && reply === 'reject' && !resolved.isWorker) voice.say(config.lines.denied);
  renderStatus();
});

agent.on('status', ({ sessionId, busy }) => {
  if (sessionId === currentId) setBusy(busy);
});

agent.on('turnEnd', () => {
  debug.mark('turnEnd');
  workerRunning = false;
  setBusy(false);
  voice.turnEnded();
});

agent.on('error', ({ message, aborted, isWorker }) => {
  if (aborted) {
    voice.notSpeaker(); // don't read out the partial reply that arrives after a stop
    transcript.note('Stopped.');
    return;
  }
  if (!isWorker) voice.turnEnded();
  transcript.note(`${isWorker ? 'Worker error' : 'Error'}: ${message}`, 'error');
});

// ---------- controls ----------

const input = $('input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

// Typed and spoken messages both go through here.
async function sendText(text) {
  if (!currentId) return;
  transcript.addUser(text, { pending: true });
  debug.mark('sent');
  voice.expectReply();
  try {
    await agent.send(text);
  } catch (e) {
    transcript.note(`Couldn't send: ${e.message}`, 'error');
    voice.turnEnded();
  }
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  sendText(text);
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('send').onclick = send;

$('stop').onclick = async () => {
  voice.notSpeaker(); // stop talking and don't read out the rest of this reply
  try {
    await agent.abort();
  } catch (e) {
    transcript.note(`Couldn't stop: ${e.message}`, 'error');
  }
};

$('newSession').onclick = async () => {
  try {
    const s = await agent.createSession();
    await openSession(s.id);
    await refreshSessions();
    input.focus();
  } catch (e) {
    transcript.note(`Couldn't start a new conversation: ${e.message}`, 'error');
  }
};

$('sessions').onchange = (e) => openSession(e.target.value);

$('mic').onclick = () => {
  if (voice.state === 'off') voice.enable();
  else if (voice.state !== 'loading') voice.disable();
};
$('debugBox').addEventListener('toggle', () => debug.refresh());

// ---------- start ----------

agent.start();
try {
  await refreshSessions();
  let id = remembered();
  if (!id || !sessions.some((s) => s.id === id)) id = sessions[0]?.id;
  if (!id) id = (await agent.createSession()).id;
  await openSession(id);
  await refreshSessions();
} catch (e) {
  transcript.note(`Couldn't reach OpenCode: ${e.message}`, 'error');
}
input.focus();
