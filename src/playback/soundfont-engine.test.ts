import { describe, expect, it, vi } from 'vitest';
import type { PlaybackLoadState, PlaybackPlan } from '@sudobility/music_types';
import { WebSynthBackend } from '../web/playback/web-backend.js';
import type { WebBackendDeps } from '../web/playback/web-backend.js';
import { SoundfontPlaybackEngine } from './soundfont-engine.js';
import {
  TICKS_PER_SECOND,
  testNote,
  testPlan,
  testTrack,
  twoTrackPlan,
} from '../shared/test-plan.js';

/** Records everything the engine tells the synth host. */
/**
 * Builds the engine from the flat options these tests have always used.
 *
 * The web-shaped half — context, font, worklet URLs — now belongs to
 * `WebSynthBackend` rather than to the scheduler, so it is split out here. The
 * tests keep exercising the real backend, which is the point: the suspended
 * context, the load progress and the font failure are its rules now, and they
 * would otherwise have lost their only coverage in the move.
 */
function engineWith(
  opts: WebBackendDeps & {
    now?: () => number;
    startPump?: (tick: () => void, intervalMs: number) => () => void;
  }
): SoundfontPlaybackEngine {
  const { now, startPump, ...web } = opts;
  return new SoundfontPlaybackEngine({
    backend: new WebSynthBackend(web),
    ...(now ? { now } : {}),
    ...(startPump ? { startPump } : {}),
  });
}

function stubHost() {
  const noteOn = vi.fn();
  return {
    init: vi.fn(async () => {}),
    ensureInstances: vi.fn(async () => {}),
    setChannelPercussion: vi.fn(),
    programSelect: vi.fn(),
    noteOn,
    noteAt: vi.fn(
      (
        instance: number,
        channel: number,
        midi: number,
        velocity: number,
        _delaySeconds: number,
        _durationSeconds: number
      ) => {
        noteOn(instance, channel, midi, velocity);
      }
    ),
    noteOff: vi.fn(),
    controlChange: vi.fn(),
    allSoundOff: vi.fn(),
    setInterpolation: vi.fn(),
    setMasterVolume: vi.fn(),
    setTrackCount: vi.fn(),
    dispose: vi.fn(),
  };
}

/** One scheduled metronome click, as the fake graph saw it. */
type ClickRecord = { startAt: number; stopAt: number };

/** Enough AudioContext for the metronome click, and nothing more. */
function stubContext() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const clicks: ClickRecord[] = [];
  return {
    sampleRate: 44100,
    currentTime: 0,
    clicks,
    destination: { connect: vi.fn(), disconnect: vi.fn() },
    close: vi.fn(),
    createOscillator: vi.fn(() => {
      const record: ClickRecord = { startAt: 0, stopAt: 0 };
      clicks.push(record);
      return {
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn((at: number) => {
          record.startAt = at;
        }),
        // Last call wins, exactly as Web Audio treats a re-stop.
        stop: vi.fn((at: number) => {
          record.stopAt = at;
        }),
        onended: null,
      };
    }),
    createGain: vi.fn(() => ({
      gain: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  } as unknown as AudioContext & { clicks: ClickRecord[] };
}

/** The fake graph behind a running engine, for asserting on scheduled clicks. */
function graphOf(context: () => AudioContext | null): {
  clicks: ClickRecord[];
} {
  return context() as unknown as { clicks: ClickRecord[] };
}

/** A pump we step by hand, so tests never wait on real time. */
/**
 * The engine registers more than one ticker — audio scheduling at 50ms and the
 * lit keys at frame rate — so this holds every callback rather than the last
 * one. Keeping only the last silently replaced the scheduling pump with the
 * sounding ticker, and `step()` then drove neither the notes nor the metronome.
 */
function manualPump() {
  const ticks = new Map<() => void, number>();
  return {
    start: (cb: () => void, intervalMs: number) => {
      ticks.set(cb, intervalMs);
      return () => {
        ticks.delete(cb);
      };
    },
    step: () => {
      for (const tick of [...ticks.keys()]) tick();
    },
    /** Drives only the tickers registered at `intervalMs`, so a test can run one without the other. */
    stepEvery: (intervalMs: number) => {
      for (const [tick, ms] of [...ticks]) if (ms === intervalMs) tick();
    },
    get running() {
      return ticks.size > 0;
    },
  };
}

/** The cadence the lit keys run at, which is deliberately not the scheduler's. */
const SOUNDING_MS = 16;

function setup(
  plan?: PlaybackPlan,
  createContext: () => AudioContext = () => stubContext()
) {
  const host = stubHost();
  // Captured on the way past: the context belongs to the backend now, and a
  // test that reached into the engine for it was reading an implementation
  // detail that has since moved.
  let context: AudioContext | null = null;
  const capture = () => (context = createContext());
  const pump = manualPump();
  const clock = { t: 0 };
  const engine = engineWith({
    host,
    moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
    fontUrl: 'font.sf3',
    loadFont: async () => new Uint8Array(4).buffer,
    createContext: capture,
    now: () => clock.t,
    startPump: pump.start,
  });
  return {
    engine,
    host,
    pump,
    clock,
    plan: plan ?? twoTrackPlan(),
    context: () => context,
  };
}

describe('SoundfontPlaybackEngine: loading a score', () => {
  it('sends each track its volume as CC7 and its pan as CC10', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    const controls = host.controlChange.mock.calls.map(c => c[2]);
    expect(controls).toContain(7);
    expect(controls).toContain(10);
  });

  it('selects each track GM program', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    const programs = host.programSelect.mock.calls.map(c => c[2]);
    expect(programs).toEqual(
      plan.tracks.map((t: { midiProgram: number }) => t.midiProgram)
    );
  });

  it('marks a percussion-clef track as percussion and never selects a program on it', async () => {
    // Selecting a program on a percussion channel silences it — see the spike.
    const base = twoTrackPlan();
    const plan = testPlan({
      ...base,
      tracks: [{ ...base.tracks[0], isPercussion: true }, base.tracks[1]],
    });
    const { engine, host } = setup(plan);
    await engine.initialize();
    await engine.load(plan);

    expect(host.setChannelPercussion).toHaveBeenCalledTimes(1);
    expect(host.programSelect).toHaveBeenCalledTimes(1); // only the pitched track
  });

  it('gives a second percussion track its own drum channel, and plays it there', async () => {
    // The case a real score hits the moment somebody adds a kit beside the
    // drums it already had. Channel 9 is the only channel fluidsynth types as
    // drums by itself, so the second one has to be told — and if its notes go
    // anywhere but its own channel, the track is silent however loud it is.
    const base = twoTrackPlan();
    const plan = testPlan({
      ...base,
      tracks: [
        { ...base.tracks[0], isPercussion: true },
        { ...base.tracks[1], isPercussion: true },
      ],
    });
    const { engine, host, pump, clock } = setup(plan);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    // Both are drum channels, and they are different ones.
    expect(host.setChannelPercussion).toHaveBeenCalledTimes(2);
    const drumChannels = host.setChannelPercussion.mock.calls.map(c => c[1]);
    expect(new Set(drumChannels).size).toBe(2);
    expect(drumChannels).toContain(9);

    // Neither is given a melodic program, which is what silences a drum channel.
    expect(host.programSelect).not.toHaveBeenCalled();

    // And every note lands on one of those two channels — in particular the
    // second track's notes reach the second channel rather than vanishing.
    for (let i = 0; i < 40; i += 1) {
      pump.step();
      clock.t += 0.1;
    }
    const noteChannels = new Set(host.noteOn.mock.calls.map(c => c[1]));
    expect(noteChannels.size).toBe(2);
    for (const channel of noteChannels) expect(drumChannels).toContain(channel);
  });

  it('tells the host how many channels are summing, which sizes the headroom', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    expect(host.setTrackCount).toHaveBeenCalledWith(plan.tracks.length);
  });

  /*
    `load` runs on every score change, because an edit produces a new score
    object and the host reloads on identity. It used to seek to 0 — so writing
    a note put the caret back at the beginning of the piece: the editing action
    advanced the caret synchronously, this reload landed afterwards, and the
    caret *is* the reported position. Typing a melody wrote every note into
    bar 1, in both the web and the React Native app.

    Nothing wanted the reset. The one caller that needs bar 1 — a score
    arriving from outside, a snapshot or a generation result — calls `stop()`
    first, and `stop` zeroes the clock, which is what the third test pins.
  */
  it('keeps the playhead where it was when the score is replaced', async () => {
    const { engine, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: tick => ticks.push(tick),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);
    engine.seek(480 * 4);

    ticks.length = 0;
    await engine.load(testPlan({ ...plan, tracks: plan.tracks }));

    expect(ticks.at(-1)).toBe(480 * 4);
  });

  it('clamps the playhead into a score that got shorter', async () => {
    // Deleting the last bars leaves the old position past the end of the
    // piece, which is a tick nothing can be seeked to.
    const { engine, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: tick => ticks.push(tick),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);
    engine.seek(480 * 8);

    ticks.length = 0;
    // Two beats' worth: the piece now ends at tick 960.
    await engine.load(testPlan({ ...plan, notes: plan.notes.slice(0, 2) }));

    expect(ticks.at(-1)).toBe(960);
  });

  it('still starts at the beginning for a score that arrives after a stop', async () => {
    const { engine, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: tick => ticks.push(tick),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);
    engine.seek(480 * 4);
    engine.stop();

    ticks.length = 0;
    await engine.load(testPlan({ ...plan, tracks: plan.tracks }));

    expect(ticks.at(-1)).toBe(0);
  });
});

describe('SoundfontPlaybackEngine: mixing', () => {
  it('mutes by sending CC7 zero and restores the track volume on unmute', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    const track = plan.tracks[0];

    host.controlChange.mockClear();
    engine.setTrackMute(track.id, true);
    expect(host.controlChange).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      7,
      0
    );

    host.controlChange.mockClear();
    engine.setTrackMute(track.id, false);
    const restored = host.controlChange.mock.calls.find(c => c[2] === 7);
    expect(restored?.[3]).toBe(Math.round(track.volume * 127));
  });

  it('solo silences every non-soloed track', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);

    host.controlChange.mockClear();
    engine.setTrackSolo(plan.tracks[0].id, true);

    const cc7 = host.controlChange.mock.calls.filter(c => c[2] === 7);
    expect(cc7.some(c => c[3] === 0)).toBe(true); // the non-soloed one
    expect(cc7.some(c => c[3] > 0)).toBe(true); // the soloed one
  });
});

describe('SoundfontPlaybackEngine: bringing the synth up', () => {
  /** A context that starts suspended, as a browser gives you without a gesture. */
  function suspendableContext(): Record<string, unknown> {
    const base = stubContext() as unknown as Record<string, unknown>;
    base.state = 'suspended';
    base.resume = vi.fn(async () => {
      base.state = 'running';
    });
    return base;
  }

  it('does not touch the synth while the context is suspended', async () => {
    // A suspended context never runs its AudioWorklet, and the synth's font
    // load round-trips through it — so this would not fail, it would hang for
    // good, leaving the transport stuck at "stopped" with a clean console.
    const context = stubContext() as unknown as Record<string, unknown>;
    context.state = 'suspended';
    const { engine, host, plan } = setup(undefined, () => context as never);
    await engine.initialize();
    await engine.load(plan);
    expect(host.init).not.toHaveBeenCalled();
  });

  it('resumes the context and brings the synth up when play is pressed', async () => {
    // Play is a user gesture, which is what makes resuming allowed.
    const context = suspendableContext();
    const { engine, host, plan } = setup(undefined, () => context as never);
    await engine.load(plan);
    expect(host.init).not.toHaveBeenCalled();

    await engine.play();
    expect(context.resume as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(host.init).toHaveBeenCalled();
  });

  it('tells the host about a score that arrived before the synth existed', async () => {
    // load no longer waits for the synth, so the programs and levels it
    // would have sent have to be sent once there is something to send them to.
    const context = suspendableContext();
    const { engine, host, plan } = setup(undefined, () => context as never);
    await engine.load(plan);
    expect(host.programSelect).not.toHaveBeenCalled();

    await engine.play();
    expect(host.programSelect).toHaveBeenCalled();
    expect(host.setTrackCount).toHaveBeenCalledWith(plan.tracks.length);
  });

  /** An engine whose soundfont does not arrive until the returned `release` is called. */
  function withPendingFont() {
    let release!: () => void;
    const font = new Promise<ArrayBuffer>(resolve => {
      release = () => resolve(new Uint8Array(4).buffer);
    });
    const host = stubHost();
    const pump = manualPump();
    const context = suspendableContext();
    const engine = engineWith({
      host,
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: () => font,
      createContext: () => context as never,
      now: () => 0,
      startPump: pump.start,
    });
    return { engine, host, pump, release };
  }

  it('does not report playing until the synth can actually sound', async () => {
    // This used to report "playing" immediately, so the button would not look
    // dead through the 23MB first load. It made the transport lie, and the app
    // believed it: the caret interpolates between the engine's 30Hz reports
    // using elapsed real time, and no reports arrive while the font loads — so
    // the caret glided silently through several bars, then snapped back when
    // the music finally started from the beginning.
    //
    // The load indicator (`PlaybackLoadState`, reported below) is what fills
    // that window now, which is what makes honest reporting affordable.
    const { engine, pump, release } = withPendingFont();
    const states: string[] = [];
    const loads: string[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: s => states.push(s),
      onLoadStateChange: s => loads.push(s.status),
    });
    await engine.load(twoTrackPlan());

    const playing = engine.play();
    expect(states).toEqual([]); // nothing is playing yet, and nothing claims to be
    // The load is reported once the context is running, a microtask later.
    await vi.waitFor(() => expect(loads).toContain('loading')); // the transport knows why
    expect(states).toEqual([]); // and still says nothing about playing
    expect(pump.running).toBe(false);

    release();
    await playing;
    expect(states).toEqual(['playing']);
    expect(pump.running).toBe(true);
  });

  it('reports playing on the spot once the synth is up', async () => {
    // Only the first press waits. Every one after it must be immediate — a
    // transport that lags a frame behind the button is its own bug.
    const { engine, host, pump, plan } = setup();
    await engine.load(plan);
    await engine.initialize();
    expect(host.init).toHaveBeenCalled();

    const states: string[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: s => states.push(s),
    });

    const playing = engine.play();
    expect(states).toEqual(['playing']); // synchronously, before the promise settles
    await playing;
    expect(pump.running).toBe(true);
  });

  it('does not start playing if the user pauses while the synth loads', async () => {
    const { engine, pump, release } = withPendingFont();
    await engine.load(twoTrackPlan());

    const playing = engine.play();
    engine.pause();
    release();
    await playing;
    expect(pump.running).toBe(false);
  });

  it('reports fetch progress, then indeterminate, then ready', async () => {
    // Without this the transport looks broken for the whole load. The fetch is
    // the measurable half; handing the font to fluidsynth reports nothing.
    const host = stubHost();
    const context = suspendableContext();
    const engine = engineWith({
      host,
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: async (_url, onProgress) => {
        onProgress?.({ loaded: 50, total: 100 });
        onProgress?.({ loaded: 100, total: 100 });
        return new Uint8Array(4).buffer;
      },
      createContext: () => context as never,
      now: () => 0,
      startPump: manualPump().start,
    });
    const seen: PlaybackLoadState[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: () => {},
      onLoadStateChange: s => seen.push(s),
    });

    await engine.initialize();
    expect(seen.at(-1)).toEqual({ status: 'ready' });
    // Fetching never claims the whole bar: seconds of decoding follow it, so a
    // completed download reads as half done, then goes indeterminate.
    const fractions = seen
      .filter(s => s.status === 'loading')
      .map(s => s.fraction);
    expect(fractions).toEqual([0, 0.25, 0.5, null]);
  });

  it('reports a failure rather than going quiet', async () => {
    // A font that will not load is otherwise indistinguishable from silence.
    const context = suspendableContext();
    const engine = engineWith({
      host: stubHost(),
      moduleUrls: { fluidsynth: 'f.js', worklet: 'w.js' },
      fontUrl: 'font.sf3',
      loadFont: async () => {
        throw new Error('Soundfont fetch failed: 404');
      },
      createContext: () => context as never,
      now: () => 0,
      startPump: manualPump().start,
    });
    const seen: PlaybackLoadState[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: () => {},
      onLoadStateChange: s => seen.push(s),
    });

    await expect(engine.initialize()).rejects.toThrow('404');
    expect(seen.at(-1)).toEqual({
      status: 'failed',
      message: 'Soundfont fetch failed: 404',
    });
  });

  it('keeps pumping after a tick throws, and says so', async () => {
    // A throw in the pump escapes a bare interval callback into nothing. The
    // interval keeps firing and every later tick throws at the same place, so
    // playback stops dead with a clean console and a transport still reporting
    // "playing" — the exact silent-failure shape this engine exists to remove.
    const { engine, host, pump, clock, plan } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await engine.load(plan);
    await engine.play();

    host.noteOn.mockImplementationOnce(() => {
      throw new Error('synth blew up');
    });
    clock.t = 1;
    expect(() => pump.step()).not.toThrow();
    expect(errors).toHaveBeenCalledWith(
      'Playback pump failed',
      expect.any(Error)
    );

    // And the next tick still dispatches, rather than the pump being dead.
    host.noteOn.mockClear();
    clock.t = 2;
    pump.step();
    expect(host.noteOn).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('brings the synth up only once for concurrent callers', async () => {
    const { engine, host, plan } = setup();
    await Promise.all([
      engine.initialize(),
      engine.initialize(),
      engine.load(plan),
    ]);
    expect(host.init).toHaveBeenCalledTimes(1);
  });

  it('retries after a deferred attempt rather than caching it forever', async () => {
    const context = stubContext() as unknown as Record<string, unknown>;
    context.state = 'suspended';
    context.resume = vi.fn(async () => {});
    const { engine, host } = setup(undefined, () => context as never);
    await engine.initialize();
    expect(host.init).not.toHaveBeenCalled();

    context.resume = vi.fn(async () => {
      context.state = 'running';
    });
    await engine.initialize();
    expect(host.init).toHaveBeenCalled();
  });
});

describe('SoundfontPlaybackEngine: transport', () => {
  it('reports playing, then paused, then stopped', async () => {
    const { engine, plan } = setup();
    const states: string[] = [];
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: s => states.push(s),
    });
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    engine.pause();
    engine.stop();
    expect(states).toEqual(['playing', 'paused', 'stopped']);
  });

  it('runs the pump only while playing', async () => {
    const { engine, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    expect(pump.running).toBe(false);
    await engine.play();
    expect(pump.running).toBe(true);
    engine.pause();
    expect(pump.running).toBe(false);
  });

  it('reports the current tick before pausing so the caret does not jump to the last sample', async () => {
    const { engine, clock, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: tick => ticks.push(tick),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    ticks.length = 0;

    clock.t = 1;
    engine.pause();

    expect(ticks.at(-1)).toBeGreaterThan(0);
  });

  it('dispatches notes that have come due, and does not repeat them', async () => {
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    clock.t = 1; // a second of score time has passed
    pump.step();
    const first = host.noteOn.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    pump.step(); // same position: nothing new is due
    expect(host.noteOn.mock.calls.length).toBe(first);
  });

  it('hands future lookahead notes to the host with a playback-relative delay', async () => {
    // 600 BPM at ppq 480 is 4800 ticks per second — a fast linear tempo, so a
    // lookahead note lands a small, easily-asserted delay ahead.
    const fast = testPlan({
      ...twoTrackPlan(),
      tempo: {
        ticksToSeconds: t => t / 4800,
        secondsToTicks: sec => sec * 4800,
      },
    });
    const { engine, host, plan } = setup(fast);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    const delays = host.noteAt.mock.calls.map(c => c[4] as number);
    expect(delays.some(delay => delay > 0.05)).toBe(true);
  });

  it('starts the piece at its beginning even when the first pump tick is late', async () => {
    // Found by hand: the clock used to start in play(), but the first pump tick
    // can be seconds late while the main thread finishes worklet and soundfont
    // setup. By then the clock said the music was already seconds in, so every
    // note before that point was past its grace window and skipped — the
    // opening of the piece vanished. Measured at 2.3s lost on a real load.
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    clock.t = 2.3; // the thread was busy; the pump only runs now
    pump.step();

    // The opening notes must still sound, not be treated as long overdue.
    expect(host.noteOn).toHaveBeenCalled();
  });

  it('does not resurrect playback from a stray pump tick after stop', async () => {
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    expect(host.noteOn).toHaveBeenCalled();

    engine.stop();
    host.noteOn.mockClear();

    clock.t = 5;
    pump.step(); // a stray tick from a stale interval must not resurrect playback
    expect(host.noteOn).not.toHaveBeenCalled();
  });

  it('clicks only when the metronome is on', async () => {
    const { engine, pump, clock, plan, context } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    clock.t = 1;
    pump.step();
    expect(
      vi.mocked((context() as AudioContext).createOscillator)
    ).not.toHaveBeenCalled();

    engine.setMetronome(true);
    clock.t = 2;
    pump.step();
    expect(
      vi.mocked((context() as AudioContext).createOscillator)
    ).toHaveBeenCalled();
  });

  it('silences everything on stop rather than leaving notes ringing', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    host.allSoundOff.mockClear();
    engine.stop();
    expect(host.allSoundOff).toHaveBeenCalled();
  });

  it('reports the new position on seek, so the caret follows a click while stopped', async () => {
    // The caret is driven by the store's positionTick, and nothing else writes
    // it: `PlaybackController.seek` only forwards to the engine. Without this
    // report a click on the sheet moved the transport but left the caret at
    // tick 0, which is exactly how it looked.
    const { engine, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: t => ticks.push(t),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);

    engine.seek(480 * 4);
    expect(ticks.at(-1)).toBe(480 * 4);
  });

  it('keeps reporting after a backward seek during playback', async () => {
    // The throttle compares the incoming position against the last reported
    // one, so seeking backwards left the difference negative and suppressed
    // every report until playback caught back up — a caret that froze for as
    // long as the jump was.
    const { engine, pump, clock, plan } = setup();
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: t => ticks.push(t),
      onActiveNotes: () => {},
      onStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    clock.t = 1; // inside the piece, while playback is still running
    pump.step();
    engine.seek(0); // jump back to the top — the audio clock keeps running

    ticks.length = 0;
    clock.t = 1.5;
    pump.step();
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('seeking moves the queue cursor, so earlier notes do not fire afterwards', async () => {
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    engine.seek(480 * 100); // far past every note
    host.noteOn.mockClear();
    clock.t = 0.1;
    pump.step();
    expect(host.noteOn).not.toHaveBeenCalled();
  });
});

describe('SoundfontPlaybackEngine: auditioning', () => {
  it('sounds a tapped key without touching transport state', async () => {
    const { engine, host, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);

    engine.noteOn(60, { program: 0, name: 'x', isPercussion: false });

    expect(host.noteOn).toHaveBeenCalled();
    expect(pump.running).toBe(false); // the transport stayed put
  });

  it('releases a held audition note', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    engine.noteOn(60, { program: 0, name: 'x', isPercussion: false });
    host.noteOff.mockClear();
    engine.noteOff(60);
    expect(host.noteOff).toHaveBeenCalled();
  });
});

/**
 * How many notes the plan schedules. Trivial now that the engine is handed
 * notes rather than a score — it used to have to flatten the fixture itself,
 * and counting `voice.events.length` instead (which includes rests) is what
 * once made this read 19 of 20.
 */
function noteCount(plan: PlaybackPlan): number {
  return plan.notes.length;
}

describe('SoundfontPlaybackEngine: scheduling horizon', () => {
  it('queues several seconds of music on the first tick, not 200ms', async () => {
    const { engine, host, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();
    const delays = host.noteAt.mock.calls.map(c => c[4] as number);
    expect(Math.max(...delays)).toBeGreaterThan(1);
  });

  it('does not re-send a note it has already scheduled', async () => {
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();
    const first = host.noteAt.mock.calls.length;
    clock.t += 0.05;
    pump.step();
    expect(host.noteAt.mock.calls.length).toBe(first);
  });

  it('plays every note of the piece even when the pump runs far behind', async () => {
    // Each step is a stall far longer than the old 200ms grace window, which
    // used to skip every note inside it outright.
    const { engine, host, pump, clock, plan } = setup();
    let state = 'stopped';
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: s => {
        state = s;
      },
    });
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    pump.step();
    // Run to the end of the piece in 1.5s lurches. Bounded so a regression that
    // never ends the piece fails here rather than hanging.
    for (let i = 0; i < 100 && state === 'playing'; i += 1) {
      clock.t += 1.5;
      pump.step();
    }

    expect(state).toBe('stopped');
    expect(host.noteAt.mock.calls.length).toBe(noteCount(plan));
  });

  it('caps how many notes one tick hands to the sequencer', async () => {
    // Each is a postMessage to the worklet; a dense score must not post
    // thousands in a single frame.
    const { engine, host, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();
    expect(host.noteAt.mock.calls.length).toBeLessThanOrEqual(512);
  });
});

describe('SoundfontPlaybackEngine: sounding notes', () => {
  function observed() {
    const onActiveNotes = vi.fn();
    const onPositionTick = vi.fn();
    return {
      onActiveNotes,
      onPositionTick,
      observer: {
        onPositionTick,
        onActiveNotes,
        onStateChange: vi.fn(),
      },
    };
  }

  it('reports sounding notes only when they change', async () => {
    const { engine, pump, clock, plan } = setup();
    const { onActiveNotes, observer } = observed();
    engine.setObserver(observer);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();

    const afterFirst = onActiveNotes.mock.calls.length;
    // Three ticks well inside the first note, during which nothing starts or ends.
    clock.t += 0.01;
    pump.step();
    clock.t += 0.01;
    pump.step();
    clock.t += 0.01;
    pump.step();

    expect(onActiveNotes.mock.calls.length).toBe(afterFirst);
  });

  it('lights a key without waiting for the audio scheduler', async () => {
    // The bug this fixes: the lit keys used to be published from the 50ms
    // scheduling pump, so a note that began just after one waited up to a full
    // 50ms to light — visibly behind the sound. The caret never had the
    // problem because it dead-reckons between reports; the keys just waited.
    const { engine, pump, clock, plan } = setup();
    const { onActiveNotes, observer } = observed();
    engine.setObserver(observer);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();
    onActiveNotes.mockClear();

    // Time passes across a note boundary, and the scheduler is deliberately
    // never run again — only the frame-rate ticker.
    for (let i = 0; i < 60; i += 1) {
      clock.t += SOUNDING_MS / 1000;
      pump.stepEvery(SOUNDING_MS);
    }

    expect(onActiveNotes).toHaveBeenCalled();
    // And it happened on a sounding tick, not a scheduling one: the scheduler
    // has not run since the mock was cleared.
    expect(pump.running).toBe(true);
  });

  it('holds a key back by the time the sound is still in the pipeline', async () => {
    // `currentTime` is what the graph is scheduling, not what the room has
    // heard: with a long output latency the music is further behind, so the
    // lights have to wait for it. Exaggerated here to be unmistakable — a real
    // machine reports ~20ms, which nearly cancels the render delay.
    const laggy = stubContext();
    (laggy as unknown as { outputLatency: number }).outputLatency = 5;
    const slow = setup(undefined, () => laggy as unknown as AudioContext);
    const a = observed();
    slow.engine.setObserver(a.observer);
    await slow.engine.initialize();
    await slow.engine.load(slow.plan);
    await slow.engine.play();
    slow.clock.t += 0.05;
    slow.pump.step();

    const litUnderLatency = (a.onActiveNotes.mock.calls.at(-1)?.[0] ??
      []) as unknown[];

    const prompt = setup();
    const b = observed();
    prompt.engine.setObserver(b.observer);
    await prompt.engine.initialize();
    await prompt.engine.load(prompt.plan);
    await prompt.engine.play();
    prompt.clock.t += 0.05;
    prompt.pump.step();

    const litWithout = (b.onActiveNotes.mock.calls.at(-1)?.[0] ??
      []) as unknown[];

    expect(litWithout.length).toBeGreaterThan(0);
    expect(litUnderLatency.length).toBe(0);
  });

  it('holds the caret back by the same latency as the lit keys', async () => {
    /*
      The caret used to run on scheduling time while the lit keys ran on
      listening time, so it sat ahead of the sound by the output latency — and
      ahead of the very notes it was pointing at. Two visuals off one clock
      disagreeing with each other is the part that made it obvious.

      Exaggerated here to be unmistakable; a real machine reports ~20ms, which
      nearly cancels the render delay.
    */
    const laggy = stubContext();
    (laggy as unknown as { outputLatency: number }).outputLatency = 5;
    const slow = setup(undefined, () => laggy as unknown as AudioContext);
    const a = observed();
    slow.engine.setObserver(a.observer);
    await slow.engine.initialize();
    await slow.engine.load(slow.plan);
    await slow.engine.play();
    slow.clock.t += 0.05;
    slow.pump.step();
    const laggyTick = a.onPositionTick.mock.calls.at(-1)?.[0] as number;

    const prompt = setup();
    const b = observed();
    prompt.engine.setObserver(b.observer);
    await prompt.engine.initialize();
    await prompt.engine.load(prompt.plan);
    await prompt.engine.play();
    prompt.clock.t += 0.05;
    prompt.pump.step();
    const promptTick = b.onPositionTick.mock.calls.at(-1)?.[0] as number;

    // The laggier the output, the further behind the caret has to sit.
    expect(laggyTick).toBeLessThan(promptTick);
  });

  it('still seeks to exactly the tick it was asked for', async () => {
    /*
      The correction is on the *playing* path only. A seek is the user saying
      where the caret goes, so answering with anything but that tick would make
      clicking the sheet land somewhere else — and by a different amount on
      every machine.
    */
    const laggy = stubContext();
    (laggy as unknown as { outputLatency: number }).outputLatency = 5;
    const { engine, plan } = setup(
      undefined,
      () => laggy as unknown as AudioContext
    );
    const { onPositionTick, observer } = observed();
    engine.setObserver(observer);
    await engine.initialize();
    await engine.load(plan);

    engine.seek(480 * 4);

    expect(onPositionTick.mock.calls.at(-1)?.[0]).toBe(480 * 4);
  });

  it('stops reporting a note once it has ended', async () => {
    // Nothing asserted this before: the set was fed by note-offs the pump fired
    // itself, and when those moved to the worklet it silently only ever grew.
    const { engine, pump, clock, plan } = setup();
    const { onActiveNotes, observer } = observed();
    engine.setObserver(observer);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();

    let sawSounding = false;
    for (let i = 0; i < 100; i += 1) {
      pump.step();
      const last = onActiveNotes.mock.calls.at(-1)?.[0] as string[] | undefined;
      if (last && last.length > 0) sawSounding = true;
      if (sawSounding && last && last.length === 0) break;
      clock.t += 0.1;
    }

    expect(sawSounding).toBe(true);
    expect(onActiveNotes.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('clears the sounding set on a seek, matching the synth being silenced', async () => {
    const { engine, pump, plan } = setup();
    const { onActiveNotes, observer } = observed();
    engine.setObserver(observer);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();

    onActiveNotes.mockClear();
    engine.seek(480 * 2);
    expect(onActiveNotes).toHaveBeenCalledWith([]);
  });
});

describe('SoundfontPlaybackEngine: applyMix', () => {
  it('pushes changed volume and pan without reloading', async () => {
    // Volume and pan had no route to the engine at all: TrackState.volume was
    // read once at loadScore, and pan only at applyScoreToHost.
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);

    host.controlChange.mockClear();
    engine.applyMix([
      { ...plan.tracks[0], volume: 0.25, pan: -1 },
      ...plan.tracks.slice(1),
    ]);

    const cc7 = host.controlChange.mock.calls.find(c => c[2] === 7);
    const cc10 = host.controlChange.mock.calls.find(c => c[2] === 10);
    expect(cc7?.[3]).toBe(Math.round(0.25 * 127));
    expect(cc10?.[3]).toBe(0); // hard left
  });

  it('honours mute and solo from the tracks it is handed', async () => {
    const { engine, host, plan } = setup();
    await engine.initialize();
    await engine.load(plan);

    host.controlChange.mockClear();
    engine.applyMix([
      { ...plan.tracks[0], solo: true },
      ...plan.tracks.slice(1),
    ]);

    const cc7 = host.controlChange.mock.calls.filter(c => c[2] === 7);
    expect(cc7.some(c => c[3] === 0)).toBe(true); // the non-soloed track
    expect(cc7.some(c => (c[3] as number) > 0)).toBe(true); // the soloed one
  });

  it('does not reschedule anything', async () => {
    const { engine, host, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();

    host.noteAt.mockClear();
    engine.applyMix(plan.tracks);
    expect(host.noteAt).not.toHaveBeenCalled();
  });
});

describe('SoundfontPlaybackEngine: the metronome', () => {
  it('takes back the clicks it has already scheduled when the transport stops', async () => {
    // Clicks are placed on the audio graph up to a whole horizon ahead, where
    // an oscillator started with `start(at)` sounds at that sample whatever
    // the transport does afterwards. Nothing in `allSoundOff` reaches them —
    // that speaks to the synth — so pausing left the room ticking for four
    // seconds after the music stopped.
    const { engine, pump, clock, plan, context } = setup();
    await engine.initialize();
    await engine.load(plan);
    engine.setMetronome(true);
    await engine.play();
    pump.step();

    const { clicks } = graphOf(context);
    const pending = clicks.filter(c => c.startAt > 0.5);
    expect(pending.length).toBeGreaterThan(0);

    clock.t = 0.5;
    engine.pause();
    // Stopped at or before the moment it would have begun, so it never sounds.
    for (const click of pending)
      expect(click.stopAt).toBeLessThanOrEqual(click.startAt);
  });

  it('stops clicking within a beat of being switched off, not a horizon later', async () => {
    const { engine, pump, clock, plan, context } = setup();
    await engine.initialize();
    await engine.load(plan);
    engine.setMetronome(true);
    await engine.play();
    pump.step();

    clock.t = 0.5;
    engine.setMetronome(false);
    const pending = graphOf(context).clicks.filter(c => c.startAt > 0.5);
    for (const click of pending)
      expect(click.stopAt).toBeLessThanOrEqual(click.startAt);
  });
});

describe('SoundfontPlaybackEngine: looping', () => {
  const loop = (startTick: number, endTick: number) => ({
    startTick,
    endTick,
    trackIds: [],
  });

  it('schedules nothing past the loop end', async () => {
    // The horizon is four seconds and the wrap only happens on the pump tick
    // *after* the end is reached, so a note a few milliseconds past the loop
    // end was already in the sequencer and sounded before the loop came round.
    const { engine, host, pump, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    engine.setLoop(loop(0, 1920)); // two seconds at 960 ticks per second
    await engine.play();
    pump.step();

    expect(host.noteAt.mock.calls.map(call => call[2])).toEqual([
      60, 61, 62, 63,
    ]);
  });

  it('does not click past the loop end either', async () => {
    const { engine, pump, plan, context } = setup();
    await engine.initialize();
    await engine.load(plan);
    engine.setMetronome(true);
    engine.setLoop(loop(0, 1920));
    await engine.play();
    pump.step();

    // Ticks 0, 480, 960, 1440 — the click at 1920 belongs to the next pass,
    // where it is the downbeat of the loop's first beat.
    expect(graphOf(context).clicks.map(c => c.startAt)).toEqual([
      0, 0.5, 1, 1.5,
    ]);
  });

  it('keeps looping past the last note rather than stopping the transport', async () => {
    const states: string[] = [];
    const { engine, pump, clock, plan } = setup();
    engine.setObserver({
      onPositionTick: () => {},
      onActiveNotes: () => {},
      onStateChange: state => states.push(state),
    });
    await engine.initialize();
    await engine.load(plan);
    engine.setLoop(loop(0, 480 * 20)); // past the eight seconds of music
    await engine.play();

    clock.t = 9; // every note drained and finished
    pump.step();
    expect(states).not.toContain('stopped');
  });
});

describe('SoundfontPlaybackEngine: playback speed', () => {
  it('rebuilds the horizon when the speed changes mid-playback', async () => {
    // Everything already in the sequencer carries a delay computed at the old
    // speed. Four seconds of it, so without a rebuild the music keeps the
    // previous tempo for a whole horizon and then jumps.
    const { engine, host, pump, clock, plan } = setup();
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();

    clock.t = 0.5;
    host.noteAt.mockClear();
    engine.setTempoMultiplier(2);
    pump.step();

    // Tick 960 falls one score-second in; half of that has played, so half a
    // score-second remains — a quarter of a second at double speed.
    const call = host.noteAt.mock.calls.find(c => c[2] === 62);
    expect(call?.[4]).toBeCloseTo(0.25, 6);
  });
});

describe('SoundfontPlaybackEngine: note velocity', () => {
  it('clamps and rounds velocity, as the offline renderer does', async () => {
    // A note-on at velocity zero is a note-off in MIDI, so a value that rounds
    // to nothing is a note that silently does not sound — while the same plan
    // exported through `soundfont-render`, which already clamps, would sound
    // it. The two must not disagree about what is audible.
    const plan = testPlan({
      tracks: [testTrack({ id: 't0' })],
      notes: [
        testNote({ trackId: 't0', tick: 0, velocity: 0.4, noteId: 'a' }),
        testNote({ trackId: 't0', tick: 480, velocity: 200, noteId: 'b' }),
        testNote({ trackId: 't0', tick: 960, velocity: 80.6, noteId: 'c' }),
      ],
    });
    const { engine, host, pump } = setup(plan);
    await engine.initialize();
    await engine.load(plan);
    await engine.play();
    pump.step();

    expect(host.noteAt.mock.calls.map(call => call[3])).toEqual([1, 127, 81]);
  });
});

describe('SoundfontPlaybackEngine: playing again after the end', () => {
  /*
    The reported bug: play a score to the end, press play again, and the sheet
    no longer follows the music.

    Nothing about following was broken. `report` throttles on the distance from
    the last reported *playback position*, and stopping rewinds the queue
    without clearing that baseline — so on the replay every position was
    "too soon" until playback climbed back past the end of the piece, which it
    never does. Audio played; the caret sat at bar 1 for the whole of it.
  */
  it('reports position again on the play after the transport reached the end', async () => {
    // Ten notes a second apart, so the four-second horizon cannot drain them
    // in one tick and the piece has a real end to reach.
    const plan = testPlan({
      tracks: [testTrack({ id: 't1' })],
      notes: Array.from({ length: 10 }, (_, i) =>
        testNote({ trackId: 't1', tick: i * TICKS_PER_SECOND, durTicks: 480 })
      ),
    });
    const { engine, pump, clock } = setup(plan);
    const states: string[] = [];
    const ticks: number[] = [];
    engine.setObserver({
      onPositionTick: tick => ticks.push(tick),
      onActiveNotes: () => {},
      onStateChange: state => states.push(state),
      onLoadStateChange: () => {},
    });
    await engine.initialize();
    await engine.load(plan);

    await engine.play();
    for (let second = 0; second <= 14; second += 1) {
      clock.t = second;
      pump.step();
    }
    expect(states).toContain('stopped');

    states.length = 0;
    ticks.length = 0;
    await engine.play();
    // The wall clock only ever moves forward; it is the *playback* position
    // that goes back to the start, which is the whole point of the case.
    for (let second = 1; second <= 4; second += 1) {
      clock.t = 14 + second;
      pump.step();
    }

    expect(states).toContain('playing');
    expect(ticks.filter(tick => tick > 0).length).toBeGreaterThan(0);
  });
});
