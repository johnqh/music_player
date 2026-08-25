import { describe, expect, it } from 'vitest';
import { twoTrackScore, twinkleScore } from '@sudobility/music_types/test';
import type { Measure, NoteEvent, Score } from '@sudobility/music_types';
import { playbackPlan, playbackTracks } from './plan.js';
import { isNoteEvent } from '@sudobility/music_types';
import { TempoMap } from '@sudobility/music_types';

describe('playbackPlan', () => {
  it('emits every sounding note with its id and track', () => {
    const plan = playbackPlan(twinkleScore());
    expect(plan.notes.length).toBeGreaterThan(0);
    for (const note of plan.notes) {
      expect(note.noteId).toBeTruthy();
      expect(note.trackId).toBeTruthy();
      expect(note.midi).toBeGreaterThan(0);
      expect(note.durTicks).toBeGreaterThan(0);
    }
  });

  it('sorts notes by tick', () => {
    const ticks = playbackPlan(twinkleScore()).notes.map(n => n.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it('carries every track, including silent ones, for mix headroom', () => {
    const score = twoTrackScore();
    expect(playbackPlan(score).tracks).toHaveLength(score.tracks.length);
  });

  it('converts ticks to seconds through the score tempo', () => {
    const score = twinkleScore();
    const plan = playbackPlan(score);
    expect(plan.tempo.ticksToSeconds(0)).toBe(0);
    expect(plan.tempo.ticksToSeconds(score.ppq)).toBeGreaterThan(0);
    // Round trip, which is what seek and position reporting rely on.
    const seconds = plan.tempo.ticksToSeconds(score.ppq * 4);
    expect(Math.round(plan.tempo.secondsToTicks(seconds))).toBe(score.ppq * 4);
  });

  it('marks beat one of each measure as an accent', () => {
    const plan = playbackPlan(twinkleScore());
    expect(plan.clicks.length).toBeGreaterThan(0);
    expect(plan.clicks[0]).toEqual({ tick: 0, accent: true });
    expect(plan.clicks.filter(c => c.accent).length).toBeGreaterThan(1);
  });

  it('reports the last tick any note ends on', () => {
    const plan = playbackPlan(twinkleScore());
    const last = Math.max(...plan.notes.map(n => n.tick + n.durTicks));
    expect(plan.durationTicks).toBe(last);
  });

  it('resolves a pitched track to its own program', () => {
    const score = twoTrackScore();
    const track = playbackTracks(score)[0];
    expect(track.isPercussion).toBe(false);
    expect(track.voiceProgram).toBe(score.tracks[0].midiProgram);
    expect(track.voiceName.length).toBeGreaterThan(0);
  });

  it('resolves a percussion track to the kit its program falls in', () => {
    // Kits sit at 0, 8, 16, 24, 25, 32, 40 and 48, so a score can arrive at an
    // address GM defines no kit at. 45 must resolve down to Brush at 40 — and
    // the name must be the kit's, not gmInstrument(40), which is Violin.
    const base = twoTrackScore();
    const score = {
      ...base,
      tracks: base.tracks.map((t, i) =>
        i === 0 ? { ...t, clef: 'percussion' as const, midiProgram: 45 } : t
      ),
    };
    const track = playbackTracks(score)[0];
    expect(track.isPercussion).toBe(true);
    expect(track.voiceProgram).toBe(40);
    expect(track.voiceName).toBe('Brush Kit');
  });

  it('carries the mix flags a live mix changes', () => {
    const base = twoTrackScore();
    const score = {
      ...base,
      tracks: base.tracks.map((t, i) =>
        i === 0 ? { ...t, muted: true, volume: 0.25 } : t
      ),
    };
    const track = playbackTracks(score)[0];
    expect(track.muted).toBe(true);
    expect(track.volume).toBe(0.25);
  });
});

describe('playbackPlan: behaviours moved from music_io schedule.ts', () => {
  const PPQ = 480;

  /** One track, one voice, with a note tied across the barline. */
  function tiedAcrossBarlineScore(): Score {
    const trackId = 'track-1';
    const voiceId = 'voice-1';
    const measureTicks = PPQ * 4;
    const note = (
      over: Partial<NoteEvent> & { id: string; startTick: number }
    ): NoteEvent => ({
      pitch: { step: 'C', accidental: 0, octave: 4 },
      durationTicks: PPQ,
      velocity: 90,
      voiceId,
      trackId,
      ...over,
    });
    const base = twinkleScore();
    const measures: Measure[] = [0, 1].map(i => ({
      id: `m${i}`,
      index: i,
      startTick: i * measureTicks,
      durationTicks: measureTicks,
      timeSignature: { numerator: 4, denominator: 4 },
      keySignature: { fifths: 0, mode: 'major' as const },
      voices: [
        {
          id: voiceId,
          name: 'Voice 1',
          events:
            i === 0
              ? [
                  note({
                    id: 'note-tie-start',
                    startTick: measureTicks - PPQ,
                    tieStart: true,
                  }),
                ]
              : [
                  note({
                    id: 'note-tie-stop',
                    startTick: measureTicks,
                    tieStop: true,
                  }),
                  note({
                    id: 'note-untied',
                    startTick: measureTicks + PPQ,
                    durationTicks: PPQ * 3,
                    pitch: { step: 'E', accidental: 0, octave: 4 },
                  }),
                ],
        },
      ],
    }));
    return { ...base, tracks: [{ ...base.tracks[0], id: trackId, measures }] };
  }

  it('joins a note tied across a barline into one, dropping the continuation', () => {
    const notes = playbackPlan(tiedAcrossBarlineScore()).notes;
    const ids = notes.map(n => n.noteId);
    expect(ids).not.toContain('note-tie-stop');
    expect(ids).toContain('note-tie-start');

    const joined = notes.find(n => n.noteId === 'note-tie-start')!;
    expect(joined.tick).toBe(PPQ * 3);
    expect(joined.durTicks).toBe(PPQ * 2);
    expect(notes).toHaveLength(2);
  });

  it('keeps trackId provenance across every track', () => {
    const score = twoTrackScore();
    const ids = new Set(playbackPlan(score).notes.map(n => n.trackId));
    expect(ids).toEqual(new Set(score.tracks.map(t => t.id)));
  });

  it('emits one click per beat across the measure grid', () => {
    // twinkleScore is 8 bars of 4/4, so 32 beats.
    const clicks = playbackPlan(twinkleScore()).clicks;
    expect(clicks).toHaveLength(32);
    expect(clicks[1]).toEqual({ tick: PPQ, accent: false });
    expect(clicks[4]).toEqual({ tick: PPQ * 4, accent: true });
  });

  it('is empty for a score with no tracks', () => {
    const score = { ...twinkleScore(), tracks: [] };
    const plan = playbackPlan(score);
    expect(plan.notes).toEqual([]);
    expect(plan.clicks).toEqual([]);
    expect(plan.tracks).toEqual([]);
  });
});

describe('fermatas in the plan', () => {
  function held(score: Score): Score {
    let done = false;
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
                  events: v.events.map(e => {
                    if (done || !isNoteEvent(e)) return e;
                    done = true;
                    return { ...e, fermata: true };
                  }),
                })),
              })),
            }
      ),
    };
  }

  it('hands the engine a tempo that slows across the pause', () => {
    // The engine schedules from `plan.tempo`, so this is what actually makes a
    // fermata audible.
    const score = twinkleScore();
    const plan = playbackPlan(held(score));
    const plain = playbackPlan(score);
    const tick = plan.notes[0].tick;

    expect(plan.tempo.ticksToSeconds(tick + 480)).toBeGreaterThan(
      plain.tempo.ticksToSeconds(tick + 480)
    );
  });

  it('leaves every note on its written tick', () => {
    const score = twinkleScore();
    expect(playbackPlan(held(score)).notes.map(n => n.tick)).toEqual(
      playbackPlan(score).notes.map(n => n.tick)
    );
  });

  it('changes nothing for a score with no fermata', () => {
    const score = twinkleScore();
    const plan = playbackPlan(score);
    expect(plan.tempo.ticksToSeconds(1920)).toBeCloseTo(
      new TempoMap(score.tempoMap, score.ppq).ticksToSeconds(1920),
      6
    );
  });
});
