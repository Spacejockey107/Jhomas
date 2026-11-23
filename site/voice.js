// The voice side of the conversation loop: listen, transcribe, send, and speak the reply.
//
// States:
//   off           mic off
//   loading       downloading / warming up the speech models
//   listening     waiting for you to talk
//   hearing       you're talking
//   transcribing  turning your speech into text
//   waiting       your message was sent; waiting for the reply
//   speaking      reading the reply aloud
//
// Milestone 2: speech while Jhomas is waiting or speaking is ignored. Barge-in (interrupting)
// comes in Milestone 3, voice approvals in Milestone 4, the wake word once it's trained.

import { SttEngine, TtsEngine, MicVad } from './speech/engines.js';
import { Player } from './speech/player.js';
import { SentenceSplitter, applyCorrections, isNoiseTranscript } from './speech/text.js';

const SAMPLE_RATE = 16000;

export class Voice {
  constructor({ config, settings, on }) {
    this.config = config;
    this.settings = settings;
    this.on = on; // { state, transcript, timing, progress, warning, error }
    this.state = 'off';
    this.engines = null; // { stt, tts, vad }; set in enable(), or by tests beforehand
    this.player = new Player();
    this.player.onEnded = () => this.maybeFinish();
    this.splitter = new SentenceSplitter((s) => this.enqueue(s));
    this.queue = [];
    this.generating = false;
    this.generation = 0;      // bumped by stopSpeaking() so late results are dropped
    this.speaker = false;     // this device sent the last message, so it speaks the reply
    this.turnOver = true;
    this.firstAudioPending = false;
    this.streamedParts = new Set();
  }

  get enabled() {
    return this.state !== 'off' && this.state !== 'loading';
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

    // Overall download progress across both models.
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
    this.stopSpeaking();
    await this.engines?.vad?.destroy();
    if (this.engines) this.engines.vad = null;
    this.setState('off');
  }

  // ---------- your speech ----------

  speechStarted() {
    if (this.state === 'listening') this.setState('hearing');
  }

  speechMisfired() {
    if (this.state === 'hearing') this.setState('listening');
  }

  async speechEnded(audio) {
    if (this.state !== 'hearing') return;
    this.on.timing?.('speechEnd');
    this.setState('transcribing');
    let text = '';
    try {
      text = await this.engines.stt.transcribe(audio);
    } catch (e) {
      this.on.error?.(`Transcription failed: ${e.message}`);
      this.setState('listening');
      return;
    }
    if (this.state !== 'transcribing') return; // turned off meanwhile
    text = applyCorrections(text, this.config.stt.corrections).trim();
    if (isNoiseTranscript(text, audio.length / SAMPLE_RATE)) {
      this.setState('listening');
      return;
    }
    this.setState('waiting');
    this.on.transcript?.(text);
  }

  // ---------- the reply ----------

  // Called when this device sends a message (spoken or typed): this device speaks the reply.
  expectReply() {
    this.stopSpeaking();
    this.speaker = true;
    this.turnOver = false;
    this.firstAudioPending = true;
    this.streamedParts.clear();
    if (this.enabled) this.setState('waiting');
  }

  // Another device sent a message: this one stays quiet.
  notSpeaker() {
    this.speaker = false;
    this.stopSpeaking();
  }

  get speaking() {
    return this.speaker && this.settings.speakReplies && this.enabled;
  }

  replyDelta(partId, delta) {
    this.streamedParts.add(partId);
    if (this.speaking) this.splitter.push(delta);
  }

  // A text part finished. Parts that never streamed are spoken whole.
  replyDone(partId, text) {
    if (!this.speaking) return;
    if (!this.streamedParts.has(partId)) this.splitter.push(text);
    this.splitter.flush();
  }

  // Speak a line the page itself produces (not from the agent).
  say(text) {
    if (!this.speaking) return;
    this.splitter.flush();
    this.splitter.push(text);
    this.splitter.flush();
  }

  turnEnded() {
    this.splitter.flush();
    this.turnOver = true;
    this.maybeFinish();
  }

  enqueue(sentence) {
    if (!this.speaking) return;
    this.queue.push(sentence);
    this.pump();
  }

  async pump() {
    if (this.generating) return;
    this.generating = true;
    const generation = this.generation;
    try {
      while (this.queue.length && generation === this.generation) {
        const sentence = this.queue.shift();
        let audio;
        try {
          audio = await this.engines.tts.synthesize(sentence, { voice: this.settings.voice, speed: this.settings.speed });
        } catch (e) {
          this.on.error?.(`Speech failed: ${e.message}`);
          continue;
        }
        if (generation !== this.generation) break; // stopped while generating
        this.player.play(audio.samples, audio.rate);
        if (this.firstAudioPending) {
          this.firstAudioPending = false;
          this.on.timing?.('firstAudio');
        }
        this.setState('speaking');
      }
    } finally {
      this.generating = false;
      if (generation === this.generation) this.maybeFinish();
    }
  }

  // Back to listening once the reply is over and everything has been said.
  maybeFinish() {
    if (!this.turnOver || this.queue.length || this.generating || this.player.playing) return;
    this.speaker = false;
    if (this.enabled) this.setState('listening');
  }

  stopSpeaking() {
    this.generation++;
    this.queue = [];
    this.splitter.reset();
    this.player.stop();
  }
}
