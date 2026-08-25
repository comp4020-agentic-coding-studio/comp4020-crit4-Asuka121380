import { describe, expect, it } from "vitest";
import {
  CHORD_COLOUR_TABLE,
  PROGRESSION_CORPUS,
  TRANSITION_COUNTS,
  sampleChordSymbol,
  sampleNextState,
  transitionProbabilities,
  type HarmonicState,
} from "../harmony";
import { mulberry32 } from "../rng";

// The published table in section 7 of the MVP brief — a fixture to check the
// derivation against, not a second source of truth. Values are rounded
// display percentages, so comparisons use a rounding tolerance.
const PUBLISHED_TRANSITIONS: Record<HarmonicState, Record<string, number>> = {
  I: { IV: 0.273, vi: 0.273, V: 0.273, iii: 0.182 },
  ii: { V: 1 },
  iii: { vi: 0.5, IV: 0.5 },
  IV: { V: 0.375, I: 0.375, ii: 0.125, iv: 0.125 },
  V: { I: 0.75, vi: 0.167, IV: 0.083 },
  vi: { ii: 0.571, IV: 0.429 },
  iv: { I: 1 },
};

const ALL_STATES: HarmonicState[] = ["I", "ii", "iii", "IV", "V", "vi", "iv"];

describe("harmony: corpus-derived transition probabilities", () => {
  it("derives transitions from the corpus, not a hard-coded table", () => {
    expect(PROGRESSION_CORPUS.length).toBe(12);
    expect(TRANSITION_COUNTS.size).toBeGreaterThan(0);
  });

  for (const state of ALL_STATES) {
    it(`matches the published table for state "${state}" within rounding tolerance`, () => {
      const derived = transitionProbabilities(state);
      const expected = PUBLISHED_TRANSITIONS[state];

      expect(derived.length).toBe(Object.keys(expected).length);
      for (const { to, probability } of derived) {
        expect(probability).toBeCloseTo(expected[to], 2);
      }
    });

    it(`state "${state}"'s outgoing transitions sum to ~1`, () => {
      const total = transitionProbabilities(state).reduce((sum, t) => sum + t.probability, 0);
      expect(total).toBeCloseTo(1, 10);
    });
  }

  it("never confuses IV (major) and iv (borrowed minor)", () => {
    const fromMajorIV = transitionProbabilities("IV").map((t) => t.to);
    const fromMinorIv = transitionProbabilities("iv").map((t) => t.to);
    expect(fromMajorIV).toContain("iv");
    expect(fromMajorIV).not.toContain("IV");
    expect(fromMinorIv).toEqual(["I"]);

    expect(CHORD_COLOUR_TABLE.IV.map((c) => c.symbol)).toEqual(["F", "Fmaj7"]);
    expect(CHORD_COLOUR_TABLE.iv.map((c) => c.symbol)).toEqual(["Fm", "Fm6"]);
  });
});

describe("harmony: seeded weighted sampling", () => {
  it("is deterministic for a fixed seed", () => {
    const runOnce = () => {
      const random = mulberry32(42);
      let state: HarmonicState = "I";
      const trace: HarmonicState[] = [state];
      for (let i = 0; i < 20; i++) {
        state = sampleNextState(state, random);
        trace.push(state);
      }
      return trace;
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it("only ever samples states that are reachable from the current state", () => {
    const random = mulberry32(7);
    let state: HarmonicState = "I";
    for (let i = 0; i < 200; i++) {
      const reachable = transitionProbabilities(state).map((t) => t.to);
      const next = sampleNextState(state, random);
      expect(reachable).toContain(next);
      state = next;
    }
  });

  it("chord-colour sampling only ever returns symbols listed for that state", () => {
    const random = mulberry32(99);
    for (const state of ALL_STATES) {
      const allowed = CHORD_COLOUR_TABLE[state].map((c) => c.symbol);
      for (let i = 0; i < 50; i++) {
        expect(allowed).toContain(sampleChordSymbol(state, random));
      }
    }
  });

  it("a deterministic random source (always 0) always picks the first weighted option", () => {
    const alwaysZero = () => 0;
    expect(sampleNextState("V", alwaysZero)).toBe(transitionProbabilities("V")[0].to);
    expect(sampleChordSymbol("V", alwaysZero)).toBe(CHORD_COLOUR_TABLE.V[0].symbol);
  });
});
