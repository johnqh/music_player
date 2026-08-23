/**
 * Pure MIDI-number conversions used by the Tone.js adapter (Task 13). Kept
 * dependency-free (no Tone.js import) so they're trivially unit-testable
 * without mocking `tone`, per the Task 13 brief's guidance to keep every
 * piece of logic that doesn't actually need Tone in small, separately
 * testable functions.
 */

/** A4 = 69 = 440Hz, the standard MIDI tuning reference. */
const A4_MIDI = 69;
const A4_HERTZ = 440;

/** Converts a MIDI note number (60 = C4) to its frequency in Hertz. */
export function midiToHertz(midi: number): number {
  return A4_HERTZ * 2 ** ((midi - A4_MIDI) / 12);
}

/**
 * Converts a domain `NoteEvent.velocity` (spec §4: integer 0-127) to Tone's
 * normalized 0-1 velocity range, clamped defensively in case of an
 * out-of-range value slipping through (validation should catch this
 * earlier, but the audio layer shouldn't crash or produce out-of-range
 * gain if it doesn't).
 */
export function normalizeVelocity(velocity: number): number {
  return Math.min(1, Math.max(0, velocity / 127));
}
