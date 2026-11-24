// The generic agent contract. The rest of the client only uses what is listed here;
// everything specific to one agent server lives in its own adapter file.
//
// Actions (async methods):
//   start()                           connect to the server's event stream
//   stop()
//   listSessions()                    -> [{ id, title, updated }]  newest first
//   createSession()                   -> { id, title }
//   openSession(id)                   -> history entries (see below); later events refer to this session
//   send(text)                        send a message to the voice agent
//   abort()                           stop the running turn
//   replyApproval(id, sessionId, reply)   reply = 'once' | 'reject'
//   pendingApprovals()                -> [approval]  (same shape as the approvalRequested event)
//
// Events (on(name, handler)):
//   connection       { state: 'connecting' | 'open' | 'reconnecting', error? }
//   resync           {}   the stream reconnected; events may have been missed, reload the session
//   sessionUpdated   { id, title }
//   userMessage      { sessionId, messageId, partId, text }
//   textDelta        { sessionId, partId, delta, isWorker, replyTo }   replyTo = the user messageId it answers
//   textDone         { sessionId, partId, text, isWorker, replyTo }
//   toolStart        { sessionId, callId, tool, title, isWorker }
//   toolEnd          { sessionId, callId, tool, title, ok, error?, isWorker }
//   subtaskStart     { sessionId, title }          a handoff to the worker began (sessionId = worker's)
//   subtaskEnd       { sessionId, ok, output? }
//   approvalRequested{ id, sessionId, isWorker, kind, command }
//   approvalResolved { id, reply }
//   status           { sessionId, busy, isWorker }
//   turnEnd          { sessionId }                 the voice agent finished its turn
//   error            { sessionId, isWorker, message, aborted }
//
// History entries (from openSession):
//   { kind: 'user', text } | { kind: 'text', text } | { kind: 'tool', tool, title, ok }
//   | { kind: 'subtask', title, ok, output }

export class AgentAdapter {
  constructor() {
    this.handlers = new Map();
  }

  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
    return () => this.handlers.get(name)?.delete(handler);
  }

  emit(name, payload) {
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`handler for ${name} failed`, e);
      }
    }
    for (const handler of this.handlers.get('*') ?? []) {
      try {
        handler(name, payload);
      } catch (e) {
        console.error('wildcard handler failed', e);
      }
    }
  }

  /* eslint-disable no-unused-vars */
  async start() { throw new Error('not implemented'); }
  stop() {}
  async listSessions() { throw new Error('not implemented'); }
  async createSession() { throw new Error('not implemented'); }
  async openSession(id) { throw new Error('not implemented'); }
  async send(text) { throw new Error('not implemented'); }
  async abort() { throw new Error('not implemented'); }
  async replyApproval(id, sessionId, reply) { throw new Error('not implemented'); }
  async pendingApprovals() { return []; }
}
