import { describe, expect, it } from "vitest";
import { CLEF_FOR_VOICE, pitchToStaffPosition } from "../notation";
import { VOICING_TABLE } from "../voicing";

describe("notation: pitch-to-staff-position", () => {
  // The visual reference's G7 is deliberately exact (ui-reference-main-page-v3.svg):
  // B4 middle line of treble, F4 first/bottom space of treble, D3 middle line
  // of bass, G2 bottom line of bass. Position 4 = middle line (3rd of 5),
  // position 0 = bottom line, position 1 = bottom space, on this 0-8 scale.
  it("places G7's four concert pitches exactly where the reference draws them", () => {
    expect(pitchToStaffPosition("B4", "treble").position).toBe(4); // middle line
    expect(pitchToStaffPosition("F4", "treble").position).toBe(1); // bottom space
    expect(pitchToStaffPosition("D3", "bass").position).toBe(4); // middle line
    expect(pitchToStaffPosition("G2", "bass").position).toBe(0); // bottom line
  });

  it("places middle C (C4) one ledger line below the treble staff", () => {
    const staffPosition = pitchToStaffPosition("C4", "treble");
    expect(staffPosition.position).toBe(-2);
    expect(staffPosition.ledgerLines).toEqual([-2]);
  });

  it("places low C (C2) on the second ledger line below the bass staff", () => {
    const staffPosition = pitchToStaffPosition("C2", "bass");
    expect(staffPosition.position).toBe(-4);
    expect(staffPosition.ledgerLines).toEqual([-2, -4]);
  });

  it("needs no ledger line for a note sitting in the first gap below the staff", () => {
    // F2 in bass clef sits directly below the bottom line (G2) with no ledger.
    const staffPosition = pitchToStaffPosition("F2", "bass");
    expect(staffPosition.position).toBe(-1);
    expect(staffPosition.ledgerLines).toEqual([]);
  });

  it("centers middle C (C4) on the alto clef's middle line", () => {
    expect(pitchToStaffPosition("C4", "alto").position).toBe(4);
  });

  it("carries the accidental through for a flatted pitch", () => {
    expect(pitchToStaffPosition("Ab3", "treble").accidental).toBe("b");
    expect(pitchToStaffPosition("G3", "treble").accidental).toBe("");
  });

  it("keeps every voicing-table pitch within one ledger line of the staff, for every clef it's read in", () => {
    for (const row of Object.values(VOICING_TABLE)) {
      for (const [ensemble, clefs] of Object.entries(CLEF_FOR_VOICE)) {
        for (const [voice, clef] of Object.entries(clefs)) {
          const pitchName = row[voice as keyof typeof row];
          const staffPosition = pitchToStaffPosition(pitchName, clef);
          expect(
            staffPosition.ledgerLines.length,
            `${pitchName} as ${ensemble}/${voice} in ${clef} clef needs ${staffPosition.ledgerLines.length} ledger lines`,
          ).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});
