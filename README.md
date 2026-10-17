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
keywords (boom-bap, trap, house, dnb, breakbeat, lofi, techno).

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

There is no legato. A new note cuts the previous note on that channel before
`noteOn`. A hat sample cuts both hat channels. The cut is stamped with
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
and has those timestamps. It does not play FM yet. **PING** plays C-4 on the
selected preset. **KEYS** sends the tracker keyboard (`Z–M` / `Q–U`, `` ` ``
for note-off) to the FM voice instead of the sample audition. The key still
writes the cell. Pattern playback stays on the drum kit either way. KEYS
defaults off.

Presets: E-Piano, Bell, FM Bass, Pluck. Edits last until you pick another
preset. Stable control ids, for the later pattern commands:

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
