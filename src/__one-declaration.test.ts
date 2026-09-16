/**
 * `ScheduledClick` and `Unsubscribe` are each declared once.
 *
 * Both had a second, identical declaration — `ScheduledClick` in the web click
 * beside the synth backend's, `Unsubscribe` in the bus beside `types.ts`. Two
 * identical types agree right up until one is edited, and nothing fails when
 * they part, so this counts the declarations.
 */
import { describe, expect, it } from 'vitest';
import { globSync, readFileSync } from 'node:fs';

describe('one declaration per type', () => {
  it.each(['ScheduledClick', 'Unsubscribe'])('declares %s once', name => {
    const pattern = new RegExp(
      `^export\\s+(?:type|interface)\\s+${name}\\b`,
      'm'
    );
    const files = globSync('src/**/*.ts').filter(
      file =>
        !file.includes('.test.') && pattern.test(readFileSync(file, 'utf8'))
    );
    expect(files).toHaveLength(1);
  });
});
