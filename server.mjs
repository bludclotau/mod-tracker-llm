#!/usr/bin/env node
/**
 * MOD Tracker LLM — static UI + sample catalog + llama.cpp compose proxy.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYER_GRAMMAR, LAYER_MAX_TOKENS, expandLayer, layerMessages } from "./public/audio/layer.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const SAMPLE_DIR = path.join(PUBLIC, "samples");
const PORT = Number(process.env.PORT || 3840);
const LLAMA_URL = process.env.LLAMA_URL || "http://10.1.1.122:8082";
const LLAMA_URL_2 = process.env.LLAMA_URL_2 || "http://10.1.1.122:8081";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_BASE_URL = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.7";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

const ROLES = ["kick", "snare", "hat", "openhat", "clap", "perc", "crash", "bass"];

const TEMPLATES = {
  "boom-bap": {
    title: "Boom Bap",
    bpm: 90,
    tracks: {
      kick: "x...x...x..x.x..",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "......x.........",
      clap: "....x.......x...",
      perc: "..x........x....",
      crash: "x...............",
      bass: "x.....x.x.......",
    },
  },
  house: {
    title: "Four on the Floor",
    bpm: 124,
    tracks: {
      kick: "x...x...x...x...",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "......x.......x.",
      clap: "....x.......x...",
      perc: "..x...x...x...x.",
      crash: "x...............",
      bass: "x...x...x...x...",
    },
  },
  trap: {
    title: "Trap",
    bpm: 140,
    tracks: {
      kick: "x.....x.x.......",
      snare: "....x.......x...",
      hat: "xxxxxxxxxxxxxxxx",
      openhat: "......x.........",
      clap: "....x.......x...",
      perc: "x.x.........x.x.",
      crash: "x...............",
      bass: "x.........x.....",
    },
  },
  dnb: {
    title: "DnB Break",
    bpm: 174,
    tracks: {
      kick: "x.....x.x.......",
      snare: "....x.....x.x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "..x.......x.....",
      clap: "........x.......",
      perc: "x.x.x...........",
      crash: "x...............",
      bass: "x..x..x.x.......",
    },
  },
  breakbeat: {
    title: "Breakbeat",
    bpm: 132,
    tracks: {
      kick: "x..x..x.....x...",
      snare: "....x..x....x...",
      hat: "x.x.x.xxx.x.x.x.",
      openhat: "..........x.....",
      clap: "....x.......x...",
      perc: ".x.x........x.x.",
      crash: "x...............",
      bass: "x...x..x.x......",
    },
  },
  lofi: {
    title: "Lofi Loop",
    bpm: 82,
    tracks: {
      kick: "x.....x....x....",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "........x.......",
      clap: "....x...........",
      perc: "......x....x....",
      crash: "................",
      bass: "x.......x.......",
    },
  },
  techno: {
    title: "Techno",
    bpm: 132,
    tracks: {
      kick: "x...x...x...x...",
      snare: "....x.......x...",
      hat: "..x...x...x...x.",
      openhat: "............x...",
      clap: "................",
      perc: "x.x.x.x.x.x.x.x.",
      crash: "x...............",
      bass: "x...x...x...x...",
    },
  },
};

function walkWavs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkWavs(p, acc);
    else if (ent.name.toLowerCase().endsWith(".wav")) acc.push(p);
  }
  return acc;
}

function roleOf(rel) {
  const n = rel.replaceAll("\\", "/").toLowerCase();
  if (n.includes("808")) return "bass";
  if (n.includes("/kicks/") || n.includes("kick")) return "kick";
  if (n.includes("/snares/") || n.includes("snare")) return "snare";
  if (n.includes("/claps/") || n.includes("clap")) return "clap";
  if (n.includes("/percs/") || n.includes("perc")) return "perc";
  if (n.includes("hats closed") || n.includes("closed hat")) return "hat";
  if (n.includes("hats open") || n.includes("open hat")) return "openhat";
  if (n.includes("crash")) return "crash";
  if (n.includes("ride")) return "ride";
  return "other";
}

function loadCatalog() {
  const files = walkWavs(SAMPLE_DIR).sort((a, b) => a.localeCompare(b));
  const byRole = {};
  const samples = files.map((abs, i) => {
    const rel = path.relative(SAMPLE_DIR, abs).replaceAll("\\", "/");
    const role = roleOf(rel);
    const rec = {
      id: i + 1,
      name: path.basename(rel, ".wav"),
      file: rel,
      url: "/samples/" + rel.split("/").map(encodeURIComponent).join("/"),
      role,
      muteGroup: role === "hat" || role === "openhat" ? "hats" : null,
    };
    (byRole[role] ||= []).push(rec);
    return rec;
  });
  return { samples, byRole };
}

const catalog = loadCatalog();

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".wav" ? "public, max-age=86400" : "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function pickVariant(role, n) {
  const list = catalog.byRole[role] || [];
  if (!list.length) return null;
  const idx = ((Number(n) || 1) - 1) % list.length;
  return list[idx < 0 ? 0 : idx];
}

function normalizeHits(str, rows) {
  let s = String(str || "").replace(/\s+/g, "");
  if (!s) s = ".".repeat(rows);
  if (s.length > rows) s = s.slice(0, rows);
  if (s.length < rows) s = s.padEnd(rows, ".");
  return [...s].map((c) => (c === "x" || c === "X" || c === "1" || c === "*" ? "x" : ".")).join("");
}

function guessTemplate(prompt) {
  const p = (prompt || "").toLowerCase();
  const order = [
    ["dnb", "drum and bass", "jungle"],
    ["trap", "hi-hat roll", "808"],
    ["techno", "minimal"],
    ["house", "four on the floor", "disco"],
    ["breakbeat", "break", "breaks"],
    ["lofi", "lo-fi", "chill", "jazz"],
    ["boom-bap", "boom bap", "hip hop", "hip-hop", "boom"],
  ];
  for (const [key, ...alts] of order) {
    if ([key, ...alts].some((w) => p.includes(w))) return TEMPLATES[key];
  }
  return TEMPLATES["boom-bap"];
}

function kitFromLlm(kit) {
  const out = {};
  for (const role of ROLES) {
    const sample = pickVariant(role === "crash" ? "crash" : role, kit?.[role] ?? 1)
      || pickVariant(role, 1)
      || catalog.samples[0];
    if (sample) out[role] = sample.id;
  }
  if (!out.crash && catalog.byRole.ride?.[0]) out.crash = catalog.byRole.ride[0].id;
  return out;
}

function expandSong(parsed, prompt) {
  const fallback = guessTemplate(prompt);
  const rows = 16;
  const bpm = Math.max(60, Math.min(200, Number(parsed?.bpm) || fallback.bpm));
  const kit = kitFromLlm(parsed?.kit);
  const tracks = {};
  for (const role of ROLES) {
    tracks[role] = normalizeHits(parsed?.tracks?.[role] ?? fallback.tracks[role], rows);
  }
  const title = String(parsed?.title || fallback.title).slice(0, 48);
  const channels = ROLES.map((role, ch) => {
    const sampleId = kit[role];
    const hits = tracks[role];
    const note = role === "bass" ? "C-1" : "C-4";
    const cells = [...hits].map((h) =>
      h === "x"
        ? { note, sample: sampleId, volume: role === "hat" ? 40 : 64, effect: 0, param: 0 }
        : { note: null, sample: 0, volume: 0, effect: 0, param: 0 }
    );
    return { role, sampleId, cells };
  });
  return {
    title,
    bpm,
    speed: 6,
    rows,
    channels: 8,
    order: [0],
    patterns: [{ name: title, rows, data: channels.map((c) => c.cells) }],
    kit,
    tracks,
    prompt: prompt || "",
  };
}

const GRAMMAR = `
space ::= [ \\t\\n]*
root ::= "{" space title-k "," space bpm-k "," space rows-k "," space kit-k "," space tracks-k space "}" space
title-k ::= "\\"title\\"" space ":" space string
string ::= "\\"" [A-Za-z0-9 ]+ "\\""
bpm-k ::= "\\"bpm\\"" space ":" space bpm
bpm ::= [6-9][0-9] | "1" [0-9] [0-9] | "200"
rows-k ::= "\\"rows\\"" space ":" space "16"
kit-k ::= "\\"kit\\"" space ":" space "{" space kit-pairs space "}"
kit-pairs ::= kick-p "," space snare-p "," space hat-p "," space open-p "," space clap-p "," space perc-p "," space crash-p "," space bass-p
kick-p ::= "\\"kick\\"" space ":" space var
snare-p ::= "\\"snare\\"" space ":" space var
hat-p ::= "\\"hat\\"" space ":" space var
open-p ::= "\\"openhat\\"" space ":" space var
clap-p ::= "\\"clap\\"" space ":" space var
perc-p ::= "\\"perc\\"" space ":" space var
crash-p ::= "\\"crash\\"" space ":" space var
bass-p ::= "\\"bass\\"" space ":" space var
var ::= "10" | [1-9]
tracks-k ::= "\\"tracks\\"" space ":" space "{" space track-pairs space "}"
track-pairs ::= t-kick "," space t-snare "," space t-hat "," space t-open "," space t-clap "," space t-perc "," space t-crash "," space t-bass
t-kick ::= "\\"kick\\"" space ":" space pat
t-snare ::= "\\"snare\\"" space ":" space pat
t-hat ::= "\\"hat\\"" space ":" space pat
t-open ::= "\\"openhat\\"" space ":" space pat
t-clap ::= "\\"clap\\"" space ":" space pat
t-perc ::= "\\"perc\\"" space ":" space pat
t-crash ::= "\\"crash\\"" space ":" space pat
t-bass ::= "\\"bass\\"" space ":" space pat
pat ::= "\\"" hit hit hit hit hit hit hit hit hit hit hit hit hit hit hit hit "\\""
hit ::= "x" | "."
`;

function catalogBlurb() {
  const lines = ROLES.map((role) => {
    const n = (catalog.byRole[role] || []).length;
    return `${role}: variants 1-${n || 1}`;
  });
  return lines.join(", ");
}

function composeMessages(prompt) {
  const example = JSON.stringify({
    title: "Boom Bap",
    bpm: 90,
    rows: 16,
    kit: { kick: 3, snare: 2, hat: 1, openhat: 4, clap: 1, perc: 5, crash: 1, bass: 3 },
    tracks: {
      kick: "x...x...x..x.x..",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "......x.........",
      clap: "....x.......x...",
      perc: "..x........x....",
      crash: "x...............",
      bass: "x.....x.x.......",
    },
  });
  return [
    {
      role: "system",
      content:
        "You are a classic MOD/XM tracker composer. Reply with JSON only. " +
        "tracks values are exactly 16 characters using x for a hit and . for a rest. " +
        "kit values are variant numbers 1-10 for that drum role. " +
        "Keep kick sparse (4-7 hits). Snare on backbeats. Hats usually 8th notes. Crash only on row 1.",
    },
    {
      role: "user",
      content:
        `Drum kit roles: ${catalogBlurb()}.\n` +
        `Example:\n${example}\n\n` +
        `Compose this 16-step loop: ${prompt}`,
    },
  ];
}

async function llamaModels(base) {
  const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`models ${r.status}`);
  return r.json();
}

async function chatComplete(base, body) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`chat ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function composeWithLlama(nodeUrl, prompt, spec = null) {
  let model = "dolphin";
  try {
    const models = await llamaModels(nodeUrl);
    model = models?.data?.[0]?.id || models?.models?.[0]?.name || model;
  } catch {
    /* use default */
  }
  const completion = await chatComplete(nodeUrl, {
    model,
    temperature: 0.7,
    max_tokens: spec?.maxTokens ?? 400,
    cache_prompt: true,
    grammar: (spec?.grammar || GRAMMAR).trim(),
    messages: spec?.messages || composeMessages(prompt),
  });
  const content = completion?.choices?.[0]?.message?.content || "";
  return { content, model, provider: "llama.cpp", node: nodeUrl };
}

async function composeWithXai(prompt, spec = null) {
  if (!XAI_API_KEY) throw new Error("no XAI_API_KEY");
  const r = await fetch(`${XAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      temperature: 0.7,
      max_tokens: spec?.maxTokens ?? 400,
      messages: spec?.messages || composeMessages(prompt),
    }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`xai ${r.status}: ${text.slice(0, 400)}`);
  const completion = JSON.parse(text);
  return {
    content: completion?.choices?.[0]?.message?.content || "",
    model: XAI_MODEL,
    provider: "spacexai",
    node: XAI_BASE_URL,
  };
}

function layerPayload(layer, llm) {
  return {
    instrument: layer.instrument,
    channelFx: layer.channelFx,
    cells: layer.cells,
    llm,
  };
}

async function handleLayer(res, parsedBody) {
  const prompt = String(parsedBody.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt required" });
  const song = parsedBody.song && typeof parsedBody.song === "object" ? parsedBody.song : {};
  const ctx = {
    bpm: song.bpm ?? parsedBody.bpm,
    kick: song.kick ?? parsedBody.kick,
    bass: song.bass ?? parsedBody.bass,
  };
  const offline = Boolean(parsedBody.local || parsedBody.offline || parsedBody.node === "offline");
  if (offline) {
    const layer = expandLayer(null, prompt, ctx);
    return json(res, 200, layerPayload(layer, {
      ok: false,
      provider: "template",
      model: "local-template",
      node: null,
      raw: "",
      errors: [],
    }));
  }

  const spec = {
    grammar: LAYER_GRAMMAR,
    messages: layerMessages(prompt, ctx),
    maxTokens: LAYER_MAX_TOKENS,
  };
  const node = String(parsedBody.node || "dolphin");
  const nodeUrl = node === "qwen" ? LLAMA_URL_2 : LLAMA_URL;
  const errors = [];
  let llm = null;
  try {
    llm = await composeWithLlama(nodeUrl, prompt, spec);
  } catch (err) {
    errors.push(String(err.message || err));
    const fallbackUrl = nodeUrl === LLAMA_URL ? LLAMA_URL_2 : LLAMA_URL;
    try {
      llm = await composeWithLlama(fallbackUrl, prompt, spec);
    } catch (err2) {
      errors.push(String(err2.message || err2));
    }
  }
  if (!llm) {
    try {
      llm = await composeWithXai(prompt, spec);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  const raw = llm?.content || "";
  const parsed = extractJson(raw);
  const layer = expandLayer(parsed, prompt, ctx);
  return json(res, 200, layerPayload(layer, {
    ok: Boolean(parsed) && !layer.fallback,
    provider: llm?.provider || "template",
    model: llm?.model || "local-template",
    node: llm?.node || null,
    raw: raw.slice(0, 4000),
    errors,
  }));
}

async function handleCompose(req, res, url, forceLayer = false) {
  const body = await readBody(req);
  let parsedBody = {};
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  if (forceLayer) parsedBody.mode = "layer";
  if (parsedBody.mode === "layer") return handleLayer(res, parsedBody);
  const prompt = String(parsedBody.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt required" });
  if (parsedBody.local) {
    const song = expandSong({}, prompt);
    song.llm = { ok: true, provider: "template", model: "local-template", node: null, raw: "", errors: [] };
    return json(res, 200, song);
  }
  const node = String(parsedBody.node || "dolphin");
  const nodeUrl = node === "qwen" ? LLAMA_URL_2 : LLAMA_URL;
  const errors = [];
  let llm = null;
  try {
    llm = await composeWithLlama(nodeUrl, prompt);
  } catch (err) {
    errors.push(String(err.message || err));
    const fallbackUrl = nodeUrl === LLAMA_URL ? LLAMA_URL_2 : LLAMA_URL;
    try {
      llm = await composeWithLlama(fallbackUrl, prompt);
    } catch (err2) {
      errors.push(String(err2.message || err2));
    }
  }
  if (!llm) {
    try {
      llm = await composeWithXai(prompt);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  const raw = llm?.content || "";
  const parsed = extractJson(raw);
  const song = expandSong(parsed || {}, prompt);
  song.llm = {
    ok: Boolean(parsed),
    provider: llm?.provider || "template",
    model: llm?.model || "local-template",
    node: llm?.node || null,
    raw: raw.slice(0, 4000),
    errors,
  };
  json(res, 200, song);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleHealth(_req, res) {
  const ping = async (url, name) => {
    const t0 = Date.now();
    try {
      const models = await llamaModels(url);
      return {
        name,
        url,
        ok: true,
        ms: Date.now() - t0,
        model: models?.data?.[0]?.id || models?.models?.[0]?.name || null,
      };
    } catch (err) {
      return { name, url, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
    }
  };
  const nodes = await Promise.all([
    ping(LLAMA_URL, "dolphin"),
    ping(LLAMA_URL_2, "qwen"),
  ]);
  json(res, 200, {
    ok: nodes.some((n) => n.ok),
    samples: catalog.samples.length,
    nodes,
    spacexai: Boolean(XAI_API_KEY),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET" && url.pathname === "/api/samples") {
      return json(res, 200, { samples: catalog.samples, roles: catalog.byRole && Object.fromEntries(
        Object.entries(catalog.byRole).map(([k, v]) => [k, v.map((s) => s.id)])
      )});
    }
    if (req.method === "GET" && url.pathname === "/api/templates") {
      return json(res, 200, { templates: Object.keys(TEMPLATES) });
    }
    if (req.method === "POST" && url.pathname === "/api/compose") return handleCompose(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/compose-layer") return handleCompose(req, res, url, true);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return sendFile(res, path.join(PUBLIC, "index.html"));
    }

    const rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) {
      res.writeHead(400);
      return res.end("bad path");
    }
    const filePath = path.join(PUBLIC, rel);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(400);
      return res.end("bad path");
    }
    return sendFile(res, filePath);
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mod-tracker-llm http://127.0.0.1:${PORT}`);
  console.log(`samples ${catalog.samples.length}  llama ${LLAMA_URL}`);
});
