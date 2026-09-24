import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RENDER_DELAY_SECONDS,
  SOUNDING_INTERVAL_MS,
  SOUNDING_SAMPLING_LEAD_SECONDS,
  soundingOffsetSeconds,
  soundingTickerFrom,
  startSoundingTicker,
  visualOffsetSeconds,
  visualSoundingOffsetSeconds,
} from './visual-sync.js';

describe('startSoundingTicker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('runs once per animation frame when the platform has them', () => {
    // A frame-rate setInterval is what fell behind under the Spatial view's
    // per-frame rendering; rAF runs inside the frame, ahead of its paint.
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
    const tick = vi.fn();

    const stop = startSoundingTicker(tick);
    expect(tick).not.toHaveBeenCalled();
    frames[0]!(16);
    frames[1]!(32);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(3); // re-armed ahead of each tick

    stop();
    expect(cancelled).toEqual([3]);
  });

  it('keeps going after a tick that throws', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const tick = vi.fn(() => {
      throw new Error('one bad frame');
    });
    startSoundingTicker(tick);
    expect(() => frames[0]!(16)).toThrow('one bad frame');
    expect(frames).toHaveLength(2);
  });

  it('falls back to the interval where there is no requestAnimationFrame', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = startSoundingTicker(tick);
    vi.advanceTimersByTime(SOUNDING_INTERVAL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(SOUNDING_INTERVAL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('defers to a host-supplied pump timer, at the sounding cadence', () => {
    // A test that steps the pump by hand steps the lights the same way.
    const startPump = vi.fn(() => () => undefined);
    const tick = () => undefined;
    soundingTickerFrom(startPump)(tick);
    expect(startPump).toHaveBeenCalledWith(tick, SOUNDING_INTERVAL_MS);
    expect(soundingTickerFrom(undefined)).toBe(startSoundingTicker);
  });
});

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

  it('scales the correction by the playback speed', () => {
    /*
      The position it is added to runs at the transport's speed; the delays it
      corrects for do not. Unscaled, a half-speed practice pass on ~150ms
      Bluetooth headphones lit the keys ~130ms after the sound — the "known
      simplification, ~8ms" estimate had assumed no output latency at all.
    */
    const real = visualOffsetSeconds(0.15);
    expect(visualOffsetSeconds(0.15, undefined, 0.5)).toBeCloseTo(real / 2, 9);
    expect(visualOffsetSeconds(0.15, undefined, 2)).toBeCloseTo(real * 2, 9);
    expect(visualOffsetSeconds(0.15, undefined, 1)).toBe(real);
  });

  it('treats a speed that cannot be true as full speed', () => {
    const real = visualOffsetSeconds(0.02);
    expect(visualOffsetSeconds(0.02, undefined, 0)).toBe(real);
    expect(visualOffsetSeconds(0.02, undefined, -1)).toBe(real);
    expect(visualOffsetSeconds(0.02, undefined, Number.NaN)).toBe(real);
  });
});

describe('soundingOffsetSeconds', () => {
  it('leads the lit notes by half the sampling interval on top of the render delay', () => {
    // A boundary is noticed 0..one interval after it happens; half an
    // interval centres that on zero rather than leaving all of it late.
    expect(SOUNDING_SAMPLING_LEAD_SECONDS).toBe(SOUNDING_INTERVAL_MS / 2000);
    expect(soundingOffsetSeconds(0.02, RENDER_DELAY_SECONDS)).toBeCloseTo(
      visualOffsetSeconds(0.02) + SOUNDING_SAMPLING_LEAD_SECONDS,
      9
    );
  });

  it('scales the whole of it, sampling lead included, by the speed', () => {
    expect(soundingOffsetSeconds(0.15, 0.03, 0.5)).toBeCloseTo(
      soundingOffsetSeconds(0.15, 0.03) / 2,
      9
    );
  });
});
