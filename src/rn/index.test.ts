/**
 * What `createMusicPlayer` and `renderSamples` hand down to the engine.
 *
 * These two factories had no tests, and the thing they do is *forwarding* — so
 * the failure they can have is an option silently not arriving. That one is
 * expensive here: with `fetchPack` dropped the engine falls back to `fetch`,
 * and a shipped app that was supposed to read its instruments out of its own
 * bundle goes back to pulling ~2.6MB per instrument off a third party's host on
 * first play. Nothing throws. It works on the developer's desk, needs a network
 * on a user's phone, and goes silent when someone else's GitHub Pages does.
 *
 * Deliberately white-box: it reads the engine's `deps`, which are private. The
 * honest alternative was no coverage at all, because driving the real engine
 * needs a fake audio graph that these factories do not expose — and a
 * forwarding bug is exactly what would otherwise reach a store build.
 */
import { describe, expect, it } from 'vitest';
import { createMusicPlayer } from './index.js';

/** The engine a player was built around, and the deps it was built with. */
function depsOf(player: unknown): Record<string, unknown> {
  const engine = (player as { engine: unknown }).engine;
  return (engine as { deps: Record<string, unknown> }).deps;
}

describe('createMusicPlayer', () => {
  it('passes a bundled-asset loader through to the engine', async () => {
    const fetchPack = async () => 'MIDI.Soundfont.x = {}';
    const deps = depsOf(createMusicPlayer({ fetchPack }));
    expect(deps.fetchPack).toBe(fetchPack);
  });

  it('still defaults to fetching when no loader is given', () => {
    // A self-hosted CDN build is a legitimate setup; omitting the loader must
    // not leave the engine with no way to read a pack at all.
    const deps = depsOf(
      createMusicPlayer({ packBase: 'https://example.test/' })
    );
    expect(typeof deps.fetchPack).toBe('function');
  });

  it('carries both pack bases', () => {
    const deps = depsOf(
      createMusicPlayer({
        packBase: 'https://example.test/packs/',
        percussionBase: 'https://example.test/drums/',
      })
    );
    expect(deps.packBase).toBe('https://example.test/packs/');
    expect(deps.percussionBase).toBe('https://example.test/drums/');
  });
});
