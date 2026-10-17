/* Oscillator sound rack from main (be49825). The page does not load this file.
 * Live playback is public/audio/voice.js and the FM worklet.
 */
/* Dependency-free Web Audio engine for Mod Tracker. */
(function (global) {
  "use strict";

  const PREVIEW_CHANNEL = "preview";
  const RAMP_TIME = 0.015;
  const CHOKE_TIME = 0.005;

  function numeric(value, fallback) {
    if (typeof value !== "number" && typeof value !== "string") return fallback;
    if (typeof value === "string" && !value.trim()) return fallback;
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function clamp(value, minimum, maximum, fallback) {
    return Math.min(maximum, Math.max(minimum, numeric(value, fallback)));
  }

  function first() {
    for (let i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
  }

  function object(value) {
    return value && typeof value === "object" ? value : {};
  }

  function enabled(value, fallback) {
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
    return fallback;
  }

  function initialMasterVolume() {
    // Read the existing UI once, without installing handlers or requiring a DOM.
    if (global.document) {
      const slider = global.document.querySelector(
        "#master-volume, #masterVolume, #master-volume-slider, " +
        "#masterVolumeSlider, [data-master-volume]"
      );
      if (slider) {
        const value = numeric(slider.value, NaN);
        if (Number.isFinite(value)) {
          const maximum = numeric(slider.max, value > 1 ? 100 : 1);
          const minimum = numeric(slider.min, 0);
          if (maximum > minimum) {
            return clamp((value - minimum) / (maximum - minimum), 0, 1, 0.8);
          }
        }
      }
    }
    return 0.8;
  }

  function disconnect(node) {
    try {
      node.disconnect();
    } catch (_) {
      // Nodes may already have been disconnected by a completion callback.
    }
  }

  // Envelopes are retained as points so a scheduled choke can evaluate the
  // future amplitude without relying on AudioParam.value or wall-clock timers.
  function envelopeValue(points, time) {
    let previous = points[0];
    if (time < previous.time) return 0;

    for (let i = 1; i < points.length; i++) {
      const next = points[i];
      if (time < next.time) {
        const span = next.time - previous.time;
        return span > 0
          ? previous.value + (next.value - previous.value) *
            ((time - previous.time) / span)
          : next.value;
      }
      previous = next;
    }
    return previous.value;
  }

  function scheduleEnvelope(param, points) {
    param.value = 0;
    points.forEach(function (point, index) {
      if (index === 0 || point.time === points[index - 1].time) {
        param.setValueAtTime(point.value, point.time);
      } else {
        param.linearRampToValueAtTime(point.value, point.time);
      }
    });
  }

  class TrackerAudioEngine {
    constructor(context) {
      if (!context || typeof context.createGain !== "function" ||
          typeof context.createOscillator !== "function") {
        throw new TypeError("TrackerAudioEngine requires an AudioContext.");
      }
      if (context.state === "closed") {
        throw new Error("Cannot use a closed AudioContext.");
      }

      this.context = context;
      this.previewChannel = PREVIEW_CHANNEL;
      this.input = context.createGain();

      this._master = context.createGain();
      this._master.connect(context.destination);
      this._maxFrequency = Math.min(20000, context.sampleRate * 0.45);
      this._maxCutoff = context.sampleRate / 2;

      this._settings = {
        master: initialMasterVolume(),
        filter: { cutoff: this._maxCutoff, q: 0 },
        distortion: { drive: 0, mix: 0 },
        delay: { time: 0.25, feedback: 0.3, mix: 0 },
        reverb: { mix: 0 },
        compressor: { enabled: false, threshold: -24, ratio: 4 }
      };

      this._master.gain.value = this._settings.master;
      this._voices = new Set();
      this._channels = new Map();
      this._graphs = [];
      this._graphTimer = null;
      this._distortionCurve = null;
      this._impulse = this._createImpulse();

      this._insertGraph(context.currentTime);
    }

    _time(value) {
      const now = this.context.currentTime;
      return clamp(value, now, now + 86400, now);
    }

    _startTime(options) {
      return this._time(first(options.startTime, options.when, options.time));
    }

    _channel(options) {
      return options.preview === true || options.channel === undefined ||
        options.channel === null ? PREVIEW_CHANNEL : options.channel;
    }

    _frequency(options, fallback) {
      const midi = first(options.midiNote, options.midi, options.note);
      let frequency = fallback;
      if (midi !== undefined) {
        frequency = 440 * Math.pow(2, (clamp(midi, 0, 127, 69) - 69) / 12);
      }
      return clamp(options.frequency, 8, this._maxFrequency, frequency);
    }

    _smooth(param, value) {
      const now = this.context.currentTime;
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.linearRampToValueAtTime(value, now + RAMP_TIME);
    }

    setMasterVolume(value) {
      this._settings.master = clamp(value, 0, 1, this._settings.master);
      this._smooth(this._master.gain, this._settings.master);
      return this;
    }

    /**
     * filter: cutoff (Hz), q
     * distortion: drive (0–100), mix (0–1)
     * delay: time (seconds), feedback, mix
     * reverb: mix
     * compressor: enable/enabled, threshold (dB), ratio
     *
     * Invalid numeric values retain the previous setting.
     */
    setEffect(name, parameter, value) {
      name = String(name).toLowerCase();
      parameter = String(parameter).toLowerCase();
      if (name === "lowpass" || name === "low-pass") name = "filter";

      const settings = this._settings[name];
      if (!settings || name === "master") return this;

      let property;
      let minimum;
      let maximum;

      if (name === "filter") {
        if (parameter === "cutoff" || parameter === "frequency") {
          property = "cutoff"; minimum = 20; maximum = this._maxCutoff;
        } else if (parameter === "q" || parameter === "resonance") {
          property = "q"; minimum = 0; maximum = 30;
        }
      } else if (name === "distortion") {
        if (parameter === "drive") {
          property = "drive"; minimum = 0; maximum = 100;
        } else if (parameter === "mix") {
          property = "mix"; minimum = 0; maximum = 1;
        }
      } else if (name === "delay") {
        if (parameter === "time" || parameter === "delaytime") {
          property = "time"; minimum = 0.01; maximum = 1;
        } else if (parameter === "feedback") {
          property = "feedback"; minimum = 0; maximum = 0.85;
        } else if (parameter === "mix") {
          property = "mix"; minimum = 0; maximum = 1;
        }
      } else if (name === "reverb" && parameter === "mix") {
        property = "mix"; minimum = 0; maximum = 1;
      } else if (name === "compressor") {
        if (parameter === "enable" || parameter === "enabled") {
          const next = enabled(value, settings.enabled);
          if (next !== settings.enabled) {
            settings.enabled = next;
            this._graphs.forEach(graph => {
              this._smooth(graph.compressorDry.gain, next ? 0 : 1);
              this._smooth(graph.compressorWet.gain, next ? 1 : 0);
            });
          }
          return this;
        }
        if (parameter === "threshold") {
          property = "threshold"; minimum = -100; maximum = 0;
        } else if (parameter === "ratio") {
          property = "ratio"; minimum = 1; maximum = 20;
        }
      }

      if (!property) return this;
      const next = clamp(value, minimum, maximum, settings[property]);
      if (next === settings[property]) return this;
      settings[property] = next;

      if (name === "distortion" && property === "drive") {
        // Only drive changes allocate a curve. Rebuilt graphs reuse it.
        this._distortionCurve = this._createDistortionCurve(next);
      }

      this._graphs.forEach(graph => {
        if (name === "filter") {
          this._smooth(property === "q" ? graph.filter.Q : graph.filter.frequency, next);
        } else if (name === "distortion") {
          if (property === "drive") graph.shaper.curve = this._distortionCurve;
          else this._setMix(graph.distortionDry, graph.distortionWet, next);
        } else if (name === "delay") {
          if (property === "time") this._smooth(graph.delay.delayTime, next);
          else if (property === "feedback") this._smooth(graph.feedback.gain, next);
          else this._setMix(graph.delayDry, graph.delayWet, next);
        } else if (name === "reverb") {
          this._setMix(graph.reverbDry, graph.reverbWet, next);
        } else if (name === "compressor") {
          this._smooth(graph.compressor[property], next);
        }
      });
      return this;
    }

    _setMix(dry, wet, mix) {
      // Complementary linear gains give exactly unity dry gain at zero mix.
      this._smooth(dry.gain, 1 - mix);
      this._smooth(wet.gain, mix);
    }

    _createDistortionCurve(drive) {
      if (drive === 0) return null;
      const curve = new Float32Array(4097);
      const amount = 1 + drive * 0.5;
      const scale = Math.tanh(amount);
      for (let i = 0; i < curve.length; i++) {
        const x = 2 * i / (curve.length - 1) - 1;
        curve[i] = Math.max(-1, Math.min(1, Math.tanh(amount * x) / scale));
      }
      return curve;
    }

    _createImpulse() {
      const length = Math.max(1, Math.floor(this.context.sampleRate * 1.25));
      const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          const decay = Math.pow(1 - i / length, 3);
          samples[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      return buffer;
    }

    _createGraph(startTime) {
      const context = this.context;
      const settings = this._settings;
      const graph = { startTime, endTime: Infinity, nodes: [] };
      const add = (name, node) => {
        graph[name] = node;
        graph.nodes.push(node);
        return node;
      };
      const gain = (name, value) => {
        const node = add(name, context.createGain());
        node.gain.value = value;
        return node;
      };

      const entry = gain("entry", 0);
      const filter = add("filter", context.createBiquadFilter());
      filter.type = "lowpass";
      filter.frequency.value = settings.filter.cutoff;
      filter.Q.value = settings.filter.q;
      entry.connect(filter);

      const shaper = add("shaper", context.createWaveShaper());
      shaper.oversample = "2x";
      shaper.curve = this._distortionCurve;
      const distortionDry = gain("distortionDry", 1 - settings.distortion.mix);
      const distortionWet = gain("distortionWet", settings.distortion.mix);
      const distortionSum = gain("distortionSum", 1);
      filter.connect(distortionDry);
      filter.connect(shaper);
      shaper.connect(distortionWet);
      distortionDry.connect(distortionSum);
      distortionWet.connect(distortionSum);

      const delay = add("delay", context.createDelay(1));
      delay.delayTime.value = settings.delay.time;
      const feedback = gain("feedback", settings.delay.feedback);
      const delayDry = gain("delayDry", 1 - settings.delay.mix);
      const delayWet = gain("delayWet", settings.delay.mix);
      const delaySum = gain("delaySum", 1);
      distortionSum.connect(delayDry);
      distortionSum.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayWet);
      delayDry.connect(delaySum);
      delayWet.connect(delaySum);

      const convolver = add("convolver", context.createConvolver());
      convolver.normalize = true;
      convolver.buffer = this._impulse;
      const reverbDry = gain("reverbDry", 1 - settings.reverb.mix);
      const reverbWet = gain("reverbWet", settings.reverb.mix);
      const reverbSum = gain("reverbSum", 1);
      delaySum.connect(reverbDry);
      delaySum.connect(convolver);
      convolver.connect(reverbWet);
      reverbDry.connect(reverbSum);
      reverbWet.connect(reverbSum);

      const compressor = add("compressor", context.createDynamicsCompressor());
      compressor.threshold.value = settings.compressor.threshold;
      compressor.ratio.value = settings.compressor.ratio;
      compressor.knee.value = 30;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      const compressorDry = gain("compressorDry", settings.compressor.enabled ? 0 : 1);
      const compressorWet = gain("compressorWet", settings.compressor.enabled ? 1 : 0);
      const output = gain("output", 0);
      reverbSum.connect(compressorDry);
      reverbSum.connect(compressor);
      compressor.connect(compressorWet);
      compressorDry.connect(output);
      compressorWet.connect(output);
      output.connect(this._master);
      this.input.connect(entry);
      return graph;
    }

    _insertGraph(time) {
      const graph = this._createGraph(time);
      this._graphs.push(graph);
      this._graphs.sort((a, b) => a.startTime - b.startTime);

      const now = this.context.currentTime;
      this._graphs.forEach((item, index) => {
        item.endTime = index + 1 < this._graphs.length
          ? this._graphs[index + 1].startTime : Infinity;

        [item.entry.gain, item.output.gain].forEach(param => {
          param.cancelScheduledValues(now);
          const active = item.startTime <= now && item.endTime > now;
          param.setValueAtTime(active ? 1 : 0, now);
          if (item.startTime > now) param.setValueAtTime(1, item.startTime);
          if (Number.isFinite(item.endTime) && item.endTime >= now) {
            param.setValueAtTime(0, item.endTime);
          }
        });
      });
      this._pruneGraphs();
    }

    _pruneGraphs() {
      if (this._graphTimer !== null) {
        global.clearTimeout(this._graphTimer);
        this._graphTimer = null;
      }

      const now = this.context.currentTime;
      this._graphs = this._graphs.filter(graph => {
        if (graph.endTime > now && this.context.state !== "closed") return true;
        try {
          this.input.disconnect(graph.entry);
        } catch (_) {}
        graph.nodes.forEach(disconnect);
        return false;
      });

      const pending = this._graphs.find(graph => Number.isFinite(graph.endTime));
      if (pending) {
        // Timing of sound is handled by AudioParams, not this cleanup timer.
        // Polling also respects an AudioContext that has been suspended.
        const milliseconds = Math.max(25, Math.min(1000, (pending.endTime - now) * 1000 + 10));
        this._graphTimer = global.setTimeout(() => this._pruneGraphs(), milliseconds);
      }
    }

    _voiceOutput(options, envelope) {
      const amplitude = this.context.createGain();
      const volume = this.context.createGain();
      const pan = this.context.createStereoPanner();
      volume.gain.value = clamp(options.volume, 0, 1, 1);
      pan.pan.value = clamp(options.pan, -1, 1, 0);
      scheduleEnvelope(amplitude.gain, envelope);
      amplitude.connect(volume);
      volume.connect(pan);
      pan.connect(this.input);
      return { amplitude, nodes: [amplitude, volume, pan] };
    }

    _makeVoice(channel, startTime, sources, nodes, amplitude, points, release, releaseAt, endTime) {
      const engine = this;
      const voice = {
        channel,
        startTime,
        ended: false,
        sources: sources.slice(),
        stop(when) {
          engine._stopVoice(voice, engine._time(when), false);
          return voice;
        },
        _sources: sources,
        _nodes: nodes,
        _amplitude: amplitude,
        _points: points,
        _release: release,
        _releaseAt: releaseAt,
        _endTime: endTime,
        _remaining: sources.length
      };

      sources.forEach(source => {
        source.onended = () => {
          voice._remaining--;
          if (voice._remaining <= 0) this._finishVoice(voice);
        };
      });
      this._voices.add(voice);
      if (!this._channels.has(channel)) this._channels.set(channel, new Set());
      this._channels.get(channel).add(voice);
      return voice;
    }

    _finishVoice(voice) {
      if (voice.ended) return;
      voice.ended = true;
      voice._sources.forEach(source => { source.onended = null; });
      voice._nodes.forEach(disconnect);
      this._voices.delete(voice);
      const channel = this._channels.get(voice.channel);
      if (channel) {
        channel.delete(voice);
        if (channel.size === 0) this._channels.delete(voice.channel);
      }
    }

    _startVoice(voice) {
      try {
        voice._sources.forEach(source => source.start(voice.startTime));
        if (Number.isFinite(voice._endTime)) {
          voice._sources.forEach(source => source.stop(voice._endTime));
        }
      } catch (error) {
        voice._sources.forEach(source => {
          try { source.stop(); } catch (_) {}
        });
        this._finishVoice(voice);
        throw error;
      }
      this._retrigger(voice);
      return voice;
    }

    _retrigger(voice) {
      const voices = this._channels.get(voice.channel);
      let nextStart = Infinity;
      voices.forEach(other => {
        if (other === voice || other.ended) return;
        if (other.startTime <= voice.startTime) {
          this._stopVoice(other, voice.startTime, false, CHOKE_TIME);
        } else {
          nextStart = Math.min(nextStart, other.startTime);
        }
      });
      // Also support notes submitted out of chronological order.
      if (Number.isFinite(nextStart)) {
        this._stopVoice(voice, nextStart, false, CHOKE_TIME);
      }
    }

    _stopVoice(voice, time, force, releaseOverride) {
      if (voice.ended || time >= voice._endTime) return;

      const cancelStart = time <= voice.startTime;
      const release = force || cancelStart ? 0 : first(releaseOverride, voice._release);
      const end = Math.min(voice._endTime, time + release);
      if (!force && !cancelStart && time >= voice._releaseAt && end >= voice._endTime) {
        return;
      }

      const level = force || cancelStart ? 0 : envelopeValue(voice._points, time);
      const param = voice._amplitude.gain;
      param.cancelScheduledValues(time);
      param.setValueAtTime(level, time);
      if (end > time) param.linearRampToValueAtTime(0, end);
      else param.setValueAtTime(0, time);

      voice._points = voice._points.filter(point => point.time < time);
      voice._points.push({ time, value: level }, { time: end, value: 0 });
      voice._releaseAt = time;
      voice._endTime = end;

      voice._sources.forEach(source => {
        try { source.stop(end); } catch (_) {}
      });

      if (end <= this.context.currentTime) this._finishVoice(voice);
    }

    /**
     * Options: channel (defaults to the separate preview channel), preview,
     * startTime/when, playbackRate or frequency, rootFrequency/rootNote,
     * volume, pan, offset, duration, loop, loopStart, loopEnd.
     */
    createSampleVoice(buffer, options) {
      options = object(options);
      if (!buffer || typeof buffer.getChannelData !== "function" ||
          !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
        throw new TypeError("createSampleVoice requires a non-empty AudioBuffer.");
      }

      const startTime = this._startTime(options);
      const source = this.context.createBufferSource();
      source.buffer = buffer;

      const rootNote = clamp(options.rootNote, 0, 127, 69);
      const rootFrequency = clamp(
        first(options.rootFrequency, options.baseFrequency),
        8, this._maxFrequency, 440 * Math.pow(2, (rootNote - 69) / 12)
      );
      const frequency = this._frequency(options, rootFrequency);
      const rate = clamp(options.playbackRate, 1 / 64, 64, frequency / rootFrequency);
      source.playbackRate.value = rate;

      const offset = clamp(options.offset, 0, buffer.duration, 0);
      const loopStart = clamp(options.loopStart, 0, buffer.duration, 0);
      const loopEnd = clamp(options.loopEnd, loopStart, buffer.duration, buffer.duration);
      source.loop = enabled(options.loop, false) && loopEnd > loopStart;
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;

      const naturalDuration = source.loop ? Infinity : (buffer.duration - offset) / rate;
      const requestedDuration = first(options.duration, options.gateDuration);
      const duration = requestedDuration === undefined
        ? naturalDuration
        : Math.min(naturalDuration, clamp(requestedDuration, 0, 3600, naturalDuration));
      const endTime = startTime + duration;
      const attackEnd = startTime + Math.min(0.003, duration / 2);
      const points = [
        { time: startTime, value: 0 },
        { time: attackEnd, value: 1 }
      ];
      let releaseAt = Infinity;
      if (Number.isFinite(endTime)) {
        releaseAt = Math.max(attackEnd, endTime - CHOKE_TIME);
        points.push({ time: releaseAt, value: 1 }, { time: endTime, value: 0 });
      }

      const output = this._voiceOutput(options, points);
      source.connect(output.amplitude);
      const voice = this._makeVoice(
        this._channel(options), startTime, [source], [source].concat(output.nodes),
        output.amplitude, points, CHOKE_TIME, releaseAt, endTime
      );
      voice.source = source;

      try {
        source.start(startTime, offset);
        if (Number.isFinite(endTime)) source.stop(endTime);
      } catch (error) {
        try { source.stop(); } catch (_) {}
        this._finishVoice(voice);
        throw error;
      }
      this._retrigger(voice);
      return voice;
    }

    /**
     * Patch: waveform, ratio, index, modDecay, attack, decay, sustain,
     * release, gateDuration. ADSR may also live in patch.adsr/patch.envelope.
     * Options: channel, preview, frequency or midiNote, volume, pan,
     * startTime/when, gateDuration/duration.
     *
     * Envelope and gate times are seconds; sustain and volume are 0–1.
     */
    createFMVoice(patch, options) {
      patch = object(patch);
      options = object(options);
      const adsr = object(first(patch.adsr, patch.envelope));
      const startTime = this._startTime(options);
      const frequency = this._frequency(options, clamp(patch.frequency, 8, this._maxFrequency, 440));
      const ratio = clamp(first(patch.ratio, patch.modRatio, patch.modulationRatio), 0.125, 32, 2);
      const index = clamp(first(patch.index, patch.modIndex, patch.modulationIndex), 0, 20, 2);
      const attack = clamp(first(adsr.attack, patch.attack), 0, 10, 0.005);
      const decay = clamp(first(adsr.decay, patch.decay), 0, 10, 0.15);
      const sustain = clamp(first(adsr.sustain, patch.sustain), 0, 1, 0.65);
      const release = clamp(first(adsr.release, patch.release), 0, 20, 0.2);
      const modDecay = clamp(first(patch.modDecay, patch.modulationDecay), 0.001, 20, 0.25);
      const gateDuration = clamp(
        first(options.gateDuration, options.duration, patch.gateDuration, patch.duration),
        0.001, 30, 0.35
      );
      const gateTime = startTime + gateDuration;
      const endTime = gateTime + release;

      const fullEnvelope = [
        { time: startTime, value: 0 },
        { time: startTime + attack, value: 1 },
        { time: startTime + attack + decay, value: sustain }
      ];
      const gateLevel = envelopeValue(fullEnvelope, gateTime);
      const points = fullEnvelope.filter(point => point.time < gateTime);
      points.push({ time: gateTime, value: gateLevel }, { time: endTime, value: 0 });

      const carrier = this.context.createOscillator();
      const modulator = this.context.createOscillator();
      const modulation = this.context.createGain();
      const waveform = String(first(patch.waveform, patch.carrierWaveform, patch.wave, "sine"));
      carrier.type = ["sine", "triangle", "sawtooth", "square"].includes(waveform)
        ? waveform : "sine";
      modulator.type = "sine";

      carrier.frequency.setValueAtTime(frequency, startTime);
      // Bound the effective ratio as well, preserving frequency * ratio.
      const effectiveRatio = Math.min(ratio, this._maxFrequency / frequency);
      modulator.frequency.setValueAtTime(frequency * effectiveRatio, startTime);
      modulation.gain.value = 0;
      modulation.gain.setValueAtTime(frequency * index, startTime);
      modulation.gain.linearRampToValueAtTime(0, startTime + modDecay);
      modulator.connect(modulation);
      modulation.connect(carrier.frequency);

      const output = this._voiceOutput(options, points);
      carrier.connect(output.amplitude);
      const voice = this._makeVoice(
        this._channel(options), startTime, [carrier, modulator],
        [carrier, modulator, modulation].concat(output.nodes),
        output.amplitude, points, release, gateTime, endTime
      );
      voice.carrier = carrier;
      voice.modulator = modulator;
      return this._startVoice(voice);
    }

    stopChannel(channel, when) {
      const time = this._time(when);
      const voices = this._channels.get(channel);
      if (voices) {
        Array.from(voices).forEach(voice => this._stopVoice(voice, time, false));
      }
      return this;
    }

    stopAll(when) {
      const time = this._time(when);
      Array.from(this._voices).forEach(voice => this._stopVoice(voice, time, true));

      /*
       * A fresh graph contains no delay or convolution history. For a future
       * stop, old/new graph gates switch exactly at the audio time; JavaScript
       * only performs physical disconnection afterward. New notes scheduled
       * after the stop already have a clean graph waiting for them.
       */
      if (time <= this.context.currentTime) {
        if (this._graphTimer !== null) {
          global.clearTimeout(this._graphTimer);
          this._graphTimer = null;
        }
        this._graphs.forEach(graph => {
          try { this.input.disconnect(graph.entry); } catch (_) {}
          graph.nodes.forEach(disconnect);
        });
        this._graphs = [];
      }
      if (this.context.state !== "closed") this._insertGraph(time);
      return this;
    }
  }

  TrackerAudioEngine.PREVIEW_CHANNEL = PREVIEW_CHANNEL;
  global.TrackerAudioEngine = TrackerAudioEngine;
})(window);