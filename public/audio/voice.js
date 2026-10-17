/**
 * Channel voices for the tracker.
 *
 * One monophonic voice per channel. The engine owns the slots and is the only
 * place that steals voices. A voice never cuts a different channel.
 *
 *   noteOn(time, note, velocity)
 *     Start a note at an AudioContext time. `note` is a MIDI note number.
 *     `velocity` is linear gain, where 1 matches cell volume 64.
 *     SampleVoice uses `voice.buffer` and `voice.pan`, which the engine sets
 *     before the call. `pan === null` skips the panner (sample audition).
 *
 *   noteOff(time)
 *     Envelope release at `time`. This does not hard-stop the voice.
 *     SampleVoice ignores it. Drum one-shots play until the buffer ends
 *     or something cuts them. The cell token for this is "===".
 *
 *   cut(time)
 *     Silence the current note with a short anti-click ramp, then stop the
 *     source 50 ms later. This is the voice-steal and transport-stop path.
 *
 * Retrigger / legato
 *   There is no legato. Before noteOn, the engine cuts that channel (both
 *   hat channels when the sample's mute group is "hats"). The cut time is
 *   ctx.currentTime at the moment the row is scheduled, which is up to one
 *   lookahead (120 ms) before the row. noteOn and noteOff receive the row's
 *   own audio-clock time. A stolen sample therefore starts fading when the
 *   scheduler sees the new hit, and the new sample starts on the row.
 *   That is the original player's behaviour, kept on purpose.
 */

export const NOTE_OFF = "===";

export function isNoteOff(cell) {
  return cell?.note === NOTE_OFF;
}

export class SampleVoice {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  usually the master gain
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.buffer = null;
    /** @type {number|null} null means connect with no StereoPanner */
    this.pan = 0;
    this.current = null;
  }

  noteOn(time, note, velocity) {
    if (!this.buffer || !this.destination) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const midi = Number(note);
    src.playbackRate.value = 2 ** ((midi - 60) / 12);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(Number(velocity), time);
    src.connect(gain);
    let tail = gain;
    let panner = null;
    if (this.pan != null) {
      panner = this.ctx.createStereoPanner();
      panner.pan.value = this.pan;
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(this.destination);
    src.start(time);
    const token = { src, gain, panner };
    this.current = token;
    src.onended = () => {
      if (this.current === token) this.current = null;
    };
  }

  noteOff(_time) {
    // One-shots have no release stage. Key-off must not chop a drum.
  }

  cut(time) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const t = Number.isFinite(time) ? time : this.ctx.currentTime;
    try {
      cur.gain.gain.cancelScheduledValues(t);
      // Time constant 10 ms. The source stops at +50 ms, about five
      // constants later, so the ramp finishes before the buffer is killed.
      cur.gain.gain.setTargetAtTime(0, t, 0.01);
      cur.src.stop(t + 0.05);
    } catch {
      /* already stopped */
    }
  }
}

if (typeof globalThis !== "undefined" && globalThis.window === globalThis) {
  globalThis.TrackerVoices = { NOTE_OFF, isNoteOff, SampleVoice };
}
