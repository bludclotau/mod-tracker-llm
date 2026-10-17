import { NOTE_OFF, SampleVoice, isNoteOff } from "./audio/voice.js";
import { FMVoice } from "./audio/fm-voice.js";
import { FM_PRESETS, clonePreset } from "./audio/fm-presets.js";

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

  function secondsPerRow() {
    const bpm = Number($("bpm").value) || state.song?.bpm || 90;
    return 15 / bpm;
  }

  async function ensureAudio() {
    if (state.ctx) {
      if (state.ctx.state === "suspended") await state.ctx.resume();
      return state.ctx;
    }
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = Number($("master").value) / 100;
    master.connect(ctx.destination);
    state.ctx = ctx;
    state.master = master;
    state.voices = Array.from({ length: 8 }, () => new SampleVoice(ctx, master));
    return ctx;
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
    const sample = state.byId.get(cell.sample);
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

  function schedule() {
    if (!state.playing || !state.ctx) return;
    const ahead = 0.12;
    const pat = state.song.patterns[0];
    while (state.nextTime < state.ctx.currentTime + ahead) {
      const row = state.playRow;
      for (let ch = 0; ch < 8; ch++) {
        playCell(pat.data[ch][row], state.nextTime, ch, ROLES[ch]);
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
    rowEl?.scrollIntoView({ block: "nearest" });
  }

  async function play() {
    await ensureAudio();
    await preloadUsed();
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
    }
    $("status").textContent = "stopped";
    $("status").className = "status";
  }

  async function preloadUsed() {
    const ids = new Set();
    const pat = state.song.patterns[0];
    for (const ch of pat.data) for (const cell of ch) if (cell.sample) ids.add(cell.sample);
    await Promise.all([...ids].map((id) => {
      const s = state.byId.get(id);
      return s ? decodeSample(s) : null;
    }));
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
    state.song = song;
    $("song-title").textContent = song.title || "Untitled";
    $("bpm").value = song.bpm || 90;
    const meta = song.llm
      ? `${song.llm.provider || ""} ${song.llm.ok === false ? "(template fallback)" : ""}`.trim()
      : "";
    $("llm-meta").textContent = meta;
    renderGrid();
    highlightKit();
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

  function renderGrid() {
    const pat = state.song.patterns[0];
    const heads = $("channel-heads");
    heads.innerHTML = "<span>#</span>" + ROLES.map((r, i) =>
      `<span>CH${i + 1} ${r.toUpperCase()}</span>`).join("");
    const grid = $("grid");
    grid.innerHTML = "";
    for (let r = 0; r < pat.rows; r++) {
      const rn = document.createElement("div");
      rn.className = "rn";
      rn.dataset.row = r;
      rn.textContent = hex2(r);
      grid.appendChild(rn);
      for (let c = 0; c < 8; c++) {
        const cell = pat.data[c][r];
        const el = document.createElement("div");
        el.className = "cell";
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

  function renderCell(cell) {
    if (isNoteOff(cell)) {
      return `<span class="n off">===</span> <span class="s">--</span> <span class="v">--</span>`;
    }
    if (!cell?.note && !cell?.sample) return "--- -- --";
    const n = cell.note || "---";
    const s = cell.sample ? hex2(cell.sample) : "--";
    const v = cell.sample ? hex2(cell.volume || 64) : "--";
    return `<span class="n">${n}</span> <span class="s">${s}</span> <span class="v">${v}</span>`;
  }

  function selectCell() {
    document.querySelectorAll(".cell.sel").forEach((el) => el.classList.remove("sel"));
    const el = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    el?.classList.add("sel");
    el?.scrollIntoView({ block: "nearest" });
  }

  function putNote(midi) {
    const pat = state.song.patterns[0];
    const cell = pat.data[state.ch][state.row];
    cell.note = fmtNote(midi);
    cell.sample = state.selectedSample || cell.sample || 1;
    cell.volume = cell.volume || 64;
    const el = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    if (el) el.innerHTML = renderCell(cell);
    const velocity = (cell.volume || 64) / 64;
    if (fmKeysOn()) {
      auditionFm(midi, velocity, 0);
    } else {
      const sample = state.byId.get(cell.sample);
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
    cell.sample = 0;
    cell.volume = 0;
    cell.effect = 0;
    cell.param = 0;
    const el = document.querySelector(`.cell[data-r="${state.row}"][data-c="${state.ch}"]`);
    if (el) el.innerHTML = renderCell(cell);
    if (state.ctx && state.voices?.[state.ch]) {
      state.voices[state.ch].noteOff(state.ctx.currentTime);
    }
    if (fmKeysOn()) noteOffFm();
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
      return;
    }
    const pat = state.song.patterns[0];
    if (ev.code === "Space") {
      ev.preventDefault();
      state.playing ? stop() : play();
      return;
    }
    if (ev.key === "ArrowDown") { state.row = (state.row + 1) % pat.rows; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowUp") { state.row = (state.row + pat.rows - 1) % pat.rows; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowRight") { state.ch = (state.ch + 1) % 8; selectCell(); ev.preventDefault(); }
    if (ev.key === "ArrowLeft") { state.ch = (state.ch + 7) % 8; selectCell(); ev.preventDefault(); }
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

  async function boot() {
    applySong(defaultSong());
    setupFmPanel();
    $("btn-play").addEventListener("click", play);
    $("btn-stop").addEventListener("click", stop);
    $("btn-compose").addEventListener("click", () => compose(false));
    $("btn-preset").addEventListener("click", () => compose(true));
    $("master").addEventListener("input", () => {
      if (!state.master || !state.ctx) return;
      // Exponential approach from the value already playing. Time constant
      // 5 ms, so a slider move settles inside the click-free window.
      state.master.gain.setTargetAtTime(Number($("master").value) / 100, state.ctx.currentTime, 0.005);
    });
    $("bpm").addEventListener("change", () => {
      if (state.song) state.song.bpm = Number($("bpm").value) || 90;
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
