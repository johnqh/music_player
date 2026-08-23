/**
 * The part of a soundfont that a recording cannot carry.
 *
 * The FluidR3 sample packs are recordings taken at full velocity. Playing one
 * back at lower gain is not what a synth does with a soft note: fluidsynth also
 * darkens it, shapes its release per instrument, and sustains it for as long as
 * the key is held. None of that survives pre-rendering, and it is what made the
 * RN engine sound flat next to the web one.
 *
 * It is recoverable, though, because it is *parameters* rather than audio.
 * `scripts/measure-expression.mjs` recovers them by rendering all 128 programs
 * through fluidsynth and measuring what changes; this module applies them.
 *
 * Measured rather than read out of the soundfont's generators, deliberately —
 * see that script's header. Reading `initialFilterFc` gave Grand Piano a 300Hz
 * low-pass, because FluidR3's piano preset layers two instruments and the
 * recording is their sum. No single layer's generators describe a layered
 * preset. The rendered sound does.
 */
import { EXPRESSION_TABLE } from './expression-table.js';

const EXPRESSION = EXPRESSION_TABLE;

/** The velocities `measure-expression.mjs` probes, descending. 127 is the reference. */
const PROBES = [127, 96, 64, 32, 16];

/**
 * Treated as "no filter". Matches the script's own guard, and sits above
 * anything a phone speaker reproduces anyway.
 */
const NO_FILTER_HZ = 18000;

/**
 * Below this a biquad is worth building; above it, skip the node entirely.
 * One node per voice matters when a dense passage has forty voices running.
 */
const FILTER_WORTH_IT_HZ = 16000;

/** Used where the probe never saw the tail reach -40dB. Longer than most, short enough not to smear a run. */
const DEFAULT_RELEASE_SECONDS = 0.6;

/**
 * Velocity -> linear gain, following SF2's default velocity-to-attenuation
 * modulator (spec §8.4.1: 960cB, concave, descending).
 *
 * fluidsynth's concave table is `1 + (40/96)·log10(v/127)`, and feeding that
 * through `attenuation = 960·(1 - concave)` then `amplitude = 10^(-att/200)`
 * reduces exactly to **(v/127)²**. Measured renders agree within the accuracy
 * of a peak reading.
 *
 * This is not a refinement. The engine previously used a linear `v/127`, which
 * at velocity 32 plays 0.252 where the truth is 0.063 — **12dB too loud**. Every
 * soft passage was wrong, and wrong in the direction that flattens dynamics.
 */
export function velocityGain(velocity: number): number {
  const clamped = Math.min(127, Math.max(0, velocity));
  return (clamped / 127) ** 2;
}

/**
 * The low-pass corner for `program` at `velocity`, or null where this
 * instrument's timbre does not track velocity (71 of the 128 do not).
 *
 * Interpolated in log-frequency between the probed velocities, because pitch
 * and filter corners are perceived logarithmically — a linear interpolation
 * between 556Hz and 4989Hz puts the midpoint an octave and a half too high.
 *
 * Always a *reduction*: the packs were rendered at velocity 127, which the
 * measurements confirm is the brightest the instrument gets, so a low-pass is
 * always the correct direction and there is never a need to brighten — which a
 * low-pass could not do anyway.
 */
export function cutoffFor(program: number, velocity: number): number | null {
  const entry = EXPRESSION[String(program)];
  if (!entry) return null;

  const at = (probe: number): number => {
    if (probe === 127) return NO_FILTER_HZ;
    return entry.cutoffs[String(probe)] ?? NO_FILTER_HZ;
  };

  const v = Math.min(127, Math.max(1, velocity));
  let hz: number;
  if (v >= 127) hz = NO_FILTER_HZ;
  else if (v <= 16) hz = at(16);
  else {
    // PROBES descends, so walk until v sits between two of them.
    let upper = 127;
    let lower = 16;
    for (let i = 0; i < PROBES.length - 1; i += 1) {
      if (v <= PROBES[i]! && v >= PROBES[i + 1]!) {
        upper = PROBES[i]!;
        lower = PROBES[i + 1]!;
        break;
      }
    }
    const t = (v - lower) / (upper - lower);
    hz = 2 ** (Math.log2(at(lower)) + t * (Math.log2(at(upper)) - Math.log2(at(lower))));
  }

  return hz >= FILTER_WORTH_IT_HZ ? null : hz;
}

/**
 * How long this instrument takes to fall silent after note-off.
 *
 * The engine used one 80ms constant for everything, which is roughly seven
 * times too short against the measured median of 0.56s — a piano chord released
 * at the end of a phrase was chopped rather than allowed to ring.
 */
export function releaseFor(program: number): number {
  return EXPRESSION[String(program)]?.releaseSec ?? DEFAULT_RELEASE_SECONDS;
}

/**
 * Whether a note longer than the recording may be held by looping its tail.
 *
 * The packs are 3.13 seconds each, so anything longer — a whole note under 60bpm,
 * a tied pad across a phrase — simply stopped sounding partway through. Looping
 * fixes that for the 79 instruments that hold their level while the key is down.
 * The other 49 are already decaying (piano, marimba, pizzicato), and looping
 * their tail would sustain a note that is supposed to die away, which is a worse
 * error than the one being fixed.
 */
export function sustains(program: number): boolean {
  return EXPRESSION[String(program)]?.sustains ?? false;
}
