// Jhomas client, Milestone 1: typed conversation with streaming replies and approvals.
// Voice input and output are added on top of this in Milestone 2.

import { config } from './config.js';
import { OpenCodeV1Adapter } from './agent/opencode-v1.js';
import { Transcript } from './ui/transcript.js';
import { Approvals } from './ui/approvals.js';
import { DebugPanel } from './ui/debug.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'jhomas.session';

const agent = new OpenCodeV1Adapter({ base: config.apiBase, agent: config.agent });
const transcript = new Transcript($('transcript'));
const approvals = new Approvals($('approvals'), (id, sessionId, reply) => agent.replyApproval(id, sessionId, reply));
const debug = new DebugPanel({ timings: $('timings'), log: $('debugLog') });

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
  if (approvals.pending.length) text = 'Waiting for your approval';
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

agent.on('userMessage', ({ text }) => transcript.confirmUser(text));

agent.on('textDelta', ({ partId, delta, sessionId, isWorker }) => {
  if (!isWorker) debug.mark('firstText');
  transcript.appendText(partId, delta, sessionId, isWorker);
});

agent.on('textDone', ({ partId, text, sessionId, isWorker }) => transcript.finishText(partId, text, sessionId, isWorker));
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
  renderStatus();
});

agent.on('status', ({ sessionId, busy }) => {
  if (sessionId === currentId) setBusy(busy);
});

agent.on('turnEnd', () => {
  debug.mark('turnEnd');
  workerRunning = false;
  setBusy(false);
});

agent.on('error', ({ message, aborted, isWorker }) => {
  if (aborted) transcript.note('Stopped.');
  else transcript.note(`${isWorker ? 'Worker error' : 'Error'}: ${message}`, 'error');
});

// ---------- controls ----------

const input = $('input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

async function send() {
  const text = input.value.trim();
  if (!text || !currentId) return;
  input.value = '';
  autosize();
  transcript.addUser(text, { pending: true });
  debug.mark('sent');
  try {
    await agent.send(text);
  } catch (e) {
    transcript.note(`Couldn't send: ${e.message}`, 'error');
  }
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
