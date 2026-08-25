/**
 * Nothing here redeclares a constant `@sudobility/music_types` already owns.
 *
 * A constant restated in a second package agrees with the first right up
 * until one of them is edited, and nothing fails when they part: the build is
 * clean, the types match, and the only symptom is a wrong sound or a picker
 * quietly missing an entry. That is how `CC_VOLUME` came to be declared three
 * times across the family, `DYNAMICS` four times, and `C_MAJOR` five — and
 * how the generation decoder ended up validating a model's output against its
 * own private copy of the vocabulary rather than against the model.
 *
 * The list of names is READ FROM music_types at runtime rather than written
 * out here, because a guard against duplication that duplicates the thing it
 * guards would drift exactly like everything else.
 */
import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import * as musicTypes from '@sudobility/music_types';

/**
 * Names this package may legitimately declare for itself.
 *
 * Empty on purpose. An entry here is somebody deciding, in writing, that a
 * local constant genuinely means something different from the shared one that
 * happens to share its name — not a way to quiet the test.
 */
const ALLOWED: readonly string[] = [];

describe('single source of truth', () => {
  it('declares no constant that music_types already exports', () => {
    const owned = Object.keys(musicTypes).filter(
      name => /^[A-Z][A-Z0-9_]*$/.test(name) && !ALLOWED.includes(name)
    );
    expect(owned.length).toBeGreaterThan(0);

    const pattern = new RegExp(`^(?:export )?const (${owned.join('|')})\\s*[:=]`, 'm');
    const offenders: string[] = [];
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      if (file.includes('.test.')) continue;
      const match = pattern.exec(readFileSync(file, 'utf8'));
      if (match) offenders.push(`${match[1]} in ${file}`);
    }

    expect(offenders).toEqual([]);
  });
});
