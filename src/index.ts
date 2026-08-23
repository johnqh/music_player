/**
 * @sudobility/music_player — everything that makes sound.
 *
 * The transport, the two synth engines (libfluidsynth on the web, sample packs
 * on React Native), plan building, and offline rendering. It takes a `Score`
 * and produces audio; it knows nothing about editing, files or the store.
 *
 * Its own package because playback was previously spread across three: engines
 * in `music_io`, the transport brain in `music_lib` where it read the Zustand
 * store, and the plan builders in `music_lib` too. Nothing owned playback;
 * three packages owned a third of it each.
 */
export {};
