/**
 * Two-operator phase-modulation synth. One monophonic voice.
 *
 *   modulator = sin(modPhase + feedback * prevMod) * modEnv * modLevel
 *   output    = sin(carPhase + depth * modulator) * carEnv * carLevel * velGain
 *
 * prevMod is the previous modulator sample, including its envelope and level.
 * feedback and depth are radians. velGain = (1 - velocitySens) + velocitySens * velocity.
 * Operator 0 is the modulator. Operator 1 is the carrier.
 *
 * Note events carry an AudioContext time. renderBlock applies every event
 * whose time is at or before the sample it is about to write, so a timestamp
 * lands on that sample. Times that have already passed play on the next sample.
 * The live scheduler stamps rows up to 120 ms ahead; a keyboard key has no
 * queue, so the main thread adds a few milliseconds of lead.
 *
 * Clicks: attack, decay and release are at least 3 ms. A new note while one
 * is sounding fades the output to zero over 5 ms, then restarts from silence.
 * cut() is that same 5 ms fade with no restart. Preset numbers slew over 5 ms.
 */

export const OUTPUT_TRIM = 0.35;
export const MIN_STAGE_S = 0.003;
export const STEAL_S = 0.005;
export const PARAM_RAMP_S = 0.005;

const OP_FIELDS = ["ratio", "detune", "attack", "decay", "sustain", "release", "level"];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function sanitize(preset) {
  const opsIn = Array.isArray(preset?.ops) ? preset.ops : [];
  return {
    depth: num(preset?.depth, 0, 0, 12),
    feedback: num(preset?.feedback, 0, 0, Math.PI),
    velocity: num(preset?.velocity, 1, 0, 1),
    ops: [0, 1].map((i) => {
      const src = opsIn[i] || {};
      return {
        ratio: num(src.ratio, 1, 0.25, 16),
        detune: num(src.detune, 0, -100, 100),
        attack: num(src.attack, 0.01, 0, 8),
        decay: num(src.decay, 0.2, 0, 8),
        sustain: num(src.sustain, 0.5, 0, 1),
        release: num(src.release, 0.1, 0, 8),
        level: num(src.level, 1, 0, 1),
      };
    }),
  };
}

function lerpPreset(from, to, dst, u) {
  const a = 1 - u;
  dst.depth = from.depth * a + to.depth * u;
  dst.feedback = from.feedback * a + to.feedback * u;
  dst.velocity = from.velocity * a + to.velocity * u;
  for (let i = 0; i < 2; i++) {
    for (const key of OP_FIELDS) {
      dst.ops[i][key] = from.ops[i][key] * a + to.ops[i][key] * u;
    }
  }
}

function freshOp() {
  return { stage: "idle", level: 0, stageSamples: 0, releaseFrom: 0 };
}

export class FMSynth {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.events = [];
    this.cur = null;
    this.target = null;
    this.rampFrom = null;
    this.rampPos = 1;
    this.rampN = 1;
    this.mode = "idle";
    this.voiceGain = 0;
    this.fadeLeft = 0;
    this.fadeTotal = 1;
    this.fadeFrom = 0;
    this.pending = null;
    this.hz = 440;
    this.velocity = 1;
    this.modPhase = 0;
    this.carPhase = 0;
    this.prevMod = 0;
    this.ops = [freshOp(), freshOp()];
  }

  setPreset(preset, immediate = false) {
    const next = sanitize(preset);
    if (!this.cur || immediate) {
      this.cur = next;
      this.target = sanitize(preset);
      this.rampFrom = sanitize(preset);
      this.rampPos = 1;
      this.rampN = 1;
      return;
    }
    this.rampFrom = sanitize(this.cur);
    this.target = next;
    this.rampPos = 0;
    this.rampN = Math.max(1, Math.round(PARAM_RAMP_S * this.sr));
  }

  pushEvent(event) {
    const time = Number(event?.time);
    if (!Number.isFinite(time)) return;
    const item = { ...event, time };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > time) i -= 1;
    this.events.splice(i, 0, item);
  }

  renderBlock(startTime, out) {
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const t = startTime + i / this.sr;
      while (this.events.length && this.events[0].time <= t) this._apply(this.events.shift());
      out[i] = this._sample();
    }
    return out;
  }

  snapshot() {
    return {
      mode: this.mode,
      voiceGain: this.voiceGain,
      depth: this.cur ? this.cur.depth : null,
      mod: this.ops[0].level,
      car: this.ops[1].level,
      modStage: this.ops[0].stage,
      carStage: this.ops[1].stage,
    };
  }

  _apply(event) {
    if (event.type === "noteOn") this._noteOn(Number(event.note), Number(event.velocity));
    else if (event.type === "noteOff") this._noteOff();
    else if (event.type === "cut") this._cut();
  }

  _noteOn(note, velocity) {
    const midi = Number.isFinite(note) ? note : 60;
    const vel = Number.isFinite(velocity) ? clamp(velocity, 0, 1) : 1;
    if (this.mode === "run" || this.mode === "fadeout" || this.mode === "cut") {
      this.pending = { midi, vel };
      this.mode = "fadeout";
      if (this.fadeLeft <= 0) {
        this.fadeTotal = Math.max(1, Math.round(STEAL_S * this.sr));
        this.fadeLeft = this.fadeTotal;
        this.fadeFrom = this.voiceGain > 0 ? this.voiceGain : 1;
      }
      return;
    }
    this._begin(midi, vel);
  }

  _begin(midi, vel) {
    this.hz = 440 * 2 ** ((midi - 69) / 12);
    this.velocity = vel;
    this.modPhase = 0;
    this.carPhase = 0;
    this.prevMod = 0;
    this.voiceGain = 1;
    this.fadeLeft = 0;
    this.pending = null;
    this.mode = "run";
    for (const op of this.ops) {
      op.stage = "attack";
      op.level = 0;
      op.stageSamples = 0;
      op.releaseFrom = 0;
    }
  }

  _noteOff() {
    this.pending = null;
    if (this.mode === "idle") return;
    for (const op of this.ops) {
      if (op.stage === "release" || op.stage === "idle") continue;
      op.releaseFrom = op.level;
      op.stage = "release";
      op.stageSamples = 0;
    }
  }

  _cut() {
    this.pending = null;
    if (this.mode === "idle") return;
    this.mode = "cut";
    this.fadeTotal = Math.max(1, Math.round(STEAL_S * this.sr));
    this.fadeLeft = this.fadeTotal;
    this.fadeFrom = this.voiceGain;
  }

  _silence() {
    this.mode = "idle";
    this.voiceGain = 0;
    this.fadeLeft = 0;
    this.prevMod = 0;
    this.pending = null;
    for (const op of this.ops) {
      op.stage = "idle";
      op.level = 0;
      op.stageSamples = 0;
    }
  }

  _rampParams() {
    if (!this.cur || !this.target || !this.rampFrom) return;
    if (this.rampPos >= this.rampN) return;
    this.rampPos += 1;
    const u = Math.min(1, this.rampPos / this.rampN);
    lerpPreset(this.rampFrom, this.target, this.cur, u);
  }

  _env(op, params) {
    const aN = Math.max(1, Math.round(Math.max(MIN_STAGE_S, params.attack) * this.sr));
    const dN = Math.max(1, Math.round(Math.max(MIN_STAGE_S, params.decay) * this.sr));
    const rN = Math.max(1, Math.round(Math.max(MIN_STAGE_S, params.release) * this.sr));
    const sustain = clamp(params.sustain, 0, 1);
    if (op.stage === "attack") {
      op.stageSamples += 1;
      op.level = Math.min(1, op.stageSamples / aN);
      if (op.stageSamples >= aN) {
        op.stage = "decay";
        op.stageSamples = 0;
        op.level = 1;
      }
      return;
    }
    if (op.stage === "decay") {
      op.stageSamples += 1;
      const u = Math.min(1, op.stageSamples / dN);
      op.level = 1 + (sustain - 1) * u;
      if (op.stageSamples >= dN) {
        op.stage = "sustain";
        op.level = sustain;
      }
      return;
    }
    if (op.stage === "sustain") {
      op.level = sustain;
      return;
    }
    if (op.stage === "release") {
      op.stageSamples += 1;
      op.level = op.releaseFrom * (1 - Math.min(1, op.stageSamples / rN));
      if (op.stageSamples >= rN) {
        op.level = 0;
        op.stage = "idle";
      }
    }
  }

  _renderOsc() {
    const modP = this.cur.ops[0];
    const carP = this.cur.ops[1];
    this._env(this.ops[0], modP);
    this._env(this.ops[1], carP);
    const modHz = this.hz * modP.ratio * 2 ** (modP.detune / 1200);
    const carHz = this.hz * carP.ratio * 2 ** (carP.detune / 1200);
    const raw = Math.sin(this.modPhase + this.cur.feedback * this.prevMod);
    const modulator = raw * this.ops[0].level * modP.level;
    this.prevMod = modulator;
    const velGain = (1 - this.cur.velocity) + this.cur.velocity * this.velocity;
    const sample = Math.sin(this.carPhase + this.cur.depth * modulator)
      * this.ops[1].level * carP.level * velGain;
    this.modPhase = (this.modPhase + (2 * Math.PI * modHz) / this.sr) % (2 * Math.PI);
    this.carPhase = (this.carPhase + (2 * Math.PI * carHz) / this.sr) % (2 * Math.PI);
    return sample;
  }

  _noteFinished() {
    return this.ops.every((op) => op.stage === "idle"
      || (op.stage === "sustain" && op.level < 1e-4));
  }

  _sample() {
    this._rampParams();
    if (!this.cur || this.mode === "idle") return 0;
    if (this.mode === "fadeout" || this.mode === "cut") {
      this.fadeLeft -= 1;
      this.voiceGain = this.fadeLeft <= 0 ? 0 : this.fadeFrom * (this.fadeLeft / this.fadeTotal);
      const y = this._renderOsc() * this.voiceGain * OUTPUT_TRIM;
      if (this.fadeLeft <= 0) {
        if (this.mode === "fadeout" && this.pending) {
          const next = this.pending;
          this._begin(next.midi, next.vel);
        } else {
          this._silence();
        }
      }
      return y;
    }
    const y = this._renderOsc() * this.voiceGain * OUTPUT_TRIM;
    if (this.mode === "run" && this._noteFinished()) this._silence();
    return y;
  }
}
