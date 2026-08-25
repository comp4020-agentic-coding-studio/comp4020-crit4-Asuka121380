import { AudioEngine, noteDurationSeconds } from "./audio";
import { buildChordEvent } from "./chordEvent";
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

  function ensembleLabel(): string {
    return ensemble === "brass" ? "Brass Choir" : "Symphonic Strings";
  }

  function triggerChord(): void {
    harmonicState = sampleNextState(harmonicState, random);
    const chordSymbol = sampleChordSymbol(harmonicState, random);
    const notes = voiceChord(chordSymbol, ensemble);
    const context = audioEngine.ensureContext();
    const event = buildChordEvent({
      harmonicState,
      chordSymbol,
      notes,
      ensemble,
      startedAtSeconds: context.currentTime,
      durationSeconds: noteDurationSeconds(ensemble),
    });
    audioEngine.playChord(event);
    visualizer.showChord(event);
  }

  const controller = new ConductingController(surface, {
    onFirstGesture: () => {
      audioEngine.ensureContext();
      invitation.classList.add("invitation-hidden");
      triggerChord();
    },
    onChordTrigger: triggerChord,
    onBatonMove: (x, y) => {
      baton.style.setProperty("--baton-x", `${x}px`);
      baton.style.setProperty("--baton-y", `${y}px`);
    },
    onToggleEnsemble: () => {
      ensemble = ensemble === "brass" ? "strings" : "brass";
      ensembleToggle.textContent = ensembleLabel();
      ensembleToggle.setAttribute("aria-pressed", String(ensemble === "strings"));
      statusRegion.textContent = `${ensembleLabel()} selected.`;
    },
    onReset: () => {
      harmonicState = INITIAL_STATE;
      statusRegion.textContent = "Harmony reset.";
    },
  });

  ensembleToggle.addEventListener("click", () => {
    ensemble = ensemble === "brass" ? "strings" : "brass";
    ensembleToggle.textContent = ensembleLabel();
    ensembleToggle.setAttribute("aria-pressed", String(ensemble === "strings"));
    statusRegion.textContent = `${ensembleLabel()} selected.`;
  });

  resetButton.addEventListener("click", () => {
    harmonicState = INITIAL_STATE;
    statusRegion.textContent = "Harmony reset.";
  });

  void controller;
}
