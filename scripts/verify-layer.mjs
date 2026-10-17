#!/usr/bin/env node
/**
 * Layer compose checks.
 *
 *   node scripts/verify-layer.mjs
 *
 * Covers "a lead synth pad melody", "slow warm pad in D minor", and a
 * compose request made while both llama.cpp nodes are unreachable.
 * The last one starts a second server on port 3841 with dead LLM URLs.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandLayer, layerCellAction, LAYER_GRAMMAR, LEVELS, applyMacros } from "../public/audio/layer.js";
import { FM_PRESETS } from "../public/audio/fm-presets.js";
import { FMSynth } from "../public/audio/fm-dsp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = process.env.TRACKER_URL || "http://127.0.0.1:3840";
const ctx = { bpm: 90, kick: "x...x...x..x.x..", bass: "x.....x.x......." };
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", msg);
  } else {
    console.log("ok", msg);
  }
}

function playable(layer, label) {
  assert(layer?.instrument?.type === "fm", `${label} type`);
  assert(layer.cells?.length === 16, `${label} 16 cells`);
  assert(layer.cells.some((cell) => cell.note && cell.note !== "==="), `${label} has a note`);
  assert(layer.cells.every((cell) => layerCellAction(cell) !== "on" || typeof cell.note === "string"), `${label} notes`);
  assert(typeof layer.channelFx?.cutoff === "number", `${label} cutoff`);
}

const lead = expandLayer(null, "a lead synth pad melody", ctx);
playable(lead, "lead phrase");
assert(lead.instrument.preset === "lead", "lead wins over pad");
assert(lead.fallback === true, "null model is a fallback");
assert(lead.instrument.sound.ops[0].ratio === 2, "lead fallback ratio");

const pad = expandLayer(null, "slow warm pad in D minor", ctx);
playable(pad, "pad phrase");
assert(pad.instrument.preset === "pad", "pad preset");
assert(pad.scale.root === "D" && pad.scale.mode === "minor", "D minor");
assert(pad.cells[0].note === "D-4", `pad root ${pad.cells[0].note}`);
assert(pad.cells.slice(1, 8).every((cell) => layerCellAction(cell) === "hold"), "pad holds");
assert(pad.cells[8].note === "F-4", `degree 3 ${pad.cells[8].note}`);
assert(pad.cells[15].note === "===" && layerCellAction(pad.cells[15]) === "off", "pad note-off");
assert(pad.instrument.sound.ops[1].attack === LEVELS.attack[7], "pad attack level 7");

const coerced = expandLayer({
  layer: "pad",
  preset: "pad",
  patch: { ratio: "0.5", depth: 2, feedback: 0, attack: 1, decay: 2, sustain: 6, release: 4, cutoff: 5, res: 1 },
  scale: { root: "C", mode: "major" },
  melody: "1m..3m..5m5h..4m..3m..2m..1m==..",
}, "a lead synth pad melody", ctx);
assert(coerced.instrument.preset === "lead" && coerced.fallback === false, "prompt role overrides a valid pad answer");
assert(coerced.instrument.sound.ops[0].ratio === 0.5, "model ratio still applies");

const melodyLine = LAYER_GRAMMAR.split("\n").find((line) => line.startsWith("melody ::="));
assert(melodyLine && melodyLine.match(/\bstep\b/g).length === 16, "grammar melody is 16 steps");
assert(LAYER_GRAMMAR.includes('".."') && LAYER_GRAMMAR.includes('"=="'), "grammar tokens");

const synth = new FMSynth(48000);
const sound = applyMacros(FM_PRESETS.find((preset) => preset.id === "pad"), {
  attack: 1, decay: 2, sustain: 6, release: 2, depth: 1, feedback: 0, ratio: "1",
});
synth.setPreset(sound, true);
synth.pushEvent({ type: "noteOn", time: 0, note: 62, velocity: 0.8 });
const block = new Float32Array(4800);
const windows = [];
for (let i = 0; i < 5; i++) {
  synth.renderBlock(i * 0.1, block);
  let sum = 0;
  for (const sample of block) sum += sample * sample;
  windows.push(Math.sqrt(sum / block.length));
}
const snap = synth.snapshot();
assert(snap.mode === "run" && snap.carStage === "sustain", `held in sustain (${snap.carStage})`);
assert(windows[3] > 0.02 && Math.abs(windows[3] - windows[4]) / windows[3] < 0.25, "sustain level stays up with no new event");
synth.pushEvent({ type: "noteOn", time: 0.5, note: 65, velocity: 0.8 });
const fade = new Float32Array(480);
synth.renderBlock(0.5, fade);
let maxDelta = 0;
for (let i = 1; i < fade.length; i++) maxDelta = Math.max(maxDelta, Math.abs(fade[i] - fade[i - 1]));
assert(maxDelta < 0.05, `retrigger fade ${maxDelta}`);
assert(synth.snapshot().carStage === "attack", "new degree restarts the envelope");
synth.pushEvent({ type: "noteOff", time: 0.7 });
for (let i = 0; i < 8; i++) synth.renderBlock(0.7 + i * 0.1, block);
assert(block.every((sample) => sample === 0) && synth.snapshot().mode === "idle", "silent after release");

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json() };
}

async function liveServer() {
  const drums = await post(`${live}/api/compose`, { prompt: "dusty boom bap", local: true });
  assert(drums.status === 200 && drums.json.channels === 8, "drum compose stays 8 channels");
  assert(drums.json.patterns[0].data.length === 8, "drum pattern width 8");
  assert(drums.json.tracks.kick === "x...x...x..x.x..", "boom bap kick");
  assert(!drums.json.instruments, "drum song has no instrument table");

  for (const [prompt, preset] of [["a lead synth pad melody", "lead"], ["slow warm pad in D minor", "pad"]]) {
    const res = await post(`${live}/api/compose`, { mode: "layer", offline: true, prompt, song: ctx });
    assert(res.status === 200 && res.json.llm?.provider === "template", `${preset} offline http`);
    assert(res.json.instrument?.preset === preset, `${preset} offline preset ${res.json.instrument?.preset}`);
    playable(res.json, `${preset} offline`);
  }
  const alias = await post(`${live}/api/compose-layer`, {
    offline: true,
    prompt: "slow warm pad in D minor",
    song: ctx,
  });
  assert(alias.status === 200 && alias.json.instrument.preset === "pad" && alias.json.cells[0].note === "D-4", "compose-layer alias");
}

function startDeadServer(port) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LLAMA_URL: "http://127.0.0.1:9",
      LLAMA_URL_2: "http://127.0.0.1:9",
      XAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function nodesDown() {
  const port = 3841;
  const child = startDeadServer(port);
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(20000) });
        if (res.ok || res.status) { up = true; break; }
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(up, "nodes-down server started");
    const res = await post(`http://127.0.0.1:${port}/api/compose`, {
      mode: "layer",
      prompt: "a lead synth pad melody",
      song: ctx,
    });
    assert(res.status === 200, `nodes-down status ${res.status}`);
    assert(res.json.llm?.ok === false && res.json.llm?.provider === "template", `nodes-down provider ${res.json.llm?.provider}`);
    assert(res.json.instrument?.preset === "lead", "nodes-down still a lead");
    playable(res.json, "nodes-down");
  } finally {
    child.kill();
    if (failed && log) console.error(log.slice(-500));
  }
}

try {
  await liveServer();
  await nodesDown();
} catch (err) {
  failed += 1;
  console.error("FAIL", err?.message || err);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("verify-layer ok");
