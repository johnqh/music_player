/**
 * The notes of a score, in time order, with a cursor.
 *
 * Replaces scheduling every note up front. The old engine handed the whole
 * piece to Tone's Transport as individual events — some 11,500 of them for a
 * three-minute arrangement — and every seek, edit or tempo change cancelled
 * and rebuilt all of it. Here a seek is a binary search and a cursor move,
 * whatever the length of the piece.
 *
 * Deliberately knows nothing about time in seconds: ticks are the score's own
 * unit, and converting them depends on the tempo map and the playback-speed
 * multiplier, both of which belong to the engine.
 */
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

export class NoteQueue {
  private notes: ScheduledNote[] = [];
  private cursor = 0;

  load(notes: readonly ScheduledNote[]): void {
    this.notes = [...notes].sort((a, b) => a.tick - b.tick);
    this.cursor = 0;
  }

  /**
   * Moves the cursor to the first note at or after `tick`.
   *
   * Binary search rather than a scan: this runs on every seek, and a scan
   * would make seeking cost more the further into the piece you go.
   */
  seekToTick(tick: number): void {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].tick < tick) lo = mid + 1;
      else hi = mid;
    }
    this.cursor = lo;
  }

  /**
   * Every not-yet-returned note starting at or before `tick`, up to `maxCount`
   * of them, advancing the cursor past what it returns.
   *
   * The cap bounds one pump tick's cost. On the web engine each note becomes a
   * `postMessage` to the worklet sequencer, and a four-second horizon over a
   * two-hundred-track score is thousands of them; whatever the cap leaves
   * behind is picked up 50ms later, long before it is due.
   *
   * Unbounded by default, because the React Native sample engine drains its
   * whole horizon in one go — it posts nothing across a thread boundary, so it
   * has nothing to bound.
   */
  drainUntil(
    tick: number,
    maxCount = Number.MAX_SAFE_INTEGER
  ): ScheduledNote[] {
    const out: ScheduledNote[] = [];
    while (
      out.length < maxCount &&
      this.cursor < this.notes.length &&
      this.notes[this.cursor].tick <= tick
    ) {
      out.push(this.notes[this.cursor]);
      this.cursor += 1;
    }
    return out;
  }

  /** True once every note has been drained — how the engine knows the piece is over. */
  get exhausted(): boolean {
    return this.cursor >= this.notes.length;
  }
}
