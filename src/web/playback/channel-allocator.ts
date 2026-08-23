/**
 * Which synth instance and MIDI channel each track plays on.
 *
 * General MIDI addresses 16 channels, but fluidsynth does not: its
 * `midi-channels` setting takes 16-256 in multiples of 16, and one instance at
 * 256 covers every realistic score with a single copy of the soundfont in WASM
 * memory. This used to assume 16, which opened another instance — and another
 * 23MB font copy — every sixteen tracks.
 *
 * Three rules shape the allocation, all of them facts about fluidsynth rather
 * than preferences:
 *
 * - **Channel 9 is percussion and cannot be anything else.** The spike found
 *   that a drum track sounds there only if left completely alone: selecting a
 *   program on it silences the channel. So percussion prefers channel 9, and a
 *   pitched track may never take it.
 * - **Whether channels 25, 41, ... are also percussion is undocumented.**
 *   General MIDI's drum channel is the tenth of each block of sixteen, and
 *   whether fluidsynth extends that convention past its first block cannot be
 *   determined without a real synth. Every `c % 16 === 9` is therefore kept
 *   away from pitched tracks: correct under either behaviour, and it costs
 *   sixteen channels out of 256.
 * - **Any channel can be made percussion** with `midiSetChannelType`. That is
 *   what lets a seventeenth drum track share an instance instead of costing a
 *   whole new synth just to reach another drum-capable channel.
 *
 * Instances are therefore opened only when channels genuinely run out, which
 * now means past 240 pitched tracks rather than past 15.
 */
export type ChannelAssignment = {
  instance: number;
  channel: number;
  /**
   * True when the channel is percussion but is not channel 9, so the engine
   * must call `midiSetChannelType` on it. Channel 9 needs nothing.
   */
  needsDrumTypeSwitch: boolean;
};

export type AllocatorTrack = { id: string; isPercussion: boolean };

/**
 * Channels one fluidsynth instance addresses.
 *
 * `midiChannelCount` accepts 16-256 in multiples of 16, so a single synth
 * covers every realistic score with one copy of the soundfont in WASM memory.
 */
export const CHANNELS_PER_INSTANCE = 256;

/** The one channel fluidsynth already types as drums, so it needs no switch. */
const DEFAULT_PERCUSSION_CHANNEL = 9;

/** Channels reserved for percussion; see this module's doc for why it is not just 9. */
function isDrumCapable(channel: number): boolean {
  return channel % 16 === 9;
}

export function allocateChannels(tracks: readonly AllocatorTrack[]): {
  assignments: Map<string, ChannelAssignment>;
  instanceCount: number;
} {
  const assignments = new Map<string, ChannelAssignment>();
  /** Taken channels per instance; the array length is the instance count. */
  const taken: Array<Set<number>> = [new Set()];

  const freeChannel = (instance: number, wantDrum: boolean): number | null => {
    for (let channel = 0; channel < CHANNELS_PER_INSTANCE; channel += 1) {
      if (isDrumCapable(channel) !== wantDrum) continue;
      if (!taken[instance].has(channel)) return channel;
    }
    return null;
  };

  const claim = (id: string, instance: number, channel: number, isPercussion: boolean): void => {
    taken[instance].add(channel);
    assignments.set(id, {
      instance,
      channel,
      // False for every pitched track. `soundfont-render.ts` branches on
      // `track.isPercussion || assignment.needsDrumTypeSwitch`, so a pitched
      // track carrying this flag would be sent a drum-bank program select and
      // export as percussion.
      //
      // Among percussion, only instance 0's channel 9 is fluidsynth's own drum
      // channel; every other drum slot has to be told what it is.
      needsDrumTypeSwitch:
        isPercussion && !(instance === 0 && channel === DEFAULT_PERCUSSION_CHANNEL),
    });
  };

  /** Places `id` on the first instance with a free channel of the wanted kind, opening one if none has. */
  const place = (id: string, wantDrum: boolean, isPercussion: boolean): void => {
    for (let instance = 0; instance < taken.length; instance += 1) {
      const channel = freeChannel(instance, wantDrum);
      if (channel !== null) {
        claim(id, instance, channel, isPercussion);
        return;
      }
    }
    taken.push(new Set());
    // A fresh instance always has a free channel of either kind.
    claim(id, taken.length - 1, freeChannel(taken.length - 1, wantDrum)!, isPercussion);
  };

  // Percussion first, so the drum-capable channels reach the tracks that need
  // them before a pitched track can push one onto a second instance.
  for (const track of tracks) {
    if (!track.isPercussion) continue;
    // Prefer a drum-capable channel; fall back to an ordinary one, switched
    // explicitly, rather than opening an instance for the sake of one channel.
    const hasDrumSlot = taken.some((_, instance) => freeChannel(instance, true) !== null);
    place(track.id, hasDrumSlot, true);
  }

  for (const track of tracks) {
    if (track.isPercussion) continue;
    place(track.id, false, false);
  }

  return { assignments, instanceCount: taken.length };
}
