// Corner detection is deliberately NOT "does cumulative direction change
// exceed a threshold" (that model let smooth curves accumulate enough drift
// to fire, since a long gradual arc and a short sharp turn can reach the same
// total heading change). Instead it looks for the concrete shape of a real
// corner: a straight incoming run, a concentrated turn, a straight outgoing
// run. Both runs are evaluated over a *distance* window (not a time window),
// each is required to be internally straight, and the corner only confirms
// when the heading genuinely pivots between two already-straight segments.
//
// Pointer coordinates arrive in CSS px, which are already device-pixel-ratio
// independent (a 30px segment is the same physical gesture on a retina
// laptop trackpad and a low-DPI touchscreen) — so the distance constants
// below need no extra DPR scaling.

export const NOISE_DISTANCE_PX = 4;
// Target path length of each stable run on either side of a candidate
// corner. Conservative per the brief's 24-36px range.
export const SEGMENT_LENGTH_PX = 30;
// A segment counts as "stable" when its straight-line chord covers at least
// this fraction of the path length actually traveled across it. A perfectly
// straight run scores 1.0; backtracking, wandering, or curving through the
// segment pulls this below 1. This one ratio check does the job of both
// "is this segment straight" and "is this segment actually going somewhere
// rather than jittering in place" — a segment with a low ratio fails either
// way, which is exactly what should disqualify it as a stable run.
export const SEGMENT_STRAIGHTNESS_MIN_RATIO = 0.92;
// Heading must pivot by an angle in [MIN, MAX] between the incoming and
// outgoing segment to count as a corner. MIN is the brief's suggested
// default. MAX excludes headings within ~15° of an exact reversal — an
// out-and-back retrace along the same line is handled by the separate
// reversal/vibrato detector below, not as a "very sharp corner."
export const CORNER_ANGLE_MIN_DEG = 70;
export const CORNER_ANGLE_MAX_DEG = 165;
// After a corner confirms, the next candidate pivot must be at least this
// much further along the path — i.e. a fresh stable direction must actually
// establish itself — before another corner can fire.
export const CORNER_REARM_DISTANCE_PX = SEGMENT_LENGTH_PX;
export const CHORD_CHANGE_COOLDOWN_MS = 150;

export const SPEED_SMOOTHING_MS = 80;
export const MAX_INSTANTANEOUS_SPEED_PX_S = 4000;
export const MIN_REVERSAL_PX = 6;
export const VIBRATO_RATE_WINDOW_MS = 700;
export const VIBRATO_BUMP = 0.32;
export const VIBRATO_DECAY_MS = 260;

export type GestureFrame = {
  speed: number;
  chordChangeTriggered: boolean;
  vibratoIntensity: number;
};

type PathPoint = { t: number; x: number; y: number; cumDist: number };

// Axis angle: a direction folded mod 180°, so a line and its exact reverse
// share one value. Used only for the reversal/vibrato baseline, where "which
// line is the hand working along" matters more than which way along it.
function toAxisAngleDegrees(dx: number, dy: number): number {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360 % 180;
}

// True heading, 0-360°, NOT folded — corner strength needs to tell a sharp
// V (heading changes ~150°) apart from a gentle bend (heading changes ~20°),
// which the folded axis angle cannot do (it maps both a 90° turn and a
// perfect reversal onto the same small range near its fold point).
function headingDegrees(dx: number, dy: number): number {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

function headingDifference(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

export class GestureAnalyzer {
  private points: PathPoint[] = [];
  private totalDist = 0;
  private activeAxis: number | null = null;
  private lastConfirmedPivotDist = -Infinity;
  // Guards against a stale cooldown outliving the gesture it was set during
  // and suppressing the first corner of an unrelated later gesture — see
  // reset() below.
  private lastChangeAt = -Infinity;
  private axisSign = 0;
  private reversalTimes: number[] = [];
  private vibratoIntensity = 0;
  private smoothedSpeed = 0;
  private prev: { t: number; x: number; y: number } | null = null;

  addSample(t: number, x: number, y: number): GestureFrame {
    let chordChangeTriggered = false;

    if (this.prev) {
      const dt = t - this.prev.t;
      if (dt > 0) {
        const dx = x - this.prev.x;
        const dy = y - this.prev.y;
        const distance = Math.hypot(dx, dy);
        const instantaneousSpeed = Math.min(distance / (dt / 1000), MAX_INSTANTANEOUS_SPEED_PX_S);
        const alpha = 1 - Math.exp(-dt / SPEED_SMOOTHING_MS);
        this.smoothedSpeed += (instantaneousSpeed - this.smoothedSpeed) * alpha;
        this.decayVibrato(dt);

        if (distance >= NOISE_DISTANCE_PX) {
          this.totalDist += distance;
          this.points.push({ t, x, y, cumDist: this.totalDist });
          this.trimPoints();
          chordChangeTriggered = this.detectCorner(t);
          this.processReversal(t, dx, dy);
        }
      }
    }

    this.prev = { t, x, y };
    return { speed: this.smoothedSpeed, chordChangeTriggered, vibratoIntensity: this.vibratoIntensity };
  }

  reset(): void {
    this.points = [];
    this.totalDist = 0;
    this.activeAxis = null;
    this.lastConfirmedPivotDist = -Infinity;
    this.lastChangeAt = -Infinity;
    this.axisSign = 0;
    this.reversalTimes = [];
    this.vibratoIntensity = 0;
    this.smoothedSpeed = 0;
    this.prev = null;
  }

  private detectCorner(t: number): boolean {
    const end = this.points[this.points.length - 1];

    if (this.activeAxis === null && this.points.length >= 2) {
      const prevPoint = this.points[this.points.length - 2];
      this.activeAxis = toAxisAngleDegrees(end.x - prevPoint.x, end.y - prevPoint.y);
    }

    const pivot = this.findAtOrBefore(end.cumDist - SEGMENT_LENGTH_PX);
    if (!pivot) return false;
    const incomingStart = this.findAtOrBefore(pivot.cumDist - SEGMENT_LENGTH_PX);
    if (!incomingStart) return false;

    if (!this.isStableSegment(incomingStart, pivot)) return false;
    if (!this.isStableSegment(pivot, end)) return false;

    const incomingHeading = headingDegrees(pivot.x - incomingStart.x, pivot.y - incomingStart.y);
    const outgoingHeading = headingDegrees(end.x - pivot.x, end.y - pivot.y);
    const turnAngle = headingDifference(incomingHeading, outgoingHeading);

    if (turnAngle < CORNER_ANGLE_MIN_DEG || turnAngle > CORNER_ANGLE_MAX_DEG) return false;
    if (pivot.cumDist - this.lastConfirmedPivotDist < CORNER_REARM_DISTANCE_PX) return false;
    if (t - this.lastChangeAt < CHORD_CHANGE_COOLDOWN_MS) return false;

    this.activeAxis = outgoingHeading % 180;
    this.lastConfirmedPivotDist = pivot.cumDist;
    this.lastChangeAt = t;
    this.axisSign = 0;
    this.reversalTimes = [];
    return true;
  }

  private isStableSegment(start: PathPoint, end: PathPoint): boolean {
    const span = end.cumDist - start.cumDist;
    if (span <= 0) return false;
    const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
    return chordLength / span >= SEGMENT_STRAIGHTNESS_MIN_RATIO;
  }

  private findAtOrBefore(cumDist: number): PathPoint | null {
    let result: PathPoint | null = null;
    for (const p of this.points) {
      if (p.cumDist <= cumDist) result = p;
      else break;
    }
    return result;
  }

  private trimPoints(): void {
    const cutoff = this.totalDist - SEGMENT_LENGTH_PX * 3;
    while (this.points.length > 1 && this.points[0].cumDist < cutoff) {
      this.points.shift();
    }
  }

  private processReversal(t: number, dx: number, dy: number): void {
    if (this.activeAxis === null) return;
    const radians = (this.activeAxis * Math.PI) / 180;
    const axisDx = Math.cos(radians);
    const axisDy = Math.sin(radians);
    const projection = dx * axisDx + dy * axisDy;
    if (Math.abs(projection) < MIN_REVERSAL_PX) return;

    const sign = projection > 0 ? 1 : -1;
    if (this.axisSign !== 0 && sign !== this.axisSign) {
      this.reversalTimes.push(t);
      this.reversalTimes = this.reversalTimes.filter((rt) => t - rt <= VIBRATO_RATE_WINDOW_MS);
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
