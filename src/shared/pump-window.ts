/**
 * What the pump does with the notes it drained, as pure logic.
 *
 * Kept apart from the posting so the rule that matters can be tested without
 * an audio device: a note whose moment has already passed by more than the
 * grace window is skipped rather than fired late.
 *
 * That rule is the one deliberate exception to "no note is ever dropped", and
 * it earns its place. Without it, a main-thread stall turns into a backlog
 * that arrives in a single burst — every note that should have been spread
 * over the stall landing at once. Late notes are worse than absent ones: the
 * absent one is a gap, the burst is a garble across every part at once.
 *
 * A note only slightly late is still played, because the ear will not notice
 * and dropping it would be gratuitous.
 *
 * **The React Native sample engine is now its only consumer.** The web engine
 * hands a four-second horizon of self-releasing notes to the fluidsynth
 * sequencer instead, so nothing there is ever dispatched late enough to need
 * skipping — see `soundfont-engine.ts`'s `HORIZON_SECONDS`. RN has no sequencer
 * to hand a horizon to and keeps this model.
 */
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

export type Dispatch = { note: ScheduledNote; atSeconds: number };

export function planDispatch({
  notes,
  secondsForTick,
  positionSeconds,
  graceSeconds,
}: {
  notes: readonly ScheduledNote[];
  /** Tick to playback seconds — the engine's, since it owns the tempo map and speed. */
  secondsForTick: (tick: number) => number;
  positionSeconds: number;
  graceSeconds: number;
}): { due: Dispatch[]; skipped: ScheduledNote[] } {
  const due: Dispatch[] = [];
  const skipped: ScheduledNote[] = [];
  for (const note of notes) {
    const atSeconds = secondsForTick(note.tick);
    if (positionSeconds - atSeconds > graceSeconds) skipped.push(note);
    else due.push({ note, atSeconds });
  }
  return { due, skipped };
}
