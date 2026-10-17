/**
 * Two-operator FM presets. Operator 0 modulates operator 1.
 * Times are seconds. feedback and depth are radians (see fm-dsp.js).
 * Factory objects are treated as immutable; clone before editing.
 */

export const FM_PRESETS = [
  {
    id: "epiano",
    name: "E-Piano",
    depth: 2.2,
    feedback: 0.55,
    velocity: 0.7,
    ops: [
      { ratio: 1, detune: 2, attack: 0.004, decay: 1.3, sustain: 0.12, release: 0.28, level: 0.85 },
      { ratio: 1, detune: 0, attack: 0.006, decay: 1.8, sustain: 0.28, release: 0.4, level: 0.9 },
    ],
  },
  {
    id: "bell",
    name: "Bell",
    depth: 3.4,
    feedback: 0.12,
    velocity: 0.55,
    ops: [
      { ratio: 3.5, detune: 4, attack: 0.003, decay: 0.45, sustain: 0, release: 0.25, level: 0.9 },
      { ratio: 1, detune: 0, attack: 0.003, decay: 2.4, sustain: 0, release: 0.6, level: 0.75 },
    ],
  },
  {
    id: "bass",
    name: "FM Bass",
    depth: 3.1,
    feedback: 0.85,
    velocity: 0.45,
    ops: [
      { ratio: 1, detune: 0, attack: 0.004, decay: 0.16, sustain: 0.25, release: 0.08, level: 1 },
      { ratio: 1, detune: -2, attack: 0.005, decay: 0.22, sustain: 0.75, release: 0.1, level: 0.95 },
    ],
  },
  {
    id: "pluck",
    name: "Pluck",
    depth: 2.4,
    feedback: 0.2,
    velocity: 0.65,
    ops: [
      { ratio: 2, detune: 7, attack: 0.003, decay: 0.07, sustain: 0, release: 0.04, level: 0.75 },
      { ratio: 1, detune: 0, attack: 0.003, decay: 0.16, sustain: 0, release: 0.06, level: 0.85 },
    ],
  },
];

export function clonePreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    depth: preset.depth,
    feedback: preset.feedback,
    velocity: preset.velocity,
    ops: preset.ops.map((op) => ({
      ratio: op.ratio,
      detune: op.detune,
      attack: op.attack,
      decay: op.decay,
      sustain: op.sustain,
      release: op.release,
      level: op.level,
    })),
  };
}
