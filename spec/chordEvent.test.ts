import { describe, expect, it } from "vitest";
import { buildChordEvent } from "../chordEvent";
import { CHORD_COLOUR_TABLE, sampleChordSymbol, sampleNextState, type HarmonicState } from "../harmony";
import { mulberry32 } from "../rng";
import { voiceChord } from "../voicing";

describe("ChordEvent: shape and consistency", () => {
  it("always carries exactly four notes and a chord symbol valid for its harmonicState", () => {
    const random = mulberry32(1234);
    let state: HarmonicState = "I";

    for (let i = 0; i < 100; i++) {
      state = sampleNextState(state, random);
      const chordSymbol = sampleChordSymbol(state, random);
      const notes = voiceChord(chordSymbol, "brass");

      const event = buildChordEvent({
        harmonicState: state,
        chordSymbol,
        notes,
        ensemble: "brass",
      });

      expect(event.notes).toHaveLength(4);
      const allowedSymbols = CHORD_COLOUR_TABLE[event.harmonicState].map((c) => c.symbol);
      expect(allowedSymbols).toContain(event.chordSymbol);
    }
  });

  it("gives every event a distinct id", () => {
    const notes = voiceChord("C", "brass");
    const a = buildChordEvent({ harmonicState: "I", chordSymbol: "C", notes, ensemble: "brass" });
    const b = buildChordEvent({ harmonicState: "I", chordSymbol: "C", notes, ensemble: "brass" });
    expect(a.id).not.toBe(b.id);
  });
});
