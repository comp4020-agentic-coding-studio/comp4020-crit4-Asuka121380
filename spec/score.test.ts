// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildChordEvent, type ChordEvent } from "../chordEvent";
import { INITIAL_STATE } from "../harmony";
import { pitchToStaffPosition } from "../notation";
import { ScoreRenderer } from "../score";
import { voiceChord, type Ensemble, type Voice, type VoicedNote } from "../voicing";

// Integration coverage for the SVG conductor's score (refinement Part A.2):
// "Tests must verify pitch-to-staff mapping, clef selection, accidentals,
// ledger lines, ensemble-specific labels, and consistency between
// displayed/sounded pitches." `notation.test.ts` already covers the pure
// `pitchToStaffPosition` geometry function in isolation; these tests instead
// drive the actual `ScoreRenderer` — the thing that ends up on screen — with
// real `ChordEvent`s and read the resulting SVG DOM, so a regression that
// only breaks the wiring between `score.ts` and `notation.ts` (wrong clef
// picked, wrong voice's label updated, a pitch drawn that doesn't match the
// one actually sounding) fails here even though the pure geometry function
// itself would still pass.

const SVG_NS = "http://www.w3.org/2000/svg";

function makeRenderer(): { renderer: ScoreRenderer; svg: SVGSVGElement } {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  const chordSymbolElement = document.createElement("div");
  return { renderer: new ScoreRenderer(svg, chordSymbolElement), svg };
}

function eventFor(chordSymbol: string, ensemble: Ensemble): ChordEvent {
  return buildChordEvent({
    harmonicState: INITIAL_STATE,
    chordSymbol,
    notes: voiceChord(chordSymbol, ensemble),
    ensemble,
  });
}

function customEvent(notes: VoicedNote[], ensemble: Ensemble): ChordEvent {
  return buildChordEvent({ harmonicState: INITIAL_STATE, chordSymbol: "Custom", notes, ensemble });
}

function staffGroup(svg: SVGSVGElement, voice: Voice): SVGGElement {
  const group = svg.querySelector<SVGGElement>(`g.staff[data-voice="${voice}"]`);
  if (!group) throw new Error(`no staff rendered for voice ${voice}`);
  return group;
}

function noteheadY(svg: SVGSVGElement, voice: Voice): number {
  const notehead = staffGroup(svg, voice).querySelector<SVGEllipseElement>("ellipse.notehead");
  const match = /translate\([-\d.]+,([-\d.]+)\)/.exec(notehead?.getAttribute("transform") ?? "");
  if (!match) throw new Error(`notehead for ${voice} has no transform yet`);
  return Number(match[1]);
}

function staffLineYs(svg: SVGSVGElement, voice: Voice): number[] {
  // Draw order is bottom line first (position 0), then up by one line
  // (position 2) each time, ending at the top line (position 8) — see
  // `buildStaff`'s `for (let line = 0; line < 5; line++)` loop.
  return Array.from(staffGroup(svg, voice).querySelectorAll<SVGLineElement>("line.staff-line")).map((line) =>
    Number(line.getAttribute("y1")),
  );
}

function visibleClef(svg: SVGSVGElement, voice: Voice): string {
  const groups = Array.from(staffGroup(svg, voice).querySelectorAll<SVGGElement>("g.clef"));
  const visible = groups.find((g) => g.style.display !== "none");
  const match = /clef-(\w+)/.exec(visible?.getAttribute("class") ?? "");
  if (!match) throw new Error(`no visible clef for voice ${voice}`);
  return match[1];
}

function label(svg: SVGSVGElement, voice: Voice): string {
  return staffGroup(svg, voice).querySelector("text.instrument-label")?.textContent ?? "";
}

function ledgerLineCount(svg: SVGSVGElement, voice: Voice): number {
  return staffGroup(svg, voice).querySelectorAll(".ledger-lines line").length;
}

function accidentalClass(svg: SVGSVGElement, voice: Voice): string | null {
  // `.accidental > *` reliably returns null under jsdom's SVG selector
  // handling even when the child exists (verified directly against the
  // rendered DOM) — walk to the child element instead of relying on the
  // combinator.
  return staffGroup(svg, voice).querySelector(".accidental")?.firstElementChild?.getAttribute("class") ?? null;
}

describe("ScoreRenderer: pitch-to-staff mapping and clef selection", () => {
  it("renders the reference G7 chord's four concert pitches exactly on the staff position the reference draws", () => {
    const { renderer, svg } = makeRenderer();
    renderer.showChord(eventFor("G7", "brass"));

    // Trumpet B4: middle line of treble (position 4) — same y as the
    // treble staff's own middle staff-line, read straight from the DOM
    // rather than a hand-computed pixel constant.
    const [sopranoBottom, , sopranoMiddle] = staffLineYs(svg, "soprano");
    expect(noteheadY(svg, "soprano")).toBe(sopranoMiddle);
    expect(visibleClef(svg, "soprano")).toBe("treble");

    // Horn F4: bottom space of treble (position 1) — exactly halfway
    // between the bottom line (position 0) and the next line up (position 2).
    const [altoBottom, altoNextLine] = staffLineYs(svg, "alto");
    expect(noteheadY(svg, "alto")).toBe((altoBottom + altoNextLine) / 2);
    expect(visibleClef(svg, "alto")).toBe("treble"); // Horn reads treble in brass

    // Trombone D3: middle line of bass (position 4).
    const [, , tenorMiddle] = staffLineYs(svg, "tenor");
    expect(noteheadY(svg, "tenor")).toBe(tenorMiddle);
    expect(visibleClef(svg, "tenor")).toBe("bass");

    // Tuba G2: bottom line of bass (position 0).
    expect(noteheadY(svg, "bass")).toBe(staffLineYs(svg, "bass")[0]);
    expect(visibleClef(svg, "bass")).toBe("bass");

    expect(sopranoBottom).not.toBe(sopranoMiddle); // sanity: distinct lines
    expect(altoBottom).not.toBe(altoNextLine);
  });

  it("renders the same G7 chord's alto voice on the alto clef, at the same sounded pitch, for strings", () => {
    const { renderer, svg } = makeRenderer();
    renderer.showChord(eventFor("G7", "strings"));

    // Viola sounds the identical F4 that Horn sounds, but reads alto clef,
    // not treble — the clef differs, the sounding pitch (and therefore the
    // note's identity) must not. In alto clef F4 sits at position 7 (the
    // space below the top line), independently confirmed via
    // pitchToStaffPosition rather than assumed to match treble's layout.
    expect(visibleClef(svg, "alto")).toBe("alto");
    expect(pitchToStaffPosition("F4", "alto").position).toBe(7);
    const [, , , altoLine6, altoLine8] = staffLineYs(svg, "alto");
    expect(noteheadY(svg, "alto")).toBe((altoLine6 + altoLine8) / 2);

    // Soprano/tenor/bass keep the same clef in both ensembles.
    expect(visibleClef(svg, "soprano")).toBe("treble");
    expect(visibleClef(svg, "tenor")).toBe("bass");
    expect(visibleClef(svg, "bass")).toBe("bass");
  });

  it("needs no ledger lines for any voice in the in-staff G7 example", () => {
    const { renderer, svg } = makeRenderer();
    renderer.showChord(eventFor("G7", "brass"));
    for (const voice of ["soprano", "alto", "tenor", "bass"] as const) {
      expect(ledgerLineCount(svg, voice)).toBe(0);
    }
  });

  it("draws the correct number of ledger lines for a note below the staff, matching pitchToStaffPosition", () => {
    const { renderer, svg } = makeRenderer();
    // C: { bass: "C2", ... } — two ledger lines below the bass staff.
    renderer.showChord(eventFor("C", "brass"));
    const expected = pitchToStaffPosition("C2", "bass").ledgerLines.length;
    expect(expected).toBe(2);
    expect(ledgerLineCount(svg, "bass")).toBe(expected);
  });
});

describe("ScoreRenderer: accidentals", () => {
  it("shows a flat for a flatted pitch and no accidental for a natural one", () => {
    const { renderer, svg } = makeRenderer();
    // Fm: { alto: "Ab3", ... } vs G: { alto: "B3", ... }.
    renderer.showChord(eventFor("Fm", "brass"));
    expect(accidentalClass(svg, "alto")).toBe("accidental-flat");

    renderer.showChord(eventFor("G", "brass"));
    expect(accidentalClass(svg, "alto")).toBeNull();
  });

  it("shows a sharp for a sharped pitch", () => {
    const { renderer, svg } = makeRenderer();
    const notes: VoicedNote[] = [
      { voice: "soprano", instrument: "Trumpet", midi: 66, pitchName: "F#4" },
      { voice: "alto", instrument: "Horn", midi: 60, pitchName: "C4" },
      { voice: "tenor", instrument: "Trombone", midi: 48, pitchName: "C3" },
      { voice: "bass", instrument: "Tuba", midi: 41, pitchName: "F2" },
    ];
    renderer.showChord(customEvent(notes, "brass"));
    expect(accidentalClass(svg, "soprano")).toBe("accidental-sharp");
  });
});

describe("ScoreRenderer: ensemble-specific instrument labels", () => {
  it("labels each staff with the current ensemble's instrument, and updates immediately on switch", () => {
    const { renderer, svg } = makeRenderer();
    renderer.showChord(eventFor("G7", "brass"));
    expect(label(svg, "soprano")).toBe("TRUMPET");
    expect(label(svg, "alto")).toBe("HORN");
    expect(label(svg, "tenor")).toBe("TROMBONE");
    expect(label(svg, "bass")).toBe("TUBA");

    renderer.showChord(eventFor("G7", "strings"));
    expect(label(svg, "soprano")).toBe("VIOLIN");
    expect(label(svg, "alto")).toBe("VIOLA");
    expect(label(svg, "tenor")).toBe("CELLO");
    expect(label(svg, "bass")).toBe("DOUBLE BASS");
  });
});

describe("ScoreRenderer: displayed pitch matches sounded pitch", () => {
  it("draws every voice at the staff position pitchToStaffPosition independently computes for that voice's sounded pitch", () => {
    const { renderer, svg } = makeRenderer();
    for (const [chordSymbol, ensemble] of [
      ["G7", "brass"],
      ["Dm7", "strings"],
      ["Am7", "brass"],
      ["Fm6", "strings"],
    ] as const) {
      const event = eventFor(chordSymbol, ensemble);
      renderer.showChord(event);
      for (const note of event.notes) {
        const clef = visibleClef(svg, note.voice) as "treble" | "alto" | "bass";
        const expectedPosition = pitchToStaffPosition(note.pitchName, clef);
        expect(ledgerLineCount(svg, note.voice)).toBe(expectedPosition.ledgerLines.length);
        const expectedAccidentalClass =
          expectedPosition.accidental === "#" ? "accidental-sharp" : expectedPosition.accidental === "b" ? "accidental-flat" : null;
        expect(accidentalClass(svg, note.voice)).toBe(expectedAccidentalClass);
      }
    }
  });
});
