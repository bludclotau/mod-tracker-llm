/**
 * AudioWorklet wrapper around FMSynth.
 * Events arrive as messages: { type: "noteOn"|"noteOff"|"cut", time, note, velocity }.
 * `time` is an AudioContext currentTime. The block start is `currentTime`,
 * which matches currentFrame / sampleRate. Each sample compares its own time.
 */
import { FMSynth } from "./fm-dsp.js";

class FMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.synth = new FMSynth(sampleRate);
    this.block = new Float32Array(128);
    const seed = options?.processorOptions;
    if (seed?.preset) this.synth.setPreset(seed.preset, true);
    for (const ev of seed?.events || []) this.synth.pushEvent(ev);
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "preset") this.synth.setPreset(msg.preset, msg.immediate === true);
      else this.synth.pushEvent(msg);
    };
  }

  process(_inputs, outputs) {
    const bus = outputs[0];
    if (!bus?.[0]) return true;
    const n = bus[0].length;
    if (this.block.length !== n) this.block = new Float32Array(n);
    // currentTime is the context time of frame currentFrame, sample 0 of this block.
    this.synth.renderBlock(currentTime, this.block);
    bus[0].set(this.block);
    if (bus[1]) bus[1].set(this.block);
    return true;
  }
}

registerProcessor("fm-voice", FMProcessor);
