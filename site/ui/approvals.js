// Approval cards. An approval stays until it's answered: there is no timeout.

export class Approvals {
  constructor(root, reply) {
    this.root = root;
    this.reply = reply; // async (id, sessionId, 'once' | 'reject')
    this.cards = new Map();
  }

  get pending() {
    return [...this.cards.keys()];
  }

  show({ id, sessionId, isWorker, kind, command }) {
    if (this.cards.has(id)) return;
    const card = document.createElement('div');
    card.className = 'approval';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${isWorker ? 'The worker' : 'Jhomas'} wants to ${kind === 'bash' ? 'run' : 'use ' + kind}:`;

    const cmd = document.createElement('pre');
    cmd.className = 'code';
    cmd.textContent = command;

    const error = document.createElement('div');
    error.className = 'error';

    const buttons = document.createElement('div');
    const approve = document.createElement('button');
    approve.textContent = 'Approve once';
    const deny = document.createElement('button');
    deny.textContent = 'Deny';
    deny.className = 'secondary';
    buttons.append(approve, deny);

    const answer = async (choice) => {
      approve.disabled = deny.disabled = true;
      error.textContent = '';
      try {
        await this.reply(id, sessionId, choice);
        // The card is removed when the server confirms (approvalResolved).
      } catch (e) {
        error.textContent = `Couldn't send the answer: ${e.message}`;
        approve.disabled = deny.disabled = false;
      }
    };
    approve.onclick = () => answer('once');
    deny.onclick = () => answer('reject');

    card.append(label, cmd, buttons, error);
    this.cards.set(id, { card, command, sessionId, isWorker, approval: { id, sessionId, isWorker, kind, command } });
    this.root.appendChild(card);
    this.root.hidden = false;
  }

  // The oldest approval still waiting, or null.
  first() {
    const [entry] = this.cards.values();
    return entry?.approval ?? null;
  }

  resolve(id) {
    const entry = this.cards.get(id);
    if (!entry) return null;
    entry.card.remove();
    this.cards.delete(id);
    this.root.hidden = this.cards.size === 0;
    return { command: entry.command, sessionId: entry.sessionId, isWorker: entry.isWorker };
  }

  clear() {
    for (const id of [...this.cards.keys()]) this.resolve(id);
  }
}
