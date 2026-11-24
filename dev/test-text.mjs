// Checks the sentence splitter, speech cleanup and transcript filters. Run: node dev/test-text.mjs
import assert from 'node:assert/strict';
import { SentenceSplitter, cleanForSpeech, applyCorrections, isNoiseTranscript } from '../site/speech/text.js';
import { config } from '../site/config.js';

function split(chunks) {
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x));
  for (const c of chunks) s.push(c);
  s.flush();
  return out;
}

// Streams arrive in arbitrary chunks; sentences come out whole.
assert.deepEqual(split(['I chec', 'ked the logs. The cont', 'ainer restarted twice', ' today.']),
  ['I checked the logs.', 'The container restarted twice today.']);

// Dots inside numbers and file names don't end a sentence.
assert.deepEqual(split(['Version 3.5 is in config.yaml now. Done.']), ['Version 3.5 is in config.yaml now.', 'Done.']);

// Code blocks are skipped, and the text around them still comes out.
assert.deepEqual(split(['Here it is:\n```\nprint(1)\n', 'print(2)\n```\nIt prints two lines.']),
  ['Here it is:', 'It prints two lines.']);

// Nothing is emitted while a code block is still open.
{
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x));
  s.push('Running it.\n```\nline one. line two. ');
  assert.deepEqual(out, ['Running it.']);
}

// Long text without punctuation is cut rather than held forever.
{
  const out = [];
  const s = new SentenceSplitter((x) => out.push(x), { maxLength: 60 });
  s.push('word '.repeat(30));
  assert.ok(out.length >= 1 && out[0].length <= 60);
}

// Markdown is stripped for speech.
assert.equal(cleanForSpeech('**Done.** See `fib.py` or [the docs](https://x.y).'), 'Done. See fib.py or the docs.');
assert.equal(cleanForSpeech('- first item\n- second item'), 'first item second item');

// Corrections from the STT test.
const fix = (t) => applyCorrections(t, config.stt.corrections);
assert.equal(fix("I'm testing Jamas's speech to text"), "I'm testing Jhomas's speech to text");
assert.equal(fix('So testing Jomis and Jarmus and Jammus'), 'So testing Jhomas and Jhomas and Jhomas');
assert.equal(fix('Pull the new image for radar and sonar'), 'Pull the new image for Radarr and Sonarr');
assert.equal(fix('change the context in the lumb swap config'), 'change the context in the llama-swap config');
assert.equal(fix('Hey Jelly Finn, refresh'), 'Hey Jellyfin, refresh');
assert.equal(fix('Look online for alternatives to Cocoa Row 82M.'), 'Look online for alternatives to Kokoro 82M.');
assert.equal(fix('the weather radar is down'), 'the weather radar is down'); // ordinary words left alone

// Noise filter.
assert.equal(isNoiseTranscript('[BLANK_AUDIO]', 2), true);
assert.equal(isNoiseTranscript(' Thank you.', 0.8), true);
assert.equal(isNoiseTranscript('Thank you.', 3), false);
assert.equal(isNoiseTranscript('List the files.', 0.9), false);

console.log('text helpers: all checks passed');

// Spoken commands
const { matchApprovalWord, isStopCommand, speakableCommand, needsTap } = await import('../site/speech/text.js');
assert.equal(matchApprovalWord('Approve.'), 'approve');
assert.equal(matchApprovalWord('Jhomas, deny.'), 'deny');
assert.equal(matchApprovalWord('Read it.'), 'read');
assert.equal(matchApprovalWord('I think we should approve it after lunch'), null);
assert.equal(matchApprovalWord('What time is it?'), null);
assert.equal(isStopCommand('Stop.'), true);
assert.equal(isStopCommand('Never mind.'), true);
assert.equal(isStopCommand('Stop the container please'), false);
assert.equal(speakableCommand('python3 /workspace/fibonacci.py'), 'python3 fibonacci.py');
assert.equal(speakableCommand('wget -O /workspace/a.html "https://www.google.com/search?q=x"'), 'wget -O a.html www.google.com');
assert.equal(speakableCommand('a b c d e f g h', 4), 'a b c d and more');
assert.equal(needsTap({ kind: 'bash', command: 'rm -rf /workspace/x' }), true);
assert.equal(needsTap({ kind: 'bash', command: 'echo hi > /etc/hosts' }), true);
assert.equal(needsTap({ kind: 'bash', command: 'python3 /workspace/fib.py > /workspace/out.txt' }), false);
assert.equal(needsTap({ kind: 'bash', command: 'date' }), false);
assert.equal(needsTap({ kind: 'webfetch', command: 'https://example.com' }), false);
console.log('spoken commands: all checks passed');
