/**
 * GM program -> FluidR3 sample-pack name.
 *
 * The packs are named after the General MIDI instrument names, but not by the
 * slug rule you would guess. Punctuation is **removed** rather than turned into
 * a separator, which is why `Honky-tonk Piano` is `honkytonk_piano` and not
 * `honky_tonk_piano`, and why `Lead 8 (bass + lead)` keeps a double underscore
 * where the `+` used to be — the `+` vanishes and both spaces around it become
 * separators.
 *
 * That one rule covers 127 of the 128 programs. Program 54 is the exception,
 * and it is a real disagreement rather than a formatting one: the GM standard
 * calls it "Voice Oohs" and this catalogue calls it "Synth Voice". Both names
 * are in circulation for that program.
 *
 * `gm-pack-name.test.ts` checks all 128 against the manifest the CDN actually
 * serves, so a wrong name here cannot ship as a silent instrument.
 */

/**
 * The pack holding a GM drum kit, named by the program that selects it.
 *
 * Not a slug of the kit's name, unlike the melodic packs: these are rendered by
 * `scripts/build-percussion-packs.mjs` rather than fetched from a CDN whose
 * naming we have to match, so the address can be the thing that actually
 * identifies a kit. `gmKitAt` in music_lib resolves any program to the kit
 * whose region contains it, so the caller passes a real kit program.
 */
export function percussionPackName(kitProgram: number): string {
  return `percussion_${kitProgram}`;
}

/** Programs whose catalogue name is not the name the packs use. */
const RENAMED: Record<number, string> = {
  54: 'voice_oohs',
};

/**
 * The pack name for a GM program with catalogue name `instrumentName`.
 *
 * Takes the name rather than looking it up, so this module stays free of
 * music_lib's catalogue and the mapping rule can be tested on its own.
 */
import PACK_NAMES_JSON from './pack-names.json' with { type: 'json' };

/**
 * Every pack the CDN serves, vendored.
 *
 * Exported so the "every GM program resolves to a pack that exists" sweep can
 * live in music_lib, which owns the catalogue the mapping starts from. That
 * check spans both packages, so it cannot sit wholly in either — and it is the
 * one that matters: a name that misses resolves to a 404, which parses to no
 * samples, which is an instrument that plays nothing.
 */
export const PACK_NAMES: readonly string[] = PACK_NAMES_JSON;

export function gmPackName(program: number, instrumentName: string): string {
  const renamed = RENAMED[program];
  if (renamed) return renamed;
  return instrumentName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/ /g, '_');
}
