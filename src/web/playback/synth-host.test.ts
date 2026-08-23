import { describe, expect, it, vi } from 'vitest';
import { SynthHost } from './synth-host.js';
import type { SynthInstance, SynthSequencer } from './synth-host.js';

/** A stand-in for one `AudioWorkletNodeSynthesizer`, recording what it was told. */
function stubSynth(sequencer?: SynthSequencer): SynthInstance & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const synth: SynthInstance & { calls: Record<string, unknown[][]> } = {
    calls,
    init: record('init'),
    createAudioNode: vi.fn(() => ({ connect: vi.fn() }) as unknown as AudioNode),
    loadSFont: vi.fn(async () => 1),
    midiNoteOn: record('midiNoteOn'),
    midiNoteOff: record('midiNoteOff'),
    midiProgramSelect: record('midiProgramSelect'),
    midiControl: record('midiControl'),
    midiSetChannelType: record('midiSetChannelType'),
    midiAllSoundsOff: record('midiAllSoundsOff'),
    setInterpolation: record('setInterpolation'),
    close: record('close'),
  };
  if (sequencer) synth.createSequencer = vi.fn(async () => sequencer);
  return synth;
}

function stubSequencer() {
  const sequencer = {
    registerSynthesizer: vi.fn(async (_synth: SynthInstance) => 1),
    setTimeScale: vi.fn((_scale: number) => {}),
    sendEventAt: vi.fn((_event, _tick: number, _isAbsolute: boolean) => {}),
    removeAllEvents: vi.fn(() => {}),
    close: vi.fn(() => {}),
  };
  return sequencer satisfies SynthSequencer;
}

/** A minimal AudioContext surface: enough for the master chain and nothing more. */
function stubContext() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: node(),
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
    createDynamicsCompressor: vi.fn(() => ({
      ...node(),
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    })),
  } as unknown as AudioContext;
}

async function hostWith(instanceCount: number, options: { withSequencer?: boolean } = {}) {
  const withSequencer = options.withSequencer ?? true;
  const sequencers = Array.from({ length: instanceCount }, () => stubSequencer());
  const synths = Array.from({ length: instanceCount }, (_, i) =>
    stubSynth(withSequencer ? sequencers[i] : undefined),
  );
  let made = 0;
  const host = new SynthHost({ createSynth: () => synths[made++] });
  await host.init(stubContext(), {
    fluidsynthModuleUrl: 'fluid.js',
    workletModuleUrl: 'worklet.js',
    soundfont: new Uint8Array(4).buffer,
    instanceCount,
  });
  return { host, synths, sequencers };
}

describe('SynthHost: timed notes', () => {
  it('sends one note event carrying its duration, in milliseconds', async () => {
    const { host, sequencers } = await hostWith(1);
    host.noteAt(0, 3, 60, 100, 0.25, 1.5);
    expect(sequencers[0].sendEventAt).toHaveBeenCalledWith(
      { type: 'note', channel: 3, key: 60, vel: 100, duration: 1500 },
      250,
      false,
    );
  });

  it('clamps a negative delay to now', async () => {
    // A note whose moment passed during a main-thread stall sounds at once
    // rather than being dropped: the sequencer still holds its release.
    const { host, sequencers } = await hostWith(1);
    host.noteAt(0, 3, 60, 100, -0.4, 1);
    expect(sequencers[0].sendEventAt.mock.calls[0][1]).toBe(0);
  });

  it('never sends a zero-length note', async () => {
    const { host, sequencers } = await hostWith(1);
    host.noteAt(0, 3, 60, 100, 0, 0);
    expect(sequencers[0].sendEventAt.mock.calls[0][0]).toMatchObject({ duration: 1 });
  });

  it('falls back to an immediate note-on when the instance has no sequencer', async () => {
    const { host, synths } = await hostWith(1, { withSequencer: false });
    host.noteAt(0, 3, 60, 100, 0.25, 1.5);
    // `midiNoteOn` is recorded by the `record()` helper, not a vi.fn.
    expect(synths[0].calls.midiNoteOn).toEqual([[3, 60, 100]]);
  });
});

describe('SynthHost: synth settings', () => {
  it('initialises each synth with 256 MIDI channels and a generous voice ceiling', async () => {
    const { synths } = await hostWith(1);
    expect(synths[0].calls.init).toEqual([[44100, { midiChannelCount: 256, polyphony: 2048 }]]);
  });

  it('gives every instance the same settings', async () => {
    const { synths } = await hostWith(2);
    expect(synths[1].calls.init).toEqual(synths[0].calls.init);
  });
});

describe('SynthHost', () => {
  it('loads the quiet-module seed, then fluidsynth, then the worklet', async () => {
    // Order is the whole contract here. The seed must precede libfluidsynth so
    // its emscripten module adopts a printErr that drops build-stub notices,
    // and libfluidsynth must precede the worklet build, which expects it.
    const ctx = stubContext();
    const host = new SynthHost({ createSynth: () => stubSynth() });
    await host.init(ctx, {
      fluidsynthModuleUrl: 'fluid.js',
      workletModuleUrl: 'worklet.js',
      soundfont: new Uint8Array(4).buffer,
      instanceCount: 1,
    });
    const added = vi.mocked(ctx.audioWorklet.addModule).mock.calls.map((c) => String(c[0]));
    expect(added).toHaveLength(3);
    expect(added[0]).toMatch(/^blob:/); // the quiet-module seed
    expect(added.slice(1)).toEqual(['fluid.js', 'worklet.js']);
  });

  it('never selects a melodic program on a percussion channel', async () => {
    // Measured on a real synth: selecting from bank 0 on channel 9 leaves it
    // playing a piano, and it stays that way for every later note. Only the
    // melodic bank is refused — the drum bank is how a kit gets chosen at all,
    // which is why this asserts the kit select survives and the melodic one
    // does not.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 9);
    host.programSelect(0, 9, 42);
    expect(synths[0].calls.midiProgramSelect).toEqual([[9, 1, 128, 0]]);
  });

  it('hands a borrowed drum channel back when a pitched track takes it', async () => {
    // Channels are allocated per score, so the channel a second drum track
    // borrowed goes to a pitched track on the next score with one fewer kit.
    // Refusing the select there left that track playing congas under a violin
    // label, for good — nothing ever cleared the flag.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 3);
    synths[0].calls.midiProgramSelect = [];
    synths[0].calls.midiSetChannelType = [];

    host.programSelect(0, 3, 40);
    expect(synths[0].calls.midiSetChannelType).toEqual([[3, false]]);
    expect(synths[0].calls.midiProgramSelect).toEqual([[3, 1, 0, 40]]);
  });

  it('opens further instances on demand, at the interpolation the others are on', async () => {
    // How many synths a score needs is not known until it is loaded, and a
    // track assigned to an instance that was never opened plays silently.
    const synths = [stubSynth(), stubSynth()];
    let made = 0;
    const host = new SynthHost({ createSynth: () => synths[made++] });
    await host.init(stubContext(), {
      fluidsynthModuleUrl: 'fluid.js',
      workletModuleUrl: 'worklet.js',
      soundfont: new Uint8Array(4).buffer,
      instanceCount: 1,
    });
    host.setInterpolation(4);

    await host.ensureInstances(2);
    host.noteOn(1, 4, 60, 100);
    expect(synths[1].calls.midiNoteOn?.[0]).toEqual([4, 60, 100]);
    expect(synths[1].calls.setInterpolation?.[0]).toEqual([4]);

    // Idempotent: asking again must not build a third.
    await host.ensureInstances(2);
    expect(made).toBe(2);
  });

  it('does select a program on an ordinary channel', async () => {
    const { host, synths } = await hostWith(1);
    host.programSelect(0, 3, 42);
    expect(synths[0].calls.midiProgramSelect?.[0]).toEqual([3, 1, 0, 42]);
  });

  it('marks a non-nine percussion channel as a drum channel', async () => {
    // How a second drum track shares an instance instead of costing another.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 5);
    expect(synths[0].calls.midiSetChannelType?.[0]).toEqual([5, true]);
  });

  it('routes notes to the instance that owns the channel', async () => {
    const { host, synths } = await hostWith(2);
    host.noteOn(1, 4, 60, 100);
    expect(synths[0].calls.midiNoteOn).toBeUndefined();
    expect(synths[1].calls.midiNoteOn?.[0]).toEqual([4, 60, 100]);
  });

  it('uses the worklet sequencer for timed notes when it exists', async () => {
    const sequencer = stubSequencer();
    const synth = stubSynth(sequencer);
    const host = new SynthHost({ createSynth: () => synth });
    await host.init(stubContext(), {
      fluidsynthModuleUrl: 'fluid.js',
      workletModuleUrl: 'worklet.js',
      soundfont: new Uint8Array(4).buffer,
      instanceCount: 1,
    });

    host.noteAt(0, 4, 60, 100, 0.125, 0.5);

    expect(sequencer.registerSynthesizer).toHaveBeenCalledWith(synth);
    expect(sequencer.setTimeScale).toHaveBeenCalledWith(1000);
    expect(sequencer.sendEventAt).toHaveBeenCalledWith(
      { type: 'note', channel: 4, key: 60, vel: 100, duration: 500 },
      125,
      false,
    );
    expect(synth.calls.midiNoteOn).toBeUndefined();
  });

  it('sends a switched drum channel to the drum bank, not just the drum type', async () => {
    // The type switch alone only routes *later* program changes to the drum
    // bank; the channel keeps its default piano preset. A second drum track
    // therefore played its congas and cowbells as piano notes. Measured against
    // a real synth: channel 9 gave peak 0.1229, the type switch alone 0.1115,
    // and the type switch plus this select matched channel 9 exactly.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 3);
    expect(synths[0].calls.midiSetChannelType).toEqual([[3, true]]);
    expect(synths[0].calls.midiProgramSelect).toEqual([[3, 1, 128, 0]]);
  });

  it('leaves channel 9 completely alone, which is what makes drums sound', async () => {
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 9);
    // No channel-type switch: channel 9 is a drum channel already. The kit
    // select is bit-identical to leaving it alone — measured at peak 0.1883,
    // rms 0.01815 either way — and is what makes a non-standard kit possible.
    expect(synths[0].calls.midiSetChannelType).toBeUndefined();
    expect(synths[0].calls.midiProgramSelect).toEqual([[9, 1, 128, 0]]);
  });

  it('selects the kit the file asked for, after the one the font is guaranteed to have', async () => {
    // General MIDI selects the drum kit with a program change on the drum
    // channel. A kit the font lacks leaves fluidsynth's selection untouched,
    // and untouched on a switched channel is the piano it started on — so
    // Standard goes on first and a failed switch lands on drums.
    const { host, synths } = await hostWith(1);
    host.setChannelPercussion(0, 9, 8); // Room
    expect(synths[0].calls.midiProgramSelect).toEqual([
      [9, 1, 128, 0],
      [9, 1, 128, 8],
    ]);
  });

  it('applies interpolation to every instance, since the governor speaks for all of them', async () => {
    const { host, synths } = await hostWith(2);
    host.setInterpolation(4);
    for (const s of synths) expect(s.calls.setInterpolation?.at(-1)).toEqual([4]);
  });

  it('silences every instance on allSoundOff', async () => {
    const { host, synths } = await hostWith(2);
    host.allSoundOff();
    for (const s of synths) expect(s.calls.midiAllSoundsOff).toBeDefined();
  });

  it('cancels queued sequencer events on allSoundOff', async () => {
    const sequencer = stubSequencer();
    const host = new SynthHost({ createSynth: () => stubSynth(sequencer) });
    await host.init(stubContext(), {
      fluidsynthModuleUrl: 'fluid.js',
      workletModuleUrl: 'worklet.js',
      soundfont: new Uint8Array(4).buffer,
      instanceCount: 1,
    });

    host.allSoundOff();

    expect(sequencer.removeAllEvents).toHaveBeenCalled();
  });

  it('ignores calls for an instance that does not exist rather than throwing', async () => {
    // A stale channel assignment must not take down the audio thread.
    const { host } = await hostWith(1);
    expect(() => host.noteOn(5, 0, 60, 100)).not.toThrow();
  });
});
