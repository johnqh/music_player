import { describe, expect, it } from 'vitest';
import { SoundingSet } from './sounding-set.js';
import type { PlaybackNote as ScheduledNote } from '@sudobility/music_types';

/** Ticks are seconds here, so the arithmetic in the assertions is readable. */
const seconds = (tick: number) => tick;

function note(noteId: string, tick: number, durTicks: number): ScheduledNote {
  return { noteId, tick, durTicks, midi: 60, velocity: 80, trackId: 't' };
}

function loaded(notes: ScheduledNote[]) {
  const set = new SoundingSet();
  set.load(notes, seconds);
  return set;
}

/** Ids only, so the assertions stay about *which* notes sound, not their payload. */
const ids = (notes: ReturnType<SoundingSet['advanceTo']>) =>
  notes?.map(n => n.noteId) ?? null;

describe('SoundingSet', () => {
  it('reports a note from its start until its end', () => {
    const set = loaded([note('a', 0, 2)]);
    expect(ids(set.advanceTo(0))).toEqual(['a']);
    expect(set.advanceTo(1)).toBeNull();
    expect(ids(set.advanceTo(2))).toEqual([]);
  });

  it('returns null while nothing changes, so a held chord emits once', () => {
    const set = loaded([note('a', 0, 10), note('b', 0, 10)]);
    expect(ids(set.advanceTo(0))!.sort()).toEqual(['a', 'b']);
    expect(set.advanceTo(1)).toBeNull();
    expect(set.advanceTo(2)).toBeNull();
    expect(set.advanceTo(3)).toBeNull();
  });

  it('handles a short note starting after a long one and ending before it', () => {
    const set = loaded([note('long', 0, 10), note('short', 2, 1)]);
    expect(ids(set.advanceTo(0))).toEqual(['long']);
    expect(ids(set.advanceTo(2))!.sort()).toEqual(['long', 'short']);
    expect(ids(set.advanceTo(3))).toEqual(['long']);
    expect(ids(set.advanceTo(10))).toEqual([]);
  });

  it('emits on the first call after a reset even if the set is the same', () => {
    const set = loaded([note('a', 0, 10)]);
    expect(ids(set.advanceTo(0))).toEqual(['a']);
    set.reset(0);
    expect(ids(set.advanceTo(0))).toEqual(['a']);
  });

  it('clears everything on reset, matching the engine silencing the synth on a seek', () => {
    const set = loaded([note('a', 0, 10)]);
    set.advanceTo(1);
    set.reset(5);
    // 'a' spans tick 5 but was not restarted, exactly as no voice is sounding
    // after allSoundOff.
    expect(ids(set.advanceTo(5))).toEqual([]);
  });

  it('reports its size, which is the concurrent voice count', () => {
    const set = loaded([note('a', 0, 10), note('b', 0, 10), note('c', 5, 1)]);
    set.advanceTo(0);
    expect(set.size).toBe(2);
    set.advanceTo(5);
    expect(set.size).toBe(3);
    set.advanceTo(6);
    expect(set.size).toBe(2);
  });

  it('carries the track and pitch the scheduler already knew', () => {
    // The whole point of resolving here: a consumer used to search the entire
    // score per sounding note to get these back.
    const set = new SoundingSet();
    set.load(
      [
        {
          noteId: 'a',
          tick: 0,
          durTicks: 4,
          midi: 67,
          velocity: 80,
          trackId: 'viola',
        },
      ],
      seconds
    );
    expect(set.advanceTo(0)).toEqual([
      { noteId: 'a', trackId: 'viola', midi: 67 },
    ]);
  });

  it('is empty for a score with no notes', () => {
    const set = loaded([]);
    expect(ids(set.advanceTo(0))).toEqual([]);
    expect(set.advanceTo(1)).toBeNull();
  });
});
