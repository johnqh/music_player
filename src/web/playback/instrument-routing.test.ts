/**
 * Which synth, which channel and which program each track ends up on.
 *
 * Every case here is a fault that was silent by construction: the transport
 * ran, the notes were dispatched, and either nothing came out or the wrong
 * instrument did. The unit under test is therefore always "what was the host
 * told", because that is the last point before the audio thread where a
 * misrouted instrument is still observable.
 */
import { describe, expect, it, vi } from 'vitest';
import { planOfTracks } from '../../shared/test-plan.js';
import { SoundfontPlaybackEngine } from './soundfont-engine.js';
import { allocateChannels } from './channel-allocator.js';

function stubHost() {
  const noteOn = vi.fn();
  return {
    init: vi.fn(async (_context: BaseAudioContext, _options: { instanceCount: number }) => {}),
    ensureInstances: vi.fn(async () => {}),
    setChannelPercussion: vi.fn(),
    programSelect: vi.fn(),
    noteOn,
    noteAt: vi.fn((instance: number, channel: number, midi: number, velocity: number, _delaySeconds: number, _durationSeconds: number) => {
      noteOn(instance, channel, midi, velocity);
    }),
    noteOff: vi.fn(),
    controlChange: vi.fn(),
    allSoundOff: vi.fn(),
    setInterpolation: vi.fn(),
    setMasterVolume: vi.fn(),
    setTrackCount: vi.fn(),
    dispose: vi.fn(),
  };
}

function stubContext() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  return {
    sampleRate: 44100,
    currentTime: 0,
    destination: node(),
    close: vi.fn(),
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
  } as unknown as AudioContext;
}

function engineWith() {
  const host = stubHost();
  const engine = new SoundfontPlaybackEngine({
    host,
    moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    createContext: () => stubContext(),
    now: () => 0,
    startPump: () => () => {},
  });
  return { host, engine };
}


describe('instrument routing', () => {
  it('opens as many synths as the allocation needs, not always one', async () => {
    // 240 pitched channels per synth (256 less the sixteen reserved for
    // percussion), so a 241-part score puts a track on instance 1. Initialising
    // with one synth left those tracks addressing `synths[1]`, which does not
    // exist — they played nothing at all, with no error anywhere. The boundary
    // was seventeen parts when an instance was sixteen channels wide.
    const { host, engine } = engineWith();
    const plan = planOfTracks(241);
    await engine.load(plan);
    await engine.initialize();

    const { instanceCount } = allocateChannels(
      plan.tracks.map((t) => ({ id: t.id, isPercussion: false })),
    );
    expect(instanceCount).toBe(2);
    expect(host.init.mock.calls[0][1].instanceCount).toBe(2);
  });

  it('keeps a seventeen-part score on one synth', async () => {
    // What used to need two instances, and a second 23MB copy of the soundfont.
    const { host, engine } = engineWith();
    await engine.load(planOfTracks(17));
    await engine.initialize();
    expect(host.init.mock.calls[0][1].instanceCount).toBe(1);
  });

  it('grows the host when a bigger score is loaded after start-up', async () => {
    const { host, engine } = engineWith();
    await engine.load(planOfTracks(2));
    await engine.initialize();
    expect(host.init.mock.calls[0][1].instanceCount).toBe(1);

    await engine.load(planOfTracks(241));
    expect(host.ensureInstances).toHaveBeenCalledWith(2);
  });

  it('auditions on a channel no track owns', async () => {
    // Channel 15 was hard-coded, and a fifteen-part score owns it: tapping a
    // key selected the audition's program on a real track, which then played
    // the wrong instrument until the next edit reloaded the score.
    const { host, engine } = engineWith();
    const plan = planOfTracks(16);
    await engine.load(plan);
    await engine.initialize();

    const { assignments } = allocateChannels(
      plan.tracks.map((t) => ({ id: t.id, isPercussion: false })),
    );
    const owned = new Set([...assignments.values()].map((a) => `${a.instance}:${a.channel}`));

    host.programSelect.mockClear();
    engine.noteOn(60, { program: 12, name: 'x', isPercussion: false });
    const [instance, channel] = host.programSelect.mock.calls[0];
    expect(owned.has(`${instance}:${channel}`)).toBe(false);
    expect(host.noteOn).toHaveBeenCalledWith(instance, channel, 60, expect.any(Number));
  });

  it('auditions a percussion track on its own kit rather than channel 9', async () => {
    // Channel 9 belongs to the drum track itself, so the audition inherited
    // that channel's volume — a muted drum track made the keyboard silent —
    // and ignored the kit, sounding Standard for a track playing TR-808.
    const { host, engine } = engineWith();
    await engine.load(planOfTracks(1, true));
    await engine.initialize();

    host.setChannelPercussion.mockClear();
    engine.noteOn(38, { program: 25, name: 'TR-808 Kit', isPercussion: true });
    const [instance, channel, kit] = host.setChannelPercussion.mock.calls[0];
    expect(kit).toBe(25);
    expect(channel).not.toBe(9);
    expect(host.noteOn).toHaveBeenCalledWith(instance, channel, 38, expect.any(Number));
  });
});
