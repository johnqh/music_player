/**
 * React bindings for the player: `usePlaybackReadiness`.
 *
 * Its own entry point (`@sudobility/music_player/react`), because the rest of
 * this package has no React in it and a host that drives playback from
 * outside React must not be made to install it.
 */
export { usePlaybackReadiness } from './usePlaybackReadiness.js';
export type { UsePlaybackReadinessOptions } from './usePlaybackReadiness.js';
