import { NOTE_OFF, SampleVoice, isNoteOff } from "./audio/voice.js";
import { FMVoice } from "./audio/fm-voice.js";
import { FM_PRESETS, clonePreset } from "./audio/fm-presets.js";
import { resolveSound } from "./audio/layer.js";
import {
  SONG_VERSION,
  applyCellFx,
  defaultChannelFx,
  migrateSong,
  normalizeChannelFx,
  resolveCatalogSample,
} from "./audio/instruments.js";
import { ChannelStrip, createMasterChain } from "./audio/dsp-strip.js";

/* MOD Tracker LLM — pattern editor + Web Audio player + Dolphin compose. */
(() => {
  const NOTES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
  const ROLES = ["kick", "snare", "hat", "openhat", "clap", "perc", "crash", "bass"];
  const LOWER = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11 };
  const UPPER = { q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23 };

  const $ = (id) => document.getElementById(id);
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

  function midiOf(note) {
    if (!note || note === "---" || note === "...") return null;
    const m = String(note).match(/^([A-G]#?)[ -]?(\d)$/i);
    if (!m) return null;
    const token = m[1].length === 1 ? m[1].toUpperCase() + "-" : m[1][0].toUpperCase() + m[1][1];
    const idx = NOTES.indexOf(token);
    if (idx < 0) return null;
    return idx + (Number(m[2]) + 1) * 12;
  }

  function fmtNote(midi) {
    if (midi == null) return "---";
    const pc = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return NOTES[pc] + oct;
  }

  const state = {
    samples: [],
    byId: new Map(),
    buffers: new Map(),
    song: null,
    row: 0,
    ch: 0,
    playing: false,
    ctx: null,
    master: null,
    voices: null,
    nextTime: 0,
    playRow: 0,
    timer: 0,
    octave: 4,
    selectedSample: 1,
    fm: null,
    fmPreset: null,
    fmTicket: 0,
    layerVoices: {},
    channelFm: {},
    instrumentSync: false,
    strips: null,
    fxBus: null,
    limiter: null,
    fxSync: false,
  };

  const FM_GLOBALS = [
    { id: "fmDepth", label: "depth", key: "depth", min: 0, max: 8, step: 0.01 },
    { id: "feedback", label: "feedback", key: "feedback", min: 0, max: 3.14, step: 0.01 },
    { id: "velSens", label: "vel", key: "velocity", min: 0, max: 1, step: 0.01 },
  ];
  const FM_OP_FIELDS = [
    { suffix: "Ratio", label: "ratio", key: "ratio", min: 0.25, max: 12, step: 0.01 },
    { suffix: "Detune", label: "detune", key: "detune", min: -100, max: 100, step: 1 },
    { suffix: "Attack", label: "attack", key: "attack", min: 0.003, max: 4, step: 0.001 },
    { suffix: "Decay", label: "decay", key: "decay", min: 0.003, max: 4, step: 0.001 },
    { suffix: "Sustain", label: "sustain", key: "sustain", min: 0, max: 1, step: 0.01 },
    { suffix: "Release", label: "release", key: "release", min: 0.003, max: 4, step: 0.001 },
    { suffix: "Level", label: "level", key: "level", min: 0, max: 1, step: 0.01 },
  ];

  function fmParamId(opIndex, suffix) {
    return (opIndex === 0 ? "op" : "car") + suffix;
  }

  function fmtSlider(step, value) {
    if (step >= 1) return String(Math.round(Number(value)));
    if (step >= 0.01) return Number(value).toFixed(2);
    return Number(value).toFixed(3);
  }

  function emptyCell() {
    return { note: null, sample: 0, volume: 0, effect: 0, param: 0 };
  }

  function defaultSong() {
    return {
      title: "Untitled",
      bpm: 90,
      speed: 6,
      rows: 16,
      channels: 8,
      order: [0],
      kit: {},
      tracks: {},
      patterns: [{
        name: "Untitled",
        rows: 16,
        data: Array.from({ length: 8 }, () => Array.from({ length: 16 }, emptyCell)),
      }],
      llm: { provider: "none" },
    };
  }

  function currentBpm() {
    return Number($("bpm").value) || state.song?.bpm || 90;
  }

  function secondsPerRow() {
    return 15 / currentBpm();
  }

  async function ensureAudio() {
    if (state.ctx) {
      if (state.ctx.state === "suspended") await state.ctx.resume();
      return state.ctx;
    }
    const ctx = new AudioContext();
    const bus = createMasterChain(ctx);
    bus.master.gain.setValueAtTime(Number($("master").value) / 100, ctx.currentTime);
    state.ctx = ctx;
    state.master = bus.master;
    state.limiter = bus.limiter;
    state.fxBus = bus;
    state.strips = {};
    for (let ch = 0; ch < 8; ch++) ensureStrip(ch, state.song?.channelFx?.[ch]);
    state.voices = Array.from({ length: 8 }, (_, ch) => new SampleVoice(ctx, state.strips[ch].input));
    return ctx;
  }

  function ensureStrip(ch, fx) {
    if (!state.strips) state.strips = {};
    if (state.strips[ch]) return state.strips[ch];
    const strip = new ChannelStrip(state.ctx, state.master, state.fxBus);
    state.strips[ch] = strip;
    strip.setFx(normalizeChannelFx(fx), state.ctx.currentTime, currentBpm(), true);
    return strip;
  }

  function resetStripsForSong() {
    if (!state.ctx || !state.strips) return;
    const t = state.ctx.currentTime;
    const bpm = currentBpm();
    for (const key of Object.keys(state.strips)) {
      const ch = Number(key);
      if (ch >= 8) {
        state.strips[ch].disconnect();
        delete state.strips[ch];
        continue;
      }
      state.strips[ch].setFx(normalizeChannelFx(state.song?.channelFx?.[ch]), t, bpm, true);
    }
  }

  function dropStrip(ch) {
    const strip = state.strips?.[ch];
    if (!strip) return;
    strip.disconnect();
    delete state.strips[ch];
  }

  function reindexStrips(removedCh) {
    if (!state.strips || removedCh < 8) return;
    const next = {};
    for (const [key, strip] of Object.entries(state.strips)) {
      const n = Number(key);
      if (n < removedCh) next[n] = strip;
      else if (n > removedCh) next[n - 1] = strip;
    }
    state.strips = next;
  }

  async function decodeSample(sample) {
    if (state.buffers.has(sample.id)) return state.buffers.get(sample.id);
    const ctx = await ensureAudio();
    const res = await fetch(sample.url);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    state.buffers.set(sample.id, buf);
    return buf;
  }

  function cutVoice(ch, time) {
    state.voices?.[ch]?.cut(time);
  }

  // Retrigger policy lives in audio/voice.js. This function only decides
  // note-off vs note-on, and which slots a hat sample steals.
  function playCell(cell, when, ch, role) {
    const voice = state.voices?.[ch];
    if (!voice) return;
    if (isNoteOff(cell)) {
      voice.noteOff(when);
      return;
    }
    if (!cell?.sample || !cell.note) return;
    const sample = resolveCatalogSample(cell.sample, state.song, state.samples);
    if (!sample) return;
    const buf = state.buffers.get(sample.id);
    if (!buf) return;
    const now = state.ctx.currentTime;
    if (sample.muteGroup === "hats") {
      cutVoice(ROLES.indexOf("hat"), now);
      cutVoice(ROLES.indexOf("openhat"), now);
    } else {
      cutVoice(ch, now);
    }
    const midi = midiOf(cell.note) ?? (role === "bass" ? 24 : 60);
    voice.buffer = buf;
    voice.pan = (ch - 3.5) / 8;
    voice.noteOn(when, midi, (cell.volume || 64) / 64);
  }

  // Layer channels do not cut on a new note. A rest posts nothing, so the
  // envelope stays in sustain until a "===" cell calls noteOff. A new pitch
  // retriggers inside the worklet (5 ms fade, envelopes restart).
  function playLayerCell(cell, when, ch) {
    const layer = state.song.layers?.[ch - 8];
    if (!layer || layer.mute) return;
    const voice = state.layerVoices[ch]?.voice;
    if (!voice) return;
    if (isNoteOff(cell)) {
      voice.noteOff(when);
      return;
    }
    if (!cell?.note) return;
    const midi = midiOf(cell.note);
    if (midi == null) return;
    voice.noteOn(when, midi, (cell.volume || 64) / 64);
  }

  // An FM drum channel matches a layer: a rest posts nothing (hold), === is
  // noteOff, and a new pitch retriggers inside the worklet. No cut() before
  // noteOn, and the hat mute group does not run on this channel.
  function playChannelFm(cell, when, ch) {
    const voice = state.channelFm[ch]?.voice;
    if (!voice) return;
    if (isNoteOff(cell)) {
      voice.noteOff(when);
      return;
    }
    if (!cell?.note) return;
    const midi = midiOf(cell.note);
    if (midi == null) return;
    voice.noteOn(when, midi, (cell.volume || 64) / 64);
  }

  function channelFmId(ch) {
    const map = state.song?.channelInstrument;
    if (!map) return null;
    return map[ch] || map[String(ch)] || null;
  }

  function channelInput(ch) {
    return state.strips?.[ch]?.input || state.master;
  }

  function schedule() {
    if (!state.playing || !state.ctx) return;
    const ahead = 0.12;
    const pat = state.song.patterns[0];
    const width = pat.data.length;
    while (state.nextTime < state.ctx.currentTime + ahead) {
      const row = state.playRow;
      for (let ch = 0; ch < width; ch++) {
        const cell = pat.data[ch][row];
        if (cell?.effect) applyRowFx(cell, state.nextTime, ch);
        if (ch < 8 && channelFmId(ch)) playChannelFm(cell, state.nextTime, ch);
        else if (ch < 8) playCell(cell, state.nextTime, ch, ROLES[ch]);
        else playLayerCell(cell, state.nextTime, ch);
      }
      paintPlayhead(row);
      $("row-ind").textContent = hex2(row);
      state.playRow = (row + 1) % pat.rows;
      state.nextTime += secondsPerRow();
    }
    state.timer = requestAnimationFrame(schedule);
  }

  function paintPlayhead(row) {
    document.querySelectorAll(".cell.play, .row-on").forEach((el) => {
      el.classList.remove("play", "row-on");
    });
    const rowEl = document.querySelector(`[data-row="${row}"]`);
    rowEl?.classList.add("row-on");
    document.querySelectorAll(`.cell[data-r="${row}"]`).forEach((el) => el.classList.add("play"));
    const wrap = $("grid-wrap");
    if (wrap && rowEl) {
      const wr = wrap.getBoundingClientRect();
      const rr = rowEl.getBoundingClientRect();
      if (rr.top < wr.top) wrap.scrollTop -= wr.top - rr.top;
      else if (rr.bottom > wr.bottom) wrap.scrollTop += rr.bottom - wr.bottom;
    }
  }

  async function play() {
    await ensureAudio();
    await preloadUsed();
    await ensureChannelFmVoices();
    await ensureLayerVoices();
    state.playing = true;
    state.playRow = 0;
    state.nextTime = state.ctx.currentTime + 0.05;
    $("status").textContent = "playing";
    $("status").className = "status ok";
    schedule();
  }

  function stop() {
    state.playing = false;
    cancelAnimationFrame(state.timer);
    state.fmTicket += 1;
    if (state.ctx && state.voices) {
      const t = state.ctx.currentTime;
      for (const voice of state.voices) voice.cut(t);
      state.fm?.cut(t);
      for (const slot of Object.values(state.layerVoices)) slot.voice.cut(t);
      for (const slot of Object.values(state.channelFm)) slot.voice.cut(t);
    }
    $("status").textContent = "stopped";
    $("status").className = "status";
  }

  async function preloadUsed() {
    const pat = state.song.patterns[0];
    const needed = [];
    const seen = new Set();
    for (const ch of pat.data) {
      for (const cell of ch) {
        if (!cell?.sample) continue;
        const sample = resolveCatalogSample(cell.sample, state.song, state.samples);
        if (!sample || seen.has(sample.id)) continue;
        seen.add(sample.id);
        needed.push(decodeSample(sample));
      }
    }
    await Promise.all(needed);
  }

  async function preview(sample) {
    await ensureAudio();
    const buf = await decodeSample(sample);
    const voice = state.voices[7];
    voice.cut(state.ctx.currentTime);
    voice.buffer = buf;
    voice.pan = null;
    voice.noteOn(state.ctx.currentTime, 60, 0.9);
  }

  function applySong(song) {
    disposeLayerVoices();
    disposeChannelFm();
    migrateSong(song, state.samples);
    const width = song.patterns?.[0]?.data?.length || 8;
    if (state.ch >= width) state.ch = Math.max(0, width - 1);
    const rows = song.patterns?.[0]?.rows || song.rows || 16;
    if (state.row >= rows) state.row = 0;
    state.song = song;
    $("song-title").textContent = song.title || "Untitled";
    $("bpm").value = song.bpm || 90;
    const meta = song.llm
      ? `${song.llm.provider || ""} ${song.llm.ok === false ? "(template fallback)" : ""}`.trim()
      : "";
    $("llm-meta").textContent = meta;
    renderGrid();
    highlightKit();
    syncChannelInstrument();
    resetStripsForSong();
    paintStrip();
  }

  function renderSamples() {
    const root = $("sample-list");
    root.innerHTML = "";
    $("sample-count").textContent = String(state.samples.length);
    const groups = {};
    for (const s of state.samples) (groups[s.role] ||= []).push(s);
    for (const role of [...ROLES, "ride", "other"]) {
      const list = groups[role];
      if (!list?.length) continue;
      const h = document.createElement("div");
      h.className = "cat";
      h.textContent = role.toUpperCase();
      root.appendChild(h);
      for (const s of list) {
        const el = document.createElement("div");
        el.className = "sample";
        el.dataset.id = s.id;
        el.innerHTML = `<span class="id">${hex2(s.id)}</span><span class="name">${s.name}</span>`;
        el.addEventListener("click", () => {
          state.selectedSample = s.id;
          highlightKit();
          preview(s);
        });
        root.appendChild(el);
      }
    }
  }

  function highlightKit() {
    document.querySelectorAll(".sample").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.id) === state.selectedSample);
    });
  }

  function layoutColumns(n) {
    const cols = `40px repeat(${n}, minmax(132px, 1fr))`;
    $("channel-heads").style.gridTemplateColumns = cols;
    $("grid").style.gridTemplateColumns = cols;
  }

  function renderGrid() {
    const pat = state.song.patterns[0];
    const width = pat.data.length;
    layoutColumns(width);
    const heads = $("channel-heads");
    heads.innerHTML = "";
    const hash = document.createElement("span");
    hash.textContent = "#";
    heads.appendChild(hash);
    for (let i = 0; i < 8 && i < width; i++) {
      const span = document.createElement("span");
      span.dataset.ch = String(i);
      span.textContent = channelHeadLabel(i);
      heads.appendChild(span);
    }
    const layers = state.song.layers || [];
    for (let i = 0; i < width - 8; i++) heads.appendChild(layerHead(layers[i], i));
    const grid = $("grid");
    grid.innerHTML = "";
    for (let r = 0; r < pat.rows; r++) {
      const rn = document.createElement("div");
      rn.className = "rn";
      rn.dataset.row = r;
      rn.textContent = hex2(r);
      grid.appendChild(rn);
      for (let c = 0; c < width; c++) {
        const cell = pat.data[c][r];
        const el = document.createElement("div");
        el.className = "cell";
        if (c >= 8 && layers[c - 8]?.mute) el.classList.add("muted");
        el.dataset.r = r;
        el.dataset.c = c;
        el.innerHTML = renderCell(cell);
        if (r === state.row && c === state.ch) el.classList.add("sel");
        el.addEventListener("click", () => {
          state.row = r;
          state.ch = c;
          selectCell();
        });
        grid.appendChild(el);
      }
    }
  }

  function layerHead(layer, index) {
    const wrap = document.createElement("div");
    wrap.className = "ch-head" + (layer?.mute ? " muted" : "");
    wrap.dataset.layer = String(index);
    const name = document.createElement("span");
    name.className = "ch-name";
    name.textContent = `CH${9 + index} ${(layer?.name || "FM").toUpperCase()}`;
    const actions = document.createElement("div");
    actions.className = "ch-actions";
    actions.append(
      miniButton(layer?.mute ? "MUTED" : "MUTE", () => toggleLayerMute(index)),
      miniButton("HEAR", () => auditionLayerChannel(index)),
      miniButton("X", () => removeLayer(index)),
    );
    wrap.append(name, actions);
    return wrap;
  }

  function miniButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
      btn.blur();
    });
    return btn;
  }

  function renderCell(cell) {
    let body;
    if (isNoteOff(cell)) {
      body = `<span class="n off">===</span> <span class="s">--</span> <span class="v">--</span>`;
    } else if (!cell?.note && !cell?.sample) {
      body = "--- -- --";
    } else {
      const n = cell.note || "---";
      const s = cell.sample ? hex2(cell.sample) : "--";
      const v = cell.note || cell.sample ? hex2(cell.volume || 64) : "--";
      body = `<span class="n">${n}</span> <span class="s">${s}</span> <span class="v">${v}</span>`;
    }
    if (cell?.effect) body += ` <span class="fx">${cell.effect}:${cell.param || 0}</span>`;
    return body;
  }

  function paintCell(r, c) {
    const el = document.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
    if (el) el.innerHTML = renderCell(state.song.patterns[0].data[c][r]);
  }

  function isLayerChannel(ch) {
    const width = state.song?.patterns?.[0]?.data?.length || 8;
    return ch >= 8 && ch < width;
  }

  function selectCell() {
    document.querySelectorAll(".cell.sel").forEach((el) => el.classList.remove("sel"));
    const el = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    el?.classList.add("sel");
    el?.scrollIntoView({ block: "nearest" });
    syncChannelInstrument();
    paintStrip();
  }

  function putNote(midi) {
    const pat = state.song.patterns[0];
    const cell = pat.data[state.ch][state.row];
    if (isLayerChannel(state.ch)) {
      cell.note = fmtNote(midi);
      cell.sample = 0;
      cell.volume = cell.volume || 64;
      cell.effect = 0;
      cell.param = 0;
      paintCell(state.row, state.ch);
      auditionLayer(state.ch, midi, (cell.volume || 64) / 64, 0);
      state.row = (state.row + 1) % pat.rows;
      selectCell();
      return;
    }
    if (channelFmId(state.ch)) {
      cell.note = fmtNote(midi);
      cell.volume = cell.volume || 64;
      paintCell(state.row, state.ch);
      auditionChannelFm(state.ch, midi, (cell.volume || 64) / 64, 0);
      state.row = (state.row + 1) % pat.rows;
      selectCell();
      return;
    }
    cell.note = fmtNote(midi);
    cell.sample = state.selectedSample || cell.sample || 1;
    cell.volume = cell.volume || 64;
    paintCell(state.row, state.ch);
    const velocity = (cell.volume || 64) / 64;
    if (fmKeysOn()) {
      auditionFm(midi, velocity, 0);
    } else {
      const sample = resolveCatalogSample(cell.sample, state.song, state.samples);
      if (sample) {
        ensureAudio().then(() => decodeSample(sample)).then(() => {
          playCell(cell, state.ctx.currentTime, state.ch, ROLES[state.ch]);
        });
      }
    }
    state.row = (state.row + 1) % pat.rows;
    selectCell();
  }

  function putNoteOff() {
    const pat = state.song.patterns[0];
    const cell = pat.data[state.ch][state.row];
    cell.note = NOTE_OFF;
    cell.volume = 0;
    cell.effect = 0;
    cell.param = 0;
    const fmDrum = !isLayerChannel(state.ch) && channelFmId(state.ch);
    if (!fmDrum) cell.sample = 0;
    paintCell(state.row, state.ch);
    if (isLayerChannel(state.ch)) {
      const voice = state.layerVoices[state.ch]?.voice;
      if (voice && state.ctx) voice.noteOff(state.ctx.currentTime + 0.01);
    } else if (fmDrum) {
      const voice = state.channelFm[state.ch]?.voice;
      if (voice && state.ctx) voice.noteOff(state.ctx.currentTime + 0.01);
    } else {
      if (state.ctx && state.voices?.[state.ch]) {
        state.voices[state.ch].noteOff(state.ctx.currentTime);
      }
      if (fmKeysOn()) noteOffFm();
    }
    state.row = (state.row + 1) % pat.rows;
    selectCell();
  }

  function clearCell() {
    const pat = state.song.patterns[0];
    pat.data[state.ch][state.row] = emptyCell();
    const el = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    if (el) el.innerHTML = renderCell(pat.data[state.ch][state.row]);
  }

  async function compose(local) {
    const prompt = $("prompt").value.trim() || "boom bap hip hop beat";
    $("status").textContent = local ? "loading preset…" : "dolphin composing…";
    $("status").className = "status busy";
    $("btn-compose").disabled = true;
    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          node: $("node").value,
          local: Boolean(local),
        }),
      });
      const song = await res.json();
      if (!res.ok) throw new Error(song.error || "compose failed");
      applySong(song);
      const via = song.llm?.model ? song.llm.model.split(/[\\/]/).pop() : song.llm?.provider;
      $("status").textContent = song.llm?.ok
        ? `composed via ${song.llm.provider} (${via})`
        : `template fallback (${song.llm?.errors?.[0] || "parse"})`;
      $("status").className = song.llm?.ok ? "status ok" : "status";
      await preloadUsed();
    } catch (err) {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    } finally {
      $("btn-compose").disabled = false;
    }
  }

  function onKey(ev) {
    const tag = ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (ev.key === "Enter" && ev.target.id === "prompt") {
        ev.preventDefault();
        compose(false);
      }
      if (ev.key === "Enter" && ev.target.id === "layer-prompt") {
        ev.preventDefault();
        composeLayer();
      }
      return;
    }
    const pat = state.song.patterns[0];
    const width = pat.data.length;
    if (ev.code === "Space") {
      ev.preventDefault();
      state.playing ? stop() : play();
      return;
    }
    if (ev.key === "ArrowDown") { state.row = (state.row + 1) % pat.rows; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowUp") { state.row = (state.row + pat.rows - 1) % pat.rows; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowRight") { state.ch = (state.ch + 1) % width; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowLeft") { state.ch = (state.ch + width - 1) % width; selectCell(); ev.preventDefault(); }
    if (ev.key === "Delete" || ev.key === "Backspace") { clearCell(); ev.preventDefault(); }
    if (ev.code === "Backquote") { putNoteOff(); ev.preventDefault(); return; }
    const k = ev.key.toLowerCase();
    if (k in LOWER) putNote(LOWER[k] + (state.octave + 1) * 12);
    if (k in UPPER) putNote(UPPER[k] + (state.octave + 1) * 12);
    if (ev.key >= "1" && ev.key <= "8") {
      const role = ROLES[Number(ev.key) - 1];
      const id = state.song.kit?.[role];
      if (id) state.selectedSample = id;
      highlightKit();
    }
  }

  function fmKeysOn() {
    return Boolean($("fm-keys")?.checked);
  }

  function makeFmSlider(spec, get, set) {
    const wrap = document.createElement("label");
    wrap.className = "fm-ctl";
    const input = document.createElement("input");
    input.type = "range";
    input.id = `fm-${spec.id}`;
    input.dataset.param = spec.id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.title = spec.id;
    const val = document.createElement("span");
    val.className = "val";
    if (spec.showName !== false) {
      const name = document.createElement("span");
      name.textContent = spec.label;
      wrap.appendChild(name);
    }
    input.addEventListener("input", () => {
      set(Number(input.value));
      val.textContent = fmtSlider(spec.step, Number(input.value));
      state.fm?.setPreset(state.fmPreset);
    });
    wrap.append(input, val);
    wrap._fmGet = get;
    wrap._fmInput = input;
    return wrap;
  }

  function paintFmControls() {
    document.querySelectorAll("#fm-controls .fm-ctl").forEach((wrap) => {
      if (!wrap._fmInput || !wrap._fmGet) return;
      const value = wrap._fmGet();
      wrap._fmInput.value = String(value);
      const step = Number(wrap._fmInput.step) || 0.01;
      wrap.querySelector(".val").textContent = fmtSlider(step, value);
    });
  }

  function setupFmPanel() {
    state.fmPreset = clonePreset(FM_PRESETS[0]);
    const select = $("fm-preset");
    for (const preset of FM_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.name;
      select.appendChild(opt);
    }
    const root = $("fm-controls");
    const globals = document.createElement("div");
    globals.className = "fm-globals";
    for (const spec of FM_GLOBALS) {
      globals.appendChild(makeFmSlider(
        spec,
        () => state.fmPreset[spec.key],
        (value) => { state.fmPreset[spec.key] = value; },
      ));
    }
    const grid = document.createElement("div");
    grid.className = "fm-grid";
    grid.appendChild(document.createElement("div"));
    for (const spec of FM_OP_FIELDS) {
      const head = document.createElement("div");
      head.className = "fm-ctl";
      head.textContent = spec.label;
      grid.appendChild(head);
    }
    for (const [index, name] of [[0, "MOD"], [1, "CAR"]]) {
      const label = document.createElement("div");
      label.className = "fm-op-name";
      label.textContent = name;
      grid.appendChild(label);
      for (const spec of FM_OP_FIELDS) {
        const id = fmParamId(index, spec.suffix);
        grid.appendChild(makeFmSlider(
          { ...spec, id, showName: false },
          () => state.fmPreset.ops[index][spec.key],
          (value) => { state.fmPreset.ops[index][spec.key] = value; },
        ));
      }
    }
    root.append(globals, grid);
    paintFmControls();
    select.addEventListener("change", () => {
      const found = FM_PRESETS.find((preset) => preset.id === select.value) || FM_PRESETS[0];
      state.fmPreset = clonePreset(found);
      paintFmControls();
      state.fm?.setPreset(state.fmPreset);
      $("fm-hint").textContent = found.name;
    });
    $("fm-keys").addEventListener("change", (ev) => {
      if (!ev.target.checked && state.fm && state.ctx) state.fm.cut(state.ctx.currentTime);
      $("fm-hint").textContent = ev.target.checked
        ? "keys play FM · pattern still plays samples"
        : "keys play samples";
      ev.target.blur();
    });
    $("fm-ping").addEventListener("click", () => auditionFm(60, 0.9, 0.7));
  }

  async function ensureFm() {
    await ensureAudio();
    if (!state.fm) {
      state.fm = new FMVoice(state.ctx, state.master);
      state.fm.setPreset(state.fmPreset);
    }
    await state.fm.load();
    return state.fm;
  }

  function auditionFm(midi, velocity, holdOff) {
    const ticket = state.fmTicket;
    ensureFm().then((fm) => {
      if (ticket !== state.fmTicket) return;
      if (!holdOff && !fmKeysOn()) return;
      const t = state.ctx.currentTime + 0.01;
      fm.noteOn(t, midi, velocity);
      if (holdOff > 0) fm.noteOff(t + holdOff);
      $("fm-hint").textContent = holdOff ? "ping C-4" : "fm keys";
    }).catch((err) => {
      $("fm-hint").textContent = String(err.message || err);
    });
  }

  function noteOffFm() {
    const ticket = state.fmTicket;
    ensureFm().then((fm) => {
      if (ticket !== state.fmTicket || !fmKeysOn()) return;
      fm.noteOff(state.ctx.currentTime + 0.01);
    }).catch((err) => {
      $("fm-hint").textContent = String(err.message || err);
    });
  }

  function disposeLayerVoices() {
    const t = state.ctx?.currentTime;
    for (const slot of Object.values(state.layerVoices)) {
      slot.dropped = true;
      if (t != null) slot.voice.cut(t);
      slot.voice.node?.disconnect();
    }
    state.layerVoices = {};
  }

  function dropLayerVoice(ch) {
    const slot = state.layerVoices[ch];
    if (!slot) return;
    slot.dropped = true;
    if (state.ctx) slot.voice.cut(state.ctx.currentTime);
    slot.voice.node?.disconnect();
    delete state.layerVoices[ch];
  }

  async function ensureLayerVoice(ch) {
    const existing = state.layerVoices[ch];
    if (existing?.ready) return existing.ready;
    const layer = state.song.layers?.[ch - 8];
    if (!layer) return null;
    await ensureAudio();
    const inst = (state.song.instruments || []).find((item) => item.id === layer.instrumentId);
    if (!inst) return null;
    const strip = ensureStrip(ch, state.song.channelFx?.[ch]);
    const voice = new FMVoice(state.ctx, strip.input);
    voice.setPreset(resolveSound(inst));
    const slot = { voice, ready: null, dropped: false };
    slot.ready = voice.load().then(() => {
      if (slot.dropped) {
        voice.node?.disconnect();
        return null;
      }
      return slot;
    });
    state.layerVoices[ch] = slot;
    return slot.ready;
  }

  async function ensureLayerVoices() {
    const n = state.song?.layers?.length || 0;
    for (let i = 0; i < n; i++) await ensureLayerVoice(8 + i);
  }

  function hitsFromChannel(ch) {
    const column = state.song?.patterns?.[0]?.data?.[ch] || [];
    return column.map((cell) => (cell?.note && !isNoteOff(cell) ? "x" : ".")).join("").padEnd(16, ".").slice(0, 16);
  }

  function uniqueInstrumentId(base) {
    const ids = new Set((state.song.instruments || []).map((item) => item.id));
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  function appendLayer(layer) {
    const song = state.song;
    song.instruments ||= [];
    song.layers ||= [];
    song.channelFx ||= {};
    const preset = layer.instrument?.preset || "lead";
    const id = uniqueInstrumentId(layer.instrument?.id || `fm-${preset}`);
    const instrument = {
      id,
      type: "fm",
      name: layer.instrument?.name || preset,
      preset,
      patch: layer.instrument?.patch || {},
      sound: layer.instrument?.sound,
    };
    song.instruments.push(instrument);
    song.layers.push({ id, name: instrument.name, instrumentId: id, mute: false });
    const pat = song.patterns[0];
    const rows = pat.rows || 16;
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const src = layer.cells?.[i];
      const note = src?.note ?? null;
      cells.push({
        note,
        sample: 0,
        volume: note && !isNoteOff(src) ? (src.volume || 64) : 0,
        effect: 0,
        param: 0,
      });
    }
    pat.data.push(cells);
    const ch = pat.data.length - 1;
    song.channelFx[ch] = normalizeChannelFx({
      cutoff: Number(layer.channelFx?.cutoff) || 3400,
      resonance: Number(layer.channelFx?.resonance) || 0.7,
      drive: Number(layer.channelFx?.drive) || 0,
      fxWet: Number(layer.channelFx?.fxWet) || 0,
    });
    song.channels = pat.data.length;
    renderGrid();
    ensureLayerVoice(ch).catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
  }

  function toggleLayerMute(index) {
    const layer = state.song.layers?.[index];
    if (!layer) return;
    layer.mute = !layer.mute;
    if (layer.mute && state.ctx) state.layerVoices[8 + index]?.voice.cut(state.ctx.currentTime);
    renderGrid();
  }

  function removeLayer(index) {
    const song = state.song;
    const ch = 8 + index;
    const layer = song.layers?.[index];
    if (!layer || !song.patterns[0].data[ch]) return;
    dropLayerVoice(ch);
    dropStrip(ch);
    song.layers.splice(index, 1);
    song.patterns[0].data.splice(ch, 1);
    if (!song.layers.some((item) => item.instrumentId === layer.instrumentId)) {
      song.instruments = (song.instruments || []).filter((item) => item.id !== layer.instrumentId);
    }
    const nextFx = {};
    for (const [key, fx] of Object.entries(song.channelFx || {})) {
      const n = Number(key);
      if (!Number.isFinite(n) || n === ch) continue;
      nextFx[n < ch ? n : n - 1] = fx;
    }
    song.channelFx = nextFx;
    const nextVoices = {};
    for (const [key, slot] of Object.entries(state.layerVoices)) {
      const n = Number(key);
      if (n < ch) nextVoices[n] = slot;
      else if (n > ch) nextVoices[n - 1] = slot;
    }
    state.layerVoices = nextVoices;
    reindexStrips(ch);
    song.channels = song.patterns[0].data.length;
    if (state.ch >= song.channels) state.ch = song.channels - 1;
    renderGrid();
    selectCell();
  }

  function auditionLayer(ch, midi, velocity, holdOff) {
    const ticket = state.fmTicket;
    ensureLayerVoice(ch).then((slot) => {
      if (!slot || ticket !== state.fmTicket) return;
      const t = state.ctx.currentTime + 0.01;
      slot.voice.noteOn(t, midi, velocity);
      if (holdOff > 0) slot.voice.noteOff(t + holdOff);
    }).catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
  }

  function auditionLayerChannel(index) {
    const ch = 8 + index;
    const column = state.song.patterns[0].data[ch] || [];
    const noteCell = column.find((cell) => cell?.note && !isNoteOff(cell));
    auditionLayer(ch, midiOf(noteCell?.note) ?? 60, 0.8, 0.7);
  }

  function channelHeadLabel(i) {
    const base = `CH${i + 1} ${ROLES[i].toUpperCase()}`;
    const id = channelFmId(i);
    if (!id) return base;
    const inst = (state.song.instruments || []).find((item) => item.id === id);
    if (!inst || inst.type !== "fm") return base;
    return `${base} · ${String(inst.preset || "fm").toUpperCase()}`;
  }

  function syncChannelInstrument() {
    const sel = $("ch-instrument");
    if (!sel || !state.song) return;
    state.instrumentSync = true;
    const ch = state.ch;
    const hint = $("ch-instrument-hint");
    if (ch > 7) {
      sel.value = "";
      sel.disabled = true;
      if (hint) hint.textContent = "layer channel";
    } else {
      sel.disabled = false;
      const id = channelFmId(ch);
      const inst = (state.song.instruments || []).find((item) => item.id === id);
      const preset = inst?.type === "fm" ? (inst.preset || "") : "";
      const known = [...sel.options].some((opt) => opt.value === preset);
      sel.value = known ? preset : "";
      if (hint) {
        const role = (ROLES[ch] || "ch").toUpperCase();
        hint.textContent = preset ? `${role} · ${inst.name || preset}` : `${role} · drum sample`;
      }
    }
    state.instrumentSync = false;
  }

  function dropUnusedBoundInstrument(id) {
    if (!id || !state.song) return;
    const song = state.song;
    const inst = (song.instruments || []).find((item) => item.id === id);
    if (!inst || inst.boundChannel == null) return;
    const used = Object.values(song.channelInstrument || {}).some((item) => item === id)
      || (song.layers || []).some((layer) => layer.instrumentId === id);
    if (used) return;
    song.instruments = song.instruments.filter((item) => item.id !== id);
  }

  function assignChannelFm(ch, presetId) {
    if (ch < 0 || ch > 7 || !state.song) return;
    const song = state.song;
    song.instruments ||= [];
    song.channelInstrument ||= {};
    const prevId = channelFmId(ch);
    if (!presetId) {
      delete song.channelInstrument[ch];
      delete song.channelInstrument[String(ch)];
      dropChannelFm(ch);
      dropUnusedBoundInstrument(prevId);
      renderGrid();
      selectCell();
      return;
    }
    const preset = FM_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    let inst = song.instruments.find((item) =>
      item.type === "fm" && item.preset === presetId && item.boundChannel === ch);
    if (!inst) {
      inst = {
        id: uniqueInstrumentId(`fm-${presetId}-ch${ch + 1}`),
        type: "fm",
        name: preset.name,
        preset: presetId,
        patch: {},
        sound: clonePreset(preset),
        boundChannel: ch,
      };
      song.instruments.push(inst);
    }
    song.channelInstrument[ch] = inst.id;
    if (prevId && prevId !== inst.id) dropUnusedBoundInstrument(prevId);
    dropChannelFm(ch);
    ensureChannelFm(ch).catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
    renderGrid();
    selectCell();
  }

  function dropChannelFm(ch) {
    const slot = state.channelFm[ch];
    if (!slot) return;
    slot.dropped = true;
    if (state.ctx) slot.voice.cut(state.ctx.currentTime);
    slot.voice.node?.disconnect();
    delete state.channelFm[ch];
  }

  function disposeChannelFm() {
    for (const ch of Object.keys(state.channelFm)) dropChannelFm(Number(ch));
    state.channelFm = {};
  }

  async function ensureChannelFm(ch) {
    const id = channelFmId(ch);
    if (!id) return null;
    const existing = state.channelFm[ch];
    if (existing?.ready && existing.instrumentId === id) return existing.ready;
    if (existing) dropChannelFm(ch);
    await ensureAudio();
    const inst = (state.song.instruments || []).find((item) => item.id === id);
    if (!inst) return null;
    const voice = new FMVoice(state.ctx, channelInput(ch));
    voice.setPreset(resolveSound(inst));
    const slot = { voice, instrumentId: id, ready: null, dropped: false };
    slot.ready = voice.load().then(() => {
      if (slot.dropped) {
        voice.node?.disconnect();
        return null;
      }
      return slot;
    });
    state.channelFm[ch] = slot;
    return slot.ready;
  }

  async function ensureChannelFmVoices() {
    for (let ch = 0; ch < 8; ch++) {
      if (channelFmId(ch)) await ensureChannelFm(ch);
    }
  }

  function auditionChannelFm(ch, midi, velocity, holdOff) {
    const ticket = state.fmTicket;
    ensureChannelFm(ch).then((slot) => {
      if (!slot || ticket !== state.fmTicket) return;
      const t = state.ctx.currentTime + 0.01;
      slot.voice.noteOn(t, midi, velocity);
      if (holdOff > 0) slot.voice.noteOff(t + holdOff);
    }).catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
  }

  function setupChannelInstrument() {
    const sel = $("ch-instrument");
    if (!sel) return;
    const drum = document.createElement("option");
    drum.value = "";
    drum.textContent = "drum sample";
    sel.appendChild(drum);
    for (const preset of FM_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.name;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      if (state.instrumentSync) return;
      const presetId = sel.value;
      sel.blur();
      if (state.ch > 7) {
        syncChannelInstrument();
        return;
      }
      assignChannelFm(state.ch, presetId);
    });
    syncChannelInstrument();
  }

  function saveProject() {
    const song = structuredClone(state.song);
    song.version = SONG_VERSION;
    const blob = new Blob([JSON.stringify(song, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const name = String(song.title || "song").replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "song";
    link.href = URL.createObjectURL(blob);
    link.download = `${name}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  function loadProject(song) {
    if (!song || typeof song !== "object" || !Array.isArray(song.patterns?.[0]?.data)) {
      throw new Error("not a tracker project");
    }
    const data = song.patterns[0].data;
    if (data.length < 8) throw new Error("pattern is missing drum channels");
    migrateSong(song, state.samples);
    song.rows = song.patterns[0].rows || data[0]?.length || 16;
    song.channels = data.length;
    while (song.layers.length < data.length - 8) {
      const index = song.layers.length;
      const used = new Set(song.layers.map((layer) => layer.instrumentId));
      let inst = song.instruments.find((item) => item?.type === "fm" && item.boundChannel == null && !used.has(item.id));
      if (!inst) {
        let n = index + 1;
        let id = `fm-lead-${n}`;
        while (song.instruments.some((item) => item.id === id)) {
          n += 1;
          id = `fm-lead-${n}`;
        }
        inst = { id, type: "fm", name: "Lead", preset: "lead", patch: {} };
        song.instruments.push(inst);
      }
      song.layers.push({
        id: inst.id,
        name: inst.name || "Lead",
        instrumentId: inst.id,
        mute: false,
      });
    }
    if (state.playing) stop();
    applySong(song);
    ensureChannelFmVoices().catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
    ensureLayerVoices().catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
  }

  async function composeLayer() {
    const prompt = $("layer-prompt").value.trim();
    if (!prompt) {
      $("status").textContent = "layer prompt required";
      $("status").className = "status err";
      return;
    }
    $("status").textContent = "layer composing…";
    $("status").className = "status busy";
    $("btn-layer").disabled = true;
    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "layer",
          prompt,
          node: $("node").value,
          song: {
            bpm: Number($("bpm").value) || state.song?.bpm || 90,
            kick: hitsFromChannel(0),
            bass: hitsFromChannel(7),
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "layer failed");
      if (!Array.isArray(body.cells) || !body.instrument) throw new Error("layer missing");
      appendLayer(body);
      const via = body.llm?.model ? String(body.llm.model).split(/[\\/]/).pop() : body.llm?.provider;
      $("status").textContent = body.llm?.ok
        ? `layer ${body.instrument.preset} via ${body.llm.provider} (${via})`
        : `layer ${body.instrument.preset} fallback`;
      $("status").className = body.llm?.ok ? "status ok" : "status";
    } catch (err) {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    } finally {
      $("btn-layer").disabled = false;
    }
  }

  const STRIP_SLIDERS = ["cutoff", "resonance", "drive", "fxWet", "delayFeedback", "delayTime", "reverbSend"];

  function applyRowFx(cell, when, ch) {
    const prev = state.song.channelFx?.[ch] || defaultChannelFx();
    const next = applyCellFx(prev, cell.effect, cell.param);
    state.song.channelFx ||= {};
    state.song.channelFx[ch] = next;
    state.strips?.[ch]?.setFx(next, when, currentBpm(), false);
    if (ch === state.ch) paintStrip();
  }

  function paintStrip() {
    const type = $("filterType");
    if (!type || !state.song) return;
    state.fxSync = true;
    const ch = state.ch;
    const fx = normalizeChannelFx(state.song.channelFx?.[ch]);
    const label = $("fx-channel");
    if (label) label.textContent = `CH${ch + 1}`;
    type.value = fx.filterType === "highpass" ? "highpass" : "lowpass";
    for (const id of STRIP_SLIDERS) {
      const el = $(id);
      if (el) el.value = String(fx[id]);
    }
    const cell = state.song.patterns?.[0]?.data?.[ch]?.[state.row];
    const effect = $("cell-effect");
    const param = $("cell-param");
    if (effect) effect.value = String(cell?.effect || 0);
    if (param) param.value = String(cell?.param || 0);
    state.fxSync = false;
  }

  function writeStripParam(key, value) {
    if (!state.song) return;
    const ch = state.ch;
    state.song.channelFx ||= {};
    const fx = normalizeChannelFx(state.song.channelFx[ch]);
    if (key === "filterType") fx.filterType = value === "highpass" ? "highpass" : "lowpass";
    else fx[key] = Number(value);
    const next = normalizeChannelFx(fx);
    state.song.channelFx[ch] = next;
    ensureAudio().then(() => {
      ensureStrip(ch, next).setFx(next, state.ctx.currentTime, currentBpm(), false);
    }).catch((err) => {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    });
  }

  function writeCellCommand() {
    if (state.fxSync || !state.song) return;
    const cell = state.song.patterns?.[0]?.data?.[state.ch]?.[state.row];
    if (!cell) return;
    cell.effect = Math.min(8, Math.max(0, Math.round(Number($("cell-effect").value) || 0)));
    cell.param = Math.min(255, Math.max(0, Math.round(Number($("cell-param").value) || 0)));
    paintCell(state.row, state.ch);
  }

  function setupStrip() {
    for (const id of STRIP_SLIDERS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("input", () => {
        if (state.fxSync) return;
        writeStripParam(id, el.value);
      });
      el.addEventListener("change", () => el.blur());
    }
    $("filterType")?.addEventListener("change", () => {
      if (state.fxSync) return;
      writeStripParam("filterType", $("filterType").value);
      $("filterType").blur();
    });
    for (const id of ["cell-effect", "cell-param"]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("input", writeCellCommand);
      el.addEventListener("change", () => {
        writeCellCommand();
        el.blur();
      });
    }
    paintStrip();
  }

  function refreshDelayTimes() {
    if (!state.ctx || !state.strips) return;
    const t = state.ctx.currentTime;
    const bpm = currentBpm();
    for (const [key, strip] of Object.entries(state.strips)) {
      const fx = state.song?.channelFx?.[key] || defaultChannelFx();
      strip.setDelayTime(fx.delayTime, t, bpm, false);
    }
  }

  async function boot() {
    applySong(defaultSong());
    setupFmPanel();
    setupChannelInstrument();
    setupStrip();
    $("btn-play").addEventListener("click", play);
    $("btn-stop").addEventListener("click", stop);
    $("btn-compose").addEventListener("click", () => compose(false));
    $("btn-preset").addEventListener("click", () => compose(true));
    $("btn-layer").addEventListener("click", () => composeLayer());
    $("btn-save").addEventListener("click", saveProject);
    $("btn-load").addEventListener("click", () => $("project-file").click());
    $("project-file").addEventListener("change", () => {
      const file = $("project-file").files?.[0];
      $("project-file").value = "";
      if (!file) return;
      file.text().then((text) => {
        loadProject(JSON.parse(text));
        $("status").textContent = `loaded ${state.song.title || "project"}`;
        $("status").className = "status ok";
      }).catch((err) => {
        $("status").textContent = String(err.message || err);
        $("status").className = "status err";
      });
    });
    $("master").addEventListener("input", () => {
      if (!state.master || !state.ctx) return;
      // Exponential approach from the value already playing. Time constant
      // 5 ms, so a slider move settles inside the click-free window.
      state.master.gain.setTargetAtTime(Number($("master").value) / 100, state.ctx.currentTime, 0.005);
    });
    $("bpm").addEventListener("change", () => {
      if (state.song) state.song.bpm = Number($("bpm").value) || 90;
      refreshDelayTimes();
    });
    window.addEventListener("keydown", onKey);

    try {
      const [samplesRes, healthRes] = await Promise.all([
        fetch("/api/samples"),
        fetch("/api/health"),
      ]);
      const samples = await samplesRes.json();
      const health = await healthRes.json();
      state.samples = samples.samples || [];
      state.byId = new Map(state.samples.map((s) => [s.id, s]));
      if (state.song) migrateSong(state.song, state.samples);
      renderSamples();
      const dol = health.nodes?.find((n) => n.name === "dolphin");
      $("status").textContent = dol?.ok
        ? `dolphin ready · ${state.samples.length} samples`
        : `dolphin offline · ${dol?.error || "check 10.1.1.122:8082"}`;
      $("status").className = dol?.ok ? "status ok" : "status err";
      $("prompt").value = "dusty boom bap hip hop at 90bpm, punchy kick, snappy snare";
      await compose(true);
    } catch (err) {
      $("status").textContent = String(err.message || err);
      $("status").className = "status err";
    }
  }

  boot();
})();
