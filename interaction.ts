// Distance travelled while pressed, in CSS pixels, before one new chord
// triggers and the accumulator resets. Faster motion crosses this more
// often, producing a denser rhythm.
export const DISTANCE_THRESHOLD_PX = 55;

// Space-held keyboard conducting simulates movement on a steady tick rather
// than a real pointer trace — documented here per section 6's "pick one" —
// then feeds the same accumulate/threshold path pointer input uses.
const KEYBOARD_TICK_MS = 60;
const KEYBOARD_STEP_PX = 7;

const ARROW_NUDGE_PX = 18;

export type ConductingCallbacks = {
  /** Fired once, the very first time any conducting gesture begins. */
  onFirstGesture: () => void;
  /** Fired every time accumulated distance crosses the threshold. */
  onChordTrigger: () => void;
  /** Baton screen position changed — visual only, never mapped to pitch. */
  onBatonMove?: (clientX: number, clientY: number) => void;
  onToggleEnsemble?: () => void;
  onReset?: () => void;
};

export class ConductingController {
  private accumulatedDistance = 0;
  private lastX = 0;
  private lastY = 0;
  private pointerPressed = false;
  private hasGestured = false;
  private keyboardTimer: ReturnType<typeof setInterval> | null = null;
  private batonX: number;
  private batonY: number;

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
    window.addEventListener("keyup", this.handleKeyUp);
  }

  private noteFirstGesture(): void {
    if (this.hasGestured) return;
    this.hasGestured = true;
    this.callbacks.onFirstGesture();
  }

  private accumulate(distance: number): void {
    this.accumulatedDistance += distance;
    if (this.accumulatedDistance >= DISTANCE_THRESHOLD_PX) {
      this.accumulatedDistance = 0;
      this.callbacks.onChordTrigger();
    }
  }

  private handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.noteFirstGesture();
    this.pointerPressed = true;
    this.accumulatedDistance = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.moveBatonTo(event.clientX, event.clientY);
    this.surface.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.pointerPressed) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.moveBatonTo(event.clientX, event.clientY);
    this.accumulate(Math.hypot(dx, dy));
  };

  private handlePointerUp = (): void => {
    this.pointerPressed = false;
  };

  private moveBatonTo(clientX: number, clientY: number): void {
    const rect = this.surface.getBoundingClientRect();
    this.batonX = clientX - rect.left;
    this.batonY = clientY - rect.top;
    this.callbacks.onBatonMove?.(this.batonX, this.batonY);
  }

  private nudgeBaton(dx: number, dy: number): void {
    const rect = this.surface.getBoundingClientRect();
    this.batonX = Math.min(Math.max(this.batonX + dx, 0), rect.width);
    this.batonY = Math.min(Math.max(this.batonY + dy, 0), rect.height);
    this.callbacks.onBatonMove?.(this.batonX, this.batonY);
  }

  private startKeyboardConducting(): void {
    if (this.keyboardTimer) return;
    this.accumulatedDistance = 0;
    let angle = 0;
    this.keyboardTimer = setInterval(() => {
      angle += Math.PI / 3;
      this.nudgeBaton(Math.cos(angle) * (KEYBOARD_STEP_PX / 2), Math.sin(angle) * (KEYBOARD_STEP_PX / 2));
      this.accumulate(KEYBOARD_STEP_PX);
    }, KEYBOARD_TICK_MS);
  }

  private stopKeyboardConducting(): void {
    if (!this.keyboardTimer) return;
    clearInterval(this.keyboardTimer);
    this.keyboardTimer = null;
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      event.preventDefault();
      if (event.repeat) return;
      this.noteFirstGesture();
      this.startKeyboardConducting();
      return;
    }
    if (event.code === "ArrowUp" || event.code === "ArrowDown" || event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      if (event.code === "ArrowUp") this.nudgeBaton(0, -ARROW_NUDGE_PX);
      if (event.code === "ArrowDown") this.nudgeBaton(0, ARROW_NUDGE_PX);
      if (event.code === "ArrowLeft") this.nudgeBaton(-ARROW_NUDGE_PX, 0);
      if (event.code === "ArrowRight") this.nudgeBaton(ARROW_NUDGE_PX, 0);
      return;
    }
    if (event.key.toLowerCase() === "e") {
      this.callbacks.onToggleEnsemble?.();
      return;
    }
    if (event.key.toLowerCase() === "r") {
      this.callbacks.onReset?.();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      event.preventDefault();
      this.stopKeyboardConducting();
    }
  };
}
