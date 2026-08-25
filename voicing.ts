export type Voice = "bass" | "tenor" | "alto" | "soprano";
export type Ensemble = "brass" | "strings";

const NOTE_INDEX: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Parses a scientific pitch name (e.g. "Ab3", "F#2") into a MIDI note number. */
export function pitchNameToMidi(pitchName: string): number {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(pitchName);
  if (!match) throw new Error(`not a pitch name: ${pitchName}`);
  const [, letter, accidental, octaveText] = match;
  const octave = Number.parseInt(octaveText, 10);
  const accidentalOffset = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return (octave + 1) * 12 + NOTE_INDEX[letter] + accidentalOffset;
}

type VoicingRow = Record<Voice, string>;

// Fixed fallback voicing table (section 8) — used as-is for every chord, no
// candidate search.
export const VOICING_TABLE: Record<string, VoicingRow> = {
  C: { bass: "C2", tenor: "C3", alto: "E3", soprano: "G3" },
  Cmaj7: { bass: "C2", tenor: "B2", alto: "E3", soprano: "G3" },
  Dm7: { bass: "D2", tenor: "C3", alto: "F3", soprano: "A3" },
  Em: { bass: "E2", tenor: "B2", alto: "E3", soprano: "G3" },
  Em7: { bass: "E2", tenor: "D3", alto: "G3", soprano: "B3" },
  F: { bass: "F2", tenor: "C3", alto: "F3", soprano: "A3" },
  Fmaj7: { bass: "F2", tenor: "C3", alto: "E3", soprano: "A3" },
  G: { bass: "G2", tenor: "D3", alto: "G3", soprano: "B3" },
  G7: { bass: "G2", tenor: "D3", alto: "F3", soprano: "B3" },
  Am: { bass: "A2", tenor: "E3", alto: "A3", soprano: "C4" },
  Am7: { bass: "A2", tenor: "E3", alto: "G3", soprano: "C4" },
  Fm: { bass: "F2", tenor: "C3", alto: "F3", soprano: "Ab3" },
  Fm6: { bass: "F2", tenor: "C3", alto: "D3", soprano: "Ab3" },
};

// Instrument-to-voice mapping (section 8) — same four abstract roles, only
// the timbre/instrument label differs between ensembles.
export const INSTRUMENT_NAMES: Record<Ensemble, Record<Voice, string>> = {
  brass: { bass: "Tuba", tenor: "Trombone", alto: "Horn", soprano: "Trumpet" },
  strings: { bass: "Double Bass", tenor: "Cello", alto: "Viola", soprano: "Violin" },
};

export const VOICE_ORDER: readonly Voice[] = ["soprano", "alto", "tenor", "bass"];

export type VoicedNote = {
  voice: Voice;
  instrument: string;
  midi: number;
  pitchName: string;
};

/** Looks up the fixed voicing for `chordSymbol` and returns concrete notes
 *  for the given ensemble's instrument labels. Throws on an unknown symbol —
 *  every symbol the harmony engine can produce has a row in the table. */
export function voiceChord(chordSymbol: string, ensemble: Ensemble): VoicedNote[] {
  const row = VOICING_TABLE[chordSymbol];
  if (!row) throw new Error(`no fixed voicing for chord: ${chordSymbol}`);
  const instruments = INSTRUMENT_NAMES[ensemble];
  return VOICE_ORDER.map((voice) => ({
    voice,
    instrument: instruments[voice],
    midi: pitchNameToMidi(row[voice]),
    pitchName: row[voice],
  }));
}
