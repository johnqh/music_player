/**
 * The master-bus rules, shared by live playback and offline export on both
 * platforms — `web/playback/synth-host.ts`, `web/audio/soundfont-render.ts`,
 * `rn/playback/sample-engine.ts` and `rn/audio/offline-render.ts`.
 *
 * They live here rather than in each caller because an export that mixed
 * differently from playback is exactly the bug this module exists to prevent:
 * the file is supposed to be a recording of what was heard, and copies of these
 * numbers would drift apart the first time one was tuned.
 *
 * Living here is not the same as being used, which is how the web export came
 * to sum its channels raw while playback trimmed them — `sqrt(n)` louder than
 * what was heard, into encoders that hard-clamp. All four callers are named
 * above so the next one to be added is noticed by its absence.
 */

/**
 * Ceiling for the safety limiter on the master bus, in dB below full scale.
 *
 * The headroom trim sizes the mix for how loud it is *on average*; this catches
 * the peaks it cannot predict — the moments when parts happen to line up in
 * phase, which sum far above the incoherent average. Just under full scale
 * rather than at it, so the limiter, and not the sound card, decides the
 * ceiling.
 */
export const LIMITER_CEILING_DB = -1;

/**
 * How far to pull the master down for `trackCount` channels summing into it.
 *
 * Every channel is scheduled at its own MIDI volume with nothing reconciling
 * them, so the mix got louder with every track added. A nine-track arrangement
 * summed to roughly two and a half times full scale and clipped through most of
 * the piece; what that distortion buried first were the quiet, sustained
 * voices, which is why tracks that were neither muted nor silent could not be
 * heard at all.
 *
 * `1/sqrt(n)`, not `1/n`: separate instrument parts are not phase-correlated,
 * so their powers add rather than their amplitudes. `1/n` is the law for copies
 * of one signal and would leave a large arrangement far too quiet. A single
 * track keeps unity — it has nothing to sum with.
 */
export function headroomTrimFor(trackCount: number): number {
  return trackCount > 1 ? 1 / Math.sqrt(trackCount) : 1;
}

/**
 * Attack and release for the offline limiter, in seconds, quoted against
 * `LIMITER_REFERENCE_DB` of reduction.
 *
 * The same numbers `SynthHost` gives its `DynamicsCompressorNode`, so a peak
 * ducks for about as long either way. Expressed as a slew rate rather than a
 * filter coefficient, which is what makes the ceiling exact — see `limitPeaks`.
 */
const LIMITER_ATTACK_SECONDS = 0.003;
const LIMITER_RELEASE_SECONDS = 0.25;

/**
 * The depth the attack and release times describe.
 *
 * A slew rate needs a distance to be a time. Twelve decibels is deep enough to
 * cover the peaks a phase-aligned tutti produces over the headroom trim, and a
 * shallower reduction simply completes proportionally sooner.
 */
const LIMITER_REFERENCE_DB = 12;

/**
 * Holds a rendered buffer under `LIMITER_CEILING_DB`, in place.
 *
 * The offline counterpart of the `DynamicsCompressorNode` on the live master
 * bus, and it exists for the same reason: the headroom trim sizes the mix for
 * how loud it is *on average*, and the moments where parts happen to line up in
 * phase sum far above that. Live those peaks meet a limiter; in an export they
 * meet `encodeWav`/`encodeMp3`, which clamp — so without this the loudest
 * instants of a file are hard-clipped rather than ducked.
 *
 * It is **not** a reimplementation of that node. `DynamicsCompressorNode` has a
 * knee, a ratio and program-dependent behaviour the specification does not pin
 * down closely enough to reproduce, and chasing it would be pretending to a
 * precision that is not there. What is reproduced is the job: nothing leaves
 * here above the ceiling, and it gets there by ducking rather than clipping.
 *
 * The gain is worked out **backwards**, which is the one thing an offline
 * limiter can do that a live one cannot. Each sample's gain is the lower of
 * what that sample needs and what the next sample allows plus one attack step,
 * so the ramp down is *finished* when the peak lands instead of chasing it.
 * That ordering is also what makes the ceiling exact rather than approximate: a
 * forward one-pole never quite arrives, and clamping the residue turns the last
 * fraction of a decibel back into the clipping this replaces.
 *
 * The forward pass is the release, and the reason a sustained loud passage does
 * not pump: within one cycle the requirement relaxes at every zero crossing,
 * and the bounded climb simply does not follow it.
 *
 * Costs one `Float32Array` the length of the render — 53MB for five minutes at
 * 44.1kHz, freed on return, against a `samples` buffer of the same size that
 * the caller is already holding.
 */
export function limitPeaks(samples: Float32Array, sampleRate: number): void {
  const attackSlope =
    LIMITER_REFERENCE_DB / Math.max(1, LIMITER_ATTACK_SECONDS * sampleRate);
  const releaseSlope =
    LIMITER_REFERENCE_DB / Math.max(1, LIMITER_RELEASE_SECONDS * sampleRate);

  // Gain in dB, never above zero: a limiter only ever turns things down.
  const envelope = new Float32Array(samples.length);
  let carried = 0;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const magnitude = Math.abs(samples[i]!);
    const required =
      magnitude > 0
        ? Math.min(0, LIMITER_CEILING_DB - 20 * Math.log10(magnitude))
        : 0;
    carried = Math.min(required, carried + attackSlope);
    envelope[i] = carried;
  }

  let level = envelope[0] ?? 0;
  for (let i = 0; i < samples.length; i += 1) {
    level = Math.min(envelope[i]!, level + releaseSlope);
    // Exactly 1 where nothing needed doing, so an untouched mix stays bit-identical.
    samples[i] = level === 0 ? samples[i]! : samples[i]! * 10 ** (level / 20);
  }
}
