// Text handling between the agent and the speech models.

// Splits streamed reply text into sentences, so each can be spoken as soon as it's complete.
export class SentenceSplitter {
  constructor(onSentence, { maxLength = 240 } = {}) {
    this.onSentence = onSentence;
    this.maxLength = maxLength;
    this.buffer = '';
  }

  push(text) {
    this.buffer += text;
    for (;;) {
      const cut = this.findCut();
      if (cut <= 0) break;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      this.emit(sentence);
    }
  }

  flush() {
    const rest = this.buffer;
    this.buffer = '';
    this.emit(rest);
  }

  reset() {
    this.buffer = '';
  }

  emit(text) {
    const spoken = cleanForSpeech(text);
    if (spoken) this.onSentence(spoken);
  }

  // Index just after the next complete sentence, or -1 if none is complete yet.
  findCut() {
    const buffer = this.buffer;
    const fence = buffer.indexOf('```');

    // A code block at the start: wait until it's closed, then cut after it as one piece.
    if (fence >= 0 && buffer.slice(0, fence).trim() === '') {
      const close = buffer.indexOf('```', fence + 3);
      if (close < 0) return -1;
      const after = buffer.slice(close + 3).match(/^[^\n]*\n?/)[0]; // rest of the closing line
      return close + 3 + after.length;
    }

    // Otherwise only look at text before the next code block.
    const text = fence >= 0 ? buffer.slice(0, fence) : buffer;
    // Sentence end: . ! ? (with optional closing quote/bracket) followed by whitespace,
    // or a line break. "3.5" and "config.yaml" don't match because no space follows the dot.
    const sentenceEnd = text.match(/[.!?…]+["')\]]*\s+|\n+/);
    if (sentenceEnd) return sentenceEnd.index + sentenceEnd[0].length;
    if (fence > 0) return fence; // the words before a code block form their own piece

    // A very long run without punctuation: cut at the last comma or space.
    if (text.length > this.maxLength) {
      const window = text.slice(0, this.maxLength);
      const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
      return at > 40 ? at + 2 : Math.max(window.lastIndexOf(' '), 1);
    }
    return -1;
  }
}

// Turns reply text into something worth reading aloud: no code, no markdown symbols.
export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')          // code blocks are shown, not spoken
    .replace(/`([^`]*)`/g, '$1')                    // inline code: keep the words
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links: keep the label
    .replace(/https?:\/\/\S+/g, 'a link')          // bare addresses
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')            // headings
    .replace(/^\s*[-*+]\s+/gm, '')                  // bullets
    .replace(/^\s*\d+\.\s+/gm, '')                  // numbered lists
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)(?<=\S)\1/g, '$2') // bold/italic
    .replace(/[|>#*]+/g, ' ')                       // leftover table and quote marks
    .replace(/\s+/g, ' ')
    .trim();
}

// Fixes words speech recognition reliably gets wrong. Each rule: [pattern, replacement].
export function applyCorrections(text, rules) {
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

// Whisper invents text for silence and noise. These come back as the whole transcript.
const NOISE = new Set([
  '', 'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
  'bye', 'okay', 'hmm', 'um', 'uh', 'so',
]);

export function isNoiseTranscript(text, audioSeconds) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[\[(].*[\])]$/.test(trimmed)) return true; // [BLANK_AUDIO], (music), …
  if (!/[a-z0-9]/i.test(trimmed)) return true;     // punctuation only
  const plain = trimmed.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  return audioSeconds < 1.5 && NOISE.has(plain);
}

// ---------- spoken commands ----------

function plainWords(text) {
  return text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// While an approval is waiting, only these count. Anything else is ignored.
const APPROVE = new Set(['approve', 'approved', 'approve it', 'i approve', 'yes approve', 'a prove', 'approve that', 'approve once']);
const DENY = new Set(['deny', 'denied', 'deny it', 'no deny', 'deny that', 'reject', 'reject it', 'the night', 'deni']);
const READ = new Set(['read it', 'read it out', 'read that', 'read', 'repeat', 'repeat that', 'what is it', "what's the command", 'read the command']);

export function matchApprovalWord(text) {
  const t = plainWords(text).replace(/^(jhomas )/, '');
  if (APPROVE.has(t)) return 'approve';
  if (DENY.has(t)) return 'deny';
  if (READ.has(t)) return 'read';
  return null;
}

// "Stop", "cancel", "never mind" on their own stop the current reply instead of being sent.
export function isStopCommand(text) {
  return /^(jhomas )?(stop|stop it|stop that|cancel|cancel that|never mind|nevermind|forget it|be quiet|quiet|shut up)$/.test(plainWords(text));
}

// A command in a form worth saying aloud: paths shortened to file names, symbols dropped.
export function speakableCommand(command, maxWords = Infinity) {
  const words = command
    .replace(/[|&;<>`"'\\(){}$]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.includes('/') && !/^https?:/.test(w) ? w.split('/').filter(Boolean).pop() ?? w : w))
    .map((w) => (/^https?:\/\//.test(w) ? new URL(w).hostname : w));
  const shown = words.slice(0, maxWords).join(' ');
  return words.length > maxWords ? `${shown} and more` : shown;
}

// Deleting or moving files, or writing outside the workspace, needs a tap on screen, not a voice "approve".
export function needsTap(approval) {
  if (approval.kind !== 'bash') return approval.kind === 'edit' && !/^\/workspace\//.test(approval.command);
  return /(^|[\s;&|(])(rm|rmdir|unlink|mv|dd|mkfs|shred|truncate|chmod|chown|kill|pkill|reboot|shutdown)\b|>\s*\/(?!workspace\/)|\bsudo\b/.test(approval.command);
}
