// The voice side of the conversation loop: listen, transcribe, send, speak the reply,
// and keep you informed while Jhomas works.
//
// States:
//   off           mic off
//   loading       downloading / warming up the speech models
//   listening     waiting for you to talk
//   hearing       you're talking (if Jhomas was speaking, it pauses)
//   transcribing  turning your speech into text
//   waiting       your message was sent; Jhomas is working
//   speaking      reading the reply aloud
//
// Interrupting: speech while Jhomas talks pauses it. If it turns out to be noise, it carries on;
// if it's real speech, the reply is dropped and your new message goes in.
// While an approval is waiting, only "approve", "deny" and "read it" count.

import { SttEngine, TtsEngine, MicVad } from './speech/engines.js';
import { Player } from './speech/player.js';
import { timeStretch } from './speech/stretch.js';
import { SentenceSplitter, applyCorrections, isNoiseTranscript, matchApprovalWord, isStopCommand } from './speech/text.js';

const SAMPLE_RATE = 16000;
const now = () => performance.now();

// Status lines while a tool runs. Each wording is used at most once per turn.
function toolLines(tool, title) {
  const name = (title.split(/\s+/).pop() ?? '').split('/').pop();
  switch (tool) {
    case 'read': return [`Still reading ${name}.`, 'Still reading the file.'];
    case 'glob':
    case 'grep':
    case 'list': return ['Still searching the files.', 'Still looking through the files.'];
    case 'bash': return [`Still running ${title.split(/\s+/)[0]}.`, 'The command is still running.'];
    case 'webfetch': return ['Still fetching the page.', 'The page is still loading.'];
    default: return [];
  }
}
const GENERIC_LINES = ['One moment.', 'Still thinking.', 'Still working on it.', 'This is taking a while.', 'Still going.'];

export class Voice {
  constructor({ config, settings, on }) {
    this.config = config;
    this.settings = settings;
    this.on = on; // { state, transcript, approvalWord, command, timing, progress, warning, error }
    this.state = 'off';
    this.engines = null; // { stt, tts, vad }; created in enable(), or set by tests beforehand
    this.player = new Player();
    this.player.onEnded = () => this.maybeFinish();
    this.splitter = new SentenceSplitter((s) => this.enqueue(s, 'reply'));
    this.queue = [];
    this.generating = false;
    this.generation = 0;       // bumped by stopSpeaking() so late results are dropped
    this.speaker = false;      // this device sent the last message, so it speaks the reply
    this.turnOver = true;
    this.turnMessage = null;   // the user message whose reply we're speaking ('pending' until confirmed)
    this.firstAudioPending = false;
    this.streamedParts = new Set();
    this.prevState = 'listening';
    this.paused = false;
    this.approval = null;
    this.tools = new Map();    // running voice-agent tools: callId -> { tool, title }
    this.workerActive = false;
    this.usedLines = new Set();
    this.silenceStart = now();
    this.silenceLines = 0;
    this.narrationTimer = null;
  }

  get enabled() {
    return this.state !== 'off' && this.state !== 'loading';
  }

  get speaking() {
    return this.speaker && this.settings.speakReplies && this.enabled;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.on.state?.(state);
  }

  // ---------- turning the mic on and off ----------

  async enable() {
    if (this.state !== 'off') return;
    const unlocking = this.player.unlock(); // must start inside the click
    this.setState('loading');
    try {
      await unlocking;
      this.engines = this.engines ?? {};
      await this.loadEngines();
      await this.engines.vad.start({
        onSpeechStart: () => this.speechStarted(),
        onSpeechEnd: (audio) => this.speechEnded(audio),
        onMisfire: () => this.speechMisfired(),
      });
      this.setState(this.turnOver ? 'listening' : 'waiting');
      clearInterval(this.narrationTimer);
      this.narrationTimer = setInterval(() => this.narrate(), 500);
      if (this.approval) this.announceApproval();
    } catch (e) {
      this.setState('off');
      this.on.error?.(`Couldn't start voice: ${e.message}`);
    }
  }

  async loadEngines() {
    const e = this.engines;
    // Recreate an engine if the settings changed since it was loaded.
    const sttSig = JSON.stringify([this.settings.sttModel, this.settings.sttDevice]);
    const ttsSig = JSON.stringify([this.settings.ttsModel, this.settings.ttsDevice]);
    if (e.stt && e.stt.signature && e.stt.signature !== sttSig) { e.stt.dispose(); e.stt = null; e.sttReady = false; }
    if (e.tts && e.tts.signature && e.tts.signature !== ttsSig) { e.tts.dispose(); e.tts = null; e.ttsReady = false; }
    e.stt = e.stt ?? new SttEngine(this.config, this.settings);
    e.tts = e.tts ?? new TtsEngine(this.config, this.settings);
    e.vad = e.vad ?? new MicVad(this.config);

    const files = new Map();
    const progress = (who) => ({ file, loaded, total }) => {
      files.set(`${who}:${file}`, { loaded: loaded ?? 0, total: total ?? 0 });
      let loadedSum = 0;
      let totalSum = 0;
      for (const f of files.values()) { loadedSum += f.loaded; totalSum += f.total; }
      if (totalSum) this.on.progress?.(Math.round((loadedSum / totalSum) * 100));
    };
    const warn = (m) => this.on.warning?.(m);
    await Promise.all([
      e.sttReady ? null : e.stt.load(progress('stt'), warn).then(() => (e.sttReady = true)),
      e.ttsReady ? null : e.tts.load(progress('tts'), warn).then(() => (e.ttsReady = true)),
    ]);
  }

  async disable() {
    clearInterval(this.narrationTimer);
    this.stopSpeaking();
    await this.engines?.vad?.destroy();
    if (this.engines) this.engines.vad = null;
    this.setState('off');
  }

  // ---------- your speech ----------

  speechStarted() {
    if (this.state === 'listening') {
      this.prevState = 'listening';
      this.setState('hearing');
      return;
    }
    // Interrupting, or answering an approval.
    if ((this.state === 'speaking' || this.state === 'waiting') && (this.settings.bargeIn || this.approval)) {
      this.prevState = this.state;
      if (this.player.playing) {
        this.player.pause();
        this.paused = true;
      }
      this.setState('hearing');
    }
  }

  // Not speech after all: carry on where we were.
  restore() {
    if (this.paused) {
      this.player.resume();
      this.paused = false;
    }
    this.setState(this.prevState === 'speaking' && !this.player.playing && !this.queue.length && !this.generating ? 'waiting' : this.prevState);
    this.maybeFinish();
  }

  speechMisfired() {
    if (this.state === 'hearing') this.restore();
  }

  async speechEnded(audio) {
    if (this.state !== 'hearing') return;
    const speechEndAt = now();
    this.setState('transcribing');
    let text = '';
    try {
      text = await this.engines.stt.transcribe(audio);
    } catch (e) {
      this.on.error?.(`Transcription failed: ${e.message}`);
      this.restore();
      return;
    }
    if (this.state !== 'transcribing') return; // turned off meanwhile
    text = applyCorrections(text, this.config.stt.corrections).trim();
    if (isNoiseTranscript(text, audio.length / SAMPLE_RATE)) {
      this.restore();
      return;
    }

    // An approval is waiting: only the approval words count.
    if (this.approval) {
      const word = matchApprovalWord(text);
      if (!word) {
        this.restore();
        return;
      }
      this.stopSpeaking();
      this.paused = false;
      this.setState(this.prevState === 'listening' ? 'listening' : 'waiting');
      this.on.approvalWord?.(word, this.approval);
      return;
    }

    if (isStopCommand(text)) {
      this.stopSpeaking();
      this.paused = false;
      this.speaker = false;
      this.setState('listening');
      this.on.command?.('stop');
      return;
    }

    const interrupting = this.prevState !== 'listening';
    if (interrupting) {
      // Drop the old reply right away, including whatever is still streaming in.
      this.stopSpeaking();
      this.speaker = false;
    }
    this.paused = false;
    this.on.timing?.('speechEnd', speechEndAt);
    this.setState('waiting');
    this.on.transcript?.(text, { interrupting });
  }

  // ---------- the reply ----------

  // Called when this device sends a message (spoken or typed): this device speaks the reply.
  expectReply() {
    this.stopSpeaking();
    this.speaker = true;
    this.turnOver = false;
    this.turnMessage = 'pending';
    this.firstAudioPending = true;
    this.streamedParts.clear();
    this.tools.clear();
    this.workerActive = false;
    this.usedLines.clear();
    this.silenceStart = now();
    this.silenceLines = 0;
    if (this.enabled) this.setState('waiting');
  }

  // The server confirmed our message; replies to it are the ones to speak.
  confirmTurn(messageId) {
    if (this.speaker && this.turnMessage === 'pending') this.turnMessage = messageId;
  }

  // Another device sent a message: this one stays quiet.
  notSpeaker() {
    this.speaker = false;
    this.stopSpeaking();
    if (this.enabled && ['waiting', 'speaking'].includes(this.state)) this.setState('listening');
  }

  belongsToTurn(replyTo) {
    if (!replyTo || !this.turnMessage) return true;
    return replyTo === this.turnMessage;
  }

  replyDelta(partId, delta, replyTo) {
    if (!this.belongsToTurn(replyTo)) return;
    this.streamedParts.add(partId);
    if (this.speaking) this.splitter.push(delta);
  }

  // A text part finished. Parts that never streamed are spoken whole.
  replyDone(partId, text, replyTo) {
    if (!this.speaking || !this.belongsToTurn(replyTo)) return;
    if (!this.streamedParts.has(partId)) this.splitter.push(text);
    this.splitter.flush();
  }

  // A line the page itself says (status, approvals, denials).
  say(text) {
    if (!this.speaking) return;
    this.splitter.flush();
    this.enqueue(text, 'status');
  }

  turnEnded() {
    this.splitter.flush();
    this.turnOver = true;
    this.tools.clear();
    this.workerActive = false;
    this.maybeFinish();
  }

  enqueue(text, kind) {
    if (!this.speaking) return;
    this.queue.push({ text, kind });
    this.pump();
  }

  async pump() {
    if (this.generating) return;
    this.generating = true;
    const generation = this.generation;
    try {
      while (this.queue.length && generation === this.generation) {
        const item = this.queue.shift();
        let audio;
        try {
          audio = await this.engines.tts.synthesize(item.text, { voice: this.settings.voice, speed: this.settings.speed });
        } catch (e) {
          this.on.error?.(`Speech failed: ${e.message}`);
          continue;
        }
        if (generation !== this.generation) break; // stopped while generating
        const samples = timeStretch(audio.samples, this.settings.playbackRate ?? 1, audio.rate);
        const delay = this.player.play(samples, audio.rate);
        if (item.kind === 'reply') {
          // Real reply speech resets the quiet-time clock for status lines.
          this.silenceStart = now() + (delay + samples.length / audio.rate) * 1000;
          this.silenceLines = 0;
          if (this.firstAudioPending) {
            this.firstAudioPending = false;
            this.on.timing?.('firstAudio');
          }
        }
        if (this.state === 'waiting') this.setState('speaking');
      }
    } finally {
      this.generating = false;
      if (generation === this.generation) this.maybeFinish();
    }
  }

  // Back to listening once the reply is over and everything has been said.
  maybeFinish() {
    if (this.queue.length || this.generating || this.player.playing) return;
    if (this.state === 'speaking') this.setState(this.turnOver ? 'listening' : 'waiting');
    if (!this.turnOver) return;
    this.speaker = false;
    if (this.state === 'waiting') this.setState('listening');
  }

  stopSpeaking() {
    this.generation++;
    this.queue = [];
    this.splitter.reset();
    this.player.stop();
  }

  // ---------- keeping you informed ----------

  toolStarted(callId, tool, title) {
    this.tools.set(callId, { tool, title });
  }

  toolEnded(callId) {
    this.tools.delete(callId);
  }

  workerStarted() {
    this.workerActive = true;
    const quietFor = now() - this.silenceStart;
    if (quietFor > 3000 && !this.player.playing && !this.queue.length && !this.generating) this.say('Handing that to the worker.');
  }

  workerEnded(ok) {
    this.workerActive = false;
    this.silenceStart = now();
    this.silenceLines = 0;
    if (!ok) this.say('The worker ran into a problem.');
  }

  workerFailed() {
    if (!this.usedLines.has('worker-failed')) {
      this.usedLines.add('worker-failed');
      this.say('The worker ran into a problem.');
    }
  }

  // Runs every half second: after 4 s of quiet, then 10 s, then every 20 s, say what's happening.
  narrate() {
    if (!this.speaking || this.turnOver) return;
    if (this.approval || this.workerActive) {
      this.silenceStart = now();
      this.silenceLines = 0;
      return;
    }
    if (this.player.playing || this.queue.length || this.generating) return;
    if (this.state !== 'waiting') return; // never while you're talking
    const due = this.silenceLines === 0 ? 4000 : this.silenceLines === 1 ? 10000 : 10000 + 20000 * (this.silenceLines - 1);
    if (now() - this.silenceStart < due) return;
    this.silenceLines++;
    const running = [...this.tools.values()].at(-1);
    const options = [...(running ? toolLines(running.tool, running.title) : []), ...GENERIC_LINES];
    const line = options.find((l) => !this.usedLines.has(l));
    if (!line) return;
    this.usedLines.add(line);
    this.say(line);
  }

  // ---------- approvals ----------

  setApproval(approval) {
    const changed = approval?.id !== this.approval?.id;
    this.approval = approval;
    if (approval && changed) this.announceApproval();
  }

  announceApproval() {
    if (this.approval) this.on.announceApproval?.(this.approval);
  }
}
