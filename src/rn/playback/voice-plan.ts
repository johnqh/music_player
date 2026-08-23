/**
 * When one sampled note starts, how loud it is, and when it lets go.
 *
 * Pure, so the arithmetic that decides whether a note is audible at all can be
 * tested without an audio device.
 *
 * There is no attack or decay stage here, deliberately. These samples are
 * recordings of real instruments, so the attack is already *in* the audio — a
 * synthesised attack ramp on top would smear the very transient that makes a
 * plucked or struck note recognisable. What the envelope does provide is a
 * release, because cutting a sample off at full amplitude produces a click.
 */
import type { SampleChoice } from './sample-pack.js';
import { cutoffFor, releaseFor, velocityGain } from './expression.js';

/**
 * Fallback fade-out, for a voice with no instrument context (the metronome, a
 * test). Real notes use the instrument's own measured release via
 * `expression.ts` — this engine used to apply this 80ms to *everything*, which
 * is about seven times too short against the measured median of 0.56s and
 * chopped every released chord.
 */
export const RELEASE_SECONDS = 0.08;

/**
 * Floor on how long a voice sounds before it starts releasing.
 *
 * A note can arrive with a zero duration — a grace note, or something
 * quantized down to nothing — and scheduling the release at the same instant
 * as the start plays silence. This is short enough to still read as a grace
 * note.
 */
export const MIN_VOICE_SECONDS = 0.05;

export type VoicePlan = {
  /** Low-pass corner reproducing this velocity's timbre, or null to leave it open. */
  cutoffHz: number | null;
  /** Context time to start the source node. */
  startAt: number;
  /** Context time the release ramp begins — the end of the written duration. */
  releaseAt: number;
  /** Context time the source node stops. */
  endAt: number;
  /** Peak linear gain, velocity and track level combined. */
  gain: number;
  /** Sample to play and how far to bend it. */
  uri: string;
  detuneCents: number;
  sampleMidi: number;
};

export function planVoice({
  atSeconds,
  durationSeconds,
  velocity,
  trackGain,
  choice,
  program,
}: {
  atSeconds: number;
  durationSeconds: number;
  velocity: number;
  trackGain: number;
  choice: SampleChoice;
  /**
   * GM program, for the instrument's own release and velocity-to-brightness.
   * Omitted by callers with no instrument (the metronome), which fall back to
   * the flat constants.
   */
  program?: number;
}): VoicePlan {
  // Never behind the context clock: a source node rejects a start time in the
  // past, and `planDispatch` has already dropped anything genuinely late.
  const startAt = Math.max(0, atSeconds);
  const held = Math.max(MIN_VOICE_SECONDS, durationSeconds);
  const releaseAt = startAt + held;
  const release = program === undefined ? RELEASE_SECONDS : releaseFor(program);

  return {
    startAt,
    releaseAt,
    endAt: releaseAt + release,
    // SF2's concave velocity curve, not a linear one — see `velocityGain`.
    gain: velocityGain(velocity) * trackGain,
    cutoffHz: program === undefined ? null : cutoffFor(program, velocity),
    uri: choice.uri,
    detuneCents: choice.detuneCents,
    sampleMidi: choice.midi,
  };
}
