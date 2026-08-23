import { describe, expect, it, vi } from 'vitest';
import type { RenderPlan } from '@sudobility/music_types';
import { LIMITER_CEILING_DB } from '../../shared/mix.js';
import { createSoundfontRenderer } from './soundfont-render.js';
import type { LoadedOfflineSynth } from './offline-synth.js';
import type { SynthesizerLike } from './synth-types.js';

const SAMPLE_RATE = 44100;

/**
 * A synth that records what it was told and writes a constant into the buffers,
 * so the render loop's own arithmetic can be checked.
 */
function stubSynth(fill: { left: number; right: number } = { left: 1, right: 1 }) {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const synth: SynthesizerLike & { calls: typeof calls } = {
    calls,
    init: record('init'),
    loadSFont: vi.fn(async () => 1),
    render: (out: Float32Array[]) => {
      out[0].fill(fill.left);
      out[1].fill(fill.right);
    },
    midiNoteOn: record('midiNoteOn'),
    midiNoteOff: record('midiNoteOff'),
    midiControl: record('midiControl'),
    midiProgramSelect: record('midiProgramSelect'),
    midiSetChannelType: record('midiSetChannelType'),
    midiAllSoundsOff: record('midiAllSoundsOff'),
    close: record('close'),
  };
  return synth;
}

function rendererFor(synth: SynthesizerLike, onAcquire?: () => void) {
  const loaded: LoadedOfflineSynth = { synth, sfontId: 1, sampleRate: SAMPLE_RATE };
  return createSoundfontRenderer({
    fluidsynthModuleUrl: 'f.js',
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    acquireSynth: async () => {
      onAcquire?.();
      return loaded;
    },
  });
}

const track = (over: Partial<RenderPlan['tracks'][number]> = {}) => ({
  id: 't1',
  midiProgram: 40,
  instrumentName: 'Violin',
  isPercussion: false,
  volume: 1,
  pan: 0,
  voiceProgram: 40,
  voiceName: 'Violin',
  ...over,
});

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  tracks: [track()],
  events: [{ trackId: 't1', midi: 60, startSec: 0.5, durationSec: 0.25, velocity: 0.8 }],
  durationSec: 1,
  ...over,
});

describe('createSoundfontRenderer', () => {
  it('renders audio of the planned length plus a release tail', async () => {
    const synth = stubSynth();
    const audio = await rendererFor(synth)(plan());
    expect(audio.sampleRate).toBe(SAMPLE_RATE);
    expect(audio.samples.length).toBe(Math.ceil(2 * SAMPLE_RATE)); // 1s + 1s tail
  });

  it('mixes both channels down, so a hard-panned track does not vanish', async () => {
    // The old renderer took channel 0 only. A track panned fully right was
    // audible in playback and silent in the export.
    const audio = await rendererFor(stubSynth({ left: 0, right: 1 }))(plan());
    expect(audio.samples[0]).toBeCloseTo(0.5, 6);
  });

  it('trims the master by the same headroom playback applies', async () => {
    // `SynthHost` puts `headroomTrimFor(trackCount)` on the master bus, so a
    // nine-track arrangement plays back at a third of what its channels sum
    // to. The renderer summed them raw, which the encoders then hard-clamp —
    // an export that clipped through most of a piece playback handled fine.
    const tracks = ['t1', 't2', 't3', 't4'].map((id) => track({ id }));
    const audio = await rendererFor(stubSynth())(plan({ tracks, events: [] }));
    expect(audio.samples[0]).toBeCloseTo(0.5, 6); // 1.0 summed, times 1/sqrt(4)
  });

  it('holds the export under the limiter ceiling instead of clipping it', async () => {
    // A single track at full scale clears the headroom trim untouched and would
    // reach the encoders at 1.0, where they hard-clamp. Playback has a limiter
    // after its master gain for exactly this; so does the render now.
    const audio = await rendererFor(stubSynth({ left: 1, right: 1 }))(plan());
    let peak = 0;
    for (const sample of audio.samples) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeLessThanOrEqual(10 ** (LIMITER_CEILING_DB / 20) * (1 + 1e-6));
  });

  it('selects the drum kit, never a melodic program, on channel 9', async () => {
    // A lone percussion track takes channel 9, which is a drum channel already
    // and needs no type switch. It still gets a kit: measured on a real synth,
    // selecting bank 128 preset 0 there is bit-identical to leaving it alone,
    // while selecting from the melodic bank leaves it playing a piano for good.
    const synth = stubSynth();
    await rendererFor(synth)(
      plan({ tracks: [track({ isPercussion: true, midiProgram: 0 })], events: [] }),
    );
    expect(synth.calls.midiSetChannelType).toBeUndefined();
    expect(synth.calls.midiProgramSelect).toEqual([[9, 1, 128, 0]]);
  });

  it('honours the kit the file asked for', async () => {
    // General MIDI selects the kit with a program change on the drum channel,
    // so a track's program is its kit — 8 is the Room kit.
    const synth = stubSynth();
    await rendererFor(synth)(
      plan({ tracks: [track({ isPercussion: true, midiProgram: 8 })], events: [] }),
    );
    expect(synth.calls.midiProgramSelect).toEqual([
      [9, 1, 128, 0],
      [9, 1, 128, 8],
    ]);
  });

  it('sends a second drum track to the drum bank, not just the drum channel type', async () => {
    // Switching the type only routes later program changes to the drum bank —
    // the channel keeps its default piano preset. Measured against a real
    // synth, the type switch alone produced a different instrument entirely.
    const synth = stubSynth();
    await rendererFor(synth)(
      plan({
        tracks: [track({ id: 'd1', isPercussion: true }), track({ id: 'd2', isPercussion: true })],
        events: [],
      }),
    );
    const switched = synth.calls.midiSetChannelType?.[0];
    expect(switched).toBeDefined();
    const channel = switched![0] as number;
    expect(synth.calls.midiProgramSelect).toContainEqual([channel, 1, 128, 0]);
  });

  it('selects the GM program for a pitched track', async () => {
    const synth = stubSynth();
    await rendererFor(synth)(plan({ events: [] }));
    expect(synth.calls.midiProgramSelect?.[0]).toEqual([0, 1, 0, 40]);
  });

  it('sends volume and pan as CC7 and CC10', async () => {
    const synth = stubSynth();
    await rendererFor(synth)(plan({ tracks: [track({ volume: 0.5, pan: -1 })], events: [] }));
    const controls = synth.calls.midiControl ?? [];
    expect(controls).toContainEqual([0, 7, 64]);
    expect(controls).toContainEqual([0, 10, 0]);
  });

  it('places a note in the block it falls due, not at the start', async () => {
    // The whole point of the chunked loop. If events were dispatched up front
    // every note would sound at zero, which is what the spike did.
    const synth = stubSynth();
    let framesRenderedBeforeNoteOn = 0;
    let blocks = 0;
    const original = synth.render;
    synth.render = (out) => {
      blocks += 1;
      original(out);
    };
    synth.midiNoteOn = () => {
      framesRenderedBeforeNoteOn = blocks * 128;
    };
    await rendererFor(synth)(plan());
    // The note starts at 0.5s = 22050 frames; allow one block of slack.
    expect(framesRenderedBeforeNoteOn).toBeGreaterThan(22050 - 256);
    expect(framesRenderedBeforeNoteOn).toBeLessThan(22050 + 256);
  });

  it('silences the shared synth before and after each render', async () => {
    // It is reused across exports, so it starts dirty and must not leak notes
    // into the next one.
    const synth = stubSynth();
    await rendererFor(synth)(plan({ events: [] }));
    expect(synth.calls.midiAllSoundsOff?.length).toBe(2);
  });

  it('renders a score too big for one synth as several summed passes', async () => {
    // One offline synth addresses sixteen channels; the allocator spreads a
    // bigger score over more. Keying on the channel alone and ignoring the
    // instance put two tracks on one channel — the second overwrote the
    // first's program — so past sixteen parts the export came out with the
    // wrong instruments while playback, which opens the extra synths, did not.
    // Asserting on what each *note* was sounding with, not on what was
    // selected: with the tracks collapsed onto one instance every program is
    // still selected, it is just overwritten before the note that needed it.
    const synth = stubSynth();
    const programOn = new Map<number, number>();
    const sounded: number[] = [];
    synth.midiProgramSelect = (channel, _sfont, _bank, preset) => programOn.set(channel, preset);
    synth.midiNoteOn = (channel) => sounded.push(programOn.get(channel) ?? -1);

    const tracks = Array.from({ length: 17 }, (_, i) =>
      track({ id: `t${i}`, midiProgram: i, isPercussion: false }),
    );
    await rendererFor(synth)(
      plan({
        tracks,
        events: tracks.map((t) => ({
          trackId: t.id,
          midi: 60,
          startSec: 0,
          durationSec: 0.25,
          velocity: 0.8,
        })),
      }),
    );

    // Every track sounded, each with its own instrument.
    expect(sounded.slice().sort((a, b) => a - b)).toEqual(tracks.map((t) => t.midiProgram));
  });

  it('reuses the synth across renders rather than reloading the soundfont', async () => {
    // The reason this rewrite exists: the previous design built a fresh
    // worklet and reloaded a 23MB font on every single export.
    const synth = stubSynth();
    let acquisitions = 0;
    const render = rendererFor(synth, () => {
      acquisitions += 1;
    });
    await render(plan({ events: [] }));
    await render(plan({ events: [] }));
    expect(acquisitions).toBe(2); // acquire is memoised inside getOfflineSynth
    expect(synth.calls.init).toBeUndefined(); // never re-initialised here
    expect(vi.mocked(synth.loadSFont)).not.toHaveBeenCalled();
  });
});
