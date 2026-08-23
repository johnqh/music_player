/**
 * Hand-built `PlaybackPlan`s for engine tests.
 *
 * The engines take a plan, not a score, so their tests build one directly
 * rather than importing a score fixture and a converter from music_lib —
 * which is what kept the platform layer depending on the domain. A plan is
 * plain data, so this is also clearer: a test that needs two notes says so
 * instead of asserting against whatever a fixture happens to contain.
 *
 * The default tempo is linear: 120 BPM at ppq 480 is 960 ticks per second, so
 * `ticksToSeconds` is `tick / 960` and the arithmetic in assertions stays
 * readable.
 */
import type {
  PlaybackNote,
  PlaybackPlan,
  PlaybackTrack,
  TempoConversion,
} from '@sudobility/music_types';

export const TICKS_PER_SECOND = 960;

export const LINEAR_TEMPO: TempoConversion = {
  ticksToSeconds: tick => tick / TICKS_PER_SECOND,
  secondsToTicks: seconds => seconds * TICKS_PER_SECOND,
};

export function testTrack(
  over: Partial<PlaybackTrack> & { id: string }
): PlaybackTrack {
  const midiProgram = over.midiProgram ?? 0;
  return {
    midiProgram,
    instrumentName: 'x',
    isPercussion: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    voiceProgram: midiProgram,
    voiceName: 'x',
    ...over,
  };
}

export function testNote(
  over: Partial<PlaybackNote> & { trackId: string }
): PlaybackNote {
  return {
    tick: 0,
    durTicks: 480,
    midi: 60,
    // MIDI's 0-127, which is the unit `PlaybackNote` carries — `RenderPlan` is
    // the one that uses 0..1. This read 0.8 for a while, which both engines
    // treat as the quietest note there is.
    velocity: 96,
    noteId: `n-${over.tick ?? 0}-${over.trackId}`,
    ...over,
  };
}

export function testPlan(over: Partial<PlaybackPlan> = {}): PlaybackPlan {
  const tracks = over.tracks ?? [testTrack({ id: 't0' })];
  const notes = over.notes ?? [];
  return {
    tracks,
    notes,
    clicks: over.clicks ?? [],
    tempo: over.tempo ?? LINEAR_TEMPO,
    // Identity by default: an engine test is about scheduling, not repeats,
    // and this is what a score with no repeats produces.
    timeline: over.timeline ?? { segments: [], durationTicks: 0 },
    durationTicks:
      over.durationTicks ??
      notes.reduce((n, note) => Math.max(n, note.tick + note.durTicks), 0),
  };
}

/** `count` pitched tracks numbered `t0..`, each on its own GM program. */
export function planOfTracks(
  count: number,
  isPercussion = false
): PlaybackPlan {
  return testPlan({
    tracks: Array.from({ length: count }, (_, i) =>
      testTrack({ id: `t${i}`, midiProgram: i, isPercussion, voiceProgram: i })
    ),
  });
}

/**
 * Two tracks over four bars of 4/4 — a quarter note per beat, alternating.
 *
 * The length is load-bearing at both ends. Long enough that the transport tests,
 * which advance the clock by seconds and assert on scheduling several seconds
 * ahead, still have music left to schedule; short enough that the sounding-note
 * test, which steps ten seconds looking for the set to empty, sees it end. At
 * 960 ticks per second this runs eight seconds.
 */
export function twoTrackPlan(): PlaybackPlan {
  const BEATS = 16;
  const tracks = [
    testTrack({ id: 't0', midiProgram: 0, voiceProgram: 0 }),
    testTrack({ id: 't1', midiProgram: 1, voiceProgram: 1 }),
  ];
  const notes = Array.from({ length: BEATS }, (_, i) =>
    testNote({
      trackId: i % 2 === 0 ? 't0' : 't1',
      tick: i * 480,
      durTicks: 480,
      midi: 60 + (i % 12),
      noteId: `n${i}`,
    })
  );
  const clicks = Array.from({ length: BEATS }, (_, i) => ({
    tick: i * 480,
    accent: i % 4 === 0,
  }));
  return testPlan({ tracks, notes, clicks });
}
