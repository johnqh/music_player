/**
 * Repeats in playback: the plan is expanded, and the mapping brings a
 * performance position back to the written bar it came from.
 */
import { describe, expect, it } from 'vitest';
import { changeRepeatsCommand } from '@sudobility/music_types';
import { sourceTickFor } from '@sudobility/music_types';
import { twinkleScore } from '../test/fixtures.js';
import { playbackPlan } from './plan.js';

/** Twinkle with its first two bars repeated. */
function repeated() {
  const base = twinkleScore();
  const bars = base.tracks[0].measures;
  const withStart = changeRepeatsCommand(
    bars[0].id,
    { repeatStart: true },
    'R'
  ).execute(base);
  return changeRepeatsCommand(
    withStart.tracks[0].measures[1].id,
    { repeatEnd: true },
    'R'
  ).execute(withStart);
}

describe('playbackPlan with repeats', () => {
  it('leaves an unrepeated score exactly as it was', () => {
    // The property that makes this safe to land on every existing project.
    const plain = playbackPlan(twinkleScore());
    const notes = plain.notes;

    expect(plain.timeline.segments).toHaveLength(1);
    expect(notes.every(n => n.tick >= 0)).toBe(true);
    expect(plain.durationTicks).toBe(
      notes.reduce((n, note) => Math.max(n, note.tick + note.durTicks), 0)
    );
  });

  it('sounds the repeated bars a second time', () => {
    const plain = playbackPlan(twinkleScore());
    const looped = playbackPlan(repeated());

    expect(looped.notes.length).toBeGreaterThan(plain.notes.length);
    expect(looped.durationTicks).toBeGreaterThan(plain.durationTicks);
  });

  it('gives the second pass its own note ids', () => {
    // The caret lights a note by id; one written note sounding twice must not
    // light both places at once.
    const looped = playbackPlan(repeated());
    const ids = looped.notes.map(n => n.noteId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some(id => id.includes('#2'))).toBe(true);
  });

  it('maps a second-pass position back to the written bar', () => {
    const score = repeated();
    const plan = playbackPlan(score);
    const barTicks = score.tracks[0].measures[0].durationTicks;

    // Two bars in is the start of the second pass, which is written bar 1.
    expect(sourceTickFor(plan.timeline, barTicks * 2)).toBe(0);
    // ...and never past the end of the written score.
    const written = score.tracks[0].measures.reduce(
      (n, m) => Math.max(n, m.startTick + m.durationTicks),
      0
    );
    for (let tick = 0; tick < plan.durationTicks; tick += barTicks / 2) {
      expect(sourceTickFor(plan.timeline, tick)).toBeLessThan(written);
    }
  });

  it('repeats the metronome too, so the click follows the music', () => {
    const plain = playbackPlan(twinkleScore());
    const looped = playbackPlan(repeated());
    expect(looped.clicks.length).toBeGreaterThan(plain.clicks.length);
  });
});
