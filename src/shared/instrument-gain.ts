/**
 * Playback trims for the FluidR3 GM patches.
 *
 * FluidR3 is musically useful but its presets are not peak-normalized: some
 * synth and vocal patches sit several dB below the acoustic instruments. The
 * trim is deliberately kept here, beside the shared playback arithmetic, so
 * native FluidSynth, the browser synth, and the RN sample renderer cannot
 * drift apart.
 *
 * Values are linear relative to the ordinary GM patch. The native/web synth
 * uses the value as a loudness request; the sample renderer uses it directly.
 */
const PROGRAM_GAIN: Record<number, number> = {
  // Bass presets are particularly quiet in FluidR3. Keep the correction
  // explicit for every bass program so a later font change is easy to audit.
  32: 1.25,
  33: 1.25,
  34: 1.25,
  35: 1.25,
  36: 1.25,
  37: 1.25,
  38: 2,
  39: 1.25,

  // The three GM voice patches share the same quiet vocal bank.
  52: 1.5,
  53: 2,
  54: 1.5,

  // Pads and effects have deliberately soft envelopes in this font.
  88: 1.25,
  89: 1.25,
  90: 1.25,
  91: 1.25,
  92: 1.25,
  93: 1.25,
  94: 1.25,
  95: 1.25,
};

/** The standard kit is quieter than melodic patches but must not be boosted per note. */
export const PERCUSSION_GAIN = 1.25;

export function instrumentGain(program: number): number {
  return PROGRAM_GAIN[program] ?? 1;
}

/**
 * Convert a trim into CC11 while preserving headroom for the quiet-patch
 * boosts. The synth master is raised by the same factor, so a normal patch
 * remains at its old level and only the calibrated patches get louder.
 */
export function instrumentExpression(program: number): number {
  return Math.round(Math.min(1, instrumentGain(program) / 2) * 127);
}

export function percussionExpression(): number {
  return Math.round(Math.min(1, PERCUSSION_GAIN / 2) * 127);
}
