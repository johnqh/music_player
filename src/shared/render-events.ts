/**
 * A score flattened into timed events, ready for an offline audio render.
 *
 * Deliberately score-in, events-out: the actual rendering needs Tone.js and an
 * audio context, so it lives in music_io. Everything *musical* about an export
 * — which tracks sound, when each note starts, how long the file has to be —
 * is decided here, where it can be tested without a browser.
 */
import { TempoMap } from '@sudobility/music_types';
import { fermataTempoMap } from '@sudobility/music_types';
import { flattenScoreNotes } from '@sudobility/music_types';
import { resolveVoice } from './plan.js';
import type { Score } from '@sudobility/music_types';

import type {
  RenderEvent,
  RenderPlan,
  RenderTrack,
} from '@sudobility/music_types';
export type {
  RenderEvent,
  RenderPlan,
  RenderTrack,
} from '@sudobility/music_types';

/** Release tail, so the last note is not cut off mid-decay. */
const TAIL_SEC = 1;

/**
 * The plan an export should sound, matching live playback.
 *
 * **Mute and solo are respected**, because they are part of how the score
 * currently sounds, and an export that ignored them would not match what you
 * just heard. Solo wins: if anything is soloed, only soloed tracks sound.
 *
 * Every track appears in `tracks` regardless — silent, muted, soloed away —
 * because the renderer sizes its mix headroom by how many channels exist, as
 * playback does. Only a track's *notes* are dropped when it is silenced.
 *
 * `isPercussion` comes from the clef and not the MIDI channel, and the voice is
 * left for the renderer to resolve from `midiProgram`/`instrumentName`: both
 * are the signals live playback uses, and the export sounding different from
 * the thing it is an export *of* is the bug being fixed here.
 *
 * That parity is now structural: the notes come from `flattenScoreNotes`, the
 * same traversal `playbackPlan` uses. Walking the score separately is what let
 * the two drift over ties.
 */
export function renderEvents(score: Score): RenderPlan {
  // The same derived map live playback uses, so an exported file holds its
  // pauses for exactly as long as the transport just did.
  const tempoMap = new TempoMap(fermataTempoMap(score), score.ppq);
  const anySolo = score.tracks.some(t => t.solo);

  const tracks: RenderTrack[] = score.tracks.map(track => {
    const isPercussion = track.clef === 'percussion';
    // The renderer picks its sample pack from this, and a percussion track's
    // midiProgram addresses a kit rather than an instrument.
    const voice = resolveVoice(
      track.midiProgram,
      isPercussion,
      track.instrumentName
    );
    return {
      id: track.id,
      midiProgram: track.midiProgram,
      instrumentName: track.instrumentName,
      isPercussion,
      volume: track.volume,
      pan: track.pan,
      voiceProgram: voice.program,
      voiceName: voice.name,
    };
  });

  // The same traversal live playback uses, so ties are joined here too. They
  // were not, and a tie re-articulated in the exported file while sustaining
  // on screen — measured: one note of 960 ticks live, two of 0.5s offline.
  const silenced = new Set(
    score.tracks.filter(t => (anySolo ? !t.solo : t.muted)).map(t => t.id)
  );
  const events: RenderEvent[] = [];
  for (const note of flattenScoreNotes(score)) {
    if (silenced.has(note.trackId)) continue;
    const startSec = tempoMap.ticksToSeconds(note.tick);
    const endSec = tempoMap.ticksToSeconds(note.tick + note.durTicks);
    events.push({
      trackId: note.trackId,
      midi: note.midi,
      startSec,
      // Never zero: a rounding error should not silence a note.
      durationSec: Math.max(0.01, endSec - startSec),
      velocity: note.velocity / 127,
    });
  }

  events.sort((a, b) => a.startSec - b.startSec);
  const lastEnd = events.reduce(
    (max, e) => Math.max(max, e.startSec + e.durationSec),
    0
  );
  return { tracks, events, durationSec: lastEnd + TAIL_SEC };
}
