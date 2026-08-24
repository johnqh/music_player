import { describe, expect, it } from 'vitest';
import {
  RENDER_DELAY_SECONDS,
  SOUNDING_INTERVAL_MS,
  visualSoundingOffsetSeconds,
} from './visual-sync.js';

describe('visualSoundingOffsetSeconds', () => {
  it('leads by the render delay when the platform reports no latency', () => {
    // React Native reports none today, so this is its real case: the lights
    // are published a frame early to arrive on time.
    expect(visualSoundingOffsetSeconds(undefined)).toBe(RENDER_DELAY_SECONDS);
    expect(visualSoundingOffsetSeconds(0)).toBe(RENDER_DELAY_SECONDS);
  });

  it('holds back by more than it leads once latency exceeds a frame', () => {
    // The sign that is easy to get backwards: a long output latency means the
    // ear is behind the scheduler, so the lights must WAIT, not hurry.
    expect(visualSoundingOffsetSeconds(0.1)).toBeLessThan(0);
  });

  it('nearly cancels at a typical desktop latency', () => {
    // ~20ms against a ~16ms frame: the two delays are close to equal and
    // opposite, which is why neither can be ignored on its own.
    expect(Math.abs(visualSoundingOffsetSeconds(0.02))).toBeLessThan(0.01);
  });

  it('ignores a latency that cannot be true', () => {
    // A backend that reports NaN or a negative must not drag the lights into
    // nonsense; an unknown latency is one we cannot correct for.
    expect(visualSoundingOffsetSeconds(Number.NaN)).toBe(RENDER_DELAY_SECONDS);
    expect(visualSoundingOffsetSeconds(-1)).toBe(RENDER_DELAY_SECONDS);
  });

  it('recomputes the lights far more often than audio is scheduled', () => {
    // 50ms is right for scheduling, which works off a lookahead horizon, and
    // wrong for a visual.
    expect(SOUNDING_INTERVAL_MS).toBeLessThan(50);
  });
});
