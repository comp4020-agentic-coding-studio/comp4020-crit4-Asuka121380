import type { ChordEvent } from "./chordEvent";
import type { Voice } from "./voicing";

// Section 12: only the chord currently sounding is ever shown. The DOM keeps
// no history of its own — each marker manages its own fade-and-remove
// lifecycle, so "the current event and briefly the previous one" falls out
// of markers naturally overlapping during a fade, with no accumulated list.
const FADE_SECONDS = 1.3;
const REDUCED_MOTION_FADE_SECONDS = 0.15;

export class ChordVisualizer {
  private readonly fadeSeconds: number;

  constructor(
    private readonly chordSymbolElement: HTMLElement,
    private readonly voiceRows: Record<Voice, HTMLElement>,
  ) {
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.fadeSeconds = prefersReducedMotion ? REDUCED_MOTION_FADE_SECONDS : FADE_SECONDS;
  }

  showChord(event: ChordEvent): void {
    this.chordSymbolElement.textContent = event.chordSymbol;
    this.chordSymbolElement.classList.remove("chord-symbol-pulse");
    void this.chordSymbolElement.offsetWidth; // restart the CSS pulse animation
    this.chordSymbolElement.classList.add("chord-symbol-pulse");

    for (const note of event.notes) {
      const row = this.voiceRows[note.voice];
      if (!row) continue;

      const marker = document.createElement("span");
      marker.className = "note-marker note-marker-active";
      marker.setAttribute("aria-hidden", "true");
      marker.dataset.pitchName = note.pitchName; // dev-only, not rendered
      marker.style.setProperty("--fade-seconds", `${this.fadeSeconds}s`);
      row.appendChild(marker);

      requestAnimationFrame(() => {
        marker.classList.remove("note-marker-active");
        marker.classList.add("note-marker-fading");
      });

      setTimeout(() => marker.remove(), this.fadeSeconds * 1000 + 80);
    }
  }
}
