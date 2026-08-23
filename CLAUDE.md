# music_player

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push` or `npm publish` **only when the user explicitly asks in
> that turn**. Approval for an earlier change does not carry forward, and finishing a
> task is not permission to commit it.

Everything that makes sound: the transport, the two synth engines, plan
building, and offline rendering. One of seven repos in the Moosiac family — see
`music_app/docs/architecture.md`.

**The rule: this package makes sound. `music_io` moves bytes. `music_codecs`
reads and writes score formats. `music_lib` edits.** It takes a `Score` and
produces audio; it knows nothing about editing, files or the store.

Its own package because playback was previously spread across three: the engines
in `music_io`, the transport brain in `music_lib` where it read the Zustand
store, and the plan builders in `music_lib` too. Nothing owned playback; three
packages owned a third of it each.

## Structure

- `src/types.ts` — `IMusicPlayer`, the transport interface
- `src/engine.ts` — the engine contract (`PlaybackEngine`, `PlaybackObserver`, `AuditionVoice`)
- `src/player.ts` — `MusicPlayer`, the transport; was `PlaybackController`, minus its store
- `src/singleton.ts` — `initializeMusicPlayer` / `getMusicPlayer` / `resetMusicPlayer`
- `src/core.ts` — the **platform-free** entry: interface, singleton, engine contract, plan builders
- `src/shared/` — `plan.ts`, `render-events.ts`, `bus.ts`, and the scheduling primitives both engines use
- `src/web/` — libfluidsynth (WebAssembly) in an `AudioWorklet`
- `src/rn/` — a sample-based FluidR3 engine
- `src/mocks/` — `MockMusicPlayer`, for downstream tests

## Package boundaries

`src/contract/no-domain-imports.test.ts` enforces: no `music_lib`, no
`music_io`, no `vexflow`, no runtime dependency. `music_types` is the only
required peer; the two engine libraries are **optional** peers, so a web app
installs `js-synthesizer` and a React Native app installs
`react-native-audio-api` without either carrying the other's.

## Gotchas

- **`IMusicPlayer.load()` takes a `Score`; the engine still takes a plan.** This
  package owns `playbackPlan`, so making the caller build one first would be a
  two-step dance whose second step is here. Underneath, `PlaybackEngine.load()`
  still takes a `PlaybackPlan` and does no score maths — which is where
  `music_io`'s "handed a plan, never a score" rule was always actually about.
- **The player has no caret, and that is deliberate.** `togglePlay`,
  `seekToMeasure`, `goToStart`, `previousMeasure`, `nextMeasure` and
  loop-from-selection are **not** here: all of them read or write the caret or
  the selection, which is editing state. A copy of either here would be a second
  thing that can disagree with the first — the exact bug `MusicPosition` exists
  to prevent. They live in music_lib's playback adapter and compose the
  primitives this exposes.
- **`music_lib` imports this package only through `/core`.** The root export
  resolves to the web entry (or the RN one under Metro), both of which construct
  a synth. `/core` is the platform-free half. A bare root import from music_lib
  would put an `AudioWorklet` in a package whose whole point is that it has none
  — its own guard test asserts this, and it was caught that way.
- **The plan model stays in `music_types`; the engine contract lives here.**
  `PlaybackPlan` composes `PerformanceTimeline`, which `performanceTimeline()`
  in music_types produces, so the whole plan cluster is anchored there — moving
  it would make music_types import from this package. The engine contract moved
  because this package is the only thing that implements *or* calls it.
- **`load()` while playing is a mix change and nothing else.** The note queue is
  kept. The host's edit lock is what makes that safe: while the transport runs,
  the only score change that can reach here is a mix change. A score arriving
  from outside that path — a generation result, an opened snapshot — **must be
  preceded by `stop()`**, or it will be heard as the old score.
- **`load()` and `play()` reject; they do not swallow.** The host translates: the
  message a user sees is localized and this package carries no copy. An earlier
  draft took an `onError` callback and stranded music_lib's translated string.
- **The bus is exposed, not wrapped.** `IMusicPlayer.bus` is the real
  `PlaybackBus`, so a host binds React to the same object the engine publishes
  into. A delegating view was tried and is wrong: two objects answering "what is
  sounding" is the disagreement the single source of truth exists to remove.
- **`bus.onPosition` and `IMusicPosition.tick` are not duplicates.** The channel
  is a *change signal*; the authoritative value is dead-reckoned forward between
  reports so the caret moves smoothly. A subscriber taking the tick from the
  event gets the unsmoothed number.
- **Synth load progress is not a bus channel.** It reports per percent and
  behaves like ordinary React state, so it goes to the host's store via
  `onLoadState`.
- **Consumers must exclude this package from Vite's dep pre-bundling.** The web
  entry lazily `import('js-synthesizer')`, and esbuild's pre-bundler resolves it
  eagerly into a chunk whose worklet asset URLs no longer point where the app
  serves them. The symptom is a blank page with no console error and a
  *production build that works fine*; music_app's `vite.config.ts` lists it
  beside music_lib and music_io.

- **Platform *engines* are optional peers; `@breezystack/lamejs` is the one
  exception.** A React Native app must never pull a browser audio library into
  its graph, which is why `js-synthesizer` — libfluidsynth compiled to WASM, for
  an AudioWorklet — is an optional peer that music_app declares itself. lamejs
  stays a runtime `dependency` for two concrete reasons: `web-audio-codec.ts`
  imports it *statically*, so an app that skipped installing it would fail to
  load the entire web entry rather than just mp3 export; and `AudioCodec.encodeMp3`
  is synchronous in `music_types`, so it cannot be made lazy the way
  `js-synthesizer` is without changing that interface across four repos. It is
  pure JS and runs under Metro — and now that `encodeMp3` is shared, the RN
  entry imports it too, which settles the question: it is not a platform
  library at all.
- **There is no RN audio, and that is a decision, not a gap in the port.** The
  web engine is libfluidsynth compiled to WASM running in an `AudioWorklet`;
  React Native has no AudioWorklet, so there is nothing to port — an RN engine
  means a different implementation of the same `PlaybackEngine` interface (a
  native synth module, or `react-native-audio-api` plus a soundfont player).
  What was there before subclassed the Tone engine over
  `react-native-audio-api` and synthesised its own approximations of the
  instruments, so it could never match what the web plays; a wrong sound is
  worse than a clear error. `unavailablePlayback()` now throws from anything
  that would make a sound and stays a silent no-op for the lifecycle methods, so
  a shared component calling `pause()` on unmount does not crash the app. The
  historical spikes are in `spikes/tone-on-rn-audio-api.md`.
- **The two platforms play the same font by different means, and that is the
  design.** Web runs libfluidsynth (WebAssembly) in an `AudioWorklet`; React
  Native has neither — `react-native-audio-api` exposes no `addModule` and
  Hermes has no WebAssembly — so it plays **FluidR3 pre-rendered per note**
  instead, from Benjamin Gleitzman's packs, generated from the same
  `FluidR3_GM.sf2` the web plays as `FluidR3Mono_GM.sf3`. Every key of all 128
  melodic programs is a real recording, so nothing is pitch-shifted in range.
  What is lost is SF2's live per-zone filters, LFOs and modulator envelopes —
  expressive variation, not the instrument's identity. The engine that was
  deleted synthesised oscillator approximations, which is a different and much
  worse thing. See `spikes/rn-sample-playback.md`.
- **`applyMix(score)` exists because mute and solo had setters and volume and pan did not.** A track's volume was read once at `loadScore` and pan only in `applyScoreToHost`, so once `music_lib`'s edit lock made a mix change stop reloading the score, moving a fader mid-playback moved the fader and not the sound. The web engine pushes CC7 and CC10 from the score and schedules nothing. **The RN engine reaches the same place with a node instead of a control change:** one gain-and-panner strip per track, built on first use, with voices connecting to their track's strip rather than to the master. Per-track rather than per-voice — the offline renderer builds a panner per voice because it schedules once and never changes its mind, where a live fader has to move under notes that are already sounding. That also settles where the headroom trim lives on RN: on the master, as it is on web, not multiplied into every voice's gain. **The metronome click bypasses the master on both platforms** so a score with more parts does not get a quieter click.
- **The transport is shared; only voicing is per platform.** `shared/playback/`
  holds score flattening, the note cursor, the sounding set, the dispatch window
  and the master trim. `governor.ts` and `channel-allocator.ts`
  stayed in `web/` despite importing nothing — they are fluidsynth-specific in
  meaning (interpolation orders; channels per synth instance) — and
  `soundfont-loader.ts` stayed because it uses the browser `caches` global.
  Import-free is not the same as platform-free.
- **`pump-window.ts` has one consumer left, and it is the RN engine.** The web
  engine hands a four-second horizon of self-releasing notes to the fluidsynth
  sequencer, so nothing there is ever dispatched late enough to need skipping.
  RN has no sequencer to hand a horizon to and keeps the lookahead-and-grace
  model, which is also why `NoteQueue.drainUntil`'s cap is optional: the web
  engine passes one because every note it schedules is a `postMessage`, and RN
  posts nothing across a thread boundary so it has nothing to bound.
- **One synth instance addresses 256 channels, not 16.** `midiChannelCount`
  takes 16-256 in multiples of 16, so every score up to 240 pitched tracks runs
  on one instance with one copy of the 23MB font. A second instance — and a
  second font copy — now opens past 240 tracks rather than past 15. Channels
  where `c % 16 === 9` are reserved for percussion: only literal channel 9 is
  documented as drum-typed by default, and whether fluidsynth extends that past
  its first block cannot be determined without a real synth, so pitched tracks
  stay off all of them. **`needsDrumTypeSwitch` must be false for a pitched
  track** — `soundfont-render.ts` branches on
  `isPercussion || needsDrumTypeSwitch`, so a pitched track carrying it exports
  as percussion. That shipped for one commit.
- **Polyphony is init-time only.** `ISynthesizer` has `setInterpolation` and
  `setGain` and no polyphony setter, so the ceiling (2048) is chosen once in
  `synth-host.ts` and fluidsynth's overflow priority steals above it. Anything
  proposing to adapt polyphony at runtime is proposing to re-init the synth,
  which means reloading the font.
- **The offline renderer shares `allocateChannels` with playback.** Change the
  channel count and `audio/offline-synth.ts` must move in the same commit, or an
  export addresses channels its synth does not have and silently loses every
  track past the sixteenth.
- **Timing lives in the worklet.** The pump tops up a rolling horizon
  (`HORIZON_SECONDS`, 512 events per tick) and each note is one sequencer event
  carrying its own duration, so fluidsynth releases it on the audio thread.
  There is no grace window and no skip-late rule on the web engine; a note whose
  moment passed during a stall sounds at once rather than being dropped. The old
  200ms window plus 200ms grace meant a stall over ~400ms silently lost every
  note inside it, and a 200-track notation redraw measures 119ms. Do not
  reintroduce a skip rule without re-reading that.
- **A four-second horizon means anything that changes the future has to take
  the future back.** The three that do are `seek`/`stop` (already), a playback
  **speed** change and the **loop** wrap. A speed change re-anchors the caret
  instantly while every queued note still carries a delay computed at the old
  speed, so without a re-seek the music kept the previous tempo for a whole
  horizon and then jumped; `setTempoMultiplier` therefore re-seeks where it
  stands when the pump is running, costing one 50ms gap. A loop wrap only
  happens on the pump tick *after* the end is reached, so `horizonTick` clamps
  the drain to `endTick - 1` — otherwise notes just past the end were already in
  the sequencer and sounded before the loop came round, every pass. For the same
  reason a loop never lets the transport stop: its range may run past the last
  note. **Metronome clicks are the case that bites**, because they are real
  oscillators on the graph and `allSoundOff` speaks only to the synth — a
  scheduled click is unreachable from there. `scheduleClick` hands back a
  `cancel`, the engine holds what is pending, and stop, seek, dispose and
  switching the metronome off all take it back. Before that, pausing left the
  room ticking for four seconds.
- **`headroomTrimFor` is in `shared/playback/mix.ts` so playback and export
  cannot disagree, and for a while the web export simply did not call it.**
  Every channel is scheduled at its own MIDI volume with nothing reconciling
  them, so a rendered file came out `sqrt(n)` louder than what was heard and
  the wav/mp3 encoders — which hard-clamp — turned that into clipping across
  most of a large score. The RN renderer always applied it. `mix.ts`'s doc now
  names all four call sites, so a fifth is noticed by its absence.
- **The export limiter is not the live one, and works backwards.** `limitPeaks`
  is the offline half of the master bus, after the trim exactly as
  `DynamicsCompressorNode` sits after the master gain live — the trim sizes the
  mix for its *average* level and the phase-aligned moments still overshoot,
  which in an export means the encoders' clamp rather than a sound card. It does
  **not** reimplement that node: its knee, ratio and program-dependent behaviour
  are not specified closely enough to reproduce, and the job — nothing leaves
  above the ceiling, by ducking rather than clipping — is what is reproduced.
  The gain envelope is computed **backwards** (each sample's gain is the lower
  of what it needs and what the next allows plus one attack step) so the ramp is
  finished when the peak lands, and so the ceiling is *exact*: a forward
  one-pole never quite arrives, and clamping the residue is the clipping this
  replaces. The forward pass is the release, and it is what stops a loud
  sustained passage pumping once per cycle. RN's renderers have no limiter at
  all, matching RN playback, which also has none.
- **A note-on at velocity 0 is a note-off.** The offline renderer always clamped
  to 1..127; the live engine passed `PlaybackNote.velocity` through untouched,
  so a plan carrying a fractional or zero velocity produced a note that silently
  did not sound in playback and did sound in the export. `clampVelocity` in
  `soundfont-engine.ts` closes that. Note the unit trap either side of it:
  `PlaybackNote.velocity` is MIDI 0-127 and `RenderEvent.velocity` is 0..1.
- **`onActiveNotes` fires only on change** (`shared/playback/sounding-set.ts`).
  It used to be a fresh array every pump tick whether or not a note had begun or
  ended, waking notation colour and the keyboard's key lights twenty times a
  second through a held chord. Anything that starts re-sending it per tick has
  undone the reason that module exists.
- **The lit set comes off the clock, never off the voices — on both engines
  now.** RN used to derive it from its scheduled voices, which are built a
  lookahead ahead of the clock and torn down only after the instrument's
  release: notation lit every note 200ms early and stayed lit through a half
  second of decay after the written note was over. `SoundingSet` answers "what
  is sounding *now*", which is the question notation is asking; a voice list
  answers "what has been arranged for", which is a different one.
- **The RN engine deliberately does not reuse the web engine's pump.** Merging
  the two transports behind a synth port is the obvious refactor and the wrong
  order: the web engine is verified on real devices and the RN one cannot be
  until it runs on a phone. Do that merge after RN audio is device-tested, not
  before.
- **Pack names are not GM slugs.** Punctuation is *removed*, not turned into a
  separator: `Honky-tonk Piano` is `honkytonk_piano` and `Lead 8 (bass + lead)`
  keeps the double underscore where the `+` was. That covers 127 of 128; program
  54 is a real naming disagreement (GM "Voice Oohs" vs. the catalogue's "Synth
  Voice"). `gm-pack-name.test.ts` checks all 128 against a vendored copy of the
  CDN manifest, because a wrong name is a 404, which parses to zero samples,
  which is an instrument that plays nothing with no error anywhere.
- **Drum kits are rendered here, not fetched.** The pre-rendered FluidR3 packs
  are the 128 *melodic* programs only, and no CDN publishes GM percussion under
  a licence this project can use — WebAudioFont, the one that has it, is
  GPL-3.0. So `scripts/build-percussion-packs.mjs` renders the eight GM kits out
  of the same `FluidR3Mono_GM.sf3` the web engine plays, with `fluidsynth` and
  `lame`, into the melodic packs' own format so one parser reads both. FluidR3
  is CC-BY 3.0, so redistributing the renderings is allowed with attribution
  (the script writes an `ATTRIBUTION.md` beside them). Output is ~1.1-1.7MB per
  kit; it is a build-time tool, run when the font changes, not part of
  `bun run build`.
- **The expression a recording cannot carry is measured back in**
  (`playback/expression.ts`, built by `scripts/measure-expression.mjs`). The
  packs are recordings taken at full velocity, so playing one softer is just the
  loud recording turned down — where fluidsynth also darkens it, shapes its
  release per instrument, and sustains it while held. Three fixes, all measured
  from the same `.sf3` the web plays:
  1. **Velocity is (v/127)², not v/127.** SF2's default velocity-to-attenuation
     modulator is 960cB concave; fluidsynth's concave table
     (`1 + (40/96)·log10(v/127)`) reduces exactly to a square. The linear curve
     the engine had played velocity 32 at 0.252 against a true 0.063 — **12dB
     too loud on every soft passage**, which flattens all dynamics.
  2. **A per-instrument low-pass** whose corner falls with velocity: piano goes
     ~4989Hz at v96 to ~556Hz at v16, strings barely move, violin and flute not
     at all. Only 57 of 128 instruments darken, and a node is built only when
     the corner is below 16kHz.
  3. **A per-instrument release**, median 0.56s measured, against the flat 80ms
     the engine applied to everything — seven times too short, chopping every
     released chord.
- **The expression table is measured, not extracted, and that is the
  interesting part.** The first attempt parsed `initialFilterFc` straight out of
  the `pdta` chunk (readable even in SF3 — only `sdta` is Vorbis-compressed). It
  gave Grand Piano a **300Hz** low-pass, which is plainly wrong: the rendered
  piano has energy out to 4.6kHz. The cause is layering — FluidR3's piano preset
  points at two instruments at once and the recording is their sum, so no single
  layer's generators describe it. Generators cannot be read off a layered
  preset; the rendered sound can. The script now renders all 128 programs at five
  velocities and finds where the quiet spectrum falls 3dB below the loud one,
  **after normalising both to the fundamental** — skipping that normalisation
  produced a table reading 281Hz for all 128, because a quiet note is quieter at
  every frequency and the first band examined already looks 3dB down.
- **Generated assets are pinned to the soundfont by hash.** Both
  `expression-table.ts` and the percussion packs are derived from
  `FluidR3Mono_GM.sf3` and regenerated by nobody. Each records the font's
  SHA-256, and music_app — which owns the font — asserts the match in
  `src/config/generated-assets.test.ts`. Without it a swapped font leaves RN
  playing kits and velocity curves from the old one, silently, presenting as
  "RN sounds subtly unlike web". The hash is read through
  `@sudobility/music_io/rn/expression-table`, a dependency-free subpath, because
  reaching it via the RN entry drags in optional peers a web app does not install.
- **Notes longer than 3.13 seconds used to go silent.** Every pack entry is
  exactly that long, whatever the instrument, so a whole note at 60bpm or a tied
  pad simply stopped sounding partway through with the gain envelope still
  holding a level over nothing. `sustain-loop.ts` loops a window inside the
  steady portion **spanning a whole number of periods of the sampled note** —
  which is known, since it is the pack entry being played, so no pitch detection
  is needed. Zero-crossing alignment alone was not enough: it removes the step
  discontinuity but not the *phase* one, so an arbitrary-length window ends
  part-way through a cycle and every harmonic restarts out of phase, audible as
  a buzz once a second on a held note. Only for the 79
  instruments measured as holding their level: looping a piano or a marimba
  would sustain a note that is supposed to die away, which is a worse and more
  obvious error than the truncation it fixes.
- **A drum note is never bent** (`exactSample`, not `nearestSample`). In a kit
  a note number names a *different instrument* — 38 is a snare, 42 a closed
  hi-hat — so reaching for the closest available slot answers a missing cowbell
  with a detuned tom, confidently. A slot the kit does not define plays nothing,
  which is what real hardware does; TR-808 genuinely leaves three of GM's slots
  empty. `percussionPackName` addresses a kit by the program that selects it,
  and goes through `gmKitAt`, because a percussion track's `midiProgram` is a
  kit and never agrees with the instrument table (Brush is 40; program 40 is
  Violin).
- **`percussionBase` has no default, deliberately.** The melodic packs have a
  CDN to fall back on; the kits are app-hosted, so there is nowhere to point.
  An app that ships scores with drums and never sets it gets a sentence naming
  the build script rather than silent percussion.
- **An export is rendered offline, not played into a file.** The engine
  schedules against a *live* clock and pumps 200ms at a time, so reusing it for
  export would make a render take as long as the piece. `RenderPlan` arrives
  fully resolved (seconds, not ticks; mute and solo already applied by
  `renderEvents` in music_lib), so `rn/audio/offline-render.ts` schedules the
  whole thing up front against an `OfflineAudioContext`. What it *does* share
  with the engine is `PackLibrary` and `planVoice` — the sample choice and the
  gain — which is what keeps the file a recording of what was heard rather than
  a second voicing that drifts. Note the velocity units differ: `RenderPlan`
  carries 0..1 and `planVoice` normalizes 0..127, so the renderer scales back up.
  Getting that backwards renders a file ~127x too quiet, which is why it has its
  own test.
## Related Projects

- `music_types` — the model, the score domain, the playhead (`@sudobility/music_types`)
- `music_codecs` — score file formats
- `music_io` — files, audio encoding, XML, MIDI input
- `music_lib` — editing; binds the store to this through its playback adapter
- `music_app` — the web UI

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
