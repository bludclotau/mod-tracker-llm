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
    hatGain: null,
    nextTime: 0,
    playRow: 0,
    timer: 0,
    octave: 4,
    selectedSample: 1,
  };

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

  function stopVoice(ch) {
    const v = state.voices?.[ch];
    if (!v) return;
    try {
      v.gain.gain.cancelScheduledValues(state.ctx.currentTime);
      v.gain.gain.setTargetAtTime(0, state.ctx.currentTime, 0.01);
      v.src.stop(state.ctx.currentTime + 0.05);
    } catch { /* already stopped */ }
    state.voices[ch] = null;
  }

  async function trigger(cell, when, ch, role) {
    if (!cell?.sample || !cell.note) return;
    const sample = state.byId.get(cell.sample);
    if (!sample) return;
    const buf = state.buffers.get(sample.id);
    if (!buf) return;
    const ctx = state.ctx;
    if (sample.muteGroup === "hats") {
      stopVoice(ROLES.indexOf("hat"));
      stopVoice(ROLES.indexOf("openhat"));
    } else {
      stopVoice(ch);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const midi = midiOf(cell.note) ?? (role === "bass" ? 24 : 60);
    src.playbackRate.value = 2 ** ((midi - 60) / 12);
    const gain = ctx.createGain();
    const vol = (cell.volume || 64) / 64;
    gain.gain.setValueAtTime(vol, when);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (ch - 3.5) / 8;
    src.connect(gain).connect(pan).connect(state.master);
    src.start(when);
    state.voices = state.voices || Array(8).fill(null);
    state.voices[ch] = { src, gain };
    src.onended = () => {
      if (state.voices?.[ch]?.src === src) state.voices[ch] = null;
    };
  }

  function schedule() {
    if (!state.playing || !state.ctx) return;
    const ahead = 0.12;
    const pat = state.song.patterns[0];
    while (state.nextTime < state.ctx.currentTime + ahead) {
      const row = state.playRow;
      for (let ch = 0; ch < 8; ch++) {
        trigger(pat.data[ch][row], state.nextTime, ch, ROLES[ch]);
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
    if (state.voices) state.voices.forEach((_, i) => stopVoice(i));
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
    stopVoice(7);
    const src = state.ctx.createBufferSource();
    src.buffer = buf;
    const gain = state.ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(state.master);
    src.start();
    state.voices = state.voices || Array(8).fill(null);
    state.voices[7] = { src, gain };
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
    const sample = state.byId.get(cell.sample);
    if (sample) {
      ensureAudio().then(() => decodeSample(sample)).then(() => {
        trigger(cell, state.ctx.currentTime, state.ch, ROLES[state.ch]);
      });
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

  async function boot() {
    applySong(defaultSong());
    $("btn-play").addEventListener("click", play);
    $("btn-stop").addEventListener("click", stop);
    $("btn-compose").addEventListener("click", () => compose(false));
    $("btn-preset").addEventListener("click", () => compose(true));
    $("master").addEventListener("input", () => {
      if (state.master) state.master.gain.value = Number($("master").value) / 100;
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
