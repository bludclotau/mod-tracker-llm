#!/usr/bin/env node
/**
 * Instrument table checks. No server, no browser.
 *
 *   node scripts/verify-instruments.mjs
 *
 * Old songs have no version and no instruments. Migration records the file
 * for each catalog id the pattern uses, leaves cell.sample alone, and
 * resolves that file after the WAV order changes.
 */
import {
  SONG_VERSION,
  applyCellFx,
  defaultChannelFx,
  migrateSong,
  normalizeChannelFx,
  resolveCatalogSample,
} from "../public/audio/instruments.js";
import { delaySeconds } from "../public/audio/dsp-strip.js";

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", msg);
  } else {
    console.log("ok", msg);
  }
}

const catalog = [
  { id: 1, file: "kicks/kick.wav", name: "kick", role: "kick" },
  { id: 2, file: "snares/snare.wav", name: "snare", role: "snare" },
  { id: 7, file: "808s/808.wav", name: "808", role: "bass" },
];

function bareSong() {
  return {
    title: "Old",
    bpm: 90,
    kit: { kick: 1, snare: 2, bass: 7 },
    patterns: [{
      rows: 2,
      data: [
        [
          { note: "C-4", sample: 1, volume: 64, effect: 0, param: 0 },
          { note: null, sample: 0, volume: 0, effect: 0, param: 0 },
        ],
        [
          { note: "C-4", sample: 2, volume: 64, effect: 0, param: 0 },
          { note: "C-4", sample: 2, volume: 64, effect: 0, param: 0 },
        ],
        [
          { note: "C-1", sample: 7, volume: 64, effect: 0, param: 0 },
          { note: null, sample: 0, volume: 0, effect: 0, param: 0 },
        ],
      ],
    }],
  };
}

const empty = bareSong();
migrateSong(empty, []);
assert(empty.instruments.length === 0, "empty catalog invents nothing");
assert(empty.version === 1, "missing version stays 1 without a catalog");
assert(Array.isArray(empty.layers) && empty.channelInstrument && empty.channelFx, "tables exist");
assert(empty.patterns[0].data[0][0].sample === 1, "cell.sample unchanged without a catalog");

const song = bareSong();
song.instruments = [{ id: "fm-lead", type: "fm", preset: "lead", name: "Lead" }];
song.channelFx = { 8: { cutoff: 3400, resonance: 1.2, drive: 0, fxWet: 0 } };
migrateSong(song, catalog);
assert(song.version === SONG_VERSION, "catalog bumps version to 2");
assert(song.instruments[0].id === "fm-lead", "fm instrument stays");
const samples = song.instruments.filter((item) => item.type === "sample");
assert(samples.length === 3, "one sample instrument per file");
assert(samples.every((item) => item.file && item.id), "sample instruments carry file and id");
assert(song.patterns[0].data[2][0].sample === 7, "bass cell.sample stays 7");
assert(song.channelFx[8].cutoff === 3400, "layer cutoff kept");
assert(song.channelFx[8].resonance === 1.2, "layer resonance kept");
assert(song.channelFx[8].drive === 0 && song.channelFx[8].fxWet === 0, "explicit zeros kept");
assert(song.channelFx[8].delayTime === defaultChannelFx().delayTime, "missing delay time filled");
assert(song.channelFx[8].filterType === "lowpass", "missing filter type filled");

migrateSong(song, catalog);
assert(song.instruments.filter((item) => item.type === "sample").length === 3, "second migrate does not duplicate");

const swapped = [
  { id: 1, file: "snares/snare.wav", name: "snare", role: "snare" },
  { id: 2, file: "kicks/kick.wav", name: "kick", role: "kick" },
  { id: 9, file: "808s/808.wav", name: "808", role: "bass" },
];
const kick = resolveCatalogSample(1, song, swapped);
assert(kick?.file === "kicks/kick.wav" && kick.id === 2, "file wins over a recycled catalog id");
const bass = resolveCatalogSample(7, song, swapped);
assert(bass?.id === 9 && bass.file === "808s/808.wav", "bass file remaps");
assert(resolveCatalogSample(1, song, catalog)?.id === 1, "original catalog id still matches");
assert(resolveCatalogSample(0, song, catalog) == null, "sample 0 resolves to nothing");
assert(song.patterns[0].data[0][0].sample === 1, "remap does not rewrite the cell");

const kept = { version: 2, instruments: [{ id: "fm-bass-ch8", type: "fm", preset: "bass" }] };
migrateSong(kept, []);
assert(kept.version === 2, "version 2 survives an empty catalog");
assert(kept.instruments.length === 1, "fm assignment survives an empty catalog");

const partial = normalizeChannelFx({ cutoff: 180, resonance: 12 });
assert(partial.cutoff === 180 && partial.resonance === 12, "normalize keeps caller values");
assert(partial.reverbSend === 0 && partial.delayFeedback === 0.35, "normalize fills the rest");

const held = applyCellFx({ cutoff: 3400, resonance: 1.2, drive: 0, fxWet: 0 }, 0, 255);
assert(held.cutoff === 3400 && held.drive === 0, "effect 0 does not move the strip");
const low = applyCellFx(held, 1, 0);
const high = applyCellFx(held, 1, 255);
assert(low.cutoff === 80, "cutoff command floor is 80 Hz");
assert(Math.abs(high.cutoff - 18000) < 1e-6, "cutoff command ceiling is 18000 Hz");
assert(applyCellFx(held, 2, 0).resonance === 0.5, "resonance floor");
assert(applyCellFx(held, 2, 255).resonance === 18, "resonance ceiling");
assert(applyCellFx(held, 5, 255).delayFeedback === 0.85, "delay feedback cap");
assert(applyCellFx(held, 6, 0).delayTime === defaultChannelFx().delayTime, "delay row 0 is ignored");
assert(applyCellFx(held, 6, 4).delayTime === 4, "delay time is a row count");
assert(applyCellFx(held, 6, 40).delayTime === defaultChannelFx().delayTime, "delay row above 16 is ignored");
assert(applyCellFx(held, 8, 0).filterType === "lowpass", "filter 0 is lowpass");
assert(applyCellFx(held, 8, 1).filterType === "highpass", "filter 1 is highpass");
assert(Math.abs(delaySeconds(2, 90) - 2 * (15 / 90)) < 1e-9, "two rows at 90 bpm");
assert(delaySeconds(16, 60) === 1.9, "delay clamps to 1.9 s");

if (failed) {
  console.error(`verify-instruments ${failed} failed`);
  process.exit(1);
}
console.log("verify-instruments ok");
