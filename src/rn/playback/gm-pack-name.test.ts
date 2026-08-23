import { describe, expect, it } from 'vitest';
import { GM_INSTRUMENTS } from '@sudobility/music_types';
import { gmPackName, PACK_NAMES } from './gm-pack-name.js';

describe('gmPackName', () => {
  it('removes punctuation rather than separating on it', () => {
    // The rule you would guess gives `honky_tonk_piano`, which does not exist.
    expect(gmPackName(3, 'Honky-tonk Piano')).toBe('honkytonk_piano');
    expect(gmPackName(103, 'FX 8 (sci-fi)')).toBe('fx_8_scifi');
  });

  it('leaves the double underscore where a `+` was, because the packs do', () => {
    expect(gmPackName(87, 'Lead 8 (bass + lead)')).toBe('lead_8_bass__lead');
  });

  it('uses the GM standard name for program 54, which the catalogue calls something else', () => {
    expect(gmPackName(54, 'Synth Voice')).toBe('voice_oohs');
  });
});

describe('GM pack coverage', () => {
  const available = new Set<string>(PACK_NAMES);

  it('names a pack that exists for every one of the 128 GM programs', () => {
    // The check that matters. A name that misses resolves to a 404, which
    // parses to no samples, which is an instrument that plays nothing.
    //
    // It lived in music_lib for a while, because the catalogue did. Now that
    // `GM_INSTRUMENTS` is in music_types this can sit beside the rule it
    // tests, and music_lib needs no dependency on this package for it.
    const missing = GM_INSTRUMENTS.filter(
      (i) => !available.has(gmPackName(i.program, i.name)),
    ).map((i) => `${i.program} "${i.name}" -> ${gmPackName(i.program, i.name)}`);
    expect(missing).toEqual([]);
  });

  it('covers the whole catalogue, so no program silently has no rule', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
  });
});
