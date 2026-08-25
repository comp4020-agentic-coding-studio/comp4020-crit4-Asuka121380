import { AudioEngine, speedToLevel } from "./audio";
import { buildChordEvent, type ChordEvent } from "./chordEvent";
import { INITIAL_STATE, sampleChordSymbol, sampleNextState, type HarmonicState } from "./harmony";
import { ConductingController } from "./interaction";
import { mulberry32 } from "./rng";
import { voiceChord, type Ensemble, type Voice } from "./voicing";
import { ChordVisualizer } from "./visualization";

const surface = document.querySelector<HTMLElement>("#conducting-surface");
const baton = document.querySelector<HTMLElement>("#baton");
const chordSymbolElement = document.querySelector<HTMLElement>("#chord-symbol");
const invitation = document.querySelector<HTMLElement>("#invitation");
const statusRegion = document.querySelector<HTMLElement>("#status");
const ensembleToggle = document.querySelector<HTMLButtonElement>("#ensemble-toggle");
const resetButton = document.querySelector<HTMLButtonElement>("#reset-button");

const voiceRows: Record<Voice, HTMLElement | null> = {
  soprano: document.querySelector<HTMLElement>("#lane-soprano"),
  alto: document.querySelector<HTMLElement>("#lane-alto"),
  tenor: document.querySelector<HTMLElement>("#lane-tenor"),
  bass: document.querySelector<HTMLElement>("#lane-bass"),
};

if (
  surface &&
  baton &&
  chordSymbolElement &&
  invitation &&
  statusRegion &&
  ensembleToggle &&
  resetButton &&
  voiceRows.soprano &&
  voiceRows.alto &&
  voiceRows.tenor &&
  voiceRows.bass
) {
  const rows = voiceRows as Record<Voice, HTMLElement>;
  const audioEngine = new AudioEngine();
  const visualizer = new ChordVisualizer(chordSymbolElement, rows);
  const random = mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

  let ensemble: Ensemble = "brass";
  let harmonicState: HarmonicState = INITIAL_STATE;

  const buildCurrentEvent = (): ChordEvent => {
    const chordSymbol = sampleChordSymbol(harmonicState, random);
    const notes = voiceChord(chordSymbol, ensemble);
    return buildChordEvent({ harmonicState, chordSymbol, notes, ensemble });
  };

  // The chord currently sustaining (or last sustained) — audio and the score
  // notation are always driven from this same object, never a separate
  // decorative copy.
  let currentEvent: ChordEvent = buildCurrentEvent();

  const ensembleLabel = (): string => (ensemble === "brass" ? "Brass Choir" : "Symphonic Strings");

  const selectEnsemble = (next: Ensemble): void => {
    if (ensemble === next) return;
    ensemble = next;
    ensembleToggle.textContent = ensembleLabel();
    ensembleToggle.setAttribute("aria-pressed", String(ensemble === "strings"));
    statusRegion.textContent = `${ensembleLabel()} selected.`;
    // Re-voice the same chord under the new ensemble's instrument names —
    // the sounding pitches are identical, so only the display relabels
    // immediately. A currently-sustaining voice keeps its own timbre until
    // the next chord change or new hold.
    currentEvent = buildChordEvent({
      harmonicState: currentEvent.harmonicState,
      chordSymbol: currentEvent.chordSymbol,
      notes: voiceChord(currentEvent.chordSymbol, ensemble),
      ensemble,
    });
    visualizer.showChord(currentEvent);
  };

  const controller = new ConductingController(surface, {
    onFirstGesture: () => {
      audioEngine.ensureContext();
      invitation.classList.add("invitation-hidden");
    },
    onGestureStart: () => {
      audioEngine.ensureContext();
      audioEngine.startChord(currentEvent);
      visualizer.showChord(currentEvent);
    },
    onGestureMove: (frame) => {
      const level = speedToLevel(frame.speed);
      audioEngine.setExpression(level, frame.vibratoIntensity);
      if (frame.chordChangeTriggered) {
        // Dev-only timing check for the corner→audio path: `import.meta.env.DEV`
        // is inlined to `false` by Vite in a production build, so this whole
        // branch is dead-code-eliminated from the shipped bundle — used to
        // confirm the confirmation→invocation leg is same-tick, not shipped
        // as permanent diagnostics.
        const confirmedAt = import.meta.env.DEV ? performance.now() : 0;
        harmonicState = sampleNextState(harmonicState, random);
        currentEvent = buildCurrentEvent();
        audioEngine.changeChord(currentEvent);
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.debug(`[timing] corner confirmed -> changeChord invoked: ${(performance.now() - confirmedAt).toFixed(2)}ms`);
        }
        visualizer.showChord(currentEvent);
      }
    },
    onGestureEnd: () => {
      audioEngine.releaseChord();
    },
    onBatonMove: (x, y) => {
      baton.style.setProperty("--baton-x", `${x}px`);
      baton.style.setProperty("--baton-y", `${y}px`);
    },
    onBatonRotate: (angleDegrees) => {
      baton.style.setProperty("--baton-angle", `${angleDegrees}deg`);
    },
    onSelectEnsemble: selectEnsemble,
  });

  ensembleToggle.addEventListener("click", () => {
    selectEnsemble(ensemble === "brass" ? "strings" : "brass");
  });

  resetButton.addEventListener("click", () => {
    harmonicState = INITIAL_STATE;
    currentEvent = buildCurrentEvent();
    visualizer.showChord(currentEvent);
    statusRegion.textContent = "Harmony reset.";
  });

  void controller;
}
