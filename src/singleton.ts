/**
 * The player singleton.
 *
 * Same shape as the rest of the family's services — initialise once at
 * start-up, read it everywhere, reset it in tests.
 *
 * A singleton because there is one transport: one piece of music is playing,
 * and two players would be two playheads, which is exactly the disagreement
 * `MusicPosition` exists to prevent.
 */
import type { IMusicPlayer } from './types.js';

let instance: IMusicPlayer | null = null;

export class MusicPlayerNotInitializedError extends Error {
  constructor() {
    super(
      'The music player has not been initialized. Call initializeMusicPlayer() from your app composition root before using playback.'
    );
    this.name = 'MusicPlayerNotInitializedError';
  }
}

/**
 * Idempotent, so a re-mounting composition root does not swap the transport out
 * from under everything subscribed to it.
 */
export function initializeMusicPlayer(player: IMusicPlayer): IMusicPlayer {
  if (!instance) instance = player;
  return instance;
}

export function getMusicPlayer(): IMusicPlayer {
  if (!instance) throw new MusicPlayerNotInitializedError();
  return instance;
}

/** Test-only: clears the singleton so suites cannot leak into each other. */
export function resetMusicPlayer(): void {
  instance = null;
}
