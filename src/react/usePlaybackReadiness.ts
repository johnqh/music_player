/**
 * Whether the engine can sound a note, as a value a Play button can show —
 * and the thing that gets it there.
 *
 * The bring-up used to be started by whatever first pushed a score into the
 * player, which is a different moment on every path to the editor: after a
 * click on a project it had been under way for a while, and on a link opened
 * cold nothing had touched the player at all, so the Play button sat enabled
 * over an engine that had not begun to load. Pressing it started the load,
 * and the spinner that followed lasted as long as the load did. Now the first
 * component to ask is what starts it: the hook reads `player.readiness`, and
 * where that is `notReady` it calls `prepare()` — once, on mount — so a
 * screen that shows a Play button is a screen on which the engine is coming
 * up. `notReady` is the player's own internal state; a caller only ever
 * sees `preparing` or `ready`.
 *
 * `useSyncExternalStore` over `onLoadState`, so a change is a re-render of
 * the button and nothing else.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { IMusicPlayer, PlaybackReadiness } from '../types.js';

export type UsePlaybackReadinessOptions = {
  /**
   * Whether to start the bring-up from here. On by default; a host that
   * must wait for a gesture before touching audio turns it off and calls
   * `prepare()` itself.
   */
  prepare?: boolean;
};

/**
 * `preparing` until the engine can sound a note, `ready` after.
 *
 * `null` for a host with no player — a test rendering a transport on its
 * own — which has nothing to wait for and is `ready`.
 */
export function usePlaybackReadiness(
  player: IMusicPlayer | null,
  { prepare = true }: UsePlaybackReadinessOptions = {}
): Exclude<PlaybackReadiness, 'notReady'> {
  const readiness = useSyncExternalStore(
    onChange => (player ? player.onLoadState(onChange) : () => undefined),
    () => (player ? player.readiness : 'ready'),
    () => (player ? player.readiness : 'ready')
  );
  useEffect(() => {
    if (prepare && player && player.readiness === 'notReady') {
      void player.prepare();
    }
  }, [player, prepare]);
  return readiness === 'ready' ? 'ready' : 'preparing';
}
