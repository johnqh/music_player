/**
 * Silences libfluidsynth's build-stub notices, and nothing else.
 *
 * The WASM build stubs out filesystem calls it does not need and reports each
 * one at *error* level every time a soundfont is loaded:
 *
 *     fluidsynth: error: function fluid_stat is a stub, always returning -1
 *     fluidsynth: error: function fluid_file_test is a stub, always returning true
 *
 * They are build notices, not failures — audio is verified working with them
 * firing. They also cannot be suppressed through `js-synthesizer`'s
 * `disableLogging`, which controls fluidsynth's *log callback*: these come out
 * of the C code's stderr through emscripten's stdio instead, as the stack shows
 * (`put_char → write → doWritev → _fd_write`).
 *
 * Two different hooks are needed, because the two paths load the module
 * differently.
 *
 * On the **main thread** the build is injected as a classic script, so its
 * `var Module = typeof Module != "undefined" ? Module : {}` sees a global we
 * seeded first, and `Module.printErr` redirects the stream.
 *
 * In an **AudioWorklet** that does not work: `addModule` loads module scripts,
 * so `var Module` is module-scoped and a global seed is invisible. The hook
 * there is the other half of the same line — `Module["printErr"] ||
 * console.error.bind(console)` binds whatever `console.error` *is at module
 * init*. Replacing it in the worklet's own scope beforehand therefore catches
 * the stream, and affects nothing outside that worklet.
 *
 * This matters more than tidiness: fluidsynth calls the stubs once per sample
 * while loading, which measured at over a thousand console writes per font —
 * each capturing a stack, during the load this engine is already slow at.
 *
 * Deliberately a pattern match rather than blanket suppression: anything that
 * is not a stub notice is passed straight through to `console.error`, so a real
 * fluidsynth failure still reaches the console.
 */

/** Matches only "function <name> is a stub, ..." — the emscripten build notices. */
export const STUB_NOTICE_PATTERN = /function \w+ is a stub/;

export function isStubNotice(text: unknown): boolean {
  return STUB_NOTICE_PATTERN.test(String(text));
}

/**
 * The seed, as source, so it can run in a worklet where our modules cannot
 * reach. Kept in sync with `isStubNotice` by construction: both use the same
 * pattern, written once here.
 */
function seedSource(): string {
  // Must run before libfluidsynth: emscripten binds console.error at init.
  return `(function () {
  var pattern = ${STUB_NOTICE_PATTERN.toString()};
  var original = console.error.bind(console);
  console.error = function () {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && pattern.test(arguments[i])) return;
    }
    original.apply(null, arguments);
  };
  globalThis.Module = Object.assign({}, globalThis.Module, {
    printErr: function (text) {
      if (!pattern.test(String(text))) original(text);
    },
  });
})();`;
}

/**
 * A module URL that filters the stub notices inside an AudioWorklet.
 *
 * Patches the worklet's own `console.error` rather than seeding `Module`, for
 * the module-scoping reason above. Scoped to the worklet, so the page console
 * is untouched.
 *
 * A blob rather than a hosted file: it is a few lines, and making an app host
 * another asset just to quiet a log would be a poor trade. Returns `null` where
 * blobs are unavailable, in which case the notices simply remain.
 */
export function createWorkletQuietModuleUrl(): string | null {
  if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  return URL.createObjectURL(new Blob([seedSource()], { type: 'text/javascript' }));
}

/** Seeds the quiet `Module` on the main thread, before libfluidsynth is injected. */
export function seedMainThreadQuietModule(): void {
  const scope = globalThis as unknown as { Module?: Record<string, unknown> };
  scope.Module = {
    ...scope.Module,
    printErr: (text: unknown) => {
      if (!isStubNotice(text)) console.error(text);
    },
  };
}
