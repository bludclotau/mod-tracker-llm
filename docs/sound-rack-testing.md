# Sound Rack Manual Verification

> This checklist matches the oscillator rack from `main` (`public/audio-engine.js`). The `dev` tracker plays through `public/audio/` instead. Use `node scripts/verify-layer.mjs` for the worklet and layer path.

## Scope

Verify the sound rack using the app’s existing startup and browser workflow. No new test runner is required.

FM patches and global effects are **session-local in this change**. The backend composition format is unchanged; this checklist does not require new backend fields, patch serialization, or effect persistence.

## Setup

1. Follow the repository’s existing startup instructions, including its normal backend and frontend commands.
2. Open the app in a supported browser. Open DevTools with:
   - **Console** visible for exceptions and audio errors.
   - **Network** recording sample requests.
3. Start at a low listening level. Perform the app’s usual user interaction to unlock browser audio.
4. Reset all global effects to their neutral settings. Keep the master/output level audible.
5. Prepare a short pattern containing:
   - A WAV sample, a bass sample in tracker channel eight, and closed/open hats.
   - FM notes in several channels, including simultaneous notes.
   - A known A4 note and notes one octave below and above it.
   - Explicit zero-volume WAV and FM cells.
6. Record the browser/version and any failed checks. Distinguish expected sample requests from requests caused by selecting or playing FM patches.

## Manual Checklist

### 1. Existing WAV workflow remains unchanged

With effects neutral:

- [ ] Select and audition WAV samples using the existing sample workflow. Playback begins normally and sounds unchanged.
- [ ] Load samples and run the existing composition workflow. Generated patterns, sample assignment, editing, and playback still work.
- [ ] Play a WAV-only pattern. Check pitch, cell volume, timing, looping, and channel assignment against the existing behavior.
- [ ] Stop playback and start again. There is no stale audio, missing first note, or changed playback position behavior.
- [ ] Confirm there are no unexpected network failures or console errors.

### 2. FM patch selection and tracker labels

For **each of F1, F2, and F3**:

- [ ] Select the patch with the mouse and audition it.
- [ ] Select it using its supported keyboard interaction. The selected state and audible patch match mouse selection.
- [ ] Enter a tracker note with that patch. The instrument label in the cell is exactly `F1`, `F2`, or `F3`, respectively—not a WAV index, missing label, or stale sample name.
- [ ] Move focus away and back, scroll the tracker, and play the pattern. The label remains correct.
- [ ] Confirm selecting, previewing, and playing the patch initiates **no sample fetches**. Filter Network to sample assets and inspect request initiators if unrelated traffic is present.

Then exercise state changes:

- [ ] Select an FM patch, load a WAV sample, and select each FM patch again.
- [ ] Run composition, then select each FM patch again and enter new notes.
- [ ] After both operations, FM selection, preview, labels, and playback still work. A previously selected sample must not silently replace the FM patch.

### 3. FM pitch, polyphony, and envelope controls

- [ ] Play the same FM pitch in several tracker channels. All channels produce the same pitch.
- [ ] Play different pitches simultaneously across multiple channels. Notes retain their pitches and do not overwrite one another.
- [ ] With modulation disabled and carrier tuning at unity, compare A4 with a 440 Hz reference. Compare octave-separated notes as well.
- [ ] Exercise every exposed modulation parameter individually, using a sustained note and moderate settings. Each parameter produces its expected audible change; avoid judging modulation ratios while modulation depth is zero.
- [ ] Compare short and long **attack**: immediate onset versus a clear fade-in.
- [ ] Compare **decay** and **sustain** settings: a clear fall from the attack peak to the selected sustain level.
- [ ] Compare short and long **gate** durations: release begins at the corresponding note-off time.
- [ ] Compare short and long **release**: the note fades for the expected duration rather than cutting off at gate end.
- [ ] Repeat notes rapidly, overlap notes, change patches, and stop during attack, sustain, and release. There are no stuck oscillators or unexplained sustained tones after notes should have ended.

### 4. Every global effect processes WAV and FM

Test **every effect exposed in the rack**, not just one representative effect. Use a WAV-only pattern, then an FM-only pattern, then a mixed pattern.

For each effect:

- [ ] Leave the other effects neutral and move this effect to an unmistakably audible, safe setting.
- [ ] Confirm WAV playback passes through it.
- [ ] Confirm FM playback passes through it.
- [ ] Check WAV audition and FM preview also follow the global effect routing.
- [ ] Confirm the mixed pattern does not reveal a dry bypass path or doubled processing for one voice type.
- [ ] Change the effect continuously during playback and while an effect tail is audible.
- [ ] Reset it during playback. Reset both the displayed controls and the actual sound.
- [ ] Listen for abrupt clicks, bursts, dropouts, or runaway feedback.
- [ ] Check Console for invalid `AudioParam` values, non-finite values, scheduling exceptions, or other audio errors.

Finally:

- [ ] Enable several effects together and repeat live changes and the rack’s reset action.
- [ ] Test valid minimum and maximum control values at a safe output level.
- [ ] Restore neutral effects. WAV and FM return to their neutral sound without requiring a reload.

### 5. Explicit zero volume means silence

Use isolated notes and clear any previous effect tails first.

- [ ] Play a WAV cell whose volume is explicitly zero. It is silent.
- [ ] Play an FM cell whose volume is explicitly zero. It is silent.
- [ ] Repeat with non-neutral effects. A silent input must not become an audible note.
- [ ] Compare with an otherwise identical nonzero-volume cell to rule out a muted output or incorrect test setup.
- [ ] Confirm zero is not treated as “volume omitted” or replaced by a default gain.

### 6. Playback cancellation and scheduled timing

**Rapid transport changes**

- [ ] Repeatedly alternate Play and Stop, including intervals shorter than one tracker row.
- [ ] Press Play repeatedly while already playing.
- [ ] Verify there is only one playback stream and one transport progression: no doubled notes, doubled tempo, or old scheduler continuing underneath.
- [ ] Stop and wait longer than the normal preload duration and scheduling lookahead. Nothing starts later.

**Stop during preload**

1. Use the existing sample-loading workflow with uncached samples. If needed, disable browser cache and temporarily throttle Network.
2. Press Play and immediately press Stop before sample loading completes.
3. Allow the pending requests to finish.

- [ ] Completion of those requests does not start playback or move the transport.
- [ ] Repeat Play → Stop → Play while the original preload is pending. Only the most recent valid Play can start one playback stream.
- [ ] Restore normal network settings afterward.

**Scheduled hat choking**

1. At a slow tempo, place a long open hat followed by a closed hat several rows later.
2. Use neutral effects so the open-hat cutoff is easy to hear.
3. Repeat over several loops and at another tempo.

- [ ] The open hat continues until the closed hat’s **scheduled audio time**.
- [ ] It is not choked early when the scheduler queues the future closed-hat event.
- [ ] Unrelated channels continue normally.

**Stop clears all sound**

- [ ] With sustained FM notes and audible delay/reverb tails, press Stop.
- [ ] Synth notes and effect tails are removed, allowing only any intentional short anti-click fade.
- [ ] Wait for the longest gate, release, tail, and queued event to have elapsed. No sound returns.
- [ ] A subsequent Play works normally; effect routing has not been permanently disconnected.

### 7. Preview isolation and keyboard focus

- [ ] Play a pattern with a clearly audible sustained or repeating bass in tracker channel eight.
- [ ] Audition WAV samples and preview every FM patch while it plays.
- [ ] Preview does not replace, choke, retune, or change the gain of the channel-eight bass.
- [ ] Ending a preview does not stop a tracker voice, and tracker note-offs do not unexpectedly stop preview voices.

For patch selectors, sliders, numeric inputs, buttons, and any other rack controls:

- [ ] Tab and Shift+Tab reach controls in a usable order.
- [ ] Arrow keys, Space, Enter, and text entry perform the focused control’s intended action.
- [ ] Typing in numeric inputs, including keys also used for tracker notes, does **not** insert notes into tracker cells.
- [ ] Keyboard patch selection while a rack control is focused does not also insert an unintended tracker note.
- [ ] Returning focus to the tracker restores its normal note-entry shortcuts.

### 8. Responsive layout and visible focus

- [ ] Check the rack at a wide desktop size, a narrow/mobile-sized viewport, and increased browser zoom.
- [ ] Controls wrap or scroll usefully without overlapping labels, hiding values, or covering transport/tracker controls.
- [ ] Every rack control remains reachable and operable.
- [ ] Keyboard focus is visibly distinguishable on every control, including selected patch buttons.
- [ ] Focus indicators are not clipped by rack containers, and focused controls remain visible when scrolling.

## Browser-Console Offline Smoke Test

This is a small numerical check of the **exported audio engine**, not a substitute for the listening and transport checks above.

### Bind the engine

Run this from the app’s browser console after normal startup:

1. Locate the audio engine’s actual module export in the frontend source.
2. Import it using the module URL served by the existing development server.
3. Write a small `scheduleVoice` adapter around that export, following its actual constructor and scheduling API.

The adapter contract below is only a console-test helper, **not a proposed application API**. It must:

- Create a fresh engine using the supplied `OfflineAudioContext`, not a new real-time `AudioContext`.
- Connect the engine’s normal global-effects output to the supplied context’s destination.
- Reset all effects to neutral and use an audible, nonzero master gain.
- Schedule the actual exported FM voice path using the requested frequency, volume, absolute start time, gate, and envelope.
- Set carrier ratio to one, disable detuning, and set all modulation depth/index and feedback to zero.
- Preserve an explicit volume of zero.
- Finish setup and scheduling before returning, without waiting for audio time to advance.

Do not replace the engine with a standalone `OscillatorNode`: that would test the browser rather than the implementation. Do not dispose the engine before offline rendering completes.

### Run the checks

Paste this helper into the console:

```js
async function runSoundRackSmoke(scheduleVoice) {
  const sampleRate = 48000;
  const duration = 1;
  const OfflineContext =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;

  if (!OfflineContext) {
    throw new Error("OfflineAudioContext is not available in this browser.");
  }

  function check(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function render(volume) {
    // Separate contexts prevent a previous voice or effect tail contaminating
    // the zero-volume render.
    const context = new OfflineContext(
      2,
      Math.ceil(duration * sampleRate),
      sampleRate
    );

    await scheduleVoice(context, {
      frequencyHz: 440,
      volume,
      startTimeSeconds: 0.05,
      gateSeconds: 0.6,
      attackSeconds: 0.01,
      decaySeconds: 0.02,
      sustainLevel: 1,
      releaseSeconds: 0.08,
      carrierRatio: 1,
      modulationDepth: 0,
      feedback: 0,
      neutralEffects: true
    });

    return context.startRendering();
  }

  function inspect(buffer) {
    let peak = 0;
    let energy = 0;
    let strongestChannel = 0;
    let strongestEnergy = -1;

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let channelEnergy = 0;

      for (const value of data) {
        check(Number.isFinite(value), "Output contains NaN or Infinity.");
        peak = Math.max(peak, Math.abs(value));
        channelEnergy += value * value;
      }

      energy += channelEnergy;
      if (channelEnergy > strongestEnergy) {
        strongestEnergy = channelEnergy;
        strongestChannel = channel;
      }
    }

    return {
      peak,
      rms: Math.sqrt(
        energy / (buffer.length * buffer.numberOfChannels)
      ),
      strongestChannel
    };
  }

  function estimateFrequency(buffer, channel) {
    const data = buffer.getChannelData(channel);
    const rate = buffer.sampleRate;

    // Measure after attack/decay and before gate end.
    const first = Math.floor(0.15 * rate);
    const last = Math.floor(0.45 * rate);
    let mean = 0;

    for (let i = first; i < last; i++) mean += data[i];
    mean /= last - first;

    const crossings = [];
    for (let i = first + 1; i < last; i++) {
      const previous = data[i - 1] - mean;
      const current = data[i] - mean;

      if (previous <= 0 && current > 0) {
        // Fractional sample position of each rising zero crossing.
        crossings.push(i - 1 + (-previous / (current - previous)));
      }
    }

    check(crossings.length > 10, "Too few crossings to measure A4.");
    return (
      rate * (crossings.length - 1) /
      (crossings[crossings.length - 1] - crossings[0])
    );
  }

  const audible = await render(0.5);
  const audibleStats = inspect(audible);
  check(audibleStats.peak > 1e-5, "Expected a nonzero FM signal.");

  const frequencyHz = estimateFrequency(
    audible,
    audibleStats.strongestChannel
  );
  check(
    Math.abs(frequencyHz - 440) <= 5,
    `Expected approximately 440 Hz; measured ${frequencyHz.toFixed(2)} Hz.`
  );

  const silent = await render(0);
  const silentStats = inspect(silent);
  check(
    silentStats.peak <= 1e-8,
    `Zero-volume voice produced signal: peak ${silentStats.peak}.`
  );

  const results = {
    audible: {
      peak: audibleStats.peak,
      rms: audibleStats.rms,
      frequencyHz
    },
    zeroVolume: {
      peak: silentStats.peak,
      rms: silentStats.rms
    }
  };

  console.table(results);
  console.log("PASS: finite A4 output and silent zero-volume voice.");
  return { results, audible, silent };
}
```

Invoke it with the engine adapter:

```js
// scheduleVoice is the adapter bound to the actual exported engine above.
const smoke = await runSoundRackSmoke(scheduleVoice);
```

**Pass criteria:** all rendered samples are finite, the audible render has nonzero output, the steady waveform measures approximately 440 Hz, and the separate zero-volume render has no signal above the numerical silence tolerance.

If this fails, first verify the adapter’s time units, carrier tuning, modulation settings, effect neutrality, and output connection. A sustained signal after Stop, stale preload playback, or broken keyboard routing still fails the manual checklist even if this offline check passes.

## Completion

Record any failing checklist item with reproduction steps and console/network evidence. Confirm the existing backend composition request/response shape remains unchanged. Reloading may reset FM patch and effect settings; persistence across sessions is not part of this change.