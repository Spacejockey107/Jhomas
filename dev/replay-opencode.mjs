// Replays a recorded OpenCode event file (from tests/api.html) through the adapter
// and prints what the client would see. Usage:
//   node dev/replay-opencode.mjs path/to/opencode-events.json [mainSessionId]

import { readFileSync } from 'node:fs';
import { OpenCodeV1Adapter } from '../site/agent/opencode-v1.js';

const [file, mainArg] = process.argv.slice(2);
const { events } = JSON.parse(readFileSync(file, 'utf8'));

// Default main session: the first session whose events appear that has no parent.
const main = mainArg ?? events
  .map((e) => e.data?.properties?.sessionID ?? e.data?.properties?.info?.id)
  .find((id, i, all) => id && !events.some((e) => e.data?.properties?.info?.id === id && e.data.properties.info.parentID));

const adapter = new OpenCodeV1Adapter();
adapter.sessionId = main;

const text = new Map();
adapter.on('*', (name, p) => {
  const who = p?.isWorker ? 'worker' : 'voice ';
  switch (name) {
    case 'textDelta':
      text.set(p.partId, (text.get(p.partId) ?? '') + p.delta);
      return;
    case 'textDone': {
      const streamed = text.get(p.partId) ?? '';
      const match = streamed === p.text ? 'matches stream' : `STREAM DIFFERS (${streamed.length} vs ${p.text.length} chars)`;
      console.log(`${who} text: ${JSON.stringify(p.text.slice(0, 120))} [${match}]`);
      return;
    }
    case 'userMessage': console.log(`user   : ${JSON.stringify(p.text)}`); return;
    case 'toolStart': console.log(`${who} tool start: ${p.title}`); return;
    case 'toolEnd': console.log(`${who} tool end  : ${p.title} ${p.ok ? 'ok' : 'ERROR ' + (p.error ?? '')}`); return;
    case 'subtaskStart': console.log(`handoff start: ${p.title}`); return;
    case 'subtaskEnd': console.log(`handoff end  : ok=${p.ok}`); return;
    case 'approvalRequested': console.log(`${who} APPROVAL ${p.id}: ${p.kind} ${p.command}`); return;
    case 'approvalResolved': console.log(`approval ${p.id}: ${p.reply}`); return;
    case 'status': console.log(`${who} ${p.busy ? 'busy' : 'idle'}`); return;
    case 'turnEnd': console.log('--- turn end ---'); return;
    case 'error': console.log(`${who} error: ${p.message}${p.aborted ? ' (aborted)' : ''}`); return;
    default: console.log(name, JSON.stringify(p));
  }
});

console.log(`main session: ${main}\n`);
for (const e of events) adapter.handleEvent(e.data);
