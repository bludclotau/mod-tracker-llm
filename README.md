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

Web Audio plays the WAV samples with per-channel voice stealing. Closed and
open hats share a mute group. Tracker keys: `Z–M` / `Q–U` for notes, arrows to
move, `DEL` to clear, space to play/stop. Click a sample to audition it.

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
