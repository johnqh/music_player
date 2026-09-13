/**
 * The small timing and weight a player puts on notes, applied at playback.
 *
 * Every generated note sits exactly on the grid at a flat velocity, and that is
 * a large part of why generated music sounds mechanical: no drummer lands every
 * snare on the same tick, no bassist plays every note at one weight. This adds
 * the feel back when the score is SOUNDED, never to the score itself — moving
 * stored notes off the grid would break the notation into tuplets and ties for
 * a difference measured in milliseconds.
 *
 * Deterministic on purpose: every offset comes from a hash of the note's id, so
 * a piece sounds the same every time it is played, and live playback and the
 * exported audio file cannot differ. MIDI export stays exact, which is what a
 * DAW user importing the file wants.
 *
 * The amounts are small and stated in ticks at 480 per quarter, scaled to the
 * score's ppq. At 120 bpm one such tick is about a millisecond.
 */
import { isPercussionTrack, gmFamilyOf } from '@sudobility/music_types';
import type { Score } from '@sudobility/music_types';

export type HumanizableNote = {
  tick: number;
  durTicks: number;
  midi: number;
  velocity: number;
  trackId: string;
  noteId: string;
};

/** How far any note may drift either way, in 480ths of a quarter. */
const JITTER = 3;
/** A snare or clap on the backbeat lands this much late: laid back. */
const SNARE_LAY_BACK = 6;
/** A bass note lands this much early: pushing the beat. */
const BASS_PUSH = 4;
/** How much lighter an off-beat hi-hat is than an on-beat one. */
const HAT_OFFBEAT_LIGHTER = 10;
/** How far velocity drifts either way. */
const VELOCITY_JITTER = 5;

const SNARES = new Set([37, 38, 39, 40]);
const HATS = new Set([42, 44, 46]);

/** Two stable values in [-1, 1] from a note id (FNV-1a). */
function drift(id: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const a = ((h >>> 0) % 2001) / 1000 - 1;
  const b = (((h >>> 11) >>> 0) % 2001) / 1000 - 1;
  return [a, b];
}

export function humanizeNotes<T extends HumanizableNote>(
  notes: readonly T[],
  score: Score
): T[] {
  const unit = score.ppq / 480;
  const kind = new Map(
    score.tracks.map(track => [
      track.id,
      isPercussionTrack(track)
        ? 'drums'
        : track.clef === 'bass' || gmFamilyOf(track.midiProgram) === 'bass'
          ? 'bass'
          : 'other',
    ])
  );
  const beat = score.ppq;
  const half = score.ppq / 2;

  return notes
    .map(note => {
      const [t, v] = drift(note.noteId);
      const role = kind.get(note.trackId) ?? 'other';
      let shift = t * JITTER * unit;
      let velocity = note.velocity + v * VELOCITY_JITTER;
      if (role === 'drums') {
        const onBeat = note.tick % beat === 0;
        const offBeat = note.tick % beat === half;
        if (SNARES.has(note.midi) && onBeat) shift += SNARE_LAY_BACK * unit;
        if (HATS.has(note.midi) && offBeat) velocity -= HAT_OFFBEAT_LIGHTER;
      } else if (role === 'bass') {
        shift -= BASS_PUSH * unit;
      }
      return {
        ...note,
        tick: Math.max(0, Math.round(note.tick + shift)),
        velocity: Math.max(1, Math.min(127, Math.round(velocity))),
      };
    })
    .sort((a, b) => a.tick - b.tick);
}
