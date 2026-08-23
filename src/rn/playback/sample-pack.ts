/**
 * FluidR3 sample packs: locating them, reading them, and choosing which sample
 * plays a given note.
 *
 * All pure. The audio nodes are `sample-engine.ts`'s problem; everything here
 * is string and number work, which is what makes the part of this engine most
 * likely to be subtly wrong — pitch selection — testable without a device.
 *
 * The packs are Benjamin Gleitzman's pre-renderings of **FluidR3_GM.sf2**, the
 * same font the web engine plays as `FluidR3Mono_GM.sf3`. That is the whole
 * reason for choosing this route over synthesising something: React Native
 * plays the same recordings the browser does, rather than an approximation of
 * them.
 *
 * Each pack is a MIDI.js-era JavaScript file assigning an object of note name
 * to base64 mp3 data URI:
 *
 *     MIDI.Soundfont.violin = { "A0": "data:audio/mp3;base64,...", ... }
 *
 * It is parsed rather than evaluated. Running fetched JavaScript to read a
 * lookup table would be an arbitrary-code-execution hole for a data file.
 */

const DEFAULT_BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';

/** Semitone offset of each pitch class from C. */
const PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export type SamplePack = {
  instrument: string;
  /** MIDI note number -> base64 `data:audio/mp3` URI. Sparse: ~52 of 88 keys. */
  samples: Map<number, string>;
};

export type SampleChoice = {
  /** The sampled note actually played. */
  midi: number;
  uri: string;
  /** How far to bend it to reach the requested note. 100 cents per semitone. */
  detuneCents: number;
};

/**
 * Where a GM instrument's pack lives. `base` lets an app self-host rather than
 * depend on a third-party CDN at runtime — the packs are CC-BY 3.0, so copying
 * them is allowed, and a music app that stops working when someone else's
 * GitHub Pages does is not a good trade.
 */
export function sampleUrlFor(instrument: string, base: string = DEFAULT_BASE): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}${instrument}-mp3.js`;
}

/** `"F#4"` / `"Bb3"` / `"A0"` -> MIDI number, or null if it is not a note name. */
export function noteNameToMidi(name: string): number | null {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
  if (!match) return null;
  const [, letter, accidental, octave] = match;
  const base = PITCH_CLASS[letter!.toUpperCase()];
  if (base === undefined) return null;
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  // MIDI 60 is C4, so C-1 is 0 — hence the +1 on the octave.
  return (Number(octave) + 1) * 12 + base + shift;
}

/**
 * Reads a pack body. Throws rather than returning an empty pack: a 404 page
 * parses to zero samples, and an instrument with no samples is silent playback
 * with nothing reporting a problem.
 */
export function parseSamplePack(body: string): SamplePack {
  const header = /MIDI\.Soundfont\.([A-Za-z0-9_]+)\s*=/.exec(body);
  if (!header) {
    throw new Error('Response is not a MIDI.js sample pack: no `MIDI.Soundfont.<instrument> =` found.');
  }

  const samples = new Map<number, string>();
  const entry = /"([A-Ga-g][#b]?-?\d+)"\s*:\s*"(data:audio\/[^"]+)"/g;
  for (const [, name, uri] of body.matchAll(entry)) {
    const midi = noteNameToMidi(name!);
    if (midi !== null) samples.set(midi, uri!);
  }

  if (samples.size === 0) {
    throw new Error('Response is not a MIDI.js sample pack: no note entries found.');
  }
  return { instrument: header[1]!, samples };
}

/**
 * The sample to play `midi` with, and how far to bend it.
 *
 * Closest sample in either direction, not the greatest one at or below. The
 * obvious downward-only rule stretches a sample by up to an octave near the top
 * of each zone, which on a sustained note is plainly audible; picking the
 * nearest halves the worst-case bend. Packs cover roughly every third key, so
 * the usual bend is one or two semitones.
 */
export function nearestSample(pack: SamplePack, midi: number): SampleChoice | null {
  let best: number | null = null;
  for (const sampled of pack.samples.keys()) {
    if (best === null || Math.abs(sampled - midi) < Math.abs(best - midi)) best = sampled;
  }
  if (best === null) return null;
  return { midi: best, uri: pack.samples.get(best)!, detuneCents: (midi - best) * 100 };
}

/**
 * The sample for `midi` **only if the pack has that exact note**, never bent.
 *
 * For percussion. In a drum pack a note number names a *different instrument*,
 * not a different pitch — 38 is a snare and 42 a closed hi-hat — so
 * `nearestSample`'s whole premise is wrong here: reaching for the closest one
 * would answer a missing cowbell with a detuned tom, confidently. A kit that
 * does not define a slot must play nothing, which is what a real drum machine
 * does too.
 */
export function exactSample(pack: SamplePack, midi: number): SampleChoice | null {
  const uri = pack.samples.get(midi);
  return uri ? { midi, uri, detuneCents: 0 } : null;
}
