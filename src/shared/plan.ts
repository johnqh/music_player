/**
 * Everything live playback needs, decided here rather than in the engine.
 *
 * The live counterpart of `renderEvents`, and the reason music_io needs no
 * musical code at all: ties are joined, pitches resolved, the measure grid's
 * beats read off, the GM voice resolved and the tempo handed over as a
 * conversion. The engine schedules and sounds; it decides nothing.
 *
 * This is `schedule.ts` from music_io, moved to where its imports already
 * lived. The note traversal itself is `flattenScoreNotes`, shared with
 * `renderEvents` so live and offline cannot drift over ties again.
 */
import type {
  MetronomeClick,
  PlaybackPlan,
  PlaybackTrack,
  Score,
} from '@sudobility/music_types';
import type { AuditionVoice } from '../engine.js';
import { TempoMap } from '@sudobility/music_types';
import {
  performanceTimeline,
  type PerformanceTimeline,
} from '@sudobility/music_types';
import { fermataTempoMap } from '@sudobility/music_types';
import { flattenScoreNotes } from '@sudobility/music_types';
import { beatBoundaries } from '@sudobility/music_types';
import { gmInstrument } from '@sudobility/music_types';
import { gmKitAt } from '@sudobility/music_types';
import { isPercussionTrack } from '@sudobility/music_types';

/**
 * The GM voice a program addresses.
 *
 * The one place the kit-versus-instrument distinction is resolved, shared by
 * the plan and by auditioning. A percussion track's `midiProgram` is a *kit*
 * address — `gmKitAt` maps any address to the kit whose region contains it, so
 * a score that arrives at a program GM defines no kit at still plays — and the
 * name must be the kit's, because `gmInstrument(40)` is Violin where kit 40 is
 * Brush.
 */
export function resolveVoice(
  program: number,
  isPercussion: boolean,
  fallbackName = ''
): AuditionVoice {
  if (isPercussion) {
    const kit = gmKitAt(program);
    return { program: kit.program, name: kit.name, isPercussion: true };
  }
  return {
    program,
    name: gmInstrument(program)?.name ?? fallbackName,
    isPercussion: false,
  };
}

/**
 * The tracks alone.
 *
 * Separate from `playbackPlan` because a mix change while playing must not
 * rebuild every note — `PlaybackEngine.applyMix` takes only this.
 */
export function playbackTracks(score: Score): PlaybackTrack[] {
  return score.tracks.map(track => {
    const percussion = isPercussionTrack(track);
    const voice = resolveVoice(
      track.midiProgram,
      percussion,
      track.instrumentName
    );
    return {
      id: track.id,
      midiProgram: track.midiProgram,
      instrumentName: track.instrumentName,
      isPercussion: percussion,
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
      voiceProgram: voice.program,
      voiceName: voice.name,
    };
  });
}

/**
 * Every beat position across the measure grid, read off the first track —
 * every track shares one grid once `rebuildMeasureTicks` has run.
 */
function metronomeClicks(score: Score): MetronomeClick[] {
  const track = score.tracks[0];
  if (!track) return [];
  const clicks: MetronomeClick[] = [];
  for (const measure of track.measures) {
    beatBoundaries(measure.timeSignature, score.ppq).forEach((offset, i) => {
      clicks.push({ tick: measure.startTick + offset, accent: i === 0 });
    });
  }
  return clicks;
}

/**
 * Lays `events` out along the timeline, repeating what the repeats repeat.
 *
 * Each segment copies the written events inside its source range to its own
 * place in performance time. A copy gets a distinct id — the caret lights a
 * note by id, and the same written note sounding twice would otherwise light
 * both times at once.
 *
 * The identity timeline copies everything exactly once at its own tick, so a
 * score without repeats produces precisely what it did before.
 */
function expandAlongTimeline<T extends { tick: number }>(
  events: T[],
  timeline: PerformanceTimeline,
  withTick: (event: T, tick: number, pass: number) => T
): T[] {
  if (timeline.segments.length === 0) return events;

  const expanded: T[] = [];
  const passesBySource = new Map<number, number>();

  for (const segment of timeline.segments) {
    const pass = (passesBySource.get(segment.sourceTick) ?? 0) + 1;
    passesBySource.set(segment.sourceTick, pass);

    const end = segment.sourceTick + segment.durationTicks;
    for (const event of events) {
      if (event.tick < segment.sourceTick || event.tick >= end) continue;
      const offset = event.tick - segment.sourceTick;
      expanded.push(withTick(event, segment.performanceTick + offset, pass));
    }
  }
  return expanded.sort((a, b) => a.tick - b.tick);
}

export function playbackPlan(score: Score): PlaybackPlan {
  const timeline = performanceTimeline(score);

  /*
    Notes are laid out in *performance* time, so a repeated bar genuinely
    sounds twice. Everything that draws translates back through `timeline`
    — see `sourceTickFor` — which is what keeps the score the canonical,
    written thing rather than teaching the caret about repeats.
  */
  const notes = expandAlongTimeline(
    flattenScoreNotes(score),
    timeline,
    (note, tick, pass) => ({
      ...note,
      tick,
      // Distinct per pass: the caret lights a note by id, and one written
      // note sounding twice must not light both places at once.
      noteId: pass === 1 ? note.noteId : `${note.noteId}#${pass}`,
    })
  );

  const clicks = expandAlongTimeline(
    metronomeClicks(score),
    timeline,
    (click, tick) => ({ ...click, tick })
  );

  return {
    tracks: playbackTracks(score),
    notes,
    clicks,
    timeline,
    /*
      The tempo map with fermatas written into it as local slowings — see
      `fermataTempoMap`. A pause is expressed as tempo rather than as longer
      notes because the score tick has to stay the playback tick; the caret
      builds its own map from the same function, so the two cannot disagree
      about how long a hold lasts.

      `TempoMap` satisfies `TempoConversion` structurally, so nothing converts
      twice.
    */
    tempo: new TempoMap(fermataTempoMap(score), score.ppq),
    durationTicks: Math.max(
      timeline.durationTicks,
      notes.reduce((n, note) => Math.max(n, note.tick + note.durTicks), 0)
    ),
  };
}
