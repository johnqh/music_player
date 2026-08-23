import { describe, expect, it, vi } from 'vitest';
import { PlaybackBus } from './bus.js';

const note = (noteId: string) => ({ noteId, trackId: 't', midi: 60 });

describe('PlaybackBus', () => {
  it('delivers each channel only to its own subscribers', () => {
    // The whole point of three channels: the caret must not wake when a note
    // starts, and the keyboard must not wake thirty times a second.
    const bus = new PlaybackBus();
    const onPosition = vi.fn();
    const onSounding = vi.fn();
    const onTransport = vi.fn();
    bus.onPosition(onPosition);
    bus.onSounding(onSounding);
    bus.onTransport(onTransport);

    bus.publishPosition(480);

    expect(onPosition).toHaveBeenCalledWith(480);
    expect(onSounding).not.toHaveBeenCalled();
    expect(onTransport).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new PlaybackBus();
    const listener = vi.fn();
    const off = bus.onPosition(listener);
    bus.publishPosition(1);
    off();
    bus.publishPosition(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('remembers the last value, so a late subscriber is not blind until the next event', () => {
    const bus = new PlaybackBus();
    bus.publishPosition(960);
    bus.publishSounding([note('a')]);
    bus.publishTransport('playing');

    expect(bus.positionTick).toBe(960);
    expect(bus.sounding).toEqual([note('a')]);
    expect(bus.transport).toBe('playing');
  });

  it('reaches every subscriber on a channel', () => {
    const bus = new PlaybackBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onSounding(a);
    bus.onSounding(b);
    bus.publishSounding([note('x')]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('publishes sounding notes even when the set repeats, because the engine already filtered', () => {
    // Filtering again here would swallow the deliberate re-publish of an empty
    // set after a seek, which is how the UI learns nothing is sounding.
    const bus = new PlaybackBus();
    const listener = vi.fn();
    bus.onSounding(listener);
    bus.publishSounding([]);
    bus.publishSounding([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clear() drops every listener', () => {
    const bus = new PlaybackBus();
    const listener = vi.fn();
    bus.onPosition(listener);
    bus.clear();
    bus.publishPosition(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
