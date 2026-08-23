import { describe, expect, it } from 'vitest';
import { applySustainLoop } from './sustain-loop.js';
import type { RNAudioBuffer, RNBufferSource } from './audio-api.js';

const RATE = 44100;

/** A 3.13s recording, like every FluidR3 pack entry, holding a steady tone. */
function buffer(seconds = 3.13, hz = 220): RNAudioBuffer {
  const length = Math.round(seconds * RATE);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
  return {
    length,
    numberOfChannels: 1,
    sampleRate: RATE,
    duration: seconds,
    getChannelData: () => data,
  };
}

function source(): RNBufferSource & { loop: boolean; loopStart: number; loopEnd: number } {
  return {
    buffer: null,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    playbackRate: { value: 1 } as never,
    detune: { value: 0 } as never,
    start: () => undefined,
    stop: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
  } as never;
}

describe('applySustainLoop', () => {
  it('leaves a note that fits inside the recording alone', () => {
    const s = source();
    expect(applySustainLoop(s, buffer(), 2)).toBe(false);
    expect(s.loop).toBe(false);
  });

  it('loops a note longer than the recording — the notes that used to go silent', () => {
    // Every pack entry is 3.13s. A whole note at 60bpm is 4s, and before this
    // it stopped sounding at 3.13 with the envelope still holding over nothing.
    const s = source();
    expect(applySustainLoop(s, buffer(), 6)).toBe(true);
    expect(s.loop).toBe(true);
    expect(s.loopEnd).toBeGreaterThan(s.loopStart);
  });

  it('keeps the loop clear of the recording\'s own release tail', () => {
    // The last third of a second is the rendered note dying away. Looping
    // through it would pump the level once a second.
    const s = source();
    applySustainLoop(s, buffer(), 6);
    expect(s.loopEnd).toBeLessThan(3.13 - 0.3);
  });

  it('takes a long enough window that the seam does not recur as a pitch', () => {
    const s = source();
    applySustainLoop(s, buffer(), 6);
    expect(s.loopEnd - s.loopStart).toBeGreaterThan(0.25);
  });


  it('spans a whole number of periods of the sampled note', () => {
    // The seam's real problem is phase, not sign. An arbitrary window ends
    // part-way through a cycle, so the waveform jumps back mid-period and every
    // harmonic restarts out of phase — audible as a buzz once a second on a
    // held note. A0 = MIDI 21 = 27.5Hz here, chosen because its period is long
    // enough that a rounding error would show.
    const s = source();
    const hz = 27.5;
    applySustainLoop(s, buffer(3.13, hz), 6, 21);

    const periods = (s.loopEnd - s.loopStart) * hz;
    expect(periods).toBeCloseTo(Math.round(periods), 1);
  });

  it('still loops when the sampled note is unknown', () => {
    // A caller with no pitch gets a working loop, just a less quiet seam.
    const s = source();
    expect(applySustainLoop(s, buffer(), 6)).toBe(true);
    expect(s.loopEnd).toBeGreaterThan(s.loopStart);
  });

  it('starts the loop on a rising zero crossing', () => {
    const s = source();
    const buf = buffer();
    applySustainLoop(s, buf, 6, 57); // A3 = 220Hz, matching the fixture tone
    const data = buf.getChannelData(0);
    const i = Math.round(s.loopEnd * RATE);
    expect(data[i - 1]!).toBeLessThanOrEqual(0);
    expect(data[i]!).toBeGreaterThan(0);
  });

  it('declines when the recording is too short to hold a window', () => {
    const s = source();
    expect(applySustainLoop(s, buffer(0.4), 5)).toBe(false);
    expect(s.loop).toBe(false);
  });
});
