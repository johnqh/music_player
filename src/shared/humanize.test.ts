import { describe, expect, it } from 'vitest';
import type { Score } from '@sudobility/music_types';
import { humanizeNotes } from './humanize.js';

/** Only what humanizing reads: the ppq and each track's id, clef and program. */
const score = (): Score =>
  ({
    ppq: 480,
    tracks: [
      { id: 'kit', clef: 'percussion', midiProgram: 0, measures: [] },
      { id: 'bass', clef: 'bass', midiProgram: 33, measures: [] },
      { id: 'piano', clef: 'treble', midiProgram: 0, measures: [] },
    ],
  }) as unknown as Score;
const note = (trackId: string, midi: number, tick: number, noteId: string) => ({
  trackId,
  midi,
  tick,
  durTicks: 240,
  velocity: 80,
  noteId,
});

describe('humanizeNotes', () => {
  it('is the same every time for the same notes', () => {
    const notes = [note('piano', 60, 960, 'a'), note('bass', 36, 480, 'b')];
    expect(humanizeNotes(notes, score())).toEqual(
      humanizeNotes(notes, score())
    );
  });

  it('lays a backbeat snare back and pushes the bass ahead, on average', () => {
    const snares = Array.from({ length: 40 }, (_, i) =>
      note('kit', 38, 480 * (2 * i + 1), `s${i}`)
    );
    const basses = Array.from({ length: 40 }, (_, i) =>
      note('bass', 36, 480 * (2 * i + 1), `b${i}`)
    );
    const mean = (ns: { tick: number }[], orig: { tick: number }[]) =>
      ns.reduce((sum, n, i) => sum + (n.tick - orig[i].tick), 0) / ns.length;
    const s = humanizeNotes(snares, score()).sort((a, b) =>
      a.noteId.localeCompare(b.noteId)
    );
    const b = humanizeNotes(basses, score()).sort((a, b2) =>
      a.noteId.localeCompare(b2.noteId)
    );
    const sortedS = [...snares].sort((a, b2) =>
      a.noteId.localeCompare(b2.noteId)
    );
    const sortedB = [...basses].sort((a, b2) =>
      a.noteId.localeCompare(b2.noteId)
    );
    expect(mean(s, sortedS)).toBeGreaterThan(3);
    expect(mean(b, sortedB)).toBeLessThan(-2);
  });

  it('moves no note more than a few milliseconds, never before zero, and keeps velocity in range', () => {
    const notes = Array.from({ length: 200 }, (_, i) => ({
      ...note('piano', 60, i * 120, `p${i}`),
      velocity: i % 2 ? 127 : 1,
    }));
    const out = humanizeNotes(notes, score());
    for (const n of out) {
      const orig = notes.find(o => o.noteId === n.noteId)!;
      expect(Math.abs(n.tick - orig.tick)).toBeLessThanOrEqual(10);
      expect(n.tick).toBeGreaterThanOrEqual(0);
      expect(n.velocity).toBeGreaterThanOrEqual(1);
      expect(n.velocity).toBeLessThanOrEqual(127);
    }
  });
});
