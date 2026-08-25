import type { RandomSource } from "./rng";
import { weightedPick } from "./rng";

// Seven functional states in the C-major/A-minor environment. `IV` (major
// subdominant) and `iv` (borrowed minor subdominant) are deliberately kept as
// distinct literal members, never interchangeable strings.
export type HarmonicState = "I" | "ii" | "iii" | "IV" | "V" | "vi" | "iv";

export const INITIAL_STATE: HarmonicState = "I";

// Curated progression corpus (section 7). Transition probabilities are
// derived from this at module load, not hand-copied, so the corpus stays the
// single source of truth.
export const PROGRESSION_CORPUS: HarmonicState[][] = [
  ["I", "IV", "V", "I"],
  ["I", "vi", "IV", "V", "I"],
  ["I", "iii", "vi", "ii", "V", "I"],
  ["I", "IV", "ii", "V", "I"],
  ["I", "V", "vi", "IV", "I"],
  ["vi", "IV", "I", "V", "vi"],
  ["I", "IV", "iv", "I"],
  ["I", "vi", "ii", "V", "I"],
  ["I", "iii", "IV", "V", "I"],
  ["ii", "V", "I", "vi", "ii", "V", "I"],
  ["I", "V", "IV", "I"],
  ["vi", "ii", "V", "I"],
];

function deriveTransitionCounts(corpus: HarmonicState[][]): Map<HarmonicState, Map<HarmonicState, number>> {
  const counts = new Map<HarmonicState, Map<HarmonicState, number>>();
  for (const progression of corpus) {
    for (let i = 0; i < progression.length - 1; i++) {
      const from = progression[i];
      const to = progression[i + 1];
      const row = counts.get(from) ?? new Map<HarmonicState, number>();
      row.set(to, (row.get(to) ?? 0) + 1);
      counts.set(from, row);
    }
  }
  return counts;
}

export const TRANSITION_COUNTS = deriveTransitionCounts(PROGRESSION_CORPUS);

/** Derived transition probabilities, exposed for tests to check against the
 *  published table (section 7) within rounding tolerance. */
export function transitionProbabilities(state: HarmonicState): Array<{ to: HarmonicState; probability: number }> {
  const row = TRANSITION_COUNTS.get(state);
  if (!row) return [];
  const total = [...row.values()].reduce((sum, n) => sum + n, 0);
  return [...row.entries()].map(([to, count]) => ({ to, probability: count / total }));
}

export function sampleNextState(state: HarmonicState, random: RandomSource): HarmonicState {
  const row = TRANSITION_COUNTS.get(state);
  if (!row || row.size === 0) return INITIAL_STATE;
  const entries = [...row.entries()];
  const targets = entries.map(([to]) => to);
  const weights = entries.map(([, count]) => count);
  return weightedPick(targets, weights, random);
}

// Chord-colour probabilities (section 7): concrete chord quality within each
// functional state, sampled independently of the state transition itself.
export const CHORD_COLOUR_TABLE: Record<HarmonicState, Array<{ symbol: string; probability: number }>> = {
  I: [
    { symbol: "C", probability: 0.7 },
    { symbol: "Cmaj7", probability: 0.3 },
  ],
  ii: [{ symbol: "Dm7", probability: 1 }],
  iii: [
    { symbol: "Em", probability: 0.7 },
    { symbol: "Em7", probability: 0.3 },
  ],
  IV: [
    { symbol: "F", probability: 0.65 },
    { symbol: "Fmaj7", probability: 0.35 },
  ],
  V: [
    { symbol: "G", probability: 0.45 },
    { symbol: "G7", probability: 0.55 },
  ],
  vi: [
    { symbol: "Am", probability: 0.65 },
    { symbol: "Am7", probability: 0.35 },
  ],
  iv: [
    { symbol: "Fm", probability: 0.75 },
    { symbol: "Fm6", probability: 0.25 },
  ],
};

export function sampleChordSymbol(state: HarmonicState, random: RandomSource): string {
  const options = CHORD_COLOUR_TABLE[state];
  const symbols = options.map((o) => o.symbol);
  const weights = options.map((o) => o.probability);
  return weightedPick(symbols, weights, random);
}
