import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSoundfont } from './soundfont-loader.js';

const bytes = (n: number): ArrayBuffer => new Uint8Array(n).buffer;

/** A stand-in for the Cache API, so the tests need no real CacheStorage. */
function stubCache(initial?: ArrayBuffer) {
  const store = new Map<string, Response>();
  if (initial) store.set('font', new Response(initial));
  const cache = {
    match: async (key: RequestInfo | URL) => store.get(String(key)),
    put: async (key: RequestInfo | URL, response: Response) => {
      store.set(String(key), response);
    },
  } as unknown as Cache;
  return { store, cache };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSoundfont', () => {
  it('fetches and caches on a miss', async () => {
    const { cache, store } = stubCache();
    const fetchSpy = vi.fn(async () => new Response(bytes(8)));
    vi.stubGlobal('fetch', fetchSpy);

    const buf = await loadSoundfont('font', { cache });

    expect(buf.byteLength).toBe(8);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.has('font')).toBe(true);
  });

  it('does not touch the network on a cache hit', async () => {
    // The font is tens of megabytes: this is the difference between a wait on
    // every visit and a wait on the first.
    const { cache } = stubCache(bytes(4));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const buf = await loadSoundfont('font', { cache });

    expect(buf.byteLength).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a failed fetch rather than resolving empty', async () => {
    // Resolving an empty buffer would load a synth with no instruments and
    // present as silent playback with no error anywhere.
    const { cache } = stubCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    );

    await expect(loadSoundfont('font', { cache })).rejects.toThrow(/404/);
  });

  it('works with no cache available, just without the caching', async () => {
    const fetchSpy = vi.fn(async () => new Response(bytes(2)));
    vi.stubGlobal('fetch', fetchSpy);

    const buf = await loadSoundfont('font', { cache: null });

    expect(buf.byteLength).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports progress, so the caller can show why play is disabled', async () => {
    const { cache } = stubCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(bytes(16), { headers: { 'content-length': '16' } })
      )
    );
    const seen: Array<{ loaded: number; total: number }> = [];

    await loadSoundfont('font', { cache, onProgress: p => seen.push(p) });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ loaded: 16, total: 16 });
  });
});
