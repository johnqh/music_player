import { describe, expect, it } from 'vitest';
import { playbackPlan } from './plan.js';
import { createEmptyScore } from '@sudobility/music_types';
import { addNoteCommand } from '@sudobility/music_types';
import { renderEvents } from './render-events.js';
import { twinkleScore } from '@sudobility/music_types/test';
import type { Measure, NoteEvent, Pitch, Score } from '@sudobility/music_types';

const pitch = (step: string, octave = 4): Pitch =>
  ({ step, accidental: 0, octave }) as unknown as Pitch;

/** Two tracks; track 0 has C4 on beat 1, track 1 has G3 on beat 2. */
function twoTrack(): Score {
  const base = createEmptyScore({
    title: 'Render',
    measures: 2,
    tracks: [
      { name: 'A', instrumentName: 'A', clef: 'treble' as const },
      { name: 'B', instrumentName: 'B', clef: 'bass' as const },
    ],
  });
  const withA = addNoteCommand(
    {
      trackId: base.tracks[0].id,
      measureId: base.tracks[0].measures[0].id,
      voiceIndex: 0,
      pitch: pitch('C'),
      startTick: 0,
      durationTicks: base.ppq,
    },
    'Add note'
  ).execute(base);
  return addNoteCommand(
    {
      trackId: withA.tracks[1].id,
      measureId: withA.tracks[1].measures[0].id,
      voiceIndex: 0,
      pitch: pitch('G', 3),
      startTick: base.ppq,
      durationTicks: base.ppq,
    },
    'Add note'
  ).execute(withA);
}

describe('renderEvents: matching what playback does', () => {
  // The export used to disagree with playback on three counts: it dropped
  // `volume` and `pan` entirely, resolved the voice from `midiProgram` alone
  // while playback preferred it only when set, and read percussion off the
  // MIDI channel while playback reads the clef. A rendered file therefore had
  // a different balance, and sometimes different instruments, from what the
  // user had just listened to.

  it('carries every track, so the renderer can size headroom as playback does', () => {
    // One score, built once: `twoTrack()` mints fresh ids on every call.
    const score = twoTrack();
    const { tracks } = renderEvents(score);
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t: { id: string }) => t.id)).toEqual(
      score.tracks.map(t => t.id)
    );
  });

  it('keeps muted and silent tracks in the track list, and only drops their notes', () => {
    // Playback builds a channel for every track whatever its mute state, and
    // its master trim is sized by that count. An export that listed only the
    // audible ones would come out louder than what was heard.
    const score = twoTrack();
    const muted: Score = {
      ...score,
      tracks: [{ ...score.tracks[0], muted: true }, score.tracks[1]],
    };
    const { tracks, events } = renderEvents(muted);
    expect(tracks).toHaveLength(2);
    expect(
      events.every((e: { trackId: string }) => e.trackId === muted.tracks[1].id)
    ).toBe(true);
  });

  it('passes each track its volume and pan', () => {
    const score = twoTrack();
    const mixed: Score = {
      ...score,
      tracks: [
        { ...score.tracks[0], volume: 0.42, pan: -0.75 },
        { ...score.tracks[1], volume: 0.9, pan: 0.5 },
      ],
    };
    const { tracks } = renderEvents(mixed);
    expect(tracks[0]).toMatchObject({ volume: 0.42, pan: -0.75 });
    expect(tracks[1]).toMatchObject({ volume: 0.9, pan: 0.5 });
  });

  it('reads percussion off the clef, the same signal playback uses', () => {
    // Not the MIDI channel: a percussion-clef track is the score stating
    // outright that it is a kit, and a GM drum track's program and channel are
    // not always what convention would suggest.
    const score = twoTrack();
    const drums: Score = {
      ...score,
      tracks: [
        { ...score.tracks[0], clef: 'percussion', midiChannel: 0 },
        score.tracks[1],
      ],
    };
    const { tracks } = renderEvents(drums);
    expect(tracks[0].isPercussion).toBe(true);
    expect(tracks[1].isPercussion).toBe(false);
  });

  it('hands the renderer both program and name, so it can pick the voice playback would', () => {
    const { tracks } = renderEvents(twoTrack());
    expect(tracks[0]).toMatchObject({
      midiProgram: expect.any(Number),
      instrumentName: expect.any(String),
    });
  });

  it('tags every event with the track it belongs to', () => {
    const score = twoTrack();
    const { events } = renderEvents(score);
    expect(events.map((e: { trackId: string }) => e.trackId)).toEqual([
      score.tracks[0].id,
      score.tracks[1].id,
    ]);
  });
});

describe('renderEvents', () => {
  it('turns every sounding note into a timed event', () => {
    const { events } = renderEvents(twoTrack());
    expect(events).toHaveLength(2);
    expect(events.map(e => e.midi)).toEqual([60, 55]);
  });

  it('places events in seconds, in order', () => {
    // 120bpm default, so a quarter note is half a second.
    const { events } = renderEvents(twoTrack());
    expect(events[0].startSec).toBeCloseTo(0, 5);
    expect(events[1].startSec).toBeCloseTo(0.5, 5);
    expect(events[0].durationSec).toBeCloseTo(0.5, 5);
  });

  it('skips a muted track', () => {
    // An export that ignored mute would not match what you just heard.
    const score = twoTrack();
    const muted: Score = {
      ...score,
      tracks: score.tracks.map((t, i) => (i === 0 ? { ...t, muted: true } : t)),
    };
    expect(renderEvents(muted).events.map(e => e.midi)).toEqual([55]);
  });

  it('plays only soloed tracks when anything is soloed', () => {
    const score = twoTrack();
    const soloed: Score = {
      ...score,
      tracks: score.tracks.map((t, i) => (i === 0 ? { ...t, solo: true } : t)),
    };
    expect(renderEvents(soloed).events.map(e => e.midi)).toEqual([60]);
  });

  it('lets solo win over mute on the same track', () => {
    const score = twoTrack();
    const both: Score = {
      ...score,
      tracks: score.tracks.map((t, i) =>
        i === 0 ? { ...t, solo: true, muted: true } : t
      ),
    };
    expect(renderEvents(both).events.map(e => e.midi)).toEqual([60]);
  });

  it('leaves a tail so the last note is not cut off', () => {
    const { events, durationSec } = renderEvents(twoTrack());
    const lastEnd = Math.max(...events.map(e => e.startSec + e.durationSec));
    expect(durationSec).toBeGreaterThan(lastEnd);
  });

  it('gives an empty score a renderable, non-zero length', () => {
    const empty = createEmptyScore({
      title: 'E',
      measures: 1,
      tracks: [{ name: 'A' }],
    });
    const plan = renderEvents(empty);
    expect(plan.events).toEqual([]);
    expect(plan.durationSec).toBeGreaterThan(0);
  });

  it('normalises velocity into 0..1 for the synth', () => {
    for (const e of renderEvents(twoTrack()).events) {
      expect(e.velocity).toBeGreaterThan(0);
      expect(e.velocity).toBeLessThanOrEqual(1);
    }
  });
});

describe('parity with live playback', () => {
  /** One track, one voice, with a note tied across the barline. */
  function tiedScore(): Score {
    const base = twinkleScore();
    const trackId = base.tracks[0].id;
    const voiceId = 'v1';
    const note = (
      over: Partial<NoteEvent> & { id: string; startTick: number }
    ): NoteEvent => ({
      pitch: { step: 'C', accidental: 0, octave: 4 },
      durationTicks: 480,
      velocity: 90,
      voiceId,
      trackId,
      ...over,
    });
    const measures: Measure[] = [0, 1].map(i => ({
      id: `m${i}`,
      index: i,
      startTick: i * 1920,
      durationTicks: 1920,
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { fifths: 0, mode: 'major' as const },
      voices: [
        {
          id: voiceId,
          name: 'V1',
          events:
            i === 0
              ? [note({ id: 'a', startTick: 1440, tieStart: true })]
              : [note({ id: 'b', startTick: 1920, tieStop: true })],
        },
      ],
    }));
    return { ...base, tracks: [{ ...base.tracks[0], measures }] };
  }

  it('sustains a tied note rather than re-articulating it', () => {
    // Measured before the fix: playback sounded one note of 960 ticks while the
    // export emitted two of 0.5s. An export must match what you just heard.
    const events = renderEvents(tiedScore()).events;
    expect(events).toHaveLength(1);
    expect(events[0].durationSec).toBeCloseTo(1, 5);
  });

  it('emits exactly the notes live playback schedules', () => {
    const score = tiedScore();
    expect(renderEvents(score).events).toHaveLength(
      playbackPlan(score).notes.length
    );
  });
});
