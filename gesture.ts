// Gesture analysis (refinement prompt sections 2 & 4) — pure and independent
// of audio/UI code so the corner/vibrato rules can be tested deterministically
// against synthetic pointer traces, not just judged by feel.

/** Rolling window used to average out per-sample noise before estimating the
 *  current movement axis. */
export const DIRECTION_WINDOW_MS = 100;

/** Per-step motion below this is ignored entirely (hand jitter, not a gesture). */
export const NOISE_DISTANCE_PX = 3;

/** Axis change past this angle (degrees, on the 0-90 mod-π scale) starts a
 *  candidate corner. */
export const CORNER_CANDIDATE_DEG = 40;

/** Axis change back below this cancels a pending candidate — the hand drifted
 *  back toward the original axis rather than committing to a turn. */
export const CORNER_CANCEL_DEG = 20;

/** Distance the candidate axis must hold once past the angle threshold. */
export const CONFIRM_DISTANCE_PX = 24;

/** Time the candidate axis must hold once past the angle threshold. */
export const CONFIRM_TIME_MS = 75;

/** Minimum gap between two confirmed chord changes. */
export const CHORD_CHANGE_COOLDOWN_MS = 150;

/** Exponential smoothing time constant for the speed estimate. */
export const SPEED_SMOOTHING_MS = 60;

/** A same-axis direction flip below this amplitude is jitter, not vibrato. */
export const MIN_REVERSAL_PX = 6;

/** How far back to look when judging whether reversals are happening at a
 *  plausible expressive rate. */
export const VIBRATO_RATE_WINDOW_MS = 700;

/** How much a single qualifying reversal adds to vibrato intensity (0-1). */
export const VIBRATO_BUMP = 0.32;

/** Exponential decay time constant for vibrato intensity once reversals stop. */
export const VIBRATO_DECAY_MS = 260;

export type GestureFrame = {
  /** Smoothed pointer speed in pixels per second. */
  speed: number;
  /** True exactly once, on the sample that confirms a corner. */
  chordChangeTriggered: boolean;
  /** 0 (none) to 1 (full) same-axis reversal expression. */
  vibratoIntensity: number;
};

/** Angle difference on the 0-180° axis (mod π) scale — always 0-90°, since a
 *  line and its opposite direction are the same axis. */
function axisAngleDifference(a: number, b: number): number {
  const diff = Math.abs(a - b) % 180;
  return Math.min(diff, 180 - diff);
}

function toAxisAngleDegrees(dx: number, dy: number): number {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const normalised = ((degrees % 360) + 360) % 360;
  return normalised % 180;
}

type Candidate = { axis: number; startT: number; distance: number; confirmed: boolean };

export class GestureAnalyzer {
  private windowSamples: Array<{ t: number; x: number; y: number }> = [];
  private activeAxis: number | null = null;
  private candidate: Candidate | null = null;
  private lastChangeAt = -Infinity;
  private axisSign: -1 | 0 | 1 = 0;
  private reversalTimes: number[] = [];
  private vibratoIntensity = 0;
  private smoothedSpeed = 0;
  private prev: { t: number; x: number; y: number } | null = null;

  /** Feed one pointer sample (monotonically increasing timestamp, in ms). */
  addSample(t: number, x: number, y: number): GestureFrame {
    let chordChangeTriggered = false;

    if (this.prev) {
      const dt = t - this.prev.t;
      if (dt > 0) {
        const dx = x - this.prev.x;
        const dy = y - this.prev.y;
        const distance = Math.hypot(dx, dy);
        const instantaneousSpeed = distance / (dt / 1000);
        const alpha = 1 - Math.exp(-dt / SPEED_SMOOTHING_MS);
        this.smoothedSpeed += (instantaneousSpeed - this.smoothedSpeed) * alpha;

        this.decayVibrato(dt);

        if (distance >= NOISE_DISTANCE_PX) {
          this.windowSamples.push({ t, x, y });
          const windowStart = t - DIRECTION_WINDOW_MS;
          while (this.windowSamples.length > 1 && this.windowSamples[0].t < windowStart) {
            this.windowSamples.shift();
          }
          chordChangeTriggered = this.processDirection(t, distance);
          this.processReversal(t, dx, dy);
        }
      }
    }

    this.prev = { t, x, y };
    return { speed: this.smoothedSpeed, chordChangeTriggered, vibratoIntensity: this.vibratoIntensity };
  }

  /** Resets axis/candidate/vibrato state for a fresh pointer-down — a new
   *  gesture shouldn't inherit the previous one's committed axis. */
  reset(): void {
    this.windowSamples = [];
    this.activeAxis = null;
    this.candidate = null;
    this.axisSign = 0;
    this.reversalTimes = [];
    this.vibratoIntensity = 0;
    this.smoothedSpeed = 0;
    this.prev = null;
    // lastChangeAt deliberately survives a reset: the cooldown is a real-time
    // guard against rapid re-triggering, not a per-gesture counter.
  }

  private processDirection(t: number, stepDistance: number): boolean {
    // Fewer than two points in the window means there's no real direction
    // yet — computing one from a single point degenerates to 0° and would
    // falsely look like a corner as soon as a second, differently-angled
    // sample arrives.
    if (this.windowSamples.length < 2) return false;

    const windowStart = this.windowSamples[0];
    const windowEnd = this.windowSamples[this.windowSamples.length - 1];
    const axis = toAxisAngleDegrees(windowEnd.x - windowStart.x, windowEnd.y - windowStart.y);

    if (this.activeAxis === null) {
      this.activeAxis = axis;
      return false;
    }

    const diffFromActive = axisAngleDifference(axis, this.activeAxis);

    if (this.candidate === null) {
      if (diffFromActive > CORNER_CANDIDATE_DEG) {
        this.candidate = { axis, startT: t, distance: 0, confirmed: false };
      }
    } else if (!this.candidate.confirmed) {
      const diffFromCandidate = axisAngleDifference(axis, this.candidate.axis);
      if (diffFromActive <= CORNER_CANCEL_DEG) {
        this.candidate = null;
      } else if (diffFromCandidate > CORNER_CANDIDATE_DEG) {
        this.candidate = { axis, startT: t, distance: 0, confirmed: false };
      } else {
        this.candidate.distance += stepDistance;
        if (this.candidate.distance >= CONFIRM_DISTANCE_PX && t - this.candidate.startT >= CONFIRM_TIME_MS) {
          this.candidate.confirmed = true;
        }
      }
    }

    if (this.candidate?.confirmed && t - this.lastChangeAt >= CHORD_CHANGE_COOLDOWN_MS) {
      this.activeAxis = this.candidate.axis;
      this.candidate = null;
      this.lastChangeAt = t;
      this.axisSign = 0;
      this.reversalTimes = [];
      return true;
    }

    return false;
  }

  private processReversal(t: number, dx: number, dy: number): void {
    if (this.activeAxis === null) return;
    const radians = (this.activeAxis * Math.PI) / 180;
    const projection = dx * Math.cos(radians) + dy * Math.sin(radians);
    if (Math.abs(projection) < MIN_REVERSAL_PX) return;

    const sign: -1 | 1 = projection > 0 ? 1 : -1;
    if (this.axisSign !== 0 && sign !== this.axisSign) {
      this.reversalTimes.push(t);
      const windowStart = t - VIBRATO_RATE_WINDOW_MS;
      this.reversalTimes = this.reversalTimes.filter((time) => time >= windowStart);
      this.vibratoIntensity = Math.min(1, this.vibratoIntensity + VIBRATO_BUMP);
    }
    this.axisSign = sign;
  }

  private decayVibrato(dt: number): void {
    if (this.vibratoIntensity <= 0) return;
    this.vibratoIntensity *= Math.exp(-dt / VIBRATO_DECAY_MS);
    if (this.vibratoIntensity < 0.001) this.vibratoIntensity = 0;
  }
}
