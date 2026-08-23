/**
 * The engine contract: what a platform must provide for sound to come out.
 *
 * Here rather than in `@sudobility/music_types` because this package is the
 * only thing that implements it — the web's fluidsynth engine and React
 * Native's sample engine — and the only thing that calls it. The *plan* those
 * engines consume stays in music_types, and must: `PlaybackPlan` composes
 * `PerformanceTimeline`, which `performanceTimeline()` produces there.
 *
 * So the line is: the plan model is score domain, the engine contract is
 * playback.
 */
import type {
  PlaybackLoadState,
  PlaybackPlan,
  PlaybackTrack,
  ScoreRange,
  SoundingNote,
  TransportPlaybackState,
} from '@sudobility/music_types';

/**
 * A voice to audition, resolved from the GM tables **by the caller**.
 *
 * The engine cannot resolve it: a percussion voice's program addresses a drum
 * kit, and only the GM tables know which kit an arbitrary address falls in.
 * Resolving here is what lets the platform layer keep no catalogue of its own.
 */
export type AuditionVoice = {
  /** The kit's program on a percussion voice, the instrument's own otherwise. */
  program: number;
  /** The GM catalogue name for `program`. */
  name: string;
  isPercussion: boolean;
};

export type PlaybackObserver = {
  onPositionTick(tick: number): void;
  /**
   * The notes currently sounding, whenever that set changes.
   *
   * Resolved rather than bare ids. The scheduler already knows each note's
   * track and pitch — it scheduled them — and emitting only the id forced every
   * consumer to search the whole score to get it back: `playingPitchesForTrack`
   * was an O(score) scan per sounding note, twenty times a second.
   */
  onActiveNotes(notes: SoundingNote[]): void;
  onStateChange(state: TransportPlaybackState): void;
  /**
   * How far along the engine is in becoming able to make a sound.
   *
   * Optional because not every engine has anything to load. The soundfont
   * engine does: tens of megabytes to fetch and several seconds for the synth
   * to digest, all on the first press of Play. Without this the transport
   * simply looks broken for that whole time — which is exactly how it read
   * before there was anywhere to report it.
   */
  onLoadStateChange?(state: PlaybackLoadState): void;
};

export interface PlaybackEngine {
  initialize(): Promise<void>;
  /** Adopts a plan. The engine is handed music, never a score. */
  load(plan: PlaybackPlan): Promise<void>;
  play(fromTick?: number): Promise<void>;
  pause(): void;
  stop(): void;
  seek(tick: number): void;
  setTempoMultiplier(multiplier: number): void;
  setLoop(range: ScoreRange | null): void;
  setTrackMute(trackId: string, muted: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;
  /**
   * Re-reads every track's volume, pan, mute and solo and pushes them,
   * touching nothing that is scheduled.
   *
   * The mixing counterpart to `load`. Mute and solo had setters; volume and pan
   * did not, and a track's volume was only ever read at load time — so once a
   * mix change stopped reloading the score (the playback edit lock, see
   * `music_lib`'s `score-slice`), moving a fader during playback moved the
   * fader and not the sound.
   *
   * Takes only the tracks, so changing a gain does not rebuild every note —
   * which is the whole reason this is separate from `load`. Idempotent, and
   * takes them all rather than one property: the caller says "the mix changed,
   * here it is" and does not work out which property it was.
   */
  applyMix(tracks: readonly PlaybackTrack[]): void;
  /** Toggles the metronome click. */
  setMetronome(enabled: boolean): void;
  /** Sets overall output level, 0-1 linear gain. */
  setMasterVolume(volume: number): void;
  /**
   * Sounds `midi` immediately on `program`'s voice and holds it, independent of
   * the transport — for auditioning a key while editing.
   *
   * `voice.isPercussion` mirrors what playback does with a percussion-clef
   * track: without it, tapping a note on a drum track auditioned a pitched
   * instrument while the same note played back as a drum.
   *
   * Separate from `play` because the two answer different questions: `play`
   * renders the written score along a timeline, this makes a sound *now*, for
   * as long as the caller holds it, whether or not a score is even loaded.
   * Implementations must not disturb transport state.
   */
  noteOn(midi: number, voice: AuditionVoice): void;
  /** Releases a pitch started by `noteOn`. Silent no-op if it is not sounding. */
  noteOff(midi: number): void;
  /** Registers (or, with `null`, clears) the single observer receiving position/active-note/state updates. */
  setObserver(observer: PlaybackObserver | null): void;
  dispose(): void;
}

