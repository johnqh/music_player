import { describe, expect, it } from 'vitest';
import type { RenderPlan } from '@sudobility/music_types';
import { createRNSoundfontRenderer, packNameForRenderTrack } from './offline-render.js';
import type { AudioApi } from '../playback/audio-api.js';

type Scheduled = { detune: number; startAt: number; stopAt: number; gain: number; pan: number; cutoff: number | null; looped: boolean };

/** An offline graph that records what was scheduled and returns a fixed buffer. */
function fakeOfflineApi() {
  const scheduled: Scheduled[] = [];
  const created: Array<{ numberOfChannels: number; length: number; sampleRate: number }> = [];
  let masterGain = 1;

  const param = (onSet: (v: number) => void) => {
    let current = 0;
    return {
      get value() {
        return current;
      },
      set value(v: number) {
        current = v;
        onSet(v);
      },
      setValueAtTime(v: number) {
        onSet(v);
        return this;
      },
      linearRampToValueAtTime() {
        return this;
      },
      cancelScheduledValues() {
        return this;
      },
    };
  };

  const api: AudioApi = {
    AudioContext: function () {
      throw new Error('offline render must not open a live context');
    } as unknown as AudioApi['AudioContext'],
    decodeAudioData: async () => ({
      length: 100,
      numberOfChannels: 1,
      sampleRate: 44100,
      duration: 1,
      getChannelData: () => new Float32Array(100),
    }),
    OfflineAudioContext: function (options: { numberOfChannels: number; length: number; sampleRate: number }) {
      created.push(options);
      let isMaster = true;
      return {
        sampleRate: options.sampleRate,
        destination: { connect: () => undefined, disconnect: () => undefined },
        createGain() {
          // The master is the first gain built; every later one is a voice amp,
          // attaching to the source created just before it.
          const mine = isMaster;
          isMaster = false;
          const record = pending[pending.length - 1];
          return {
            gain: param((v) => {
              if (mine) masterGain = v;
              else if (record && record.gain === 0) record.gain = v;
            }),
            connect: () => undefined,
            disconnect: () => undefined,
          };
        },
        createBufferSource() {
          const record: Scheduled = { detune: 0, startAt: -1, stopAt: -1, gain: 0, pan: 0, cutoff: null, looped: false };
          pending.push(record);
          return {
            buffer: null,
            get loop() { return record.looped; },
            set loop(v: boolean) { record.looped = v; },
            loopStart: 0,
            loopEnd: 0,
            playbackRate: param(() => undefined),
            detune: param((v) => {
              if (record) record.detune = v;
            }),
            start(when = 0) {
              if (record) record.startAt = when;
            },
            stop(when = 0) {
              if (record) {
                record.stopAt = when;
                scheduled.push(record);
              }
            },
            connect: () => undefined,
            disconnect: () => undefined,
          };
        },
        createBiquadFilter() {
          const record = pending[pending.length - 1];
          return {
            type: 'lowpass',
            frequency: param((v) => { if (record) record.cutoff = v; }),
            Q: param(() => undefined),
            connect: () => undefined,
            disconnect: () => undefined,
          };
        },
        createStereoPanner() {
          const record = pending[pending.length - 1];
          return {
            pan: param((v) => {
              if (record) record.pan = v;
            }),
            connect: () => undefined,
            disconnect: () => undefined,
          };
        },
        startRendering: async () => ({
          length: options.length,
          numberOfChannels: 2,
          sampleRate: options.sampleRate,
          duration: options.length / options.sampleRate,
          getChannelData: () => new Float32Array(options.length).fill(0.25),
        }),
      };
    } as unknown as NonNullable<AudioApi['OfflineAudioContext']>,
  };

  const pending: Scheduled[] = [];
  return { api, scheduled, created, get masterGain() { return masterGain; } };
}

function packBody(name: string): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const entries: string[] = [];
  const isKit = name.startsWith('percussion_');
  const [lo, hi] = isKit ? [35, 81] : [21, 108];
  for (let midi = lo; midi <= hi; midi += 1) {
    // Slot 56 is left undefined in kits, the way TR-808 genuinely leaves three
    // of GM's empty. A kit fixture with every slot filled cannot tell exact
    // selection from nearest selection — both answer, and both answer 0 cents.
    if (isKit && midi === 56) continue;
    entries.push(`"${names[midi % 12]}${Math.floor(midi / 12) - 1}": "data:audio/mp3;base64,AAAA"`);
  }
  return `MIDI.Soundfont.${name} = {${entries.join(',')}}`;
}

function makeRenderer(overrides: { fetchPack?: (url: string) => Promise<string> } = {}) {
  const graph = fakeOfflineApi();
  const fetched: string[] = [];
  const renderer = createRNSoundfontRenderer({
    loadAudioApi: async () => graph.api,
    percussionBase: 'https://app.example.com/audio/percussion/',
    fetchPack:
      overrides.fetchPack ??
      (async (url) => {
        fetched.push(url);
        return packBody(/\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!);
      }),
  });
  return { renderer, graph, fetched };
}

const PIANO = {
  id: 't1',
  midiProgram: 0,
  instrumentName: 'Acoustic Grand Piano',
  isPercussion: false,
  volume: 1,
  pan: 0,
  voiceProgram: 0,
  voiceName: 'Acoustic Grand Piano',
};
const DRUMS = {
  id: 't2',
  midiProgram: 25,
  instrumentName: 'TR-808 Kit',
  isPercussion: true,
  volume: 1,
  pan: 0,
  voiceProgram: 25,
  voiceName: 'TR-808 Kit',
};

function plan(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return {
    tracks: [PIANO],
    events: [{ trackId: 't1', midi: 60, startSec: 0, durationSec: 1, velocity: 1 }],
    durationSec: 2,
    ...overrides,
  };
}

describe('packNameForRenderTrack', () => {
  it('reads a percussion track as a kit, never as an instrument', () => {
    // Program 25 addresses the TR-808 kit on a drum track and a steel-string
    // guitar on a pitched one. The two never agree — which is why music_lib
    // resolves the voice and this only reads the answer.
    expect(packNameForRenderTrack(DRUMS)).toBe('percussion_25');
    expect(
      packNameForRenderTrack({
        ...DRUMS,
        isPercussion: false,
        voiceName: 'Acoustic Guitar (steel)',
      }),
    ).toBe('acoustic_guitar_steel');
  });
});

describe('createRNSoundfontRenderer', () => {
  it('renders without opening a live audio context', async () => {
    // The whole point: an export must not play in real time. The fake throws
    // if a live context is constructed.
    const { renderer } = makeRenderer();
    const audio = await renderer.render(plan());

    expect(audio.sampleRate).toBe(44100);
    expect(audio.samples.length).toBeGreaterThan(0);
  });

  it('sizes the file to hold the last note\'s release tail', async () => {
    const { renderer, graph } = makeRenderer();
    await renderer.render(plan({ durationSec: 3 }));

    // 3s of music plus the release, or the final note is clipped off the end.
    expect(graph.created[0]!.length).toBeGreaterThan(3 * 44100);
  });

  it('scales velocity back to MIDI range — a RenderPlan carries 0..1', async () => {
    // planVoice normalizes a 0..127 value. Passing the plan's 0..1 straight in
    // renders a file roughly 127x too quiet, which reads as a broken export.
    const { renderer, graph } = makeRenderer();
    await renderer.render(plan());

    expect(graph.scheduled[0]!.gain).toBeCloseTo(1, 5);
  });

  it('applies each track\'s own volume and pan', async () => {
    const { renderer, graph } = makeRenderer();
    await renderer.render(
      plan({
        tracks: [{ ...PIANO, volume: 0.5, pan: -0.8 }],
      }),
    );

    expect(graph.scheduled[0]!.gain).toBeCloseTo(0.5, 5);
    expect(graph.scheduled[0]!.pan).toBeCloseTo(-0.8, 5);
  });

  it('sizes headroom by how many tracks exist, including ones that sound nothing', async () => {
    // Matches live playback. Deriving it from the events alone opens a
    // muted-heavy export a couple of dB above what was heard.
    const quiet = makeRenderer();
    await quiet.renderer.render(plan({ tracks: [PIANO, { ...PIANO, id: 'x' }, { ...PIANO, id: 'y' }] }));
    const solo = makeRenderer();
    await solo.renderer.render(plan());

    expect(quiet.graph.masterGain).toBeLessThan(solo.graph.masterGain);
    expect(quiet.graph.masterGain).toBeCloseTo(1 / Math.sqrt(3), 5);
  });

  it('downloads only the packs that actually sound', async () => {
    const { renderer, fetched } = makeRenderer();
    await renderer.render(plan({ tracks: [PIANO, DRUMS] })); // no drum events

    // A plan lists every track so the headroom is right. Fetching a 1MB kit
    // for a track with no notes is minutes of nothing.
    expect(fetched.some((u) => u.includes('acoustic_grand_piano'))).toBe(true);
    expect(fetched.some((u) => u.includes('percussion_25'))).toBe(false);
  });

  it('never bends a drum, in an export as in playback', async () => {
    const { renderer, graph } = makeRenderer();
    await renderer.render(
      plan({
        tracks: [DRUMS],
        events: [
          { trackId: 't2', midi: 38, startSec: 0, durationSec: 0.2, velocity: 1 }, // snare: defined
          { trackId: 't2', midi: 56, startSec: 1, durationSec: 0.2, velocity: 1 }, // cowbell: not in this kit
        ],
      }),
    );

    // The snare sounds; the undefined slot is silent rather than answered by a
    // detuned neighbour, which would be a different drum.
    expect(graph.scheduled).toHaveLength(1);
    expect(graph.scheduled[0]!.detune).toBe(0);
  });

  it('says so when the native module is too old for an offline context', async () => {
    const graph = fakeOfflineApi();
    const renderer = createRNSoundfontRenderer({
      loadAudioApi: async () => ({ ...graph.api, OfflineAudioContext: undefined }),
      fetchPack: async (url) => packBody(/\/([a-z0-9_]+)-mp3\.js$/.exec(url)![1]!),
    });

    await expect(renderer.render(plan())).rejects.toThrow(/>=0\.13/);
  });
});
