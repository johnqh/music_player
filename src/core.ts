/**
 * The platform-free half: the interface and the singleton, and nothing that
 * makes a sound.
 *
 * Its own entry point so a package that only *drives* playback does not pull an
 * audio engine in with it. `music_lib` is exactly that case — it holds an
 * `IMusicPlayer` and calls it, and its own guard test asserts it declares no
 * platform dependency. Importing this package's root would resolve to the web
 * entry and drag in `AudioWorklet` and `js-synthesizer`, which would make that
 * assertion false.
 *
 * Same reasoning as `@sudobility/music_player/rn/expression-table`: a subpath
 * exists so a consumer can reach one dependency-free thing without the peers
 * that surround it.
 */
export * from './types.js';
/** The engine contract, for a platform implementing one. */
export * from './engine.js';
export * from './singleton.js';

/**
 * Plan building is here too: it is pure score maths over `@sudobility/music_types`
 * and touches no engine, so a consumer that wants to know what *would* sound —
 * music_lib's articulation tests, music_api if it ever needs to — can have it
 * without an audio context.
 */
export { playbackPlan, playbackTracks, resolveVoice } from './shared/plan.js';
export { renderEvents } from './shared/render-events.js';

/**
 * The bus itself, for hosts that bind React to it and for their tests, which
 * construct one and publish into it. Platform-free: three listener sets.
 */
export { PlaybackBus } from './shared/bus.js';
