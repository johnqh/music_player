/**
 * Offline audio rendering on React Native.
 *
 * Export goes through the same samples as playback, for the same reason the web
 * export goes through the same soundfont: the file is supposed to be a
 * recording of what was heard, and two voicing paths drift apart the first time
 * one is tuned.
 *
 * The engine could not simply be reused, because it schedules against a *live*
 * context's clock and pumps notes 200ms at a time — rendering an export that
 * way would take as long as the piece. `RenderPlan` is already fully resolved
 * (seconds, not ticks; mute and solo applied by `renderEvents` in music_lib),
 * so everything can be scheduled up front against an `OfflineAudioContext` and
 * rendered as fast as the device manages. What is shared is the part that
 * matters: `PackLibrary` picks the sample, and `planVoice` decides the gain and
 * the release.
 */
import type { AudioRenderer, DecodedAudio, RenderPlan, RenderTrack } from '@sudobility/music_types';
import { headroomTrimFor } from '../../shared/mix.js';
import { gmPackName, percussionPackName } from '../playback/gm-pack-name.js';
import { PackLibrary } from '../playback/pack-library.js';
import { RELEASE_SECONDS, planVoice } from '../playback/voice-plan.js';
import { sustains } from '../playback/expression.js';
import { applySustainLoop } from '../playback/sustain-loop.js';
import { loadAudioApi } from '../playback/audio-api.js';
import type { AudioApi, RNAudioBuffer, RNOfflineAudioContext } from '../playback/audio-api.js';

const SAMPLE_RATE = 44100;
/** Stereo, so panning survives into the file. */
const CHANNELS = 2;

export type OfflineRendererDeps = {
  loadAudioApi?: () => Promise<AudioApi>;
  fetchPack?: (url: string) => Promise<string>;
  packBase?: string;
  percussionBase?: string;
};

/** The pack a track's notes come from — the same rule live playback uses. */
export function packNameForRenderTrack(track: RenderTrack): string | null {
  // The kit-versus-instrument distinction is already resolved into
  // `voiceProgram`/`voiceName` by music_lib, which owns the GM tables.
  return track.isPercussion
    ? percussionPackName(track.voiceProgram)
    : gmPackName(track.voiceProgram, track.voiceName);
}

function defaultFetchPack(url: string): Promise<string> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Sample pack ${url} responded ${r.status}`);
    return r.text();
  });
}

export function createRNSoundfontRenderer(deps: OfflineRendererDeps = {}): AudioRenderer {
  return {
    async render(plan: RenderPlan): Promise<DecodedAudio> {
      const api = await (deps.loadAudioApi ?? loadAudioApi)();
      if (!api.OfflineAudioContext) {
        throw new Error('react-native-audio-api is missing OfflineAudioContext; export needs >=0.13.');
      }

      const library = new PackLibrary({
        fetchPack: deps.fetchPack ?? defaultFetchPack,
        decodeAudioData: (bytes) => api.decodeAudioData(bytes),
        packBase: deps.packBase,
        percussionBase: deps.percussionBase,
      });

      const packByTrack = new Map<string, string>();
      for (const track of plan.tracks) {
        const name = packNameForRenderTrack(track);
        if (name) packByTrack.set(track.id, name);
      }
      // Only the packs notes are actually played from: a plan lists every track
      // so the headroom is right, including silent ones, and downloading a pack
      // for a track that sounds nothing would be minutes of nothing.
      const sounding = new Set([...plan.events].map((e) => packByTrack.get(e.trackId)).filter(Boolean) as string[]);
      for (const name of sounding) await library.ensure(name);

      // Headroom is sized by how many tracks *exist*, not how many sound — the
      // same rule live playback applies, or an export of a muted-heavy score
      // comes out a couple of dB louder than what was heard.
      const headroom = headroomTrimFor(plan.tracks.length);
      // The tail of the last note has to fit inside the file.
      const seconds = plan.durationSec + RELEASE_SECONDS;
      const ctx: RNOfflineAudioContext = new api.OfflineAudioContext({
        numberOfChannels: CHANNELS,
        length: Math.ceil(seconds * SAMPLE_RATE),
        sampleRate: SAMPLE_RATE,
      });

      const master = ctx.createGain();
      master.gain.value = headroom;
      master.connect(ctx.destination);

      const trackById = new Map(plan.tracks.map((t) => [t.id, t]));
      for (const event of plan.events) {
        const packName = packByTrack.get(event.trackId);
        const track = trackById.get(event.trackId);
        if (!packName || !track) continue;

        const voicing = library.voice(packName, event.midi, track.isPercussion);
        if (!voicing) continue;

        // `velocity` arrives 0..1 here but `planVoice` takes a 0..127 MIDI
        // value, so it is scaled back up rather than passed through — getting
        // this backwards renders a silent file, which is why it has a test.
        const voice = planVoice({
          atSeconds: event.startSec,
          durationSeconds: event.durationSec,
          velocity: event.velocity * 127,
          trackGain: track.volume,
          choice: voicing.choice,
          // Same expression as playback — velocity curve, per-instrument
          // release, velocity-to-brightness — so the file is a recording of
          // what was heard. Percussion opts out for the same reason it does live.
          program: track.isPercussion ? undefined : track.midiProgram,
        });

        const mayLoop = !track.isPercussion && sustains(track.midiProgram);
        buildOfflineVoice(ctx, master, voicing.buffer, voice, track.pan, mayLoop);
      }

      const rendered = await ctx.startRendering();
      return { samples: toMono(rendered), sampleRate: rendered.sampleRate };
    },
  };
}

function buildOfflineVoice(
  ctx: RNOfflineAudioContext,
  master: { connect(node: unknown): unknown },
  buffer: RNAudioBuffer,
  voice: ReturnType<typeof planVoice>,
  pan: number,
  mayLoop: boolean,
): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (voice.detuneCents !== 0) source.detune.value = voice.detuneCents;
  if (mayLoop) applySustainLoop(source, buffer, voice.releaseAt - voice.startAt, voice.sampleMidi);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(voice.gain, voice.startAt);
  amp.gain.setValueAtTime(voice.gain, voice.releaseAt);
  amp.gain.linearRampToValueAtTime(0, voice.endAt);

  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));

  if (voice.cutoffHz === null) {
    source.connect(amp);
  } else {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = voice.cutoffHz;
    source.connect(filter);
    filter.connect(amp);
  }
  amp.connect(panner);
  panner.connect(master as never);
  source.start(voice.startAt);
  source.stop(voice.endAt);
}

/** The `DecodedAudio` contract is mono; the render is stereo so panning is real. */
function toMono(buffer: RNAudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) out[i] += data[i]! / buffer.numberOfChannels;
  }
  return out;
}
