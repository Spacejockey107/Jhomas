// Debug panel: per-turn timings and the last events from the adapter.

const MAX_LINES = 300;

export class DebugPanel {
  constructor({ timings, log }) {
    this.timingsEl = timings;
    this.logEl = log;
    this.lines = [];
    this.turn = null;
  }

  // Timestamps for the current turn. Milestone 2 adds "speech end" and "first audio".
  mark(name) {
    const t = performance.now();
    if (name === 'sent') this.turn = { sent: t };
    else if (this.turn && this.turn[name] == null) this.turn[name] = t;
    this.render();
  }

  render() {
    const turn = this.turn;
    if (!turn) return;
    const since = (name) => (turn[name] != null ? `${Math.round(turn[name] - turn.sent)} ms` : '—');
    this.timingsEl.textContent = `Last turn — first text: ${since('firstText')}, finished: ${since('turnEnd')}`;
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
