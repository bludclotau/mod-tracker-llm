/**
 * Main-thread FM voice. Same calls as SampleVoice: noteOn, noteOff, cut.
 * The preset lives on the voice (setPreset), the way a sample lives on
 * SampleVoice.buffer. A drum channel uses this only when the song assigns
 * an FM instrument to it. A layer channel always uses this.
 *
 * noteOn retriggers inside the worklet with a 5 ms fade. Callers should not
 * cut() and noteOn() at the same timestamp: the cut would win and the new
 * note would never start. cut() is the hard silence (stop, or leaving FM keys).
 */
import { clonePreset } from "./fm-presets.js";

export class FMVoice {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.node = null;
    this.preset = null;
    this.ready = null;
  }

  load() {
    if (!this.ready) this.ready = this._load();
    return this.ready;
  }

  async _load() {
    try {
      if (!this.ctx.audioWorklet) throw new Error("AudioWorklet is not available");
      await this.ctx.audioWorklet.addModule("/audio/fm-worklet.js");
      this.node = new AudioWorkletNode(this.ctx, "fm-voice", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: this.preset ? { preset: this.preset } : {},
      });
      this.node.connect(this.destination);
    } catch (err) {
      this.ready = null;
      this.node = null;
      throw err;
    }
  }

  setPreset(preset) {
    this.preset = clonePreset(preset);
    this.node?.port.postMessage({ type: "preset", preset: this.preset, immediate: false });
  }

  noteOn(time, note, velocity) {
    this._post({ type: "noteOn", time, note, velocity });
  }

  noteOff(time) {
    this._post({ type: "noteOff", time });
  }

  cut(time) {
    this._post({ type: "cut", time });
  }

  _post(msg) {
    this.node?.port.postMessage(msg);
  }
}
