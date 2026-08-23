/**
 * Holding a note for longer than the recording lasts.
 *
 * Every FluidR3 sample pack entry is **3.13 seconds**, whatever the instrument.
 * That is not a limit of the format, just how they were rendered — but it means
 * a note written longer than that simply stops sounding partway through. A whole
 * note at 60bpm is four seconds. A tied pad across a phrase is many. Those went
 * silent, with the gain envelope still dutifully holding a level over nothing.
 *
 * SF2 solves this with loop points, and the packs lost them along with
 * everything else in the `sdta` chunk. What survives is the audio, and for an
 * instrument that *holds* its level — measured per instrument by
 * `scripts/measure-expression.mjs` — a window inside its steady portion can be
 * looped to sustain it indefinitely.
 *
 * Only for those instruments. Looping a piano's tail would hold a note that is
 * supposed to die away, which is a worse and more obvious error than the
 * truncation it fixes.
 */
import { midiToHertz } from '../../shared/midi.js';
import type { RNAudioBuffer, RNBufferSource } from './audio-api.js';

/** Kept clear of the end, which holds the rendered note's own release. */
const TAIL_GUARD_SECONDS = 0.35;
/**
 * Longest loop window worth taking.
 *
 * Long enough that any period mismatch at the seam recurs rarely, short enough
 * to sit inside the steady portion of a 3.13s recording.
 */
const MAX_LOOP_SECONDS = 1.0;
/** Shorter than this and the seam recurs often enough to be heard as a pitch. */
const MIN_LOOP_SECONDS = 0.25;

/**
 * Points a source at a loop inside its own sustain, if it needs one and one fits.
 *
 * Returns whether looping was applied — false when the note is short enough to
 * play straight through, or the recording too short to find a window in.
 *
 * **The loop spans a whole number of periods of the note being played.** That
 * is what makes the seam quiet. Aligning both ends to rising zero crossings, as
 * the first version did, removes the step discontinuity but not the *phase*
 * one: an arbitrary-length window ends part-way through a cycle, so the
 * waveform jumps back mid-period and every partial above the fundamental
 * restarts out of phase. Rounding the window to whole periods lands the end of
 * the loop at the same point in the cycle as its start, so the fundamental and
 * its harmonics all continue smoothly.
 *
 * The sampled note is known — it is the pack entry being played — so its
 * fundamental is known, and no pitch detection is needed. `sampleMidi` is the
 * *sampled* note rather than the sounding one: the buffer holds the recording
 * as rendered, and `detune` bends it afterwards, so the period in the buffer
 * belongs to the sample.
 */
export function applySustainLoop(
  source: RNBufferSource,
  buffer: RNAudioBuffer,
  neededSeconds: number,
  sampleMidi?: number,
): boolean {
  const duration = buffer.duration;
  if (neededSeconds <= duration) return false;

  const end = duration - TAIL_GUARD_SECONDS;
  const target = Math.min(MAX_LOOP_SECONDS, end / 2);
  if (end <= 0 || target < MIN_LOOP_SECONDS) return false;

  const channel = buffer.getChannelData(0);
  const rate = buffer.sampleRate;

  const endSample = nearestRisingZero(channel, Math.floor(end * rate), rate);
  const lengthSamples = wholePeriods(target * rate, sampleMidi, rate);
  const startSample = endSample - lengthSamples;
  if (startSample <= 0) return false;

  const loopStart = startSample / rate;
  const loopEnd = endSample / rate;
  if (!(loopEnd > loopStart) || loopEnd - loopStart < MIN_LOOP_SECONDS) return false;

  source.loop = true;
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;
  return true;
}

/**
 * `targetSamples` rounded to a whole number of periods of `sampleMidi`.
 *
 * Returned unchanged when the note is unknown — a caller with no pitch (a test,
 * a future non-melodic use) still gets a working loop, just one whose seam is
 * only zero-crossing-aligned.
 */
function wholePeriods(targetSamples: number, sampleMidi: number | undefined, sampleRate: number): number {
  if (sampleMidi === undefined) return Math.round(targetSamples);
  const period = sampleRate / midiToHertz(sampleMidi);
  const periods = Math.max(1, Math.round(targetSamples / period));
  return Math.round(periods * period);
}

/**
 * The nearest sample index where the waveform crosses zero going upward.
 *
 * Searched within a few milliseconds either way — far enough to find a crossing
 * at any musical pitch, near enough not to move the loop bound audibly.
 */
function nearestRisingZero(channel: Float32Array, at: number, sampleRate: number): number {
  const reach = Math.floor(0.005 * sampleRate);
  const lo = Math.max(1, at - reach);
  const hi = Math.min(channel.length - 1, at + reach);
  for (let offset = 0; offset <= reach; offset += 1) {
    for (const index of [at - offset, at + offset]) {
      if (index <= lo || index >= hi) continue;
      if (channel[index - 1]! <= 0 && channel[index]! > 0) return index;
    }
  }
  return at;
}
