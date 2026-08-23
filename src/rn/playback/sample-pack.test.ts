import { describe, expect, it } from 'vitest';
import { exactSample, nearestSample, parseSamplePack, sampleUrlFor, type SamplePack } from './sample-pack.js';

/** The shape gleitz/midi-js-soundfonts actually serves, trimmed to three notes. */
const PACK_JS = `
if (typeof(MIDI) === 'undefined') var MIDI = {};
if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
MIDI.Soundfont.violin = {
"A0": "data:audio/mp3;base64,AAAA",
"C4": "data:audio/mp3;base64,BBBB",
"F#4": "data:audio/mp3;base64,CCCC"
}
`;

describe('parseSamplePack', () => {
  it('reads note names and their data URIs out of the MIDI.js wrapper', () => {
    const pack = parseSamplePack(PACK_JS);

    expect(pack.instrument).toBe('violin');
    expect(pack.samples.size).toBe(3);
    expect(pack.samples.get(21)).toBe('data:audio/mp3;base64,AAAA'); // A0
    expect(pack.samples.get(60)).toBe('data:audio/mp3;base64,BBBB'); // C4
  });

  it('resolves sharps, which is half the note names in every pack', () => {
    // F#4 is 66. Getting this wrong detunes an entire pack by a semitone in
    // the places it matters most — the black keys.
    expect(parseSamplePack(PACK_JS).samples.get(66)).toBe('data:audio/mp3;base64,CCCC');
  });

  it('throws on a body that is not a pack rather than yielding an empty instrument', () => {
    // An empty pack loads an instrument that plays nothing: silent playback
    // with no error anywhere, which is the failure this engine exists to stop.
    expect(() => parseSamplePack('<!doctype html><title>404</title>')).toThrow(/not a MIDI\.js sample pack/i);
  });
});

describe('nearestSample', () => {
  const pack: SamplePack = {
    instrument: 'violin',
    samples: new Map([
      [60, 'c4'],
      [72, 'c5'],
    ]),
  };

  it('plays a sampled note at its own pitch, with no detune', () => {
    expect(nearestSample(pack, 60)).toEqual({ midi: 60, uri: 'c4', detuneCents: 0 });
  });

  it('reaches an unsampled note by detuning the closest sample', () => {
    // 62 is two semitones above the C4 sample: 200 cents up, not a new sample.
    expect(nearestSample(pack, 62)).toEqual({ midi: 60, uri: 'c4', detuneCents: 200 });
  });

  it('detunes downward when the closest sample is above', () => {
    expect(nearestSample(pack, 70)).toEqual({ midi: 72, uri: 'c5', detuneCents: -200 });
  });

  it('picks the genuinely closest sample, not the first one under', () => {
    // 67 is 7 semitones over C4 and 5 under C5. Choosing by "greatest sample
    // at or below" — the obvious implementation — stretches a sample nearly an
    // octave and sounds visibly wrong on sustained notes.
    expect(nearestSample(pack, 67)!.midi).toBe(72);
  });

  it('clamps past the ends of the pack rather than failing', () => {
    expect(nearestSample(pack, 21)!.midi).toBe(60);
    expect(nearestSample(pack, 108)!.midi).toBe(72);
  });

  it('returns null for an empty pack instead of guessing', () => {
    expect(nearestSample({ instrument: 'x', samples: new Map() }, 60)).toBeNull();
  });
});

describe('sampleUrlFor', () => {
  it('builds the CDN url from a GM program name', () => {
    expect(sampleUrlFor('acoustic_grand_piano')).toBe(
      'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
    );
  });

  it('honours a self-hosted base, because an app may not want a third-party CDN at runtime', () => {
    expect(sampleUrlFor('violin', 'https://cdn.example.com/fluid/')).toBe(
      'https://cdn.example.com/fluid/violin-mp3.js',
    );
  });

  it('tolerates a base without a trailing slash', () => {
    expect(sampleUrlFor('violin', 'https://cdn.example.com/fluid')).toBe(
      'https://cdn.example.com/fluid/violin-mp3.js',
    );
  });
});

describe('exactSample', () => {
  const kit: SamplePack = {
    instrument: 'percussion_0',
    samples: new Map([
      [38, 'snare'],
      [42, 'closed-hat'],
    ]),
  };

  it('plays the drum at that slot, never bent', () => {
    expect(exactSample(kit, 38)).toEqual({ midi: 38, uri: 'snare', detuneCents: 0 });
  });

  it('plays nothing for a slot the kit does not define', () => {
    // A note number names a *different instrument* in a drum pack, so the
    // nearest one is not a worse version of the right answer — it is the wrong
    // drum. TR-808 genuinely leaves three GM slots empty; those must be silent.
    expect(exactSample(kit, 56)).toBeNull();
    // Which is exactly where nearestSample would confidently be wrong:
    expect(nearestSample(kit, 56)!.uri).toBe('closed-hat');
  });
});
