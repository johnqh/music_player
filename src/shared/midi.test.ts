import { describe, expect, it } from 'vitest';
import { midiToHertz, normalizeVelocity } from './midi.js';

describe('midiToHertz', () => {
  it('returns 440 for A4 (midi 69)', () => {
    expect(midiToHertz(69)).toBeCloseTo(440, 5);
  });

  it('returns 261.63 for C4 (midi 60)', () => {
    expect(midiToHertz(60)).toBeCloseTo(261.626, 2);
  });

  it('doubles per octave (12 semitones up)', () => {
    expect(midiToHertz(81)).toBeCloseTo(midiToHertz(69) * 2, 5);
  });
});

describe('normalizeVelocity', () => {
  it('maps 0-127 to 0-1', () => {
    expect(normalizeVelocity(0)).toBe(0);
    expect(normalizeVelocity(127)).toBe(1);
    expect(normalizeVelocity(64)).toBeCloseTo(64 / 127, 5);
  });

  it('clamps out-of-range values', () => {
    expect(normalizeVelocity(-10)).toBe(0);
    expect(normalizeVelocity(200)).toBe(1);
  });
});
