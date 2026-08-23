import { describe, expect, it } from 'vitest';
import { planDispatch } from './pump-window.js';
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

const note = (tick: number, id: string): ScheduledNote => ({
  tick,
  durTicks: 240,
  midi: 60,
  velocity: 90,
  trackId: 't',
  noteId: id,
});

/** One beat per second, so ticks read directly as seconds in these tests. */
const secondsForTick = (tick: number): number => tick / 480;

describe('planDispatch', () => {
  it('stamps each note with the moment it should sound', () => {
    const { due } = planDispatch({
      notes: [note(480, 'a')],
      secondsForTick,
      positionSeconds: 0.5,
      graceSeconds: 0.2,
    });
    expect(due).toEqual([{ note: note(480, 'a'), atSeconds: 1 }]);
  });

  it('skips a note long past due rather than firing it late', () => {
    // The failure this prevents: after a main-thread stall, the backlog
    // arrives at once and the passage garbles.
    const { due, skipped } = planDispatch({
      notes: [note(0, 'old')],
      secondsForTick,
      positionSeconds: 5,
      graceSeconds: 0.2,
    });
    expect(due).toEqual([]);
    expect(skipped.map(n => n.noteId)).toEqual(['old']);
  });

  it('still plays a note only slightly late, since the ear will not notice', () => {
    const { due, skipped } = planDispatch({
      notes: [note(480, 'a')],
      secondsForTick,
      positionSeconds: 1.1,
      graceSeconds: 0.2,
    });
    expect(due.map(d => d.note.noteId)).toEqual(['a']);
    expect(skipped).toEqual([]);
  });

  it('keeps notes that are still in the future', () => {
    const { due, skipped } = planDispatch({
      notes: [note(960, 'later')],
      secondsForTick,
      positionSeconds: 0,
      graceSeconds: 0.2,
    });
    expect(due.map(d => d.note.noteId)).toEqual(['later']);
    expect(skipped).toEqual([]);
  });

  it('splits a mixed batch, so one stale note does not cost the punctual ones', () => {
    const { due, skipped } = planDispatch({
      notes: [note(0, 'stale'), note(480, 'ok'), note(960, 'soon')],
      secondsForTick,
      positionSeconds: 1,
      graceSeconds: 0.2,
    });
    expect(due.map(d => d.note.noteId)).toEqual(['ok', 'soon']);
    expect(skipped.map(n => n.noteId)).toEqual(['stale']);
  });
});
