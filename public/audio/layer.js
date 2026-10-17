/**
 * FM layer compose: grammar, prompt, and expansion.
 *
 * The model returns macro levels. This file turns them into an FM preset
 * (see fm-presets.js) plus 16 tracker cells. A missing or invalid model
 * reply still returns a playable layer.
 *
 * Macro levels are integers 0-9. The tables below are the only mapping.
 * Attack, decay, and release are seconds. Sustain is a linear level.
 * Depth and feedback are radians. Cutoff is Hz. Res is biquad Q.
 * FMSynth still clamps each envelope stage to at least 3 ms.
 *
 *   attack   0.005 0.01 0.02 0.04 0.08 0.15 0.30 0.55 1.0  1.6
 *   decay    0.04  0.07 0.12 0.20 0.35 0.55 0.80 1.2  1.8  2.6
 *   sustain  0     0.12 0.24 0.36 0.48 0.58 0.70 0.80 0.90 1
 *   release  0.02  0.04 0.08 0.12 0.20 0.35 0.55 0.90 1.4  2.2
 *   depth    0     0.4  0.8  1.3  1.8  2.4  3.1  4.0  5.0  6.0
 *   feedback 0     0.15 0.3  0.5  0.75 1.0  1.35 1.7  2.1  2.6
 *   cutoff   180   280  420  650  1000 1500 2200 3400 5200 7800
 *   res      0.5   0.8  1.2  1.8  2.5  3.5  5    7    9    12
 *
 * ratio is the modulator ratio (op 0). The carrier ratio stays at the
 * preset default. Attack, sustain, and release are written to both
 * operators. Modulator decay is 0.65 of the decay table; the carrier
 * gets the full value. Keys the model omits stay on the named preset.
 * Cutoff and resonance are not FM-operator fields. They become channelFx
 * for one lowpass on that layer. drive and fxWet are stored as 0.
 * There is no per-channel DSP strip in this build.
 *
 * Melody tokens are 2 characters, 16 of them:
 *   1-7 plus l|m|h   scale degree, octave low / mid / high
 *   ..               rest (the voice is not touched, so a pad holds)
 *   ==               note-off, expanded to the tracker cell "==="
 * Octave letters are 3/4/5, or 1/2/3 when the preset is bass.
 * Pentatonic has five degrees; 6 and 7 wrap into the next octave.
 * Note names match app.js fmtNote ("C-4", "C#4").
 */

import { FM_PRESETS, clonePreset } from "./fm-presets.js";

export const LAYER_ROWS = 16;

export const LEVELS = {
  attack: [0.005, 0.01, 0.02, 0.04, 0.08, 0.15, 0.3, 0.55, 1, 1.6],
  decay: [0.04, 0.07, 0.12, 0.2, 0.35, 0.55, 0.8, 1.2, 1.8, 2.6],
  sustain: [0, 0.12, 0.24, 0.36, 0.48, 0.58, 0.7, 0.8, 0.9, 1],
  release: [0.02, 0.04, 0.08, 0.12, 0.2, 0.35, 0.55, 0.9, 1.4, 2.2],
  depth: [0, 0.4, 0.8, 1.3, 1.8, 2.4, 3.1, 4, 5, 6],
  feedback: [0, 0.15, 0.3, 0.5, 0.75, 1, 1.35, 1.7, 2.1, 2.6],
  cutoff: [180, 280, 420, 650, 1000, 1500, 2200, 3400, 5200, 7800],
  res: [0.5, 0.8, 1.2, 1.8, 2.5, 3.5, 5, 7, 9, 12],
};

const ROLES = ["lead", "pad", "bell", "bass", "pluck"];
const MODES = ["major", "minor", "dorian", "pentatonic"];
const RATIO_VALUE = { "1": 1, "2": 2, "3": 3, "4": 4, "0.5": 0.5 };
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic: [0, 3, 5, 7, 10],
};
const ROOT_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** Used when the model sends no usable patch, and for filter defaults. */
export const FALLBACK_PATCH = {
  lead: { ratio: "2", depth: 5, feedback: 3, attack: 2, decay: 5, sustain: 6, release: 4, cutoff: 7, res: 2 },
  pad: { ratio: "1", depth: 2, feedback: 1, attack: 7, decay: 6, sustain: 8, release: 7, cutoff: 4, res: 1 },
  bell: { ratio: "4", depth: 6, feedback: 1, attack: 1, decay: 4, sustain: 0, release: 5, cutoff: 8, res: 3 },
  bass: { ratio: "1", depth: 6, feedback: 5, attack: 1, decay: 4, sustain: 7, release: 2, cutoff: 3, res: 2 },
  pluck: { ratio: "2", depth: 4, feedback: 2, attack: 0, decay: 3, sustain: 0, release: 2, cutoff: 6, res: 2 },
};

const TEMPLATE_STEPS = {
  lead: ["1m", "..", "3m", "..", "5m", "5h", "..", "4m", "..", "3m", "..", "2m", "..", "1m", "==", ".."],
  pad: ["1m", "..", "..", "..", "..", "..", "..", "..", "3m", "..", "..", "..", "..", "..", "..", "=="],
  bell: ["5h", "..", "..", "7h", "..", "..", "5h", "..", "..", "6h", "..", "3h", "..", "5h", "==", ".."],
};

export const LAYER_GRAMMAR = `
space ::= [ \\t\\n]*
role ::= "\\"lead\\"" | "\\"pad\\"" | "\\"bell\\"" | "\\"bass\\"" | "\\"pluck\\""
ratio ::= "\\"1\\"" | "\\"2\\"" | "\\"3\\"" | "\\"4\\"" | "\\"0.5\\""
digit ::= [0-9]
pitch ::= "\\"" [A-G] "\\"" | "\\"" [A-G] [#] "\\""
scale-mode ::= "\\"major\\"" | "\\"minor\\"" | "\\"dorian\\"" | "\\"pentatonic\\""
step ::= [1-7] [lmh] | ".." | "=="
root ::= "{" space layer-k "," space preset-k "," space patch-k "," space scale-k "," space melody-k space "}" space
layer-k ::= "\\"layer\\"" space ":" space role
preset-k ::= "\\"preset\\"" space ":" space role
patch-k ::= "\\"patch\\"" space ":" space "{" space ratio-k "," space depth-k "," space feedback-k "," space attack-k "," space decay-k "," space sustain-k "," space release-k "," space cutoff-k "," space res-k space "}"
ratio-k ::= "\\"ratio\\"" space ":" space ratio
depth-k ::= "\\"depth\\"" space ":" space digit
feedback-k ::= "\\"feedback\\"" space ":" space digit
attack-k ::= "\\"attack\\"" space ":" space digit
decay-k ::= "\\"decay\\"" space ":" space digit
sustain-k ::= "\\"sustain\\"" space ":" space digit
release-k ::= "\\"release\\"" space ":" space digit
cutoff-k ::= "\\"cutoff\\"" space ":" space digit
res-k ::= "\\"res\\"" space ":" space digit
scale-k ::= "\\"scale\\"" space ":" space "{" space tonic-k "," space mode-k space "}"
tonic-k ::= "\\"root\\"" space ":" space pitch
mode-k ::= "\\"mode\\"" space ":" space scale-mode
melody-k ::= "\\"melody\\"" space ":" space melody
melody ::= "\\"" step step step step step step step step step step step step step step step step "\\""
`;

function presetById(id) {
  return FM_PRESETS.find((preset) => preset.id === id) || FM_PRESETS.find((preset) => preset.id === "lead");
}

/** Null when the prompt does not name a role. Lead is tested before pad. */
export function roleFromPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/\blead\b/.test(text)) return "lead";
  if (/\bpad\b/.test(text)) return "pad";
  if (/\bbell\b/.test(text)) return "bell";
  if (/\bbass\b/.test(text)) return "bass";
  if (/\bpluck\b/.test(text)) return "pluck";
  return null;
}

export function presetFromPrompt(prompt) {
  return roleFromPrompt(prompt) || "lead";
}

/** Null when the prompt does not name a root and a mode. */
export function namedScale(prompt) {
  const match = String(prompt || "").match(/\b([A-G]#?)\s+(major|minor|dorian|pentatonic)\b/i);
  if (!match) return null;
  const letter = match[1][0].toUpperCase();
  const sharp = match[1].includes("#") ? "#" : "";
  return { root: letter + sharp, mode: match[2].toLowerCase() };
}

export function scaleFromPrompt(prompt) {
  return namedScale(prompt) || { root: "A", mode: "minor" };
}

export function normalizeRhythm(str) {
  let text = String(str || "").replace(/\s+/g, "");
  if (text.length > LAYER_ROWS) text = text.slice(0, LAYER_ROWS);
  if (text.length < LAYER_ROWS) text = text.padEnd(LAYER_ROWS, ".");
  return [...text].map((ch) => (ch === "x" || ch === "X" || ch === "1" || ch === "*" ? "x" : ".")).join("");
}

function clampBpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 90;
  return Math.max(60, Math.min(200, Math.round(n)));
}

function validRole(value) {
  const id = String(value || "").toLowerCase();
  return ROLES.includes(id) ? id : null;
}

function validScale(scale) {
  if (!scale || typeof scale !== "object") return null;
  const root = String(scale.root || "").toUpperCase();
  const mode = String(scale.mode || "").toLowerCase();
  if (!/^([A-G])#?$/.test(root) || !MODES.includes(mode)) return null;
  return { root, mode };
}

function readLevel(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(9, Math.round(n)));
}

function macrosFrom(patch) {
  if (!patch || typeof patch !== "object") return null;
  const out = {};
  if (RATIO_VALUE[String(patch.ratio)] != null) out.ratio = String(patch.ratio);
  for (const key of ["depth", "feedback", "attack", "decay", "sustain", "release", "cutoff", "res"]) {
    const level = readLevel(patch[key]);
    if (level !== undefined) out[key] = level;
  }
  return Object.keys(out).length ? out : null;
}

function parseMelody(value) {
  if (typeof value !== "string" || value.length !== LAYER_ROWS * 2) return null;
  const steps = [];
  for (let i = 0; i < LAYER_ROWS; i++) {
    const token = value.slice(i * 2, i * 2 + 2);
    if (token === ".." || token === "==" || /^[1-7][lmh]$/.test(token)) steps.push(token);
    else return null;
  }
  return steps;
}

function rhythmSteps(bass, kick, token, noteOffNextRest) {
  const hits = bass.includes("x") ? bass : kick;
  const steps = [];
  let armed = false;
  for (let i = 0; i < LAYER_ROWS; i++) {
    if (hits[i] === "x") {
      steps.push(token);
      armed = true;
    } else if (noteOffNextRest && armed) {
      steps.push("==");
      armed = false;
    } else {
      steps.push("..");
    }
  }
  if (!steps.some((step) => step !== ".." && step !== "==")) {
    steps[0] = token;
    steps[LAYER_ROWS - 1] = "==";
  }
  return steps;
}

function templateSteps(preset, rhythm) {
  if (preset === "bass") return rhythmSteps(rhythm.bass, rhythm.kick, "1l", false);
  if (preset === "pluck") return rhythmSteps(rhythm.bass, rhythm.kick, "1m", true);
  return TEMPLATE_STEPS[preset] || TEMPLATE_STEPS.lead;
}

export function fmtNote(midi) {
  const wrapped = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return NOTES[wrapped] + oct;
}

function degreeMidi(degree, octLetter, scale, preset) {
  const intervals = SCALES[scale.mode];
  let index = degree - 1;
  let extra = 0;
  while (index >= intervals.length) {
    index -= intervals.length;
    extra += 1;
  }
  const octaves = preset === "bass" ? { l: 1, m: 2, h: 3 } : { l: 3, m: 4, h: 5 };
  let pc = ROOT_PC[scale.root[0]];
  let carry = 0;
  if (scale.root.endsWith("#")) {
    pc += 1;
    if (pc >= 12) {
      pc -= 12;
      carry = 1;
    }
  }
  let midi = (octaves[octLetter] + extra + carry + 1) * 12 + pc + intervals[index];
  if (midi > 127) midi = 127;
  if (midi < 0) midi = 0;
  return midi;
}

function stepsToCells(steps, scale, preset) {
  return steps.map((step) => {
    if (step === "..") return { note: null, sample: 0, volume: 0, effect: 0, param: 0 };
    if (step === "==") return { note: "===", sample: 0, volume: 0, effect: 0, param: 0 };
    const midi = degreeMidi(Number(step[0]), step[1], scale, preset);
    return { note: fmtNote(midi), sample: 0, volume: 64, effect: 0, param: 0 };
  });
}

export function applyMacros(preset, macros) {
  const sound = clonePreset(preset);
  if (!macros) return sound;
  if (macros.ratio != null) sound.ops[0].ratio = RATIO_VALUE[String(macros.ratio)];
  if (macros.depth != null) sound.depth = LEVELS.depth[macros.depth];
  if (macros.feedback != null) sound.feedback = LEVELS.feedback[macros.feedback];
  if (macros.attack != null) {
    const attack = LEVELS.attack[macros.attack];
    sound.ops[0].attack = attack;
    sound.ops[1].attack = attack;
  }
  if (macros.decay != null) {
    const decay = LEVELS.decay[macros.decay];
    sound.ops[0].decay = Math.max(0.003, decay * 0.65);
    sound.ops[1].decay = decay;
  }
  if (macros.sustain != null) {
    const sustain = LEVELS.sustain[macros.sustain];
    sound.ops[0].sustain = sustain;
    sound.ops[1].sustain = sustain;
  }
  if (macros.release != null) {
    const release = LEVELS.release[macros.release];
    sound.ops[0].release = release;
    sound.ops[1].release = release;
  }
  return sound;
}

export function resolveSound(instrument) {
  if (instrument?.sound?.ops?.length === 2) return clonePreset(instrument.sound);
  const id = validRole(instrument?.preset) || "lead";
  return applyMacros(presetById(id), macrosFrom(instrument?.patch) || {});
}

/** "on" starts a note, "off" releases, "hold" leaves the voice alone. */
export function layerCellAction(cell) {
  if (cell?.note === "===") return "off";
  if (cell?.note) return "on";
  return "hold";
}

/**
 * Always returns a playable layer.
 * parsed may be null. ctx is { bpm, kick, bass }.
 * fallback is true when any field was replaced.
 */
export function expandLayer(parsed, prompt, ctx = {}) {
  const rhythm = {
    kick: normalizeRhythm(ctx.kick),
    bass: normalizeRhythm(ctx.bass),
  };
  const body = parsed && typeof parsed === "object" ? parsed : null;
  let fallback = body == null;

  // A role or scale written in the prompt wins, so "lead synth pad melody"
  // stays a lead even when the model answers preset "pad". The model's
  // patch and melody are still used. With no keyword, the model chooses.
  const namedRole = roleFromPrompt(prompt);
  let preset = namedRole || validRole(body?.preset) || validRole(body?.layer);
  if (!preset) {
    preset = "lead";
    fallback = true;
  }

  const named = namedScale(prompt);
  let scale = named || validScale(body?.scale);
  if (!scale) {
    scale = { root: "A", mode: "minor" };
    fallback = true;
  }

  let steps = parseMelody(body?.melody);
  if (!steps) {
    steps = templateSteps(preset, rhythm);
    fallback = true;
  }

  const provided = macrosFrom(body?.patch);
  let patch;
  if (!provided) {
    patch = { ...FALLBACK_PATCH[preset] };
    fallback = true;
  } else {
    patch = provided;
  }

  const filterPatch = FALLBACK_PATCH[preset];
  const cutoffLevel = patch.cutoff ?? filterPatch.cutoff;
  const resLevel = patch.res ?? filterPatch.res;
  const base = presetById(preset);

  return {
    instrument: {
      id: `fm-${preset}`,
      type: "fm",
      name: base.name,
      preset,
      patch,
      sound: applyMacros(base, patch),
    },
    channelFx: {
      cutoff: LEVELS.cutoff[cutoffLevel],
      resonance: LEVELS.res[resLevel],
      drive: 0,
      fxWet: 0,
    },
    cells: stepsToCells(steps, scale, preset),
    scale,
    fallback,
  };
}

export function layerMessages(prompt, ctx = {}) {
  const bpm = clampBpm(ctx.bpm);
  const kick = normalizeRhythm(ctx.kick);
  const bass = normalizeRhythm(ctx.bass);
  return [
    {
      role: "system",
      content:
        "You write one FM synth layer for a 16-step tracker. Reply with JSON only. " +
        "melody is exactly 16 steps of 2 characters: a scale degree 1-7 plus octave l, m, or h " +
        "(1m is the root in the middle octave); .. is a rest and the note keeps sounding; " +
        "== releases the note. Fit the pitches to the kick and bass rhythm at this BPM. " +
        "patch numbers are levels 0-9. ratio is one of 1, 2, 3, 4, 0.5. " +
        "layer and preset are the same role: lead, pad, bell, bass, or pluck.",
    },
    {
      role: "user",
      content:
        `BPM ${bpm}. Kick ${kick}. Bass ${bass}.\n` +
        "Example melody: 1m..3m..5m5h..4m..3m..2m..1m==..\n" +
        `Write a layer for: ${prompt}`,
    },
  ];
}

export const LAYER_MAX_TOKENS = 256;
