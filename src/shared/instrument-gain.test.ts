import { describe, expect, it } from 'vitest';
import {
  instrumentExpression,
  instrumentGain,
  percussionExpression,
  PERCUSSION_GAIN,
} from './instrument-gain.js';

describe('FluidR3 instrument loudness profile', () => {
  it('covers every GM program with a safe finite trim', () => {
    for (let program = 0; program < 128; program += 1) {
      expect(Number.isFinite(instrumentGain(program))).toBe(true);
      expect(instrumentGain(program)).toBeGreaterThan(0);
      expect(instrumentExpression(program)).toBeGreaterThanOrEqual(1);
      expect(instrumentExpression(program)).toBeLessThanOrEqual(127);
    }
  });

  it('raises the two quiet patches called out by playback reports', () => {
    expect(instrumentGain(38)).toBe(2);
    expect(instrumentGain(53)).toBe(2);
    expect(instrumentExpression(38)).toBe(127);
    expect(instrumentExpression(53)).toBe(127);
  });

  it('keeps the kit correction on the same bounded scale', () => {
    expect(PERCUSSION_GAIN).toBeGreaterThan(1);
    expect(percussionExpression()).toBeGreaterThan(64);
    expect(percussionExpression()).toBeLessThanOrEqual(127);
  });
});
