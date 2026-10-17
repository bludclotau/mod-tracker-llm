# MOD Tracker LLM

Classic tracker for arranging drum samples in the browser. **Dolphin** on the
llama.cpp node at `10.1.1.122:8082` turns a text prompt into a 16-step pattern
using the wavbvkery *dreams* kit copied from `ess-eleven-hundred`.

## Run

```sh
node server.mjs
```

Open http://127.0.0.1:3840

## Compose

Type a prompt (`dusty boom bap at 90bpm`) and hit **COMPOSE**. The server calls
Dolphin (`/v1/chat/completions`) with a GBNF grammar so the model returns kit
variant numbers plus `x....` hit strings. Those expand onto eight tracker
channels:

| CH | role |
|----|------|
| 1 | kick |
| 2 | snare |
| 3 | closed hat |
| 4 | open hat |
| 5 | clap |
| 6 | perc |
| 7 | crash |
| 8 | 808 bass |

**PRESET** skips the LLM and loads a local genre template from the prompt
keywords (boom-bap, trap, house, dnb, breakbeat, lofi, techno). That replaces
the whole song, including any FM layer.

## Layer mode

**LAYER** does not rebuild the kit. It reads the current BPM and the kick and
bass columns (`x` where a cell has a note) and asks for one FM part. The new
channel is appended. Drum channels stay as they are.

```sh
POST /api/compose
{ "mode": "layer", "prompt": "a lead synth pad melody", "node": "dolphin",
  "song": { "bpm": 90, "kick": "x...x...x..x.x..", "bass": "x.....x.x......." } }
```

`POST /api/compose-layer` is the same call. The full-song compose path is the
request without `mode`. `offline: true`, `local: true`, or `node: "offline"`
skips the model and returns the fallback layer.

The reply is one instrument, a channel FX suggestion, and 16 cells:

```json
{ "instrument": { "type": "fm", "preset": "lead", "patch": {}, "sound": {} },
  "channelFx": { "cutoff": 3400, "resonance": 1.2, "drive": 0, "fxWet": 0 },
  "cells": [], "llm": {} }
```

`sound` is the preset after the macro overrides, ready for `FMVoice.setPreset`.
`song.instruments[]` records both kinds of instrument. Drums stay in
`cell.sample` and in `song.kit`. On load, each used catalog id is copied to
`{ type: "sample", id, file, name, role }` when that file is not already
listed, so a later WAV reorder still resolves. FM entries keep a string id
(`fm-lead`, `fm-bass-ch8`).

`song.channelInstrument` assigns an FM id to a drum channel (0–7). The
channel head stays `CH1 KICK` and can add the preset (`CH8 BASS · BASS`).
Playback of that channel uses the cell note: a rest holds, `===` releases,
and a new pitch retriggers inside the worklet. The kit sample id stays in
the cell. Sample channels, including the hat mute group, are unchanged. An
FM channel does not join that mute group.

`channelFx.cutoff` and `channelFx.resonance` are a lowpass on a layer voice.
`drive` and `fxWet` are stored and not heard. There is no per-channel DSP
strip yet.

### Grammar

`LAYER_GRAMMAR` in `public/audio/layer.js` is a separate GBNF grammar. The
start rule is `root`. Keys are fixed in this order: `layer`, `preset`,
`patch`, `scale`, `melody`. `max_tokens` is 256.

| field | values |
|-------|--------|
| `layer`, `preset` | `lead`, `pad`, `bell`, `bass`, `pluck` |
| `patch.ratio` | `"1"`, `"2"`, `"3"`, `"4"`, `"0.5"` |
| other patch fields | integer 0–9 |
| `scale.root` | `A`–`G` with an optional `#` |
| `scale.mode` | `major`, `minor`, `dorian`, `pentatonic` |
| `melody` | exactly 16 steps of 2 characters |

### Melody tokens

| token | meaning |
|-------|---------|
| `1`–`7` plus `l`, `m`, or `h` | scale degree. `l`/`m`/`h` are octaves 3/4/5, or 1/2/3 for a bass layer |
| `..` | rest. The voice is not touched, so a held note stays in sustain |
| `==` | note-off. The cell is stored as `===` |

Pentatonic has five degrees. Degree 6 and 7 wrap into the next octave. The
octave letter is the root's octave. A degree that crosses C prints the next
octave name (`A` degree 2 in octave 4 is `C-5`). Note names match the tracker
(`C-4`, `C#4`).

A new degree retriggers inside the worklet (5 ms fade, envelopes restart).
There is no legato. `===` starts the release. The patch attack and release
are the envelope times.

### Level map

Levels are integers 0–9. The tables live in `public/audio/layer.js` (`LEVELS`).
The named preset is the starting point. A key the model sends replaces that
macro. A key it omits stays on the preset. Ratio sets the modulator only.
Attack, sustain, and release go to both operators. Modulator decay is 0.65
of the decay value. The carrier gets the full decay. The synth still clamps
every envelope stage to at least 3 ms.

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|-------|---|---|---|---|---|---|---|---|---|---|
| attack (s) | 0.005 | 0.01 | 0.02 | 0.04 | 0.08 | 0.15 | 0.30 | 0.55 | 1.0 | 1.6 |
| decay (s) | 0.04 | 0.07 | 0.12 | 0.20 | 0.35 | 0.55 | 0.80 | 1.2 | 1.8 | 2.6 |
| sustain | 0 | 0.12 | 0.24 | 0.36 | 0.48 | 0.58 | 0.70 | 0.80 | 0.90 | 1 |
| release (s) | 0.02 | 0.04 | 0.08 | 0.12 | 0.20 | 0.35 | 0.55 | 0.90 | 1.4 | 2.2 |
| depth (rad) | 0 | 0.4 | 0.8 | 1.3 | 1.8 | 2.4 | 3.1 | 4.0 | 5.0 | 6.0 |
| feedback (rad) | 0 | 0.15 | 0.3 | 0.5 | 0.75 | 1.0 | 1.35 | 1.7 | 2.1 | 2.6 |
| cutoff (Hz) | 180 | 280 | 420 | 650 | 1000 | 1500 | 2200 | 3400 | 5200 | 7800 |
| res (Q) | 0.5 | 0.8 | 1.2 | 1.8 | 2.5 | 3.5 | 5 | 7 | 9 | 12 |

Cutoff and resonance are the lowpass, not FM operator fields. When the model
omits them, the role's fallback levels are used.

### Fallback

The result is always playable. A missing reply, a rejected grammar, or both
llama.cpp nodes down (and no `XAI_API_KEY`) expands `expandLayer(null, prompt)`.

If the prompt names a role, that role wins, lead before pad, then bell, bass,
pluck. `a lead synth pad melody` is a lead. If it names no role, the model's
`preset` or `layer` is used, otherwise lead. A phrase like `D minor` sets the
scale. Otherwise the model's scale is used, otherwise A minor.

An invalid melody is replaced with a template: a short lead phrase, a pad
that holds `1m` then `3m` until `==`, sparse high bell notes, or bass and
pluck notes on the current bass (or kick) hits. Pluck writes `==` on the rest
after each hit. An invalid patch is replaced with that role's fallback
levels, so a pad is slow and dark even when the nodes are down.

**MUTE**, **HEAR**, and **X** on the layer header mute, audition, and remove
that channel. They do not change the drums. Tracker keys on a layer channel
write sample `0` and play the layer voice. Keys on a drum channel still write
samples.

## Project file

**SAVE** downloads the song as JSON with `version: 2`. **LOAD** reads it back,
including a missing version or version 1. The file includes `instruments`,
`channelInstrument`, `layers` (including mute), `channelFx`, and the extra
pattern columns. A drum song with eight columns and no version still loads
and plays. The compose HTTP response has no `instruments` key. The page adds
sample instruments after the catalog loads.

## Playback

Web Audio plays the WAV samples with one monophonic voice per channel. Closed
and open hats share a mute group. Tracker keys: `Z–M` / `Q–U` for notes,
`` ` `` for note-off, arrows to move, `DEL` to clear, space to play/stop.
Click a sample to audition it. Audition uses the bass channel's voice.

A row is a sixteenth note: `15 / bpm` seconds. `song.speed` is stored (classic
ticks per row) and the scheduler does not read it. The scheduler looks ahead
120 ms and stamps each row with an audio-clock time.

## Voices

`public/audio/voice.js` is the playback interface. Each channel holds one voice.

| call | meaning |
|------|---------|
| `noteOn(time, note, velocity)` | start a note at an audio-clock time. `note` is MIDI. `velocity` 1 matches cell volume 64 |
| `noteOff(time)` | envelope release. Cell token `===`. Drum one-shots ignore it |
| `cut(time)` | silence with a 10 ms ramp, then stop the source 50 ms later |

There is no legato. A new note on a sample channel cuts the previous note
on that channel before `noteOn`. A hat sample cuts both hat channels. An
FM-assigned drum channel does not cut before `noteOn`. A rest on that
channel posts nothing. The cut is stamped with
`currentTime` when the row is scheduled, so a stolen sample can start fading
up to one lookahead early. `noteOn` and `noteOff` use the row time itself.
`SampleVoice` is the drum implementation of this interface. Pattern commands
do not change it. Existing songs have no `===` cells, so drum playback is
unchanged.

## FM voice

`FMVoice` is a second implementation of the same three calls. It is a
two-operator AudioWorklet (`public/audio/fm-worklet.js`), not an oscillator
graph, because operator feedback is per sample. Operator 0 modulates operator 1:

```
modulator = sin(modPhase + feedback * prevMod) * modEnv * modLevel
output    = sin(carPhase + depth * modulator) * carEnv * carLevel * velGain
```

`prevMod` is the previous modulator sample, including its envelope and level.
`depth` and `feedback` are radians. `velGain = (1 - velSens) + velSens * velocity`.
Each operator has a ratio (against the played note), fine detune in cents,
ADSR, and an output level. Attack, decay, release, retrigger, and cut are
ramped (3 ms minimum on the envelope stages, 5 ms on retrigger, cut, and
preset moves).

The worklet applies a note at the sample whose audio-clock time reaches the
timestamp on the message. The pattern scheduler already looks ahead 120 ms
and has those timestamps. Drum channels stay on samples unless **CH INST**
assigns an FM preset to the selected drum channel. That assignment does not
change the other channels. A **LAYER** channel plays this voice: a rest
sends nothing, so the envelope holds, and `===` releases it. **PING** plays
C-4 on the selected preset. **KEYS** sends the tracker keyboard (`Z–M` /
`Q–U`, `` ` `` for note-off) to the audition FM voice instead of the sample.
The key still writes the cell. KEYS defaults off. On an FM-assigned drum
channel the key writes the note, leaves `cell.sample` in place, and auditions
that channel's voice.

Presets: E-Piano, Bell, FM Bass, Pluck, Lead, Pad. Edits on this panel last
until you pick another preset. They do not edit a layer that is already in
the pattern. Stable control ids, for the later pattern commands:

| id | meaning |
|----|---------|
| `fmDepth` | carrier modulation index, radians |
| `feedback` | modulator feedback, radians |
| `velSens` | how much velocity scales the output |
| `opRatio`, `opDetune`, `opAttack`, `opDecay`, `opSustain`, `opRelease`, `opLevel` | modulator |
| `carRatio`, `carDetune`, `carAttack`, `carDecay`, `carSustain`, `carRelease`, `carLevel` | carrier |

## LLM nodes

| node | default |
|------|---------|
| Dolphin | `http://10.1.1.122:8082` |
| Qwen (fallback) | `http://10.1.1.122:8081` |

Override with `LLAMA_URL` / `LLAMA_URL_2`. If both llama.cpp nodes fail and
`XAI_API_KEY` is set, compose falls back to SpaceXAI (`grok-4.7` at
`https://api.x.ai/v1`).

## Samples

90 WAVs from `ess-eleven-hundred/samples` (wavbvkery dreams). Third-party audio;
the tracker code is separate from that pack.

## Check the layer

```sh
node scripts/verify-layer.mjs
```

That checks three prompts against the expander and, when this server is up,
against HTTP:

| prompt | expect |
|--------|--------|
| `a lead synth pad melody` | preset `lead`, even though the words also say pad |
| `slow warm pad in D minor` | preset `pad`, root D, mode minor, a held note, then `===` |
| either prompt with the LLM nodes down | a playable fallback layer, HTTP 200 |

In the browser: **PRESET** a beat, **LAYER** the lead prompt, press **PLAY**
(drums and the new channel together), **MUTE** / **HEAR** / **X** the header,
then **SAVE** and **LOAD**. **PRESET** again clears the layer and the drums
still play.

## Check the instruments

```sh
node scripts/verify-instruments.mjs
```

That checks migration, file remap, and channel FX defaults. In the browser,
**PRESET** a beat, press **PLAY**, and the drum samples still start. Select
the bass column, set **CH INST** to FM Bass, press **PLAY**: the kick still
plays its sample and the bass column plays FM at the written pitch (`C-1`
on the drum templates). **SAVE** writes `version: 2` and a sample instrument
for each kit file. `cell.sample` on those drum cells is unchanged.
