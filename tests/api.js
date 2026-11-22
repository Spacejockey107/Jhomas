import { $, download, escapeHtml, errorText } from './common.js';

const API = '/api';
let spec = null;
let reader = null;
let controller = null;
const events = [];
const counts = new Map();
const startedAt = Date.now();

// ---- Health and API description ----

$('health').onclick = async () => {
  $('specStatus').textContent = 'Checking…';
  try {
    const res = await fetch(`${API}/global/health`);
    $('specStatus').textContent = `${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    $('specStatus').textContent = `Failed: ${e.message}`;
  }
};

$('spec').onclick = async () => {
  $('specStatus').textContent = 'Loading…';
  try {
    const res = await fetch(`${API}/doc`);
    const text = await res.text();
    try {
      spec = JSON.parse(text);
    } catch {
      $('specStatus').textContent = `${res.status}: /doc did not return JSON (first 200 characters below)`;
      $('paths').hidden = false;
      $('paths').textContent = text.slice(0, 200);
      return;
    }
    const lines = [];
    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        if (typeof op !== 'object') continue;
        lines.push(`${method.toUpperCase().padEnd(7)} ${path}${op.summary ? '  — ' + op.summary : ''}`);
      }
    }
    $('paths').hidden = false;
    $('paths').textContent = lines.join('\n') || '(no paths found)';
    $('specStatus').textContent = `${lines.length} endpoints`;
    $('specDownload').disabled = false;
  } catch (e) {
    $('specStatus').textContent = `Failed: ${e.message}`;
  }
};

$('specDownload').onclick = () => spec && download('opencode-api.json', JSON.stringify(spec, null, 2));

// ---- Event stream recorder ----
// Reads the stream with fetch instead of EventSource, so events with any name are kept.

function eventType(ev) {
  return ev.data?.type ?? ev.event ?? 'message';
}

function renderCounts() {
  $('counts').innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `<tr><td>${escapeHtml(type)}</td><td>${n}</td></tr>`)
    .join('');
}

function show(ev) {
  const filter = $('filter').value.trim().toLowerCase();
  const line = `${(ev.t / 1000).toFixed(2).padStart(8)}s  ${eventType(ev)}  ${typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}`;
  if (!filter || line.toLowerCase().includes(filter)) {
    $('events').textContent += line.slice(0, 600) + '\n';
    $('events').scrollTop = $('events').scrollHeight;
  }
}

function record(block) {
  let name = null;
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length && !name) return;
  const raw = dataLines.join('\n');
  let data = raw;
  try { data = JSON.parse(raw); } catch { /* keep as text */ }
  const ev = { t: Date.now() - startedAt, event: name, data };
  events.push(ev);
  const type = eventType(ev);
  counts.set(type, (counts.get(type) ?? 0) + 1);
  renderCounts();
  show(ev);
}

$('startRec').onclick = async () => {
  $('startRec').disabled = true;
  $('stopRec').disabled = false;
  $('recStatus').textContent = 'Connecting…';
  controller = new AbortController();
  try {
    const streamPath = $('streamPath').value.trim() || '/event';
    const res = await fetch(`${API}${streamPath.startsWith('/') ? streamPath : '/' + streamPath}`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    $('recStatus').textContent = 'Recording';
    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        record(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
      }
    }
    $('recStatus').textContent = 'Stream ended by the server';
  } catch (e) {
    $('recStatus').textContent = e.name === 'AbortError' ? 'Stopped' : `Failed: ${e.message}`;
    if (e.name !== 'AbortError') console.error(errorText(e));
  } finally {
    $('startRec').disabled = false;
    $('stopRec').disabled = true;
    $('download').disabled = events.length === 0;
  }
};

$('stopRec').onclick = () => controller?.abort();

$('download').onclick = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  download(`opencode-events-${stamp}.json`, JSON.stringify({ recordedAt: new Date(startedAt).toISOString(), events }, null, 2));
};

$('filter').oninput = () => {
  $('events').textContent = '';
  events.forEach(show);
};

// ---- Manual requests ----

$('send').onclick = async () => {
  const method = $('method').value;
  const path = $('path').value.trim();
  const body = $('body').value.trim();
  $('response').textContent = 'Sending…';
  try {
    const res = await fetch(`${API}${path.startsWith('/') ? path : '/' + path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && method !== 'GET' ? body : undefined,
    });
    const text = await res.text();
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
    $('response').textContent = `${res.status} ${res.statusText}\n\n${pretty}`;
  } catch (e) {
    $('response').textContent = `Failed: ${e.message}`;
  }
};
