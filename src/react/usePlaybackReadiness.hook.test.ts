// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PlaybackLoadState } from '@sudobility/music_types';
import type { IMusicPlayer } from '../types.js';
import { readinessOf } from '../types.js';
import { usePlaybackReadiness } from './usePlaybackReadiness.js';

/** A player that reports what it is told to, and counts the asks. */
function fakePlayer(initial: PlaybackLoadState) {
  let state = initial;
  const listeners = new Set<(s: PlaybackLoadState) => void>();
  let prepares = 0;
  const player = {
    get readiness() {
      return readinessOf(state);
    },
    prepare: async () => {
      prepares += 1;
    },
    onLoadState: (fn: (s: PlaybackLoadState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as IMusicPlayer;
  const report = (next: PlaybackLoadState) => {
    state = next;
    for (const fn of listeners) fn(next);
  };
  return { player, report, prepares: () => prepares };
}

describe('usePlaybackReadiness', () => {
  it('starts the bring-up when nothing has, and shows preparing meanwhile', () => {
    const { player, report, prepares } = fakePlayer({ status: 'idle' });
    const { result } = renderHook(() => usePlaybackReadiness(player));
    // Never `notReady` to a caller: the ask has been made.
    expect(result.current).toBe('preparing');
    expect(prepares()).toBe(1);
    act(() => report({ status: 'loading', fraction: 0.5 }));
    expect(result.current).toBe('preparing');
    act(() => report({ status: 'ready' }));
    expect(result.current).toBe('ready');
  });

  it('asks nothing of an engine already up, or already coming up', () => {
    const ready = fakePlayer({ status: 'ready' });
    renderHook(() => usePlaybackReadiness(ready.player));
    expect(ready.prepares()).toBe(0);
    const loading = fakePlayer({ status: 'loading', fraction: null });
    const { result } = renderHook(() => usePlaybackReadiness(loading.player));
    expect(loading.prepares()).toBe(0);
    expect(result.current).toBe('preparing');
  });

  it('is ready where there is no player to wait for', () => {
    const { result } = renderHook(() => usePlaybackReadiness(null));
    expect(result.current).toBe('ready');
  });

  it('leaves the bring-up to the host when told to', () => {
    const { player, prepares } = fakePlayer({ status: 'idle' });
    renderHook(() => usePlaybackReadiness(player, { prepare: false }));
    expect(prepares()).toBe(0);
  });
});
