// A stand-in for Caddy + OpenCode, for testing the client without the real server.
// Serves site/ at / and replays a recorded event file (from tests/api.html) at /api.
// Each message you send replays the next recorded turn; replay pauses at an approval
// until the page answers it.
//
//   node dev/mock-opencode.mjs path/to/opencode-events.json [port]

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const [file, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 8765);
const siteDir = fileURLToPath(new URL('../site/', import.meta.url));
const { events: recorded } = JSON.parse(readFileSync(file, 'utf8'));
const data = recorded.map((e) => ({ t: e.t, ev: e.data })).filter((e) => e.ev?.type && e.ev.type !== 'server.heartbeat');

// The main session is the parent of every worker session in the recording.
const mainId = data.find((e) => e.ev.type === 'session.created' && e.ev.properties.info.parentID)?.ev.properties.info.parentID
  ?? data.find((e) => e.ev.properties?.sessionID)?.ev.properties.sessionID;

// Split into turns at each user message in the main session.
const turns = [];
const userMessages = new Set();
for (const e of data) {
  const p = e.ev.properties ?? {};
  if (e.ev.type === 'message.updated' && p.info?.role === 'user' && p.info.sessionID === mainId && !userMessages.has(p.info.id)) {
    userMessages.add(p.info.id);
    turns.push([]);
  }
  if (turns.length) turns.at(-1).push(e);
}

const clients = new Set();
const log = [];
let turnIndex = 0;
let waitingFor = null; // permission id
let resumeReplay = null;
let aborted = false;

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function replayTurn(text) {
  const turn = turns[turnIndex++];
  if (!turn) {
    log.push('no more recorded turns');
    return;
  }
  aborted = false;
  let prevT = turn[0].t;
  for (const { t, ev } of turn) {
    await sleep(Math.min(250, Math.max(0, t - prevT)));
    prevT = t;
    let out = ev;
    // Show the text that was actually typed instead of the recorded user text.
    if (ev.type === 'message.part.updated' && ev.properties.part?.type === 'text' && turn.some((x) => x.ev.type === 'message.updated' && x.ev.properties.info?.role === 'user' && x.ev.properties.info.id === ev.properties.part.messageID)) {
      out = structuredClone(ev);
      out.properties.part.text = text;
    }
    if (ev.type === 'permission.replied') {
      // Wait for the page to answer before replaying the recorded answer.
      if (waitingFor) await new Promise((r) => (resumeReplay = r));
    }
    broadcast(out);
    if (ev.type === 'permission.asked') waitingFor = ev.properties.id;
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : null); } catch { resolve(null); }
    });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  log.push(`${req.method} ${path}`);

  if (path === '/api/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    clients.add(res);
    const hb = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 10000);
    req.on('close', () => { clients.delete(res); clearInterval(hb); });
    return;
  }
  if (path === '/api/session' && req.method === 'GET') {
    return json(res, 200, [{ id: mainId, title: 'Recorded session', time: { created: Date.now() - 60000, updated: Date.now() } }]);
  }
  if (path === '/api/session' && req.method === 'POST') return json(res, 200, { id: mainId, title: 'Recorded session' });
  if (path === `/api/session/${mainId}/message` && req.method === 'GET') return json(res, 200, []);
  if (path === '/api/permission' && req.method === 'GET') return json(res, 200, []);
  if (path === `/api/session/${mainId}/prompt_async` && req.method === 'POST') {
    const body = await readBody(req);
    const text = body?.parts?.[0]?.text ?? '';
    log.push(`  send: ${text} (agent=${body?.agent})`);
    res.writeHead(204);
    res.end();
    replayTurn(text);
    return;
  }
  const permMatch = path.match(/^\/api\/permission\/([^/]+)\/reply$/);
  if (permMatch && req.method === 'POST') {
    const body = await readBody(req);
    log.push(`  approval ${permMatch[1]}: ${body?.reply}`);
    if (waitingFor === permMatch[1]) {
      waitingFor = null;
      resumeReplay?.();
      resumeReplay = null;
    }
    return json(res, 200, true);
  }
  if (path === `/api/session/${mainId}/abort` && req.method === 'POST') {
    aborted = true;
    return json(res, 200, true);
  }
  if (path === '/__log') return json(res, 200, log);
  if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  // Static files
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const full = join(siteDir, rel);
  if (!full.startsWith(siteDir) || !existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': types[extname(full)] ?? 'application/octet-stream' });
  res.end(readFileSync(full));
}).listen(port, () => console.log(`mock on http://localhost:${port} (main session ${mainId}, ${turns.length} turns)`));
