import { GestureAnalyzer, type GestureFrame } from "./gesture";
import type { Ensemble } from "./voicing";

export type ConductingCallbacks = {
  /** Fired once, the very first time any conducting gesture begins. */
  onFirstGesture: () => void;
  /** Pointer down: sustain begins. */
  onGestureStart: () => void;
  /** Every pointer move while held: smoothed speed, whether this sample
   *  confirmed a corner (harmony should advance), and vibrato intensity. */
  onGestureMove: (frame: GestureFrame) => void;
  /** Pointer up (or cancel): sustain releases. */
  onGestureEnd: () => void;
  /** Baton screen position — visual only, never mapped to pitch. */
  onBatonMove?: (clientX: number, clientY: number) => void;
  /** Instantaneous raw movement heading in degrees, for the baton's
   *  rotation — independent of the axis-lock state that gates corners. */
  onBatonRotate?: (angleDegrees: number) => void;
  onSelectEnsemble?: (ensemble: Ensemble) => void;
};

const ROTATE_MIN_DISTANCE_PX = 2;

export class ConductingController {
  private readonly analyzer = new GestureAnalyzer();
  private pointerPressed = false;
  private hasGestured = false;
  private batonX: number;
  private batonY: number;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly surface: HTMLElement,
    private readonly callbacks: ConductingCallbacks,
  ) {
    const rect = surface.getBoundingClientRect();
    this.batonX = rect.width / 2;
    this.batonY = rect.height / 2;
    this.bind();
  }

  private bind(): void {
    this.surface.addEventListener("pointerdown", this.handlePointerDown);
    this.surface.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  private noteFirstGesture(): void {
    if (this.hasGestured) return;
    this.hasGestured = true;
    this.callbacks.onFirstGesture();
  }

  private handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.noteFirstGesture();
    this.pointerPressed = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.analyzer.reset();
    this.analyzer.addSample(event.timeStamp, event.clientX, event.clientY);
    this.moveBatonTo(event.clientX, event.clientY);
    this.surface.setPointerCapture(event.pointerId);
    this.callbacks.onGestureStart();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.pointerPressed) return;

    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    if (Math.hypot(dx, dy) >= ROTATE_MIN_DISTANCE_PX) {
      const angleDegrees = (Math.atan2(dy, dx) * 180) / Math.PI;
      this.callbacks.onBatonRotate?.(angleDegrees);
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    }

    const frame = this.analyzer.addSample(event.timeStamp, event.clientX, event.clientY);
    this.moveBatonTo(event.clientX, event.clientY);
    this.callbacks.onGestureMove(frame);
  };

  private handlePointerUp = (): void => {
    if (!this.pointerPressed) return;
    this.pointerPressed = false;
    this.callbacks.onGestureEnd();
  };

  private moveBatonTo(clientX: number, clientY: number): void {
    const rect = this.surface.getBoundingClientRect();
    this.batonX = clientX - rect.left;
    this.batonY = clientY - rect.top;
    this.callbacks.onBatonMove?.(this.batonX, this.batonY);
  }

  // "1"/"2" select an ensemble outright — the keyboard's equivalent of
  // pressing one of the two ensemble icon buttons (section 8), and what
  // keeps this a genuinely multi-modal instrument now that Space/arrow-key
  // conducting is gone.
  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "1") {
      this.callbacks.onSelectEnsemble?.("brass");
    } else if (event.key === "2") {
      this.callbacks.onSelectEnsemble?.("strings");
    }
  };
}
