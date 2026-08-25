import type { ChordEvent } from "./chordEvent";
import { CLEF_FOR_VOICE, pitchToStaffPosition, type Clef } from "./notation";
import { VOICE_ORDER, type Voice } from "./voicing";

// Real SVG conductor's-score renderer (refinement Part A). Everything drawn
// here is computed from the same `ChordEvent`/`pitchToStaffPosition` math the
// audio engine's notes come from — there is no separate decorative pitch
// table. Clefs, noteheads, accidentals and ledger lines are hand-authored SVG
// paths, not platform emoji or music-font glyph text (the reference SVG's own
// Unicode clef glyphs are explicitly not the target here).
const SVG_NS = "http://www.w3.org/2000/svg";

export const SCORE_VIEWBOX_WIDTH = 620;
export const SCORE_VIEWBOX_HEIGHT = 600;

const LINE_GAP = 14; // px between two adjacent staff lines
const UNIT = LINE_GAP / 2; // px per staff "position" step (notation.ts scale)
const STAFF_START_X = 158;
const STAFF_END_X = 520;
const CLEF_X = 175;
const LABEL_X = 8;
const NOTE_X = 430;
const ACCIDENTAL_X = NOTE_X - 24;
const LEDGER_HALF_WIDTH = 15;
const STEM_LENGTH = 32;

// One bottom-line y-coordinate per voice slot, top (soprano) to bottom
// (bass) — matches VOICE_ORDER so the four staves stack as a conductor
// score: Trumpet/Violin, Horn/Viola, Trombone/Cello, Tuba/Double Bass.
const BOTTOM_LINE_Y: Record<Voice, number> = {
  soprano: 150,
  alto: 280,
  tenor: 410,
  bass: 540,
};

// Hand-authored clef glyphs, local origin (0,0) = the staff's bottom line,
// "up" is negative y — the same convention as the global SVG (y grows
// downward), so these paths drop straight into a `translate(x, bottomLineY)`
// group with no further transform.
const CLEF_PATHS: Record<Clef, string> = {
  treble:
    "M14,-77 C -4,-77 -12,-66 -12,-55 C -12,-44 -2,-37 9,-38 C 20,-39 25,-49 20,-58 " +
    "C 13,-70 -4,-64 -8,-48 L 4,4 C 6,14 -2,20 -9,15 C -15,10 -14,1 -6,-1",
  bass: "M0,-59 C 22,-61 34,-52 33,-41 C 32,-28 16,-21 0,-26",
  alto: "M2,-56 C 16,-52 16,-32 2,-28 C 16,-24 16,-4 2,0",
};

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function buildClefGraphic(clef: Clef): SVGGElement {
  const g = el("g", { class: `clef clef-${clef}` });
  g.append(el("path", { d: CLEF_PATHS[clef] }));
  if (clef === "bass") {
    g.append(el("circle", { class: "clef-dot", cx: "38", cy: "-50", r: "3" }));
    g.append(el("circle", { class: "clef-dot", cx: "38", cy: "-34", r: "3" }));
  } else if (clef === "alto") {
    g.append(el("line", { x1: "12", y1: "-56", x2: "12", y2: "0", class: "alto-bar-thin" }));
    g.append(el("line", { x1: "18", y1: "-56", x2: "18", y2: "0", class: "alto-bar-thick" }));
  } else if (clef === "treble") {
    g.append(el("circle", { class: "clef-dot", cx: "4", cy: "10", r: "2" }));
  }
  return g;
}

function buildSharp(cx: number, cy: number): SVGGElement {
  const g = el("g", { class: "accidental-sharp", transform: `translate(${cx},${cy})` });
  g.append(el("line", { x1: "-5", y1: "-13", x2: "-5", y2: "13" }));
  g.append(el("line", { x1: "5", y1: "-13", x2: "5", y2: "13" }));
  g.append(el("line", { x1: "-8", y1: "-4", x2: "8", y2: "-7" }));
  g.append(el("line", { x1: "-8", y1: "7", x2: "8", y2: "4" }));
  return g;
}

function buildFlat(cx: number, cy: number): SVGGElement {
  const g = el("g", { class: "accidental-flat", transform: `translate(${cx},${cy - 3})` });
  g.append(el("line", { x1: "-4", y1: "-15", x2: "-4", y2: "9" }));
  g.append(el("path", { d: "M-4,9 C 6,9 9,0 3,-4 C -1,-6.5 -4,-4 -4,0" }));
  return g;
}

type StaffRefs = {
  bottomLineY: number;
  label: SVGTextElement;
  clefGroups: Record<Clef, SVGGElement>;
  ledgerGroup: SVGGElement;
  accidentalGroup: SVGGElement;
  stem: SVGLineElement;
  notehead: SVGEllipseElement;
  glowGroup: SVGGElement;
};

// Only the current chord is ever shown — no history, no measures, no
// rhythm. A brief muted-gold flash on change settles back to plain ink
// notation; disabled under prefers-reduced-motion.
const FLASH_CLASS = "note-flash";

export class ScoreRenderer {
  private readonly staffRefs: Record<Voice, StaffRefs>;
  private readonly reducedMotion: boolean;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly chordSymbolElement: HTMLElement,
  ) {
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.svg.setAttribute("viewBox", `0 0 ${SCORE_VIEWBOX_WIDTH} ${SCORE_VIEWBOX_HEIGHT}`);
    this.svg.append(this.buildBracket());
    this.staffRefs = {
      soprano: this.buildStaff("soprano"),
      alto: this.buildStaff("alto"),
      tenor: this.buildStaff("tenor"),
      bass: this.buildStaff("bass"),
    };
  }

  private buildBracket(): SVGPathElement {
    const top = BOTTOM_LINE_Y.soprano - 90;
    const bottom = BOTTOM_LINE_Y.bass + 30;
    return el("path", {
      class: "system-bracket",
      d: `M12,${top} C 4,${top} 4,${top} 4,${top + 20} L 4,${bottom - 20} C 4,${bottom} 4,${bottom} 12,${bottom}`,
    });
  }

  private buildStaff(voice: Voice): StaffRefs {
    const bottomLineY = BOTTOM_LINE_Y[voice];
    const g = el("g", { class: "staff", "data-voice": voice });

    for (let line = 0; line < 5; line++) {
      const y = bottomLineY - line * LINE_GAP;
      g.append(el("line", { class: "staff-line", x1: String(STAFF_START_X), y1: String(y), x2: String(STAFF_END_X), y2: String(y) }));
    }

    const label = el("text", { class: "instrument-label", x: String(LABEL_X), y: String(bottomLineY - LINE_GAP * 2 - 4) });
    g.append(label);

    const clefGroups: Record<Clef, SVGGElement> = {
      treble: buildClefGraphic("treble"),
      alto: buildClefGraphic("alto"),
      bass: buildClefGraphic("bass"),
    };
    for (const clef of Object.keys(clefGroups) as Clef[]) {
      const clefGroup = clefGroups[clef];
      clefGroup.setAttribute("transform", `translate(${CLEF_X},${bottomLineY})`);
      clefGroup.style.display = "none";
      g.append(clefGroup);
    }

    const glowGroup = el("g", { class: "note-glow" });
    const ledgerGroup = el("g", { class: "ledger-lines" });
    const accidentalGroup = el("g", { class: "accidental" });
    const stem = el("line", { class: "stem" });
    const notehead = el("ellipse", { class: "notehead", cx: "0", cy: "0", rx: "9", ry: "6.5" });
    g.append(glowGroup, ledgerGroup, accidentalGroup, stem, notehead);

    this.svg.append(g);

    return { bottomLineY, label, clefGroups, ledgerGroup, accidentalGroup, stem, notehead, glowGroup };
  }

  showChord(event: ChordEvent): void {
    this.chordSymbolElement.textContent = event.chordSymbol;
    this.chordSymbolElement.classList.remove("chord-symbol-pulse");
    void this.chordSymbolElement.offsetWidth; // restart the CSS pulse animation
    this.chordSymbolElement.classList.add("chord-symbol-pulse");

    for (const voice of VOICE_ORDER) {
      const note = event.notes.find((n) => n.voice === voice);
      const ref = this.staffRefs[voice];
      if (!note || !ref) continue;

      const clef = CLEF_FOR_VOICE[event.ensemble][voice];
      for (const clefName of Object.keys(ref.clefGroups) as Clef[]) {
        ref.clefGroups[clefName].style.display = clefName === clef ? "" : "none";
      }
      ref.label.textContent = note.instrument.toUpperCase();

      const { position, ledgerLines, accidental } = pitchToStaffPosition(note.pitchName, clef);
      const y = ref.bottomLineY - position * UNIT;

      ref.notehead.setAttribute("transform", `translate(${NOTE_X},${y}) rotate(-18)`);

      const stemUp = position < 4;
      const stemX = stemUp ? NOTE_X + 8 : NOTE_X - 8;
      const stemStartY = stemUp ? y - 2 : y + 2;
      const stemEndY = stemUp ? y - STEM_LENGTH : y + STEM_LENGTH;
      ref.stem.setAttribute("x1", String(stemX));
      ref.stem.setAttribute("y1", String(stemStartY));
      ref.stem.setAttribute("x2", String(stemX));
      ref.stem.setAttribute("y2", String(stemEndY));

      ref.ledgerGroup.replaceChildren();
      for (const ledgerPosition of ledgerLines) {
        const ledgerY = ref.bottomLineY - ledgerPosition * UNIT;
        ref.ledgerGroup.append(
          el("line", {
            class: "ledger-line",
            x1: String(NOTE_X - LEDGER_HALF_WIDTH),
            y1: String(ledgerY),
            x2: String(NOTE_X + LEDGER_HALF_WIDTH),
            y2: String(ledgerY),
          }),
        );
      }

      ref.accidentalGroup.replaceChildren();
      if (accidental === "#") ref.accidentalGroup.append(buildSharp(ACCIDENTAL_X, y));
      else if (accidental === "b") ref.accidentalGroup.append(buildFlat(ACCIDENTAL_X, y));

      ref.glowGroup.replaceChildren();
      if (!this.reducedMotion) {
        const glow = el("ellipse", {
          class: "note-glow-flash",
          cx: String(NOTE_X),
          cy: String(y),
          rx: "16",
          ry: "13",
        });
        ref.glowGroup.append(glow);
      }

      const group = ref.notehead.closest<SVGGElement>("g.staff");
      if (group) {
        group.classList.remove(FLASH_CLASS);
        void group.getBoundingClientRect();
        group.classList.add(FLASH_CLASS);
      }
    }
  }
}
