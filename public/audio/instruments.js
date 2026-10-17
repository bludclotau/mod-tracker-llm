/**
 * Song instrument table. Pure module: no DOM, no Web Audio.
 *
 * cell.sample stays the drum reference (the catalog id at the time the cell
 * was written). A sample instrument records that file so a later WAV reorder
 * still resolves. FM instruments use string ids, so they do not collide with
 * catalog numbers. song.channelInstrument[channel] is an FM id, or absent
 * when that drum channel plays its kit sample.
 */

export const SONG_VERSION = 2;

export function defaultChannelFx() {
  return {
    filterType: "lowpass",
    cutoff: 18000,
    resonance: 0.707,
    drive: 0,
    fxWet: 0,
    delayFeedback: 0.35,
    delayTime: 2,
    reverbSend: 0,
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Fill missing strip keys. A value the caller set, including 0, stays. */
export function normalizeChannelFx(fx) {
  const base = defaultChannelFx();
  const src = fx && typeof fx === "object" ? fx : {};
  const out = { ...base };
  if (src.filterType != null && src.filterType !== "") {
    out.filterType = src.filterType === "highpass" ? "highpass" : "lowpass";
  }
  if (src.cutoff != null && src.cutoff !== "") out.cutoff = clamp(src.cutoff, 20, 20000, base.cutoff);
  if (src.resonance != null && src.resonance !== "") out.resonance = clamp(src.resonance, 0.0001, 40, base.resonance);
  if (src.drive != null && src.drive !== "") out.drive = clamp(src.drive, 0, 1, base.drive);
  if (src.fxWet != null && src.fxWet !== "") out.fxWet = clamp(src.fxWet, 0, 1, base.fxWet);
  if (src.delayFeedback != null && src.delayFeedback !== "") {
    out.delayFeedback = clamp(src.delayFeedback, 0, 0.85, base.delayFeedback);
  }
  if (src.delayTime != null && src.delayTime !== "") {
    out.delayTime = clamp(Math.round(Number(src.delayTime)), 1, 16, base.delayTime);
  }
  if (src.reverbSend != null && src.reverbSend !== "") out.reverbSend = clamp(src.reverbSend, 0, 1, base.reverbSend);
  return out;
}

function catalogList(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.samples)) return catalog.samples;
  return [];
}

function addSampleId(ids, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return;
  ids.add(n);
}

function collectSampleIds(song) {
  const ids = new Set();
  if (song.kit && typeof song.kit === "object") {
    for (const id of Object.values(song.kit)) addSampleId(ids, id);
  }
  for (const pat of song.patterns || []) {
    for (const column of pat?.data || []) {
      for (const cell of column || []) addSampleId(ids, cell?.sample);
    }
  }
  return ids;
}

/**
 * Record sample files for every kit id and cell.sample the catalog knows.
 * An empty catalog adds nothing and does not bump a missing version past 1.
 * Existing instruments are kept. Files and sample ids are not duplicated.
 */
export function migrateSong(song, catalog) {
  if (!song || typeof song !== "object") return song;
  if (!Array.isArray(song.instruments)) song.instruments = [];
  if (!Array.isArray(song.layers)) song.layers = [];
  if (!song.channelFx || typeof song.channelFx !== "object" || Array.isArray(song.channelFx)) {
    song.channelFx = {};
  }
  if (!song.channelInstrument || typeof song.channelInstrument !== "object" || Array.isArray(song.channelInstrument)) {
    song.channelInstrument = {};
  }

  const list = catalogList(catalog);
  const byId = new Map();
  for (const sample of list) {
    if (sample?.id == null) continue;
    byId.set(sample.id, sample);
    byId.set(Number(sample.id), sample);
    byId.set(String(sample.id), sample);
  }

  const haveFile = new Set();
  const haveId = new Set();
  for (const item of song.instruments) {
    if (item?.type !== "sample") continue;
    if (item.file) haveFile.add(item.file);
    if (item.id != null) haveId.add(String(item.id));
  }

  if (list.length) {
    for (const id of collectSampleIds(song)) {
      const entry = byId.get(id);
      if (!entry?.file) continue;
      if (haveFile.has(entry.file) || haveId.has(String(entry.id))) continue;
      song.instruments.push({
        id: entry.id,
        type: "sample",
        file: entry.file,
        name: entry.name || entry.file,
        role: entry.role || null,
      });
      haveFile.add(entry.file);
      haveId.add(String(entry.id));
    }
    const prev = Number(song.version) || 0;
    song.version = Math.max(prev, SONG_VERSION);
  } else if (song.version == null) {
    song.version = 1;
  }

  for (const key of Object.keys(song.channelFx)) {
    song.channelFx[key] = normalizeChannelFx(song.channelFx[key]);
  }
  return song;
}

function sameId(a, b) {
  return a === b || String(a) === String(b);
}

/**
 * Prefer the sample instrument's file, then the catalog id.
 * cell.sample itself is not rewritten.
 */
export function resolveCatalogSample(cellSample, song, catalog) {
  const n = Number(cellSample);
  if (!Number.isFinite(n) || n <= 0) return null;
  const list = catalogList(catalog);
  const inst = (song?.instruments || []).find((item) => item?.type === "sample" && sameId(item.id, n));
  if (inst?.file) {
    const byFile = list.find((sample) => sample?.file === inst.file);
    if (byFile) return byFile;
  }
  return list.find((sample) => sameId(sample?.id, n)) || null;
}
