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

// Diatonic (letter-only) step index, independent of accidental — the notation
// renderer's staff-position math (notation.ts) needs this, not just the
// chromatic MIDI number, so both consume the same parse.
const LETTER_STEP: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

export type ParsedPitch = { letter: string; accidental: "#" | "b" | ""; octave: number };

/** Parses a scientific pitch name (e.g. "Ab3", "F#2") into letter/accidental/octave —
 *  the one shared parse both `pitchNameToMidi` (audio) and `notation.ts` (score) use. */
export function parsePitchName(pitchName: string): ParsedPitch {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(pitchName);
  if (!match) throw new Error(`not a pitch name: ${pitchName}`);
  const [, letter, accidental, octaveText] = match;
  return { letter, accidental: accidental as "#" | "b" | "", octave: Number.parseInt(octaveText, 10) };
}

export function pitchNameToMidi(pitchName: string): number {
  const { letter, accidental, octave } = parsePitchName(pitchName);
  const accidentalOffset = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return (octave + 1) * 12 + NOTE_INDEX[letter] + accidentalOffset;
}

/** Diatonic step index (letter + octave only, accidental-independent) — an
 *  ever-increasing integer used to place a notehead on a staff. */
export function diatonicStep(pitchName: string): number {
  const { letter, octave } = parsePitchName(pitchName);
  return LETTER_STEP[letter] + octave * 7;
}

type VoicingRow = Record<Voice, string>;

// Revised high-register fallback voicing table (refinement prompt section 6)
// — authoritative for both sound and notation. Upper chord tones are
// deliberately registered higher than the previous muddy low table so the
// ensemble reads clearly; G7 sounds/displays exactly G2-D3-F4-B4.
export const VOICING_TABLE: Record<string, VoicingRow> = {
  C: { bass: "C2", tenor: "G2", alto: "E4", soprano: "C5" },
  Cmaj7: { bass: "C2", tenor: "G2", alto: "E4", soprano: "B4" },
  Dm7: { bass: "D2", tenor: "A2", alto: "C4", soprano: "F4" },
  Em: { bass: "E2", tenor: "B2", alto: "G3", soprano: "E4" },
  Em7: { bass: "E2", tenor: "B2", alto: "D4", soprano: "G4" },
  F: { bass: "F2", tenor: "C3", alto: "A3", soprano: "F4" },
  Fmaj7: { bass: "F2", tenor: "C3", alto: "E4", soprano: "A4" },
  G: { bass: "G2", tenor: "D3", alto: "B3", soprano: "G4" },
  G7: { bass: "G2", tenor: "D3", alto: "F4", soprano: "B4" },
  Am: { bass: "A2", tenor: "E3", alto: "C4", soprano: "A4" },
  Am7: { bass: "A2", tenor: "E3", alto: "G4", soprano: "C5" },
  Fm: { bass: "F2", tenor: "C3", alto: "Ab3", soprano: "F4" },
  Fm6: { bass: "F2", tenor: "C3", alto: "D4", soprano: "Ab4" },
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
