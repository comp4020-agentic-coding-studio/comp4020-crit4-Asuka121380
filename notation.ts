import { diatonicStep, parsePitchName } from "./voicing";
import type { Ensemble, Voice } from "./voicing";

export type Clef = "treble" | "alto" | "bass";

// Clef assignment (refinement prompt section 7). Soprano/tenor/bass keep the
// same clef in both ensembles; only alto differs (Horn reads treble, Viola
// reads alto clef) even though the two instruments sound the same pitch.
export const CLEF_FOR_VOICE: Record<Ensemble, Record<Voice, Clef>> = {
  brass: { soprano: "treble", alto: "treble", tenor: "bass", bass: "bass" },
  strings: { soprano: "treble", alto: "alto", tenor: "bass", bass: "bass" },
};

// Diatonic step index of each clef's bottom staff line — position 0 in the
// scale below. Adjacent lines/spaces are one diatonic step apart, so this
// single reference point plus `diatonicStep` gives every note's position.
const CLEF_BOTTOM_LINE_STEP: Record<Clef, number> = {
  treble: diatonicStep("E4"),
  alto: diatonicStep("F3"),
  bass: diatonicStep("G2"),
};

export type StaffPosition = {
  /** 0 = bottom line, 8 = top line, one integer per line/space in between.
   *  Negative = below the staff, >8 = above it. */
  position: number;
  /** Ledger-line positions (same scale) needed between the staff and the note. */
  ledgerLines: number[];
  accidental: "#" | "b" | "";
};

/** Maps a scientific pitch name to a vertical staff position for the given
 *  clef — the tested foundation the renderer draws from, not a hand-placed
 *  guess. Verified against the reference G7 layout (see notation.test.ts). */
export function pitchToStaffPosition(pitchName: string, clef: Clef): StaffPosition {
  const { accidental } = parsePitchName(pitchName);
  const position = diatonicStep(pitchName) - CLEF_BOTTOM_LINE_STEP[clef];
  const ledgerLines: number[] = [];
  if (position < 0) {
    for (let p = -2; p >= position; p -= 2) ledgerLines.push(p);
  } else if (position > 8) {
    for (let p = 10; p <= position; p += 2) ledgerLines.push(p);
  }
  return { position, ledgerLines, accidental };
}
