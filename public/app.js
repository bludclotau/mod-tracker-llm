/* MOD Tracker — WAV and FM instruments, pattern editing, and real-time effects. */
(() => {
  "use strict";

  const NOTES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
  const ROLES = ["kick", "snare", "hat", "openhat", "clap", "perc", "crash", "bass"];
  const LOWER = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11 };
  const UPPER = { q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23 };
  const PREVIEW_CHANNEL = "preview";
  const WAVEFORMS = ["sine", "triangle", "sawtooth", "square"];
  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const hex2 = (n) => Number(n).toString(16).toUpperCase().padStart(2, "0");

  function numberIn(value, min, max, fallback) {
    const n = value === "" || value == null ? NaN : Number(value);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  }

  const FM_DEFAULTS = [
    {
      id: "fm:bass", label: "F1", name: "Round FM Bass", kind: "fm",
      waveform: "sine", ratio: 1, index: 3.5, modulationDecay: 0.16,
      attack: 0.005, decay: 0.18, sustain: 0.45, release: 0.14,
      gate: 0.24, previewMidi: 36,
    },
    {
      id: "fm:bell", label: "F2", name: "Glass FM Bell", kind: "fm",
      waveform: "sine", ratio: 2.76, index: 5, modulationDecay: 1.2,
      attack: 0.003, decay: 1.3, sustain: 0.06, release: 1.1,
      gate: 0.8, previewMidi: 72,
    },
    {
      id: "fm:keys", label: "F3", name: "Soft Electric Keys", kind: "fm",
      waveform: "sine", ratio: 2, index: 1.8, modulationDecay: 0.4,
      attack: 0.008, decay: 0.55, sustain: 0.25, release: 0.45,
      gate: 0.5, previewMidi: 60,
    },
  ];

  const EFFECT_DEFAULTS = Object.freeze({
    filterCutoff: 20000,
    filterResonance: 0.707,
    drive: 0,
    delayTime: 0.25,
    delayFeedback: 0,
    delayMix: 0,
    reverbMix: 0,
    compressorThreshold: 0,
    compressorRatio: 1,
    pan: 0,
  });

  const FM_CONTROLS = [
    ["ratio", "Modulator ratio", 0.125, 16, 0.125],
    ["index", "Modulation index", 0, 20, 0.1],
    ["modulationDecay", "Modulation decay (s)", 0.005, 5, 0.005],
    ["attack", "Attack (s)", 0.001, 2, 0.001],
    ["decay", "Decay (s)", 0.005, 5, 0.005],
    ["sustain", "Sustain", 0, 1, 0.01],
    ["release", "Release (s)", 0.005, 5, 0.005],
    ["gate", "Gate duration (s)", 0.02, 5, 0.01],
  ];

  const EFFECT_CONTROLS = [
    ["filterCutoff", "Low-pass cutoff (Hz)", 40, 20000, 1],
    ["filterResonance", "Filter resonance (Q)", 0.1, 20, 0.1],
    ["drive", "Saturation", 0, 100, 1],
    ["delayTime", "Delay time (s)", 0.01, 2, 0.01],
    ["delayFeedback", "Delay feedback", 0, 0.9, 0.01],
    ["delayMix", "Delay mix", 0, 1, 0.01],
    ["reverbMix", "Reverb mix", 0, 1, 0.01],
    ["compressorThreshold", "Compressor threshold (dB)", -60, 0, 1],
    ["compressorRatio", "Compressor ratio", 1, 20, 0.1],
    ["pan", "Master pan", -1, 1, 0.01],
  ];

  /*
   * The engine owns all voices and the effects graph. Instrument settings are
   * snapshotted per note; effect parameters remain live.
   */
  class TrackerAudioEngine {
    constructor(context) {
      this.ctx = context;
      this.voices = new Map();
      this.effects = { ...EFFECT_DEFAULTS };

      this.input = context.createGain();
      this.filter = context.createBiquadFilter();
      this.filter.type = "lowpass";
      this.shaper = context.createWaveShaper();
      this.shaper.oversample = "2x";
      this.compressor = context.createDynamicsCompressor();
      this.compressor.knee.value = 0;
      this.compressor.attack.value = 0.006;
      this.compressor.release.value = 0.15;
      this.panner = context.createStereoPanner();
      this.master = context.createGain();

      this.input.connect(this.filter);
      this.filter.connect(this.shaper);
      this.shaper.connect(this.compressor);

      this.delay = context.createDelay(2);
      this.delayFeedback = context.createGain();
      this.delayWet = context.createGain();
      this.convolver = context.createConvolver();
      this.reverbWet = context.createGain();
      this.wetBus = context.createGain();

      this.compressor.connect(this.panner);
      this.compressor.connect(this.delay);
      this.delay.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delay);
      this.delay.connect(this.delayWet);
      this.delayWet.connect(this.wetBus);

      this.compressor.connect(this.convolver);
      this.convolver.connect(this.reverbWet);
      this.reverbWet.connect(this.wetBus);
      this.wetBus.connect(this.panner);
      this.panner.connect(this.master);
      this.master.connect(context.destination);

      const length = Math.floor(context.sampleRate * 2.2);
      const impulse = context.createBuffer(2, length, context.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
        }
      }
      this.convolver.buffer = impulse;
      for (const [key, value] of Object.entries(this.effects)) this.setEffect(key, value);
      this.setMasterVolume(0.8);
    }

    smooth(param, value) {
      const now = this.ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.015);
    }

    setMasterVolume(value) {
      this.smooth(this.master.gain, numberIn(value, 0, 1, 0.8));
    }

    setEffect(key, value) {
      const spec = EFFECT_CONTROLS.find((control) => control[0] === key);
      if (!spec) return;
      value = numberIn(value, spec[2], spec[3], EFFECT_DEFAULTS[key]);
      this.effects[key] = value;
      switch (key) {
        case "filterCutoff":
          this.smooth(this.filter.frequency, Math.min(value, this.ctx.sampleRate * 0.49));
          break;
        case "filterResonance":
          this.smooth(this.filter.Q, value);
          break;
        case "drive": {
          if (value === 0) {
            this.shaper.curve = null;
          } else {
            const curve = new Float32Array(4096);
            const amount = 1 + value / 8;
            const scale = Math.tanh(amount);
            for (let i = 0; i < curve.length; i++) {
              const x = i * 2 / (curve.length - 1) - 1;
              curve[i] = Math.tanh(x * amount) / scale;
            }
            this.shaper.curve = curve;
          }
          break;
        }
        case "delayTime": this.smooth(this.delay.delayTime, value); break;
        case "delayFeedback": this.smooth(this.delayFeedback.gain, value); break;
        case "delayMix": this.smooth(this.delayWet.gain, value * 0.65); break;
        case "reverbMix": this.smooth(this.reverbWet.gain, value * 0.65); break;
        case "compressorThreshold": this.smooth(this.compressor.threshold, value); break;
        case "compressorRatio": this.smooth(this.compressor.ratio, value); break;
        case "pan": this.smooth(this.panner.pan, value); break;
      }
    }

    registerVoice(channel, sources, gain, pan, when, volume, extraNodes = []) {
      const voice = { sources, gain, pan, when, volume, extraNodes, stopAt: Infinity };
      if (!this.voices.has(channel)) this.voices.set(channel, new Set());
      this.voices.get(channel).add(voice);
      sources[0].onended = () => {
        const voices = this.voices.get(channel);
        voices?.delete(voice);
        if (!voices?.size) this.voices.delete(channel);
        for (const node of [...sources, gain, pan, ...extraNodes]) {
          try { node.disconnect(); } catch { /* Already disconnected. */ }
        }
      };
      return voice;
    }

    voiceOutput(channel, when, volume) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = typeof channel === "number" ? (channel - 3.5) / 8 : 0;
      gain.gain.setValueAtTime(volume, when);
      gain.connect(pan).connect(this.input);

      // Stop silences old effect tails; opening the bus permits new notes.
      this.wetBus.gain.setValueAtTime(1, when);
      return { gain, pan };
    }

    stopChannel(channel, when = this.ctx.currentTime) {
      const voices = this.voices.get(channel);
      if (!voices) return;
      const time = Math.max(this.ctx.currentTime, when);
      for (const voice of voices) {
        if (voice.when > time || voice.stopAt <= time) continue;
        voice.stopAt = time;
        const param = voice.gain.gain;
        try {
          if (typeof param.cancelAndHoldAtTime === "function") {
            param.cancelAndHoldAtTime(time);
          } else {
            param.cancelScheduledValues(time);
            param.setValueAtTime(voice.volume, time);
          }
          param.linearRampToValueAtTime(0, time + 0.006);
          for (const source of voice.sources) source.stop(time + 0.008);
        } catch { /* A naturally ended voice needs no further stop. */ }
      }
    }

    stopAll() {
      const now = this.ctx.currentTime;
      for (const voices of this.voices.values()) {
        for (const voice of voices) {
          try {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setValueAtTime(0, now);
            for (const source of voice.sources) source.stop(now);
          } catch { /* Already ended. */ }
        }
      }
      this.voices.clear();
      this.wetBus.gain.cancelScheduledValues(now);
      this.wetBus.gain.setValueAtTime(0, now);

      // Clear delay memory without changing the user's effect settings.
      this.delay.disconnect();
      this.delayFeedback.disconnect();
      this.compressor.disconnect(this.delay);
      this.delay = this.ctx.createDelay(2);
      this.delay.delayTime.value = this.effects.delayTime;
      this.compressor.connect(this.delay);
      this.delay.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delay);
      this.delay.connect(this.delayWet);

      // Replacing the convolution node discards its old reverb tail.
      const impulse = this.convolver.buffer;
      this.compressor.disconnect(this.convolver);
      this.convolver.disconnect();
      this.convolver = this.ctx.createConvolver();
      this.convolver.buffer = impulse;
      this.compressor.connect(this.convolver);
      this.convolver.connect(this.reverbWet);
    }

    playSample(buffer, { channel, when, playbackRate = 1, volume = 1 }) {
      const time = Math.max(this.ctx.currentTime, when);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.setValueAtTime(playbackRate, time);
      const { gain, pan } = this.voiceOutput(channel, time, volume);
      source.connect(gain);
      this.registerVoice(channel, [source], gain, pan, time, volume);
      source.start(time);
    }

    playFM(patch, { channel, when, frequency, volume = 1 }) {
      const p = { ...patch };
      const time = Math.max(this.ctx.currentTime, when);
      const carrier = this.ctx.createOscillator();
      const modulator = this.ctx.createOscillator();
      const modulation = this.ctx.createGain();
      carrier.type = WAVEFORMS.includes(p.waveform) ? p.waveform : "sine";
      carrier.frequency.setValueAtTime(frequency, time);
      modulator.type = "sine";
      modulator.frequency.setValueAtTime(frequency * p.ratio, time);
      modulation.gain.setValueAtTime(frequency * p.index, time);
      modulation.gain.setTargetAtTime(0, time, Math.max(0.005, p.modulationDecay / 3));
      modulator.connect(modulation).connect(carrier.frequency);

      const level = volume * 0.45;
      const { gain, pan } = this.voiceOutput(channel, time, 0);
      const attackEnd = time + p.attack;
      const decayEnd = attackEnd + p.decay;
      const gateEnd = time + p.gate;
      const releaseEnd = gateEnd + p.release;

      gain.gain.setValueAtTime(0, time);
      if (gateEnd <= attackEnd) {
        gain.gain.linearRampToValueAtTime(level * p.gate / p.attack, gateEnd);
      } else {
        gain.gain.linearRampToValueAtTime(level, attackEnd);
        if (gateEnd < decayEnd) {
          const progress = (gateEnd - attackEnd) / p.decay;
          gain.gain.linearRampToValueAtTime(level * (1 - (1 - p.sustain) * progress), gateEnd);
        } else {
          gain.gain.linearRampToValueAtTime(level * p.sustain, decayEnd);
          gain.gain.setValueAtTime(level * p.sustain, gateEnd);
        }
      }
      gain.gain.linearRampToValueAtTime(0, releaseEnd);
      carrier.connect(gain);
      this.registerVoice(channel, [carrier, modulator], gain, pan, time, level, [modulation]);
      carrier.start(time);
      modulator.start(time);
      carrier.stop(releaseEnd + 0.01);
      modulator.stop(releaseEnd + 0.01);
    }
  }

  const state = {
    samples: [],
    fmPatches: FM_DEFAULTS.map((patch) => ({ ...patch })),
    activeFMPatchId: "fm:bass",
    effectSettings: { ...EFFECT_DEFAULTS },
    audioEngine: null,
    byId: new Map(),
    buffers: new Map(),
    bufferPromises: new Map(),
    song: null,
    row: 0,
    ch: 0,
    playing: false,
    ctx: null,
    master: null,
    nextTime: 0,
    playRow: 0,
    timer: 0,
    octave: 4,
    selectedSample: 1,
    playbackStartGeneration: 0,
    playbackStartPromise: null,
    auditionGeneration: 0,
    playheadQueue: [],
    composing: false,
  };
  for (const patch of state.fmPatches) state.byId.set(patch.id, patch);

  function instrumentLabel(id) {
    const instrument = state.byId.get(id);
    if (instrument?.kind === "fm") return instrument.label;
    if (typeof id === "string" && id.startsWith("fm:")) {
      return FM_DEFAULTS.find((patch) => patch.id === id)?.label || "FM";
    }
    return typeof id === "number" && Number.isFinite(id) ? hex2(id) : "--";
  }

  function midiOf(note) {
    if (!note || note === "---" || note === "...") return null;
    const match = String(note).match(/^([A-G]#?)[ -]?(\d)$/i);
    if (!match) return null;
    const token = match[1].length === 1
      ? match[1].toUpperCase() + "-"
      : match[1][0].toUpperCase() + match[1][1];
    const index = NOTES.indexOf(token);
    return index < 0 ? null : index + (Number(match[2]) + 1) * 12;
  }

  function fmtNote(midi) {
    if (midi == null) return "---";
    return NOTES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  function emptyCell() {
    return { note: null, sample: 0, volume: 0, effect: 0, param: 0 };
  }

  function defaultSong() {
    return {
      title: "Untitled", bpm: 90, speed: 6, rows: 16, channels: 8,
      order: [0], kit: {}, tracks: {},
      patterns: [{
        name: "Untitled",
        rows: 16,
        data: Array.from({ length: 8 }, () => Array.from({ length: 16 }, emptyCell)),
      }],
      llm: { provider: "none" },
    };
  }

  function setStatus(message, kind = "") {
    $("status").textContent = message;
    $("status").className = `status${kind ? ` ${kind}` : ""}`;
  }

  function reportAudioError(error) {
    console.error("Tracker audio:", error);
    setStatus(`Audio failed: ${error.message || error}. Check audio permission and sample availability, then try again.`, "err");
  }

  function runAudio(action) {
    Promise.resolve().then(action).catch(reportAudioError);
  }

  function secondsPerRow() {
    return 15 / numberIn($("bpm").value, 20, 400, state.song?.bpm || 90);
  }

  async function ensureAudio() {
    if (!state.ctx || state.ctx.state === "closed") {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support Web Audio");
      state.ctx = new AudioContextClass();
      state.audioEngine = null;
      state.buffers.clear();
      state.bufferPromises.clear();
    }
    if (!state.audioEngine) {
      state.audioEngine = new TrackerAudioEngine(state.ctx);
      state.master = state.audioEngine.master;
      state.audioEngine.setMasterVolume(numberIn($("master").value, 0, 100, 80) / 100);
      for (const [key, value] of Object.entries(state.effectSettings)) {
        state.audioEngine.setEffect(key, value);
      }
    }
    if (state.ctx.state === "suspended") await state.ctx.resume();
    if (state.ctx.state !== "running") {
      throw new Error("Audio is suspended; click Play or Audition to enable it");
    }
    return state.ctx;
  }

  async function decodeSample(sample) {
    if (!sample || sample.kind === "fm") return null;
    if (state.buffers.has(sample.id)) return state.buffers.get(sample.id);
    if (state.bufferPromises.has(sample.id)) return state.bufferPromises.get(sample.id);
    const pending = (async () => {
      const ctx = await ensureAudio();
      if (!sample.url) throw new Error(`No WAV URL for ${sample.name || sample.id}`);
      const response = await fetch(sample.url);
      if (!response.ok) {
        throw new Error(`Cannot load ${sample.name || sample.id} (HTTP ${response.status})`);
      }
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      state.buffers.set(sample.id, buffer);
      return buffer;
    })();
    state.bufferPromises.set(sample.id, pending);
    try {
      return await pending;
    } finally {
      if (state.bufferPromises.get(sample.id) === pending) state.bufferPromises.delete(sample.id);
    }
  }

  function stopVoice(channel, when = state.ctx?.currentTime) {
    if (state.audioEngine) state.audioEngine.stopChannel(channel, when);
  }

  function trigger(cell, when, channel, role) {
    if (!cell?.sample || !cell.note || !state.audioEngine) return;
    const instrument = state.byId.get(cell.sample);
    if (!instrument) return;
    const isFM = instrument.kind === "fm";
    const buffer = isFM ? null : state.buffers.get(instrument.id);
    if (!isFM && !buffer) return;

    if (instrument.muteGroup === "hats") {
      stopVoice(ROLES.indexOf("hat"), when);
      stopVoice(ROLES.indexOf("openhat"), when);
      if (channel !== ROLES.indexOf("hat") && channel !== ROLES.indexOf("openhat")) {
        stopVoice(channel, when);
      }
    } else {
      stopVoice(channel, when);
    }

    const midi = midiOf(cell.note) ?? (role === "bass" ? 24 : 60);
    const volume = numberIn(cell.volume ?? 64, 0, 64, 64) / 64;
    if (isFM) {
      state.audioEngine.playFM(instrument, {
        channel, when, volume,
        frequency: 440 * 2 ** ((midi - 69) / 12),
      });
    } else {
      state.audioEngine.playSample(buffer, {
        channel, when, volume,
        playbackRate: 2 ** ((midi - 60) / 12),
      });
    }
  }

  function schedule(generation) {
    if (!state.playing || !state.ctx || generation !== state.playbackStartGeneration) return;
    try {
      const now = state.ctx.currentTime;
      const pattern = state.song.patterns[0];
      // Do not replay a backlog after a suspended/background browser tab.
      if (state.nextTime < now - secondsPerRow()) state.nextTime = now + 0.02;
      while (state.nextTime < now + 0.12) {
        const row = state.playRow;
        for (let channel = 0; channel < 8; channel++) {
          trigger(pattern.data[channel][row], state.nextTime, channel, ROLES[channel]);
        }
        state.playheadQueue.push({ row, when: state.nextTime });
        state.playRow = (row + 1) % pattern.rows;
        state.nextTime += secondsPerRow();
      }
      let current = null;
      while (state.playheadQueue.length && state.playheadQueue[0].when <= now) {
        current = state.playheadQueue.shift();
      }
      if (current) {
        paintPlayhead(current.row);
        $("row-ind").textContent = hex2(current.row);
      }
      state.timer = requestAnimationFrame(() => schedule(generation));
    } catch (error) {
      stop();
      reportAudioError(error);
    }
  }

  function clearPlayhead() {
    document.querySelectorAll(".cell.play, .row-on").forEach((element) => {
      element.classList.remove("play", "row-on");
    });
    $("row-ind").textContent = "--";
  }

  function paintPlayhead(row) {
    document.querySelectorAll(".cell.play, .row-on").forEach((element) => {
      element.classList.remove("play", "row-on");
    });
    const rowElement = document.querySelector(`[data-row="${row}"]`);
    rowElement?.classList.add("row-on");
    document.querySelectorAll(`.cell[data-r="${row}"]`).forEach((element) => element.classList.add("play"));
    rowElement?.scrollIntoView({ block: "nearest" });
  }

  function play() {
    if (state.playing) return Promise.resolve();
    if (state.playbackStartPromise) return state.playbackStartPromise;
    const generation = ++state.playbackStartGeneration;
    const song = state.song;
    setStatus("preparing audio…", "busy");

    const pending = (async () => {
      try {
        await ensureAudio();
        if (generation !== state.playbackStartGeneration) return;
        await preloadUsed(song);
        if (generation !== state.playbackStartGeneration || state.song !== song) return;
        state.playing = true;
        state.playRow = 0;
        state.playheadQueue = [];
        state.nextTime = state.ctx.currentTime + 0.05;
        setStatus("playing", "ok");
        schedule(generation);
      } catch (error) {
        if (generation === state.playbackStartGeneration) {
          stop();
          reportAudioError(error);
        }
      } finally {
        if (state.playbackStartPromise === pending) state.playbackStartPromise = null;
      }
    })();
    state.playbackStartPromise = pending;
    return pending;
  }

  function stop() {
    ++state.playbackStartGeneration;
    ++state.auditionGeneration;
    state.playbackStartPromise = null;
    state.playing = false;
    cancelAnimationFrame(state.timer);
    state.timer = 0;
    state.playRow = 0;
    state.nextTime = 0;
    state.playheadQueue = [];
    state.audioEngine?.stopAll();
    clearPlayhead();
    setStatus("stopped");
  }

  async function preloadUsed(song = state.song) {
    const ids = new Set();
    for (const channel of song.patterns[0].data) {
      for (const cell of channel) {
        if (cell?.sample && state.byId.get(cell.sample)?.kind !== "fm") ids.add(cell.sample);
      }
    }
    await Promise.all([...ids].map((id) => {
      const sample = state.byId.get(id);
      return sample ? decodeSample(sample) : null;
    }));
  }

  async function preview(instrument) {
    if (!instrument) return;
    const generation = ++state.auditionGeneration;
    await ensureAudio();
    const buffer = instrument.kind === "fm" ? null : await decodeSample(instrument);
    if (generation !== state.auditionGeneration) return;
    const when = state.ctx.currentTime;
    stopVoice(PREVIEW_CHANNEL, when);
    if (instrument.kind === "fm") {
      state.audioEngine.playFM(instrument, {
        channel: PREVIEW_CHANNEL, when, volume: 0.9,
        frequency: 440 * 2 ** ((instrument.previewMidi - 69) / 12),
      });
    } else {
      state.audioEngine.playSample(buffer, {
        channel: PREVIEW_CHANNEL, when, volume: 0.9, playbackRate: 1,
      });
    }
  }

  function applySong(song) {
    if (!song?.patterns?.[0]?.data) throw new Error("The server returned an invalid pattern");
    stop();
    const pattern = song.patterns[0];
    pattern.rows = Math.round(numberIn(pattern.rows ?? song.rows, 1, 1024, 16));
    pattern.data = Array.from({ length: 8 }, (_, channel) =>
      Array.from({ length: pattern.rows }, (_, row) => ({
        ...emptyCell(), ...(pattern.data[channel]?.[row] || {}),
      })));
    state.song = song;
    state.row = 0;
    state.ch = clamp(state.ch, 0, 7);
    state.playRow = 0;
    $("song-title").textContent = song.title || "Untitled";
    $("bpm").value = numberIn(song.bpm, 20, 400, 90);
    $("llm-meta").textContent = song.llm
      ? `${song.llm.provider || ""} ${song.llm.ok === false ? "(template fallback)" : ""}`.trim()
      : "";
    renderGrid();
    highlightKit();
  }

  function selectInstrument(instrument) {
    state.selectedSample = instrument.id;
    if (instrument.kind === "fm") {
      state.activeFMPatchId = instrument.id;
      syncFMControls();
    }
    highlightKit();
    runAudio(() => preview(instrument));
  }

  function appendInstrument(root, instrument) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample";
    button.dataset.id = String(instrument.id);
    button.setAttribute("aria-label", `${instrumentLabel(instrument.id)} ${instrument.name}, select and audition`);
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = instrumentLabel(instrument.id);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = instrument.name || `Sample ${instrument.id}`;
    button.append(id, name);
    button.addEventListener("click", () => selectInstrument(instrument));
    root.appendChild(button);
  }

  function renderSamples() {
    const root = $("sample-list");
    root.replaceChildren();
    $("sample-count").textContent = String(state.samples.length);
    let synthCount = $("synth-count");
    if (!synthCount) {
      const countLabel = document.createElement("span");
      countLabel.className = "synth-count-label";
      countLabel.append(document.createTextNode(" · Synths: "));
      synthCount = document.createElement("span");
      synthCount.id = "synth-count";
      countLabel.appendChild(synthCount);
      $("sample-count").parentNode.appendChild(countLabel);
    }
    synthCount.textContent = String(state.fmPatches.length);

    const heading = (text) => {
      const element = document.createElement("div");
      element.className = "cat";
      element.textContent = text;
      root.appendChild(element);
    };
    heading("FM SYNTH");
    state.fmPatches.forEach((patch) => appendInstrument(root, patch));

    const groups = new Map();
    for (const sample of state.samples) {
      const role = sample.role || "other";
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(sample);
    }
    const roles = [...new Set([...ROLES, "ride", "other", ...groups.keys()])];
    for (const role of roles) {
      const list = groups.get(role);
      if (!list?.length) continue;
      heading(role.toUpperCase());
      list.forEach((sample) => appendInstrument(root, sample));
    }
    highlightKit();
  }

  function highlightKit() {
    document.querySelectorAll(".sample[data-id]").forEach((element) => {
      const active = String(element.dataset.id) === String(state.selectedSample);
      element.classList.toggle("active", active);
      element.setAttribute("aria-pressed", String(active));
    });
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function renderCell(cell) {
    if (!cell?.note && !cell?.sample) return "--- -- --";
    const note = cell.note || "---";
    const instrument = cell.sample ? instrumentLabel(cell.sample) : "--";
    const volume = cell.sample ? hex2(Math.round(numberIn(cell.volume ?? 64, 0, 64, 64))) : "--";
    return `<span class="n">${escapeHTML(note)}</span> <span class="s">${escapeHTML(instrument)}</span> <span class="v">${volume}</span>`;
  }

  function renderGrid() {
    const pattern = state.song.patterns[0];
    const heads = $("channel-heads");
    heads.replaceChildren();
    for (const text of ["#", ...ROLES.map((role, i) => `CH${i + 1} ${role.toUpperCase()}`)]) {
      const span = document.createElement("span");
      span.textContent = text;
      heads.appendChild(span);
    }
    const grid = $("grid");
    grid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let row = 0; row < pattern.rows; row++) {
      const rowNumber = document.createElement("div");
      rowNumber.className = "rn";
      rowNumber.dataset.row = row;
      rowNumber.textContent = hex2(row);
      fragment.appendChild(rowNumber);
      for (let channel = 0; channel < 8; channel++) {
        const element = document.createElement("div");
        element.className = "cell";
        element.dataset.r = row;
        element.dataset.c = channel;
        element.innerHTML = renderCell(pattern.data[channel][row]);
        if (row === state.row && channel === state.ch) element.classList.add("sel");
        element.addEventListener("click", () => {
          state.row = row;
          state.ch = channel;
          selectCell();
        });
        fragment.appendChild(element);
      }
    }
    grid.appendChild(fragment);
  }

  function selectCell() {
    document.querySelectorAll(".cell.sel").forEach((element) => element.classList.remove("sel"));
    const element = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    element?.classList.add("sel");
    element?.scrollIntoView({ block: "nearest" });
  }

  function putNote(midi) {
    const pattern = state.song.patterns[0];
    const channel = state.ch;
    const cell = pattern.data[channel][state.row];
    const wasEmpty = !cell.note && !cell.sample;
    cell.note = fmtNote(midi);
    cell.sample = state.selectedSample || cell.sample || 1;
    // Empty cells use volume zero as a placeholder; existing silent notes retain it.
    cell.volume = wasEmpty ? 64 : numberIn(cell.volume ?? 64, 0, 64, 64);
    const element = document.querySelector(`.cell[data-r="${state.row}"][data-c="${channel}"]`);
    if (element) element.innerHTML = renderCell(cell);

    const snapshot = { ...cell };
    const instrument = state.byId.get(snapshot.sample);
    const generation = state.auditionGeneration;
    const song = state.song;
    if (instrument) {
      runAudio(async () => {
        await ensureAudio();
        if (instrument.kind !== "fm") await decodeSample(instrument);
        if (generation !== state.auditionGeneration || state.song !== song) return;
        trigger(snapshot, state.ctx.currentTime, channel, ROLES[channel]);
      });
    }
    state.row = (state.row + 1) % pattern.rows;
    selectCell();
  }

  function clearCell() {
    const pattern = state.song.patterns[0];
    pattern.data[state.ch][state.row] = emptyCell();
    const element = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    if (element) element.innerHTML = renderCell(pattern.data[state.ch][state.row]);
  }

  const fmBindings = [];
  const effectBindings = [];

  function activePatch() {
    return state.fmPatches.find((patch) => patch.id === state.activeFMPatchId) || state.fmPatches[0];
  }

  function ensurePanel(id, title, parent) {
    let panel = $(id);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = id;
      panel.className = "audio-panel";
      const heading = document.createElement("h3");
      heading.textContent = title;
      panel.appendChild(heading);
      parent.appendChild(panel);
    }
    return panel;
  }

  function ensureControl(panel, id, labelText, type = "range") {
    let input = $(id);
    if (!input) {
      const label = document.createElement("label");
      label.className = "audio-control";
      label.htmlFor = id;
      const caption = document.createElement("span");
      caption.textContent = labelText;
      input = document.createElement(type === "select" ? "select" : "input");
      input.id = id;
      if (type !== "select") input.type = type;
      label.append(caption, input);
      panel.appendChild(label);
    }
    return input;
  }

  function ensureButton(panel, id, text, action) {
    let button = $(id);
    if (!button) {
      button = document.createElement("button");
      button.id = id;
      button.textContent = text;
      panel.appendChild(button);
    }
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  function bindRange(panel, prefix, spec, read, write, bindings) {
    const [key, label, min, max, step] = spec;
    const input = ensureControl(panel, `${prefix}-${key}`, label);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    let output = $(`${input.id}-value`);
    if (!output) {
      output = document.createElement("output");
      output.id = `${input.id}-value`;
      output.htmlFor = input.id;
      input.insertAdjacentElement("afterend", output);
    }
    const decimals = (String(step).split(".")[1] || "").length;
    function sync() {
      const value = numberIn(read(key), min, max, min);
      input.value = String(value);
      output.textContent = value.toFixed(decimals);
    }
    function update() {
      const value = numberIn(input.value, min, max, read(key));
      write(key, value);
      sync();
    }
    input.addEventListener("input", update);
    input.addEventListener("change", update);
    bindings.push(sync);
    sync();
  }

  function syncFMControls() {
    const patch = activePatch();
    if ($("fm-patch")) $("fm-patch").value = patch.id;
    if ($("fm-waveform")) $("fm-waveform").value = patch.waveform;
    fmBindings.forEach((sync) => sync());
  }

  function syncEffectControls() {
    effectBindings.forEach((sync) => sync());
  }

  function setupAudioControls() {
    let root = $("audio-controls");
    if (!root) {
      root = document.createElement("div");
      root.id = "audio-controls";
      root.className = "audio-controls";
      (document.querySelector("main") || document.body).appendChild(root);
    }

    const fmPanel = ensurePanel("fm-panel", "FM Synth", root);
    const selector = ensureControl(fmPanel, "fm-patch", "Instrument", "select");
    selector.replaceChildren();
    for (const patch of state.fmPatches) {
      const option = document.createElement("option");
      option.value = patch.id;
      option.textContent = `${patch.label} · ${patch.name}`;
      selector.appendChild(option);
    }
    selector.addEventListener("change", () => {
      const patch = state.byId.get(selector.value);
      if (patch?.kind === "fm") selectInstrument(patch);
    });

    const waveform = ensureControl(fmPanel, "fm-waveform", "Carrier waveform", "select");
    waveform.replaceChildren();
    for (const type of WAVEFORMS) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type[0].toUpperCase() + type.slice(1);
      waveform.appendChild(option);
    }
    waveform.addEventListener("change", () => {
      if (WAVEFORMS.includes(waveform.value)) activePatch().waveform = waveform.value;
      syncFMControls();
    });
    for (const spec of FM_CONTROLS) {
      bindRange(fmPanel, "fm", spec,
        (key) => activePatch()[key],
        (key, value) => { activePatch()[key] = value; },
        fmBindings);
    }
    ensureButton(fmPanel, "btn-fm-audition", "Audition", () => {
      runAudio(() => preview(activePatch()));
    });
    ensureButton(fmPanel, "btn-fm-reset", "Reset Patch", () => {
      const patch = activePatch();
      Object.assign(patch, FM_DEFAULTS.find((entry) => entry.id === patch.id));
      syncFMControls();
    });

    const effectsPanel = ensurePanel("effects-panel", "Sound Processing", root);
    for (const spec of EFFECT_CONTROLS) {
      bindRange(effectsPanel, "effect", spec,
        (key) => state.effectSettings[key],
        (key, value) => {
          state.effectSettings[key] = value;
          state.audioEngine?.setEffect(key, value);
        },
        effectBindings);
    }
    ensureButton(effectsPanel, "btn-effects-reset", "Reset Effects", () => {
      Object.assign(state.effectSettings, EFFECT_DEFAULTS);
      for (const [key, value] of Object.entries(state.effectSettings)) {
        state.audioEngine?.setEffect(key, value);
      }
      syncEffectControls();
    });
    syncFMControls();

    if (!$("tracker-audio-control-styles")) {
      const style = document.createElement("style");
      style.id = "tracker-audio-control-styles";
      style.textContent = `
        #audio-controls { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0; }
        #audio-controls .audio-panel { flex:1 1 300px; padding:1rem; border:1px solid #555; border-radius:4px; }
        #audio-controls .audio-control { display:flex; align-items:center; flex-wrap:wrap; gap:.6rem; margin:.55rem 0; }
        #audio-controls .audio-control > span { flex:1 1 150px; }
        #audio-controls .audio-control input { flex:2 1 120px; min-width:0; }
        #audio-controls output { min-width:4.5em; text-align:right; font-variant-numeric:tabular-nums; }
        #audio-controls button { margin:.5rem .5rem 0 0; }
        #sample-list button.sample { width:100%; text-align:left; font:inherit; color:inherit; cursor:pointer; }
        #sample-list button.sample:focus-visible { outline:2px solid currentColor; outline-offset:-2px; }
      `;
      document.head.appendChild(style);
    }
  }

  async function compose(local) {
    if (state.composing) return;
    state.composing = true;
    const prompt = $("prompt").value.trim() || "boom bap hip hop beat";
    setStatus(local ? "loading preset…" : "dolphin composing…", "busy");
    $("btn-compose").disabled = true;
    $("btn-preset").disabled = true;
    try {
      // Local instrument IDs, patches, and effects never cross the compose API.
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          node: $("node").value,
          local: Boolean(local),
        }),
      });
      const song = await response.json();
      if (!response.ok) throw new Error(song.error || "compose failed");
      applySong(song);
      const via = song.llm?.model ? song.llm.model.split(/[\\/]/).pop() : song.llm?.provider;
      setStatus(song.llm?.ok
        ? `composed via ${song.llm.provider} (${via})`
        : `template fallback (${song.llm?.errors?.[0] || "parse"})`,
      song.llm?.ok ? "ok" : "");
      // Loading a composition must not require a browser audio gesture.
      // Its WAV assets are prepared on the next Play or audition.
    } catch (error) {
      setStatus(String(error.message || error), "err");
    } finally {
      state.composing = false;
      $("btn-compose").disabled = false;
      $("btn-preset").disabled = false;
    }
  }

  function onKey(event) {
    const target = event.target;
    if (target instanceof Element &&
        (target.closest("input, textarea, select, button, a, [role='button'], [role='slider'], [role='textbox']") ||
         target.closest("[contenteditable]:not([contenteditable='false'])") ||
         target.isContentEditable)) {
      if (event.key === "Enter" && target.id === "prompt" && !event.isComposing) {
        event.preventDefault();
        compose(false);
      }
      return;
    }
    if (!state.song || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const pattern = state.song.patterns[0];
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) {
        if (state.playing || state.playbackStartPromise) stop();
        else runAudio(play);
      }
      return;
    }
    const navigation = {
      ArrowDown: () => { state.row = (state.row + 1) % pattern.rows; },
      ArrowUp: () => { state.row = (state.row + pattern.rows - 1) % pattern.rows; },
      ArrowRight: () => { state.ch = (state.ch + 1) % 8; },
      ArrowLeft: () => { state.ch = (state.ch + 7) % 8; },
    };
    if (Object.prototype.hasOwnProperty.call(navigation, event.key)) {
      navigation[event.key]();
      selectCell();
      event.preventDefault();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      clearCell();
      event.preventDefault();
      return;
    }
    if (/^F[123]$/.test(event.key)) {
      event.preventDefault();
      selectInstrument(state.fmPatches[Number(event.key.slice(1)) - 1]);
      return;
    }
    const key = event.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LOWER, key)) {
      event.preventDefault();
      putNote(LOWER[key] + (state.octave + 1) * 12);
    }
    if (Object.prototype.hasOwnProperty.call(UPPER, key)) {
      event.preventDefault();
      putNote(UPPER[key] + (state.octave + 1) * 12);
    }
    if (event.key >= "1" && event.key <= "8") {
      const role = ROLES[Number(event.key) - 1];
      const id = state.song.kit?.[role];
      if (id) state.selectedSample = id;
      highlightKit();
    }
  }

  async function boot() {
    setupAudioControls();
    applySong(defaultSong());
    renderSamples();
    $("btn-play").addEventListener("click", () => runAudio(play));
    $("btn-stop").addEventListener("click", stop);
    $("btn-compose").addEventListener("click", () => compose(false));
    $("btn-preset").addEventListener("click", () => compose(true));
    $("master").addEventListener("input", () => {
      state.audioEngine?.setMasterVolume(numberIn($("master").value, 0, 100, 80) / 100);
    });
    $("bpm").addEventListener("change", () => {
      const bpm = numberIn($("bpm").value, 20, 400, 90);
      $("bpm").value = bpm;
      if (state.song) state.song.bpm = bpm;
    });
    window.addEventListener("keydown", onKey);

    try {
      const [samplesResponse, healthResponse] = await Promise.all([
        fetch("/api/samples"),
        fetch("/api/health").catch(() => null),
      ]);
      if (!samplesResponse.ok) throw new Error(`Sample list failed (HTTP ${samplesResponse.status})`);
      const samples = await samplesResponse.json();
      const health = healthResponse?.ok ? await healthResponse.json().catch(() => ({})) : {};
      state.samples = Array.isArray(samples.samples) ? samples.samples : [];
      // Keep server numeric IDs intact and retain the local FM patch objects.
      state.byId = new Map([
        ...state.samples.map((sample) => [sample.id, sample]),
        ...state.fmPatches.map((patch) => [patch.id, patch]),
      ]);
      renderSamples();
      const dolphin = health.nodes?.find((node) => node.name === "dolphin");
      setStatus(dolphin?.ok
        ? `dolphin ready · ${state.samples.length} WAV samples · ${state.fmPatches.length} synths`
        : `dolphin offline · ${dolphin?.error || "check 10.1.1.122:8082"}`,
      dolphin?.ok ? "ok" : "err");
      if (!$("prompt").value.trim()) {
        $("prompt").value = "dusty boom bap hip hop at 90bpm, punchy kick, snappy snare";
      }
      await compose(true);
    } catch (error) {
      setStatus(`${error.message || error}. Local FM instruments are still available.`, "err");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      boot().catch((error) => setStatus(String(error.message || error), "err"));
    }, { once: true });
  } else {
    boot().catch((error) => setStatus(String(error.message || error), "err"));
  }
})();