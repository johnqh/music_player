import { describe, expect, it } from 'vitest';
import { NoteQueue } from './note-queue.js';
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

const note = (tick: number, id: string): ScheduledNote => ({
  tick,
  durTicks: 480,
  midi: 60,
  velocity: 90,
  trackId: 't1',
  noteId: id,
});

describe('NoteQueue', () => {
  it('returns only notes starting at or before the drain point, once each', () => {
    // The cursor is the point: draining twice must not sound a note twice.
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b'), note(960, 'c')]);
    expect(q.drainUntil(480).map(n => n.noteId)).toEqual(['a', 'b']);
    expect(q.drainUntil(480).map(n => n.noteId)).toEqual([]);
    expect(q.drainUntil(960).map(n => n.noteId)).toEqual(['c']);
  });

  it('sorts on load, so callers need not', () => {
    const q = new NoteQueue();
    q.load([note(960, 'c'), note(0, 'a')]);
    expect(q.drainUntil(9999).map(n => n.noteId)).toEqual(['a', 'c']);
  });

  it('seeking moves the cursor without rescheduling anything', () => {
    // What this buys: seeking a 200-second piece used to mean cancelling and
    // rebuilding some 11,500 scheduled events.
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b'), note(960, 'c')]);
    q.seekToTick(480);
    expect(q.drainUntil(9999).map(n => n.noteId)).toEqual(['b', 'c']);
  });

  it('seeking backwards replays the notes it moved behind', () => {
    const q = new NoteQueue();
    q.load([note(0, 'a'), note(480, 'b')]);
    q.drainUntil(9999);
    q.seekToTick(0);
    expect(q.drainUntil(9999).map(n => n.noteId)).toEqual(['a', 'b']);
  });

  it('reports exhaustion so the caller can stop at the end', () => {
    const q = new NoteQueue();
    q.load([note(0, 'a')]);
    expect(q.exhausted).toBe(false);
    q.drainUntil(9999);
    expect(q.exhausted).toBe(true);
  });

  it('is empty, not broken, before anything is loaded', () => {
    const q = new NoteQueue();
    expect(q.drainUntil(9999)).toEqual([]);
    expect(q.exhausted).toBe(true);
  });
});

describe('NoteQueue: capped drain', () => {
  it('drains no more than maxCount, leaving the rest for the next call', () => {
    const queue = new NoteQueue();
    queue.load(
      Array.from({ length: 10 }, (_, i) => ({
        tick: i,
        durTicks: 1,
        midi: 60,
        velocity: 80,
        trackId: 't',
        noteId: `n${i}`,
      }))
    );
    expect(queue.drainUntil(100, 4).map(n => n.noteId)).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
    ]);
    expect(queue.drainUntil(100, 4).map(n => n.noteId)).toEqual([
      'n4',
      'n5',
      'n6',
      'n7',
    ]);
    expect(queue.exhausted).toBe(false);
    expect(queue.drainUntil(100, 4).map(n => n.noteId)).toEqual(['n8', 'n9']);
    expect(queue.exhausted).toBe(true);
  });
});
