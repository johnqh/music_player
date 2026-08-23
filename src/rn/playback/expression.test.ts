import { describe, expect, it } from 'vitest';
import { cutoffFor, releaseFor, sustains, velocityGain } from './expression.js';

const GRAND_PIANO = 0;
const VIOLIN = 40;
const STRINGS = 48;
const MARIMBA = 12;

describe('velocityGain', () => {
  it('is SF2\'s concave default modulator, which reduces to (v/127)^2', () => {
    expect(velocityGain(127)).toBe(1);
    expect(velocityGain(64)).toBeCloseTo((64 / 127) ** 2, 6);
    expect(velocityGain(32)).toBeCloseTo(0.0635, 4);
  });

  it('is far quieter than the linear curve it replaced, where it matters most', () => {
    // The bug this fixes. Linear v/127 at velocity 32 gives 0.252 against a
    // true 0.063 — 12dB too loud, on every soft passage in every score.
    expect(velocityGain(32)).toBeLessThan(32 / 127 / 3);
  });

  it('clamps rather than producing negative or over-unity gain', () => {
    expect(velocityGain(0)).toBe(0);
    expect(velocityGain(-5)).toBe(0);
    expect(velocityGain(999)).toBe(1);
  });
});

describe('cutoffFor', () => {
  it('darkens the piano steeply, which is what the measurements found', () => {
    const soft = cutoffFor(GRAND_PIANO, 16)!;
    const mid = cutoffFor(GRAND_PIANO, 64)!;
    expect(soft).toBeLessThan(mid);
    expect(soft).toBeLessThan(1000);
    expect(mid).toBeGreaterThan(1000);
  });

  it('leaves velocity 127 unfiltered, since that is what the packs were rendered at', () => {
    expect(cutoffFor(GRAND_PIANO, 127)).toBeNull();
  });

  it('returns null for instruments whose timbre does not track velocity', () => {
    // Violin measured flat across the whole velocity range; filtering it would
    // invent a darkening fluidsynth does not apply.
    expect(cutoffFor(VIOLIN, 16)).toBeNull();
  });

  it('skips the filter when the corner is above hearing anyway', () => {
    // Strings darken, but only from ~17.8kHz to ~7kHz. At high velocity the
    // corner is above anything a phone reproduces, so no node is built.
    expect(cutoffFor(STRINGS, 120)).toBeNull();
    expect(cutoffFor(STRINGS, 16)).not.toBeNull();
  });

  it('is monotone in velocity — softer is never brighter', () => {
    for (let v = 2; v <= 127; v += 1) {
      const lower = cutoffFor(GRAND_PIANO, v - 1) ?? Infinity;
      const higher = cutoffFor(GRAND_PIANO, v) ?? Infinity;
      expect(higher, `v${v}`).toBeGreaterThanOrEqual(lower);
    }
  });

  it('interpolates in log-frequency, not linearly', () => {
    // Velocity 48 is the midpoint of the 32 and 64 *probes* — the brackets are
    // the probe points, not any two velocities. Log interpolation puts it at
    // the geometric mean of the two corners; linear would put it a quarter of
    // an octave high.
    const lo = cutoffFor(GRAND_PIANO, 32)!;
    const hi = cutoffFor(GRAND_PIANO, 64)!;
    const mid = cutoffFor(GRAND_PIANO, 48)!;
    expect(mid).toBeCloseTo(Math.sqrt(lo * hi), 0);
    expect(mid).toBeLessThan((lo + hi) / 2);
  });

  it('answers for every program without throwing', () => {
    for (let p = 0; p < 128; p += 1) {
      expect(() => cutoffFor(p, 64)).not.toThrow();
    }
  });
});

describe('releaseFor', () => {
  it('gives each instrument its own measured release', () => {
    expect(releaseFor(GRAND_PIANO)).toBeCloseTo(0.52, 2);
    expect(releaseFor(19)).toBeGreaterThan(1); // church organ rings on
  });

  it('is far longer than the 80ms constant it replaced', () => {
    // Every instrument was being chopped at 80ms regardless.
    let longer = 0;
    for (let p = 0; p < 128; p += 1) if (releaseFor(p) > 0.08) longer += 1;
    expect(longer).toBeGreaterThan(120);
  });

  it('falls back for an instrument whose tail outlasted the probe', () => {
    expect(releaseFor(MARIMBA)).toBeGreaterThan(0);
  });
});

describe('sustains', () => {
  it('holds bowed and blown instruments', () => {
    expect(sustains(STRINGS)).toBe(true);
    expect(sustains(VIOLIN)).toBe(true);
  });

  it('does not hold instruments that are already decaying', () => {
    // Looping a piano's tail sustains a note that is supposed to die away —
    // a worse error than the truncation it would be fixing.
    expect(sustains(GRAND_PIANO)).toBe(false);
    expect(sustains(MARIMBA)).toBe(false);
  });
});
