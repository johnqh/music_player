import { describe, expect, it } from 'vitest';
import { headroomTrimFor, LIMITER_CEILING_DB, limitPeaks } from './mix.js';

const SAMPLE_RATE = 44100;
const CEILING = 10 ** (LIMITER_CEILING_DB / 20);

/** A sine at `hz`, `seconds` long, scaled to `peak`. */
function sine(peak: number, hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = peak * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return out;
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

describe('headroomTrimFor', () => {
  it('leaves a single track at unity, since it sums with nothing', () => {
    expect(headroomTrimFor(1)).toBe(1);
    expect(headroomTrimFor(0)).toBe(1);
  });

  it('falls as one over the root of the part count, not one over the count', () => {
    // Separate parts are not phase-correlated, so their powers add rather than
    // their amplitudes. `1/n` is the law for copies of one signal and would
    // leave a large arrangement far too quiet.
    expect(headroomTrimFor(4)).toBeCloseTo(0.5, 12);
    expect(headroomTrimFor(9)).toBeCloseTo(1 / 3, 12);
  });
});

describe('limitPeaks', () => {
  it('leaves a signal already under the ceiling exactly as it was', () => {
    // The limiter is a safety catch, not a sound. Anything it does to a mix
    // that never reaches the ceiling is damage.
    const quiet = sine(CEILING * 0.9, 440, 0.2);
    const expected = Float32Array.from(quiet);
    limitPeaks(quiet, SAMPLE_RATE);
    expect(Array.from(quiet)).toEqual(Array.from(expected));
  });

  it('holds a loud signal under the ceiling', () => {
    const loud = sine(2.5, 220, 0.5);
    limitPeaks(loud, SAMPLE_RATE);
    // Exact to within a float32 rounding step, which is the precision the
    // buffer itself has — the envelope arithmetic is done in float64 and the
    // result is stored in a `Float32Array`. The property that matters is that
    // nothing arrives at the encoder's clamp, which is a full order of
    // magnitude further up.
    expect(peakOf(loud)).toBeLessThanOrEqual(CEILING * (1 + 1e-6));
    expect(peakOf(loud)).toBeLessThan(1);
  });

  it('starts ducking before the peak arrives, rather than chasing it', () => {
    // The lookahead is the one thing an offline limiter can do that the live
    // compressor cannot. Without it the reduction lands after the transient and
    // the transient itself is what clips.
    const samples = new Float32Array(SAMPLE_RATE);
    samples.fill(CEILING * 0.5);
    const spikeAt = SAMPLE_RATE / 2;
    for (let i = spikeAt; i < spikeAt + 100; i += 1) samples[i] = 3;

    limitPeaks(samples, SAMPLE_RATE);

    // A millisecond ahead of the spike, the steady tone is already turned down.
    const ahead = samples[spikeAt - Math.round(0.001 * SAMPLE_RATE)]!;
    expect(ahead).toBeLessThan(CEILING * 0.5);
    // And well before the lookahead window it is untouched.
    expect(samples[spikeAt - SAMPLE_RATE / 4]!).toBeCloseTo(CEILING * 0.5, 6);
  });

  it('comes back up after the peak instead of staying ducked', () => {
    const samples = new Float32Array(SAMPLE_RATE * 2);
    samples.fill(CEILING * 0.5);
    for (let i = 0; i < 100; i += 1) samples[i] = 3;

    limitPeaks(samples, SAMPLE_RATE);

    // One release constant later it is most of the way back; a second later,
    // indistinguishable from where it started.
    expect(samples[Math.round(0.25 * SAMPLE_RATE)]!).toBeGreaterThan(
      CEILING * 0.3
    );
    expect(samples[SAMPLE_RATE]!).toBeCloseTo(CEILING * 0.5, 4);
  });

  it('moves the gain smoothly rather than stepping it', () => {
    // A step in gain is a click, which is the failure mode a plain clamp has
    // and this exists to avoid.
    const samples = sine(2, 100, 0.5);
    const before = Float32Array.from(samples);
    limitPeaks(samples, SAMPLE_RATE);

    let worst = 0;
    for (let i = 1; i < samples.length; i += 1) {
      // Compare the applied gain, not the waveform: the signal itself swings.
      if (Math.abs(before[i]!) < 1e-4 || Math.abs(before[i - 1]!) < 1e-4)
        continue;
      const gain = samples[i]! / before[i]!;
      const previous = samples[i - 1]! / before[i - 1]!;
      worst = Math.max(worst, Math.abs(gain - previous));
    }
    // The bound is the attack slew itself: twelve decibels over three
    // milliseconds at 44.1kHz is 0.091dB a sample, which is 1.05% of the gain.
    expect(worst).toBeLessThan(0.011);
  });
});
