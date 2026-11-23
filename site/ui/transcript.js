// The conversation on screen: your messages, Jhomas's replies, tool steps and worker jobs.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// First sentence of a long job description, for the worker block's heading.
function shortTitle(title) {
  const first = title.split(/(?<=[.!?])\s/)[0];
  return first.length > 90 ? first.slice(0, 87) + '…' : first;
}

// Plain text with ``` code fences shown as code blocks. Never interprets HTML.
function renderText(node, text) {
  node.textContent = '';
  const pieces = text.split(/```[^\n]*\n?/);
  pieces.forEach((piece, i) => {
    if (!piece) return;
    if (i % 2 === 1) node.appendChild(el('pre', 'code', piece.replace(/\n$/, '')));
    else node.appendChild(el('span', null, piece));
  });
}

export class Transcript {
  constructor(root) {
    this.root = root;
    this.clear();
  }

  clear() {
    this.root.textContent = '';
    this.texts = new Map();    // partId -> element
    this.tools = new Map();    // callId -> element
    this.workers = new Map();  // worker sessionId -> { box, body, status }
  }

  nearBottom() {
    return this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 120;
  }

  add(node, parent = this.root) {
    const stick = this.nearBottom();
    parent.appendChild(node);
    if (stick) this.root.scrollTop = this.root.scrollHeight;
    return node;
  }

  container(sessionId, isWorker) {
    return (isWorker && this.workers.get(sessionId)?.body) || this.root;
  }

  addUser(text, { pending = false } = {}) {
    const node = el('div', 'msg user' + (pending ? ' pending' : ''), text);
    return this.add(node);
  }

  // A message arrived from the server. If it's one we just sent, confirm it instead of adding it twice.
  confirmUser(text) {
    for (const node of this.root.querySelectorAll('.msg.user.pending')) {
      if (node.textContent === text) {
        node.classList.remove('pending');
        return;
      }
    }
    this.addUser(text);
  }

  appendText(partId, delta, sessionId, isWorker) {
    let node = this.texts.get(partId);
    if (!node) {
      node = el('div', isWorker ? 'msg worker-text' : 'msg assistant');
      node.dataset.raw = '';
      this.texts.set(partId, node);
      this.add(node, this.container(sessionId, isWorker));
    }
    node.dataset.raw += delta;
    node.textContent = node.dataset.raw;
    if (this.nearBottom()) this.root.scrollTop = this.root.scrollHeight;
  }

  finishText(partId, text, sessionId, isWorker) {
    let node = this.texts.get(partId);
    if (!node) {
      node = el('div', isWorker ? 'msg worker-text' : 'msg assistant');
      this.texts.set(partId, node);
      this.add(node, this.container(sessionId, isWorker));
    }
    node.dataset.raw = text;
    renderText(node, text);
  }

  toolStart({ callId, tool, title, sessionId, isWorker }) {
    if (tool === 'task') return; // shown as a worker block instead
    const node = el('div', 'tool running');
    node.append(el('span', 'icon', '…'), el('span', 'title', title));
    this.tools.set(callId, node);
    this.add(node, this.container(sessionId, isWorker));
  }

  toolEnd({ callId, tool, ok, error }) {
    if (tool === 'task') return;
    const node = this.tools.get(callId);
    if (!node) return;
    node.className = 'tool ' + (ok ? 'done' : 'failed');
    node.querySelector('.icon').textContent = ok ? '✓' : '✕';
    if (!ok && error) node.title = error;
  }

  subtaskStart(sessionId, title) {
    if (this.workers.has(sessionId)) return;
    const box = el('details', 'worker running');
    const summary = el('summary');
    const status = el('span', 'status', 'Worker running');
    summary.append(status, el('span', 'title', ` — ${shortTitle(title)}`));
    summary.title = title;
    const body = el('div', 'body');
    box.append(summary, body);
    this.workers.set(sessionId, { box, body, status });
    this.add(box);
  }

  subtaskEnd(sessionId, ok) {
    const w = this.workers.get(sessionId);
    if (!w) return;
    w.box.className = 'worker ' + (ok ? 'done' : 'failed');
    w.status.textContent = ok ? 'Worker finished' : 'Worker failed';
  }

  note(text, kind = '', sessionId = null, isWorker = false) {
    return this.add(el('div', 'note ' + kind, text), this.container(sessionId, isWorker));
  }

  renderHistory(entries) {
    this.clear();
    for (const e of entries) {
      if (e.kind === 'user') this.root.appendChild(el('div', 'msg user', e.text));
      else if (e.kind === 'text') {
        const node = el('div', 'msg assistant');
        renderText(node, e.text);
        this.root.appendChild(node);
      } else if (e.kind === 'tool') {
        const node = el('div', 'tool ' + (e.ok === false ? 'failed' : 'done'));
        node.append(el('span', 'icon', e.ok === false ? '✕' : '✓'), el('span', 'title', e.title));
        this.root.appendChild(node);
      } else if (e.kind === 'subtask') {
        const box = el('details', 'worker ' + (e.ok === false ? 'failed' : 'done'));
        const summary = el('summary');
        summary.append(el('span', 'status', e.ok === false ? 'Worker failed' : 'Worker finished'), el('span', 'title', ` — ${shortTitle(e.title)}`));
        summary.title = e.title;
        const body = el('div', 'body');
        if (e.output) {
          const out = el('div', 'msg worker-text');
          renderText(out, e.output.replace(/<\/?task[^>]*>/g, '').trim());
          body.appendChild(out);
        }
        box.append(summary, body);
        this.root.appendChild(box);
      }
    }
    this.root.scrollTop = this.root.scrollHeight;
  }
}
