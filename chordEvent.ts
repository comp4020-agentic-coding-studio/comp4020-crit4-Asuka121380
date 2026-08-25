import type { HarmonicState } from "./harmony";
import type { Ensemble, VoicedNote } from "./voicing";

// The single record that drives both audio playback and the transient
// visualisation (section 15) — never two separate representations of "what's
// currently sounding."
export type ChordEvent = {
  id: string;
  harmonicState: HarmonicState;
  chordSymbol: string;
  startedAtSeconds: number;
  durationSeconds: number;
  ensemble: Ensemble;
  notes: VoicedNote[];
};

let nextEventId = 0;

export function buildChordEvent(params: {
  harmonicState: HarmonicState;
  chordSymbol: string;
  notes: VoicedNote[];
  ensemble: Ensemble;
  startedAtSeconds: number;
  durationSeconds: number;
}): ChordEvent {
  nextEventId += 1;
  return { id: `chord-${nextEventId}`, ...params };
}
