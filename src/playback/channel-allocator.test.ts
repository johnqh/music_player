import { describe, expect, it } from 'vitest';
import {
  allocateChannels,
  CHANNELS_PER_INSTANCE,
} from './channel-allocator.js';

const pitched = (id: string) => ({ id, isPercussion: false });
const drums = (id: string) => ({ id, isPercussion: true });
const manyPitched = (count: number) =>
  Array.from({ length: count }, (_, i) => pitched(`p${i}`));

describe('allocateChannels', () => {
  it('puts a drum track on channel 9, which GM maps to percussion by default', () => {
    // Verified in spikes/js-synthesizer-in-audioworklet.md: channel 9 sounds
    // only if left alone. Anything that needs an explicit select is worse off.
    const { assignments, instanceCount } = allocateChannels([drums('d')]);
    expect(assignments.get('d')).toEqual({
      instance: 0,
      channel: 9,
      needsDrumTypeSwitch: false,
    });
    expect(instanceCount).toBe(1);
  });

  it('never gives channel 9 to a pitched track', () => {
    // A pitched track there would play drums, because fluidsynth forces the
    // percussion bank on channel 9.
    const { assignments } = allocateChannels(
      Array.from({ length: 15 }, (_, i) => pitched(`p${i}`))
    );
    for (const a of assignments.values()) expect(a.channel).not.toBe(9);
  });

  it('fills an instance before opening another', () => {
    // 240 pitched channels per instance: 256 less the sixteen reserved for
    // percussion. The boundary was 15 when an instance was 16 channels wide.
    const tracks = Array.from({ length: 241 }, (_, i) => pitched(`p${i}`));
    const { assignments, instanceCount } = allocateChannels(tracks);
    expect(instanceCount).toBe(2);
    expect(assignments.get('p240')?.instance).toBe(1);
  });

  it('gives a second drum track an ordinary channel switched to drum type, not a whole new instance', () => {
    // Opening a second synth instance just to reach another channel 9 would
    // cost a full 16-channel synth for one extra drum part. `midiSetChannelType`
    // marks any channel as percussion, so an ordinary slot does.
    const { assignments, instanceCount } = allocateChannels([
      drums('d1'),
      drums('d2'),
    ]);
    expect(assignments.get('d1')).toEqual({
      instance: 0,
      channel: 9,
      needsDrumTypeSwitch: false,
    });
    const second = assignments.get('d2');
    expect(second?.instance).toBe(0);
    expect(second?.channel).not.toBe(9);
    expect(second?.needsDrumTypeSwitch).toBe(true);
    expect(instanceCount).toBe(1);
  });

  it('assigns every track exactly one distinct slot', () => {
    const tracks = [
      drums('d'),
      ...Array.from({ length: 40 }, (_, i) => pitched(`p${i}`)),
    ];
    const { assignments } = allocateChannels(tracks);
    expect(assignments.size).toBe(41);
    const slots = new Set(
      [...assignments.values()].map(a => `${a.instance}:${a.channel}`)
    );
    expect(slots.size).toBe(41);
  });

  it('handles a score with no tracks', () => {
    const { assignments, instanceCount } = allocateChannels([]);
    expect(assignments.size).toBe(0);
    expect(instanceCount).toBe(1);
  });
});

describe('allocateChannels: 256 channels per instance', () => {
  it('exposes 256 channels per instance', () => {
    expect(CHANNELS_PER_INSTANCE).toBe(256);
  });

  it('keeps seventeen pitched tracks on one instance', () => {
    const { assignments, instanceCount } = allocateChannels(manyPitched(17));
    expect(instanceCount).toBe(1);
    for (const a of assignments.values()) expect(a.instance).toBe(0);
  });

  it('never gives a pitched track a drum-capable channel', () => {
    // Only literal channel 9 is documented as drum-typed by default. Whether
    // fluidsynth does the same for 25, 41, ... at a raised channel count is
    // undocumented and untestable here, so pitched tracks stay off all of them.
    const { assignments } = allocateChannels(manyPitched(240));
    for (const a of assignments.values()) expect(a.channel % 16).not.toBe(9);
  });

  it('never sets needsDrumTypeSwitch on a pitched track', () => {
    // `soundfont-render.ts` branches on `isPercussion || needsDrumTypeSwitch`,
    // so a pitched track carrying the flag is sent a drum-bank program select
    // and exports as percussion. It shipped that way for one commit.
    const { assignments } = allocateChannels([...manyPitched(40), drums('d')]);
    for (const [id, a] of assignments) {
      if (id !== 'd') expect(a.needsDrumTypeSwitch).toBe(false);
    }
  });

  it('fits 240 pitched tracks on one instance, the non-drum channels', () => {
    const { assignments, instanceCount } = allocateChannels(manyPitched(240));
    expect(instanceCount).toBe(1);
    expect(new Set([...assignments.values()].map(a => a.channel)).size).toBe(
      240
    );
  });

  it('opens a second instance only past the first instance capacity', () => {
    const { instanceCount } = allocateChannels(manyPitched(241));
    expect(instanceCount).toBe(2);
  });

  it('puts later drum tracks on drum-capable channels, switched explicitly', () => {
    const tracks = Array.from({ length: 3 }, (_, i) => drums(`d${i}`));
    const { assignments, instanceCount } = allocateChannels(tracks);
    expect(instanceCount).toBe(1);
    const got = tracks.map(d => assignments.get(d.id)!);
    expect(got.map(a => a.channel % 16)).toEqual([9, 9, 9]);
    expect(got.map(a => a.needsDrumTypeSwitch)).toEqual([false, true, true]);
    expect(new Set(got.map(a => a.channel)).size).toBe(3);
  });

  it('gives a seventeenth drum track an ordinary channel with a type switch', () => {
    // Sixteen drum-capable channels per instance, so the seventeenth has to
    // borrow a melodic slot rather than cost a whole new synth.
    const tracks = Array.from({ length: 17 }, (_, i) => drums(`d${i}`));
    const { assignments, instanceCount } = allocateChannels(tracks);
    expect(instanceCount).toBe(1);
    const last = assignments.get('d16')!;
    expect(last.channel % 16).not.toBe(9);
    expect(last.needsDrumTypeSwitch).toBe(true);
  });
});
