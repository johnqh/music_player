/**
 * Which notes are sounding at a given moment, by two monotonic cursors.
 *
 * Replaces deriving the set from a list of pending note-offs the pump walked
 * every tick — a list that no longer exists, because releases happen in the
 * worklet now. One cursor over notes by start, one over the same notes by end;
 * both only ever move forward, so a step costs the number of notes that
 * actually started or stopped rather than the size of the score.
 *
 * `advanceTo` returns `null` when nothing changed, which is the point. The
 * engine used to hand its observer a freshly-allocated array twenty times a
 * second whether or not a single note had begun or ended, waking every
 * consumer downstream — notation colour, the piano keyboard's key lights — for
 * nothing.
 */
import type { SoundingNote } from '@sudobility/music_types';
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

export class SoundingSet {
  private byStart: Array<{ note: SoundingNote; startSeconds: number }> = [];
  private byEnd: Array<{ noteId: string; endSeconds: number }> = [];
  private startCursor = 0;
  private endCursor = 0;
  /**
   * Keyed by note id so an end can remove the right entry, valued by the
   * resolved note so a consumer never has to search the score for the track and
   * pitch the scheduler already knew.
   */
  private sounding = new Map<string, SoundingNote>();
  /** Forces the next `advanceTo` to emit, so a reset is always observable. */
  private dirty = true;

  load(
    notes: readonly ScheduledNote[],
    secondsForTick: (tick: number) => number
  ): void {
    this.byStart = notes
      .map(n => ({
        note: { noteId: n.noteId, trackId: n.trackId, midi: n.midi },
        startSeconds: secondsForTick(n.tick),
      }))
      .sort((a, b) => a.startSeconds - b.startSeconds);
    this.byEnd = notes
      .map(n => ({
        noteId: n.noteId,
        endSeconds: secondsForTick(n.tick + n.durTicks),
      }))
      .sort((a, b) => a.endSeconds - b.endSeconds);
    this.reset(0);
  }

  /**
   * Drops everything sounding and moves both cursors to `positionSeconds`.
   *
   * A note spanning that moment is deliberately *not* restored: the engine
   * silences the synth on every seek and stop, so nothing is audible there
   * either. Highlighting a note that is not sounding would be a lie.
   */
  reset(positionSeconds: number): void {
    this.sounding.clear();
    this.startCursor = lowerBound(
      this.byStart,
      positionSeconds,
      e => e.startSeconds
    );
    this.endCursor = lowerBound(this.byEnd, positionSeconds, e => e.endSeconds);
    this.dirty = true;
  }

  /** The ids sounding at `positionSeconds`, or `null` if they are what they were. */
  advanceTo(positionSeconds: number): SoundingNote[] | null {
    let changed = this.dirty;
    this.dirty = false;

    while (
      this.startCursor < this.byStart.length &&
      this.byStart[this.startCursor].startSeconds <= positionSeconds
    ) {
      const { note } = this.byStart[this.startCursor];
      this.sounding.set(note.noteId, note);
      this.startCursor += 1;
      changed = true;
    }
    while (
      this.endCursor < this.byEnd.length &&
      this.byEnd[this.endCursor].endSeconds <= positionSeconds
    ) {
      // Deleting an id that was never added — its start was skipped by a reset
      // — is a no-op, which is what makes seeking into a held note safe.
      if (this.sounding.delete(this.byEnd[this.endCursor].noteId))
        changed = true;
      this.endCursor += 1;
    }

    return changed ? [...this.sounding.values()] : null;
  }

  /** How many notes are sounding. */
  get size(): number {
    return this.sounding.size;
  }
}

/** First index whose key is >= `value`. */
function lowerBound<T>(
  items: readonly T[],
  value: number,
  key: (item: T) => number
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
