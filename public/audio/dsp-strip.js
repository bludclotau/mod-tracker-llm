/**
 * One effects strip per channel, built once and shared by sample and FM voices.
 *
 *   voice → filter → saturation → dry/delay → output → master → limiter
 *                              ↘ reverb send → shared convolver → master
 *
 * Defaults are unity around the parts that would color the sound: drive 0,
 * delay wet 0, reverb send 0, lowpass at 18 kHz. The limiter only reduces
 * peaks above 0 dBFS. Delay time is a row count; a row is 15/bpm seconds
 * (song.speed is not read). Chorus is not part of this strip.
 */

export const PARAM_RAMP_S = 0.005;
export const DELAY_RAMP_S = 0.01;
export const FEEDBACK_CAP = 0.85;

export function delaySeconds(rows, bpm) {
  const row = 15 / (Number(bpm) || 90);
  const sec = (Number(rows) || 0) * row;
  return Math.min(1.9, Math.max(0.01, sec));
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function tanhCurve(length = 2048) {
  const curve = new Float32Array(length);
  const last = length - 1;
  for (let i = 0; i < length; i++) {
    const x = (i / last) * 2 - 1;
    curve[i] = Math.tanh(x);
  }
  return curve;
}

/** About 1.2 s of decaying noise. Quiet enough that a full send is a tail, not a blast. */
export function makeImpulse(ctx, seconds = 1.2) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-4 * (i / len));
      data[i] = (Math.random() * 2 - 1) * env * 0.35;
    }
  }
  return buf;
}

/**
 * Master gain stays the volume slider. The limiter sits after it.
 * Threshold and knee are set before the limiter is connected so the
 * browser default (-24 dB) never touches a buffer.
 */
export function createMasterChain(ctx) {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(0, now);
  limiter.knee.setValueAtTime(0, now);
  limiter.ratio.setValueAtTime(20, now);
  limiter.attack.setValueAtTime(0.003, now);
  limiter.release.setValueAtTime(0.08, now);
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  convolver.connect(master);
  master.connect(limiter);
  limiter.connect(ctx.destination);
  return { master, limiter, convolver };
}

export class ChannelStrip {
  constructor(ctx, destination, shared) {
    this.ctx = ctx;
    const now = ctx.currentTime;

    this.input = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.setValueAtTime(18000, now);
    this.filter.Q.setValueAtTime(0.707, now);

    this.clean = ctx.createGain();
    this.clean.gain.setValueAtTime(1, now);
    this.driveAmp = ctx.createGain();
    this.driveAmp.gain.setValueAtTime(0, now);
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = tanhCurve();
    this.shaper.oversample = "4x";

    this.mix = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.setValueAtTime(1, now);
    this.wet = ctx.createGain();
    this.wet.gain.setValueAtTime(0, now);
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.setValueAtTime(delaySeconds(2, 90), now);
    this.feedback = ctx.createGain();
    this.feedback.gain.setValueAtTime(0.35, now);

    this.output = ctx.createGain();
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.setValueAtTime(0, now);

    this.input.connect(this.filter);
    this.filter.connect(this.clean);
    this.filter.connect(this.driveAmp);
    this.clean.connect(this.mix);
    this.driveAmp.connect(this.shaper);
    this.shaper.connect(this.mix);
    this.mix.connect(this.dry);
    this.dry.connect(this.output);
    this.mix.connect(this.wet);
    this.wet.connect(this.delay);
    this.delay.connect(this.output);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.mix.connect(this.reverbSend);
    if (shared?.convolver) this.reverbSend.connect(shared.convolver);
    this.output.connect(destination);
  }

  setFx(fx, when, bpm, immediate = false) {
    const t = Number.isFinite(when) ? when : this.ctx.currentTime;
    const type = fx?.filterType === "highpass" ? "highpass" : "lowpass";
    if (this.filter.type !== type) this.filter.type = type;
    const ramp = (param, value, tc) => {
      if (immediate) param.setValueAtTime(value, t);
      else param.setTargetAtTime(value, t, tc);
    };
    ramp(this.filter.frequency, clamp(fx?.cutoff, 20, 20000, 18000), PARAM_RAMP_S);
    ramp(this.filter.Q, clamp(fx?.resonance, 0.0001, 40, 0.707), PARAM_RAMP_S);
    const drive = clamp(fx?.drive, 0, 1, 0);
    ramp(this.clean.gain, 1 - drive, PARAM_RAMP_S);
    ramp(this.driveAmp.gain, drive * 6, PARAM_RAMP_S);
    const wet = clamp(fx?.fxWet, 0, 1, 0);
    ramp(this.dry.gain, 1 - wet, PARAM_RAMP_S);
    ramp(this.wet.gain, wet, PARAM_RAMP_S);
    ramp(this.feedback.gain, clamp(fx?.delayFeedback, 0, FEEDBACK_CAP, 0.35), PARAM_RAMP_S);
    this.setDelayTime(fx?.delayTime, t, bpm, immediate);
    ramp(this.reverbSend.gain, clamp(fx?.reverbSend, 0, 1, 0), PARAM_RAMP_S);
  }

  setDelayTime(rows, when, bpm, immediate = false) {
    const t = Number.isFinite(when) ? when : this.ctx.currentTime;
    const sec = delaySeconds(rows ?? 2, bpm);
    if (immediate) this.delay.delayTime.setValueAtTime(sec, t);
    else this.delay.delayTime.setTargetAtTime(sec, t, DELAY_RAMP_S);
  }

  disconnect() {
    for (const node of [
      this.input, this.filter, this.clean, this.driveAmp, this.shaper, this.mix,
      this.dry, this.wet, this.delay, this.feedback, this.output, this.reverbSend,
    ]) {
      try { node.disconnect(); } catch { /* already disconnected */ }
    }
  }
}
