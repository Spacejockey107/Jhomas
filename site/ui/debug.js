// Debug panel: per-turn timings and the last events from the adapter.
//
// A turn's clock starts when you stop speaking (spoken turns) or when you press Send (typed).
//   speech end -> sent         transcription time
//   -> first text              network + model until the reply starts
//   -> first audio             plus speech synthesis of the first sentence
//   -> finished                the whole turn

const MAX_LINES = 300;

export class DebugPanel {
  constructor({ timings, log }) {
    this.timingsEl = timings;
    this.logEl = log;
    this.lines = [];
    this.turn = null;
  }

  mark(name, t = performance.now()) {
    if (name === 'speechEnd') {
      this.turn = { start: t, speechEnd: t };
    } else if (name === 'sent') {
      // A typed turn starts here; a spoken one already started at speech end.
      const spoken = this.turn && this.turn.speechEnd != null && this.turn.sent == null && t - this.turn.speechEnd < 15000;
      if (!spoken) this.turn = { start: t };
      this.turn.sent = t;
    } else if (this.turn && this.turn[name] == null) {
      this.turn[name] = t;
    }
    this.render();
  }

  render() {
    const turn = this.turn;
    if (!turn) return;
    const at = (name) => (turn[name] != null ? `${Math.round(turn[name] - turn.start)} ms` : '—');
    const parts = [];
    if (turn.speechEnd != null) parts.push(`transcribed and sent: ${at('sent')}`);
    parts.push(`first text: ${at('firstText')}`, `first audio: ${at('firstAudio')}`, `finished: ${at('turnEnd')}`);
    this.timingsEl.textContent = `Last turn (from ${turn.speechEnd != null ? 'end of speech' : 'Send'}) — ${parts.join(', ')}`;
  }

  event(name, payload) {
    if (name === 'textDelta') return; // too many to be useful
    const time = new Date().toLocaleTimeString();
    this.lines.push(`${time}  ${name}  ${JSON.stringify(payload).slice(0, 300)}`);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (!this.logEl.closest('details')?.open) return;
    this.logEl.textContent = this.lines.join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  refresh() {
    this.logEl.textContent = this.lines.join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
