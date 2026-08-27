import { describe, expect, it } from 'vitest';
import { PlaybackClock } from './clock.js';

/** A clock driven by a variable we control, so the tests need no real time. */
function fake() {
  const state = { t: 0 };
  return { state, clock: new PlaybackClock(() => state.t) };
}

describe('PlaybackClock', () => {
  it('advances with the injected clock only while running', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 2;
    expect(clock.positionSeconds).toBeCloseTo(2, 6);
    clock.pause();
    state.t = 5;
    expect(clock.positionSeconds).toBeCloseTo(2, 6);
  });

  it('resumes from where it paused, not from where the clock got to', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 2;
    clock.pause();
    state.t = 10; // time passed while paused; it must not count
    clock.start();
    state.t = 11;
    expect(clock.positionSeconds).toBeCloseTo(3, 6);
  });

  it('stop returns to the beginning', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 4;
    clock.stop();
    expect(clock.positionSeconds).toBe(0);
    expect(clock.isRunning).toBe(false);
  });

  it('seeks while running without stopping', () => {
    const { state, clock } = fake();
    clock.start();
    state.t = 1;
    clock.seek(30);
    state.t = 2;
    expect(clock.positionSeconds).toBeCloseTo(31, 6);
    expect(clock.isRunning).toBe(true);
  });

  it('seeks while paused, and stays paused', () => {
    const { state, clock } = fake();
    clock.seek(12);
    state.t = 99;
    expect(clock.positionSeconds).toBeCloseTo(12, 6);
    expect(clock.isRunning).toBe(false);
  });

  it('rate scales elapsed time, which is the playback-speed control', () => {
    const { state, clock } = fake();
    clock.setRate(2);
    clock.start();
    state.t = 3;
    expect(clock.positionSeconds).toBeCloseTo(6, 6);
  });

  it('changing rate mid-play keeps the position already reached', () => {
    // Without banking the position first, a speed change would retroactively
    // rescale everything played so far and jump the caret.
    const { state, clock } = fake();
    clock.start();
    state.t = 4; // 4s in at rate 1
    clock.setRate(2);
    state.t = 5;
    expect(clock.positionSeconds).toBeCloseTo(6, 6);
  });
});
