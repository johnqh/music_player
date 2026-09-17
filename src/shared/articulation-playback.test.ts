/**
 * Articulations reaching the notes that actually sound.
 *
 * `articulation.test.ts` pins the resolution itself; these pin its arrival in
 * `flattenScoreNotes`, which is the traversal live playback and offline export
 * share — so a marking that passes here cannot be audible in one and silent in
 * the other.
 */
import { describe, expect, it } from 'vitest';
import type { Articulation, Score } from '@sudobility/music_types';
import { isNoteEvent } from '@sudobility/music_types';
import { twinkleScore } from '@sudobility/music_types/test';
import { playbackPlan } from '@sudobility/music_player/core';
import { flattenScoreNotes } from '@sudobility/music_types';

/** Marks every note of the first track, so a whole part plays articulated. */
function scoreMarked(articulation: Articulation): Score {
  const score = twinkleScore();
  return {
    ...score,
    tracks: score.tracks.map((track, i) =>
      i !== 0
        ? track
        : {
            ...track,
            measures: track.measures.map(m => ({
              ...m,
              voices: m.voices.map(v => ({
                ...v,
                events: v.events.map(e =>
                  isNoteEvent(e) ? { ...e, articulation } : e
                ),
              })),
            })),
          }
    ),
  };
}

const firstTrackId = twinkleScore().tracks[0].id;

function firstTrackNotes(score: Score) {
  return flattenScoreNotes(score).filter(n => n.trackId === firstTrackId);
}

describe('articulations in flattenScoreNotes', () => {
  it('leaves an unmarked score exactly as it played before articulations sounded', () => {
    // The rule the dynamics work established, and the one most worth pinning:
    // adding this feature must not change a single existing score. Asserted
    // against what the score actually says rather than against another call to
    // the same function, which would only prove the function is deterministic.
    const score = twinkleScore();
    const written = new Map<string, { dur: number; velocity: number }>();
    for (const track of score.tracks) {
      for (const measure of track.measures) {
        for (const voice of measure.voices) {
          for (const event of voice.events) {
            if (isNoteEvent(event)) {
              written.set(event.id, {
                dur: event.durationTicks,
                velocity: event.velocity,
              });
            }
          }
        }
      }
    }

    const flat = flattenScoreNotes(score);
    const compared = flat.filter(n => written.has(n.noteId));
    expect(compared.length).toBeGreaterThan(0);

    for (const note of compared) {
      const source = written.get(note.noteId)!;
      expect(note.durTicks).toBe(source.dur);
      expect(note.velocity).toBe(source.velocity);
    }
  });

  it('shortens staccato notes', () => {
    const plain = firstTrackNotes(twinkleScore());
    const marked = firstTrackNotes(scoreMarked('staccato'));

    expect(marked).toHaveLength(plain.length);
    expect(marked.every((n, i) => n.durTicks < plain[i].durTicks)).toBe(true);
  });

  it('does not move anything when it shortens', () => {
    // A staccato note releases early but still occupies its written length, so
    // the bar adds up and every following note starts where it did. This is
    // what keeps the marking a performance detail rather than an edit.
    const plain = firstTrackNotes(twinkleScore());
    const marked = firstTrackNotes(scoreMarked('staccato'));

    expect(marked.map(n => n.tick)).toEqual(plain.map(n => n.tick));
    expect(marked.map(n => n.midi)).toEqual(plain.map(n => n.midi));
  });

  it('makes an accent louder without shortening it', () => {
    const plain = firstTrackNotes(twinkleScore());
    const marked = firstTrackNotes(scoreMarked('accent'));

    expect(marked.every((n, i) => n.velocity > plain[i].velocity)).toBe(true);
    expect(marked.map(n => n.durTicks)).toEqual(plain.map(n => n.durTicks));
  });

  it('leaves velocity alone for staccato', () => {
    const plain = firstTrackNotes(twinkleScore());
    const marked = firstTrackNotes(scoreMarked('staccato'));

    expect(marked.map(n => n.velocity)).toEqual(plain.map(n => n.velocity));
  });

  it('reaches the plan the engine is actually handed', () => {
    // flattenScoreNotes is a step, not the destination: the plan re-times
    // notes along the performance timeline and re-ids second-pass ones. If
    // that step dropped the shortening, articulations would be audible in the
    // tests and silent in the app.
    const plainPlan = playbackPlan(twinkleScore()).notes.filter(
      n => n.trackId === firstTrackId
    );
    const markedPlan = playbackPlan(scoreMarked('staccato')).notes.filter(
      n => n.trackId === firstTrackId
    );

    expect(markedPlan).toHaveLength(plainPlan.length);
    expect(markedPlan.length).toBeGreaterThan(0);
    expect(markedPlan.every((n, i) => n.durTicks < plainPlan[i].durTicks)).toBe(
      true
    );
    // Still in the same places: shortening is a release, not a re-timing.
    expect(markedPlan.map(n => n.tick)).toEqual(plainPlan.map(n => n.tick));
  });

  it('marks only the track that carries the marking', () => {
    // The marking is per note, so a second part must be untouched.
    const marked = scoreMarked('staccato');
    const otherTrackId = marked.tracks[1]?.id;
    if (!otherTrackId) return;

    const before = flattenScoreNotes(twinkleScore()).filter(
      n => n.trackId === otherTrackId
    );
    const after = flattenScoreNotes(marked).filter(
      n => n.trackId === otherTrackId
    );
    expect(after).toEqual(before);
  });
});
