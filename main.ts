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
const ensembleBrassButton = document.querySelector<HTMLButtonElement>("#ensemble-brass");
const ensembleStringsButton = document.querySelector<HTMLButtonElement>("#ensemble-strings");
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
  ensembleBrassButton &&
  ensembleStringsButton &&
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
    ensembleBrassButton.setAttribute("aria-pressed", String(ensemble === "brass"));
    ensembleStringsButton.setAttribute("aria-pressed", String(ensemble === "strings"));
    statusRegion.textContent = `${ensembleLabel()} selected.`;
    // Re-voice the same chord under the new ensemble's instrument names —
    // the sounding pitches are identical, so only the display relabels
    // immediately.
    currentEvent = buildChordEvent({
      harmonicState: currentEvent.harmonicState,
      chordSymbol: currentEvent.chordSymbol,
      notes: voiceChord(currentEvent.chordSymbol, ensemble),
      ensemble,
    });
    // If a chord is currently sustaining, crossfade it into the new
    // ensemble's timbre right away — switching should be audible
    // immediately, not only on the next corner or the next hold. No-ops
    // (see retimbreChord) when nothing is currently sounding.
    audioEngine.retimbreChord(currentEvent);
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
        // Dev-only timing breakdown for the corner→audio path: `import.meta.env.DEV`
        // is inlined to `false` by Vite in a production build, so this whole
        // branch is dead-code-eliminated from the shipped bundle. Broken into
        // stages (rather than one start/end measurement) so a real Mac/Safari
        // retest can show exactly which leg — harmony selection, event
        // construction, or the audio engine call itself — accounts for any
        // remaining delay, instead of only knowing the total.
        const cornerConfirmedAt = import.meta.env.DEV ? performance.now() : 0;
        harmonicState = sampleNextState(harmonicState, random);
        const harmonySelectedAt = import.meta.env.DEV ? performance.now() : 0;
        currentEvent = buildCurrentEvent();
        const eventBuiltAt = import.meta.env.DEV ? performance.now() : 0;
        audioEngine.changeChord(currentEvent);
        if (import.meta.env.DEV) {
          const audioInvokedAt = performance.now();
          // eslint-disable-next-line no-console
          console.debug(
            `[timing] corner confirmed -> harmony selected: ${(harmonySelectedAt - cornerConfirmedAt).toFixed(2)}ms, ` +
              `event built: ${(eventBuiltAt - harmonySelectedAt).toFixed(2)}ms, ` +
              `audio engine invoked: ${(audioInvokedAt - eventBuiltAt).toFixed(2)}ms, ` +
              `total: ${(audioInvokedAt - cornerConfirmedAt).toFixed(2)}ms`,
          );
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

  ensembleBrassButton.addEventListener("click", () => selectEnsemble("brass"));
  ensembleStringsButton.addEventListener("click", () => selectEnsemble("strings"));

  resetButton.addEventListener("click", () => {
    harmonicState = INITIAL_STATE;
    currentEvent = buildCurrentEvent();
    visualizer.showChord(currentEvent);
    statusRegion.textContent = "Harmony reset.";
  });

  void controller;
}
