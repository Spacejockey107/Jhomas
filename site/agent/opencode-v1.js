// Adapter for the OpenCode 1.x server (tested against 1.19.5), reached through Caddy at /api.
//
// Event shapes were taken from a recording of a real session (Milestone 0, test 5).
// Endpoints that weren't confirmed have fallbacks: each action tries its candidates in
// order and remembers the first one the server accepts.

import { AgentAdapter } from './adapter.js';

const RETRY_MS = [1000, 2000, 5000, 10000];
const STALL_MS = 45000; // the server sends a heartbeat about every 10 s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanTitle(title) {
  return (title ?? '').replace(/\s*\(@\w+ subagent\)\s*$/, '').trim();
}

function describeTool(tool, input = {}) {
  switch (tool) {
    case 'bash': return input.command ?? 'command';
    case 'read': return `read ${input.filePath ?? ''}`.trim();
    case 'write':
    case 'edit': return `${tool} ${input.filePath ?? ''}`.trim();
    case 'glob':
    case 'grep': return `${tool} ${input.pattern ?? ''}`.trim();
    case 'list': return `list ${input.path ?? ''}`.trim();
    case 'webfetch': return `fetch ${input.url ?? ''}`.trim();
    case 'task': return cleanTitle(input.description) || 'worker task';
    default: return tool;
  }
}

// Reads a server-sent-events body and calls onEvent with each parsed JSON payload.
async function readSse(body, onEvent, onActivity) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onActivity();
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      // /global/event wraps events as { directory, payload }.
      onEvent(parsed?.payload?.type ? parsed.payload : parsed);
    }
  }
}

export class OpenCodeV1Adapter extends AgentAdapter {
  constructor({ base = '/api', agent = 'voice', fetchImpl } = {}) {
    super();
    this.base = base.replace(/\/$/, '');
    this.agent = agent;
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.endpointChoice = {};
    this.sessionId = null;
    this.running = false;
    this.everConnected = false;
    this.resetSessionState();
  }

  resetSessionState() {
    this.children = new Set();       // worker sessions started from the current session
    this.roles = new Map();          // messageId -> 'user' | 'assistant'
    this.partTypes = new Map();      // partId -> 'text' | 'reasoning' | 'tool' | ...
    this.seenUserParts = new Set();
    this.toolsStarted = new Set();
    this.toolsEnded = new Set();
    this.taskChild = new Map();      // task tool callId -> worker sessionId
    this.busy = new Map();           // sessionId -> boolean
  }

  isOurs(sessionId) {
    return sessionId != null && (sessionId === this.sessionId || this.children.has(sessionId));
  }

  isWorker(sessionId) {
    return this.children.has(sessionId);
  }

  // ---------- HTTP ----------

  async request(method, path, body) {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed: ${res.status} ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data)?.slice(0, 200) ?? ''}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Tries each candidate until one isn't a 404/405, and remembers which one worked.
  async firstWorking(key, candidates) {
    const startAt = this.endpointChoice[key] ?? 0;
    const order = [...candidates.keys()].slice(startAt).concat([...candidates.keys()].slice(0, startAt));
    let lastError = null;
    for (const i of order) {
      try {
        const result = await candidates[i]();
        this.endpointChoice[key] = i;
        return result;
      } catch (e) {
        lastError = e;
        if (e.status !== 404 && e.status !== 405) throw e;
      }
    }
    throw lastError ?? new Error(`no endpoint for ${key}`);
  }

  // ---------- Event stream ----------

  async start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.streamAbort?.abort();
  }

  async loop() {
    let attempt = 0;
    while (this.running) {
      this.emit('connection', { state: this.everConnected ? 'reconnecting' : 'connecting' });
      let watchdog = null;
      try {
        this.streamAbort = new AbortController();
        const res = await this.fetchImpl(this.base + '/event', {
          headers: { Accept: 'text/event-stream' },
          signal: this.streamAbort.signal,
        });
        if (!res.ok) throw new Error(`event stream: ${res.status}`);
        this.emit('connection', { state: 'open' });
        if (this.everConnected) this.emit('resync', {});
        this.everConnected = true;
        attempt = 0;

        let lastActivity = Date.now();
        watchdog = setInterval(() => {
          if (Date.now() - lastActivity > STALL_MS) this.streamAbort.abort();
        }, 5000);
        await readSse(res.body, (ev) => this.handleEvent(ev), () => (lastActivity = Date.now()));
      } catch (e) {
        if (!this.running) break;
        this.emit('connection', { state: 'reconnecting', error: e.message });
      } finally {
        clearInterval(watchdog);
      }
      if (!this.running) break;
      await sleep(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    }
  }

  // Public so recorded events can be replayed in tests.
  handleEvent(ev) {
    const type = ev?.type;
    const p = ev?.properties ?? {};
    switch (type) {
      case 'session.created':
      case 'session.updated':
        return this.onSession(p.info);
      case 'message.updated':
        if (p.info?.id) this.roles.set(p.info.id, p.info.role);
        return;
      case 'message.part.updated':
        return this.onPart(p.part);
      case 'message.part.delta':
        return this.onDelta(p);
      case 'permission.asked':
      case 'permission.updated':
        return this.onPermissionAsked(p);
      case 'permission.replied':
        if (!this.isOurs(p.sessionID)) return;
        this.emit('approvalResolved', { id: p.requestID ?? p.permissionID ?? p.id, reply: p.reply ?? p.response });
        return;
      case 'session.status':
        return this.onStatus(p.sessionID, p.status?.type !== 'idle');
      case 'session.idle':
        return this.onStatus(p.sessionID, false);
      case 'session.error':
        if (!this.isOurs(p.sessionID)) return;
        this.emit('error', {
          sessionId: p.sessionID,
          isWorker: this.isWorker(p.sessionID),
          message: p.error?.data?.message ?? p.error?.name ?? 'unknown error',
          aborted: p.error?.name === 'MessageAbortedError',
        });
        return;
      default:
        return;
    }
  }

  onSession(info) {
    if (!info?.id) return;
    if (info.id === this.sessionId) {
      this.emit('sessionUpdated', { id: info.id, title: info.title ?? '' });
      return;
    }
    if (info.parentID && this.isOurs(info.parentID) && !this.children.has(info.id)) {
      this.children.add(info.id);
      this.emit('subtaskStart', { sessionId: info.id, title: cleanTitle(info.title) });
    }
  }

  onPart(part) {
    if (!part || !this.isOurs(part.sessionID)) return;
    this.partTypes.set(part.id, part.type);
    const isWorker = this.isWorker(part.sessionID);

    if (part.type === 'text') {
      if (this.roles.get(part.messageID) === 'user') {
        if (isWorker || part.synthetic || this.seenUserParts.has(part.id)) return;
        this.seenUserParts.add(part.id);
        this.emit('userMessage', { sessionId: part.sessionID, partId: part.id, text: part.text ?? '' });
        return;
      }
      if (part.time?.end) {
        this.emit('textDone', { sessionId: part.sessionID, partId: part.id, text: part.text ?? '', isWorker });
      }
      return;
    }
    if (part.type === 'tool') this.onTool(part, isWorker);
  }

  onDelta(p) {
    if (!this.isOurs(p.sessionID) || p.field !== 'text') return;
    const type = this.partTypes.get(p.partID);
    if (type && type !== 'text') return; // reasoning is never shown as reply text
    if (this.roles.get(p.messageID) === 'user') return;
    this.emit('textDelta', { sessionId: p.sessionID, partId: p.partID, delta: p.delta ?? '', isWorker: this.isWorker(p.sessionID) });
  }

  onTool(part, isWorker) {
    const state = part.state ?? {};
    const status = state.status;
    const callId = part.callID ?? part.id;
    const base = {
      sessionId: part.sessionID,
      callId,
      tool: part.tool,
      title: describeTool(part.tool, state.input) || state.title || part.tool,
      isWorker,
    };

    if (part.tool === 'task' && state.metadata?.sessionId) {
      const child = state.metadata.sessionId;
      this.taskChild.set(callId, child);
      if (!this.children.has(child)) {
        this.children.add(child);
        this.emit('subtaskStart', { sessionId: child, title: base.title });
      }
    }

    if (status === 'pending') return; // input isn't known yet
    if (!this.toolsStarted.has(callId)) {
      this.toolsStarted.add(callId);
      this.emit('toolStart', base);
    }
    if ((status === 'completed' || status === 'error') && !this.toolsEnded.has(callId)) {
      this.toolsEnded.add(callId);
      const ok = status === 'completed';
      this.emit('toolEnd', { ...base, ok, error: state.error });
      if (part.tool === 'task') {
        this.emit('subtaskEnd', { sessionId: this.taskChild.get(callId) ?? null, ok, output: state.output });
      }
    }
  }

  onPermissionAsked(p) {
    const sessionId = p.sessionID;
    if (!this.isOurs(sessionId)) return;
    this.emit('approvalRequested', this.toApproval(p));
  }

  toApproval(p) {
    const command = p.metadata?.command ?? (p.patterns?.length ? p.patterns.join(' ') : null) ?? p.pattern ?? p.title ?? p.permission ?? p.type;
    return {
      id: p.id,
      sessionId: p.sessionID,
      isWorker: this.isWorker(p.sessionID),
      kind: p.permission ?? p.type ?? 'action',
      command: String(command ?? ''),
    };
  }

  onStatus(sessionId, busy) {
    if (!this.isOurs(sessionId)) return;
    const was = this.busy.get(sessionId) ?? false;
    if (was === busy) return;
    this.busy.set(sessionId, busy);
    this.emit('status', { sessionId, busy, isWorker: this.isWorker(sessionId) });
    if (!busy && sessionId === this.sessionId) this.emit('turnEnd', { sessionId });
  }

  // ---------- Actions ----------

  async listSessions() {
    const all = (await this.request('GET', '/session')) ?? [];
    return all
      .filter((s) => !s.parentID)
      .map((s) => ({ id: s.id, title: s.title ?? '', updated: s.time?.updated ?? s.time?.created ?? 0 }))
      .sort((a, b) => b.updated - a.updated);
  }

  async createSession() {
    const s = await this.request('POST', '/session', {});
    return { id: s.id, title: s.title ?? '' };
  }

  async openSession(id) {
    this.sessionId = id;
    this.resetSessionState();

    // Worker sessions already started from this session, so their events are recognised.
    try {
      const all = (await this.request('GET', '/session')) ?? [];
      const byParent = new Map();
      for (const s of all) if (s.parentID) byParent.set(s.parentID, [...(byParent.get(s.parentID) ?? []), s.id]);
      const queue = [id];
      while (queue.length) {
        for (const child of byParent.get(queue.shift()) ?? []) {
          if (!this.children.has(child)) {
            this.children.add(child);
            queue.push(child);
          }
        }
      }
    } catch {
      // Not fatal: only affects recognising worker events that started before this point.
    }

    const messages = (await this.request('GET', `/session/${id}/message`)) ?? [];
    return this.toHistory(messages);
  }

  toHistory(messages) {
    const entries = [];
    for (const m of messages) {
      const role = m.info?.role;
      if (m.info?.id) this.roles.set(m.info.id, role);
      for (const part of m.parts ?? []) {
        if (part.id) this.partTypes.set(part.id, part.type);
        if (part.type === 'text' && !part.synthetic && part.text) {
          entries.push(role === 'user' ? { kind: 'user', text: part.text } : { kind: 'text', text: part.text });
          if (role === 'user') this.seenUserParts.add(part.id);
        } else if (part.type === 'tool') {
          const state = part.state ?? {};
          const callId = part.callID ?? part.id;
          this.toolsStarted.add(callId);
          if (state.status === 'completed' || state.status === 'error') this.toolsEnded.add(callId);
          const title = describeTool(part.tool, state.input) || state.title || part.tool;
          const ok = state.status === 'completed' ? true : state.status === 'error' ? false : null;
          if (part.tool === 'task') entries.push({ kind: 'subtask', title, ok, output: state.output ?? '' });
          else entries.push({ kind: 'tool', tool: part.tool, title, ok });
        }
      }
    }
    return entries;
  }

  async send(text) {
    const id = this.sessionId;
    if (!id) throw new Error('no session open');
    const body = { agent: this.agent, parts: [{ type: 'text', text }] };
    return this.firstWorking('send', [
      // Returns as soon as the message is accepted; progress arrives as events.
      () => this.request('POST', `/session/${id}/prompt_async`, body),
      // Older servers: this request only returns when the turn is finished, so don't wait for it.
      () => {
        const pending = this.request('POST', `/session/${id}/message`, body);
        pending.catch((e) => this.emit('error', { sessionId: id, isWorker: false, message: e.message, aborted: false }));
        return Promise.race([pending, sleep(1500).then(() => null)]);
      },
    ]);
  }

  async abort() {
    if (!this.sessionId) return;
    await this.request('POST', `/session/${this.sessionId}/abort`);
  }

  async replyApproval(id, sessionId, reply) {
    return this.firstWorking('approval', [
      () => this.request('POST', `/permission/${id}/reply`, { reply }),
      () => this.request('POST', `/session/${sessionId}/permissions/${id}`, { response: reply }),
    ]);
  }

  async pendingApprovals() {
    try {
      const list = (await this.request('GET', '/permission')) ?? [];
      return (Array.isArray(list) ? list : []).filter((p) => this.isOurs(p.sessionID)).map((p) => this.toApproval(p));
    } catch {
      return [];
    }
  }
}
