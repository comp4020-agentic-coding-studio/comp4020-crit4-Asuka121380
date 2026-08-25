import type { HarmonicState } from "./harmony";
import type { Ensemble, VoicedNote } from "./voicing";

// The single record that drives both audio playback and the score notation —
// never two separate representations of "what's currently sounding." There is
// no duration field: a chord sustains for as long as the pointer holds it,
// not for a fixed timed length.
export type ChordEvent = {
  id: string;
  harmonicState: HarmonicState;
  chordSymbol: string;
  ensemble: Ensemble;
  notes: VoicedNote[];
};

let nextEventId = 0;

export function buildChordEvent(params: {
  harmonicState: HarmonicState;
  chordSymbol: string;
  notes: VoicedNote[];
  ensemble: Ensemble;
}): ChordEvent {
  nextEventId += 1;
  return { id: `chord-${nextEventId}`, ...params };
}
