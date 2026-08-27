import { describe, expect, it, vi } from 'vitest';
import { Governor } from './governor.js';

describe('Governor', () => {
  it('starts at the best quality, because most machines never need less', () => {
    expect(new Governor().interpolation).toBe(7);
  });

  it('does not degrade interpolation on main-thread lateness alone', () => {
    // Far more than the ten consecutive late frames that used to step it down.
    // Since the scheduling horizon, the worklet holds seconds of queued audio,
    // so a busy main thread says nothing about whether the synth is struggling.
    const onChange = vi.fn();
    const g = new Governor({ onChange });
    for (let i = 0; i < 100; i += 1) g.record(0.5);
    expect(onChange).not.toHaveBeenCalled();
    expect(g.interpolation).toBe(7);
  });

  it('still counts consecutive late frames, so a future audio-thread signal has something to read', () => {
    const g = new Governor();
    for (let i = 0; i < 12; i += 1) g.record(0.5);
    expect(g.stalledFrames).toBeGreaterThanOrEqual(10);
  });

  it('resets the count as soon as a frame runs on time', () => {
    const g = new Governor();
    for (let i = 0; i < 12; i += 1) g.record(0.5);
    g.record(0);
    expect(g.stalledFrames).toBe(0);
  });

  it('does not count a frame that ran within the threshold', () => {
    const g = new Governor();
    for (let i = 0; i < 12; i += 1) g.record(0.05);
    expect(g.stalledFrames).toBe(0);
  });
});
