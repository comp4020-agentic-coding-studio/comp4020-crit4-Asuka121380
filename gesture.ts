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
//
// A second axis of confusion, separate from "is this a corner at all," is
// "is this a corner or a same-axis reversal" (vibrato/scrubbing). A pointer
// drawn back and forth along one line reverses heading by ~180°, which is a
// *larger* raw heading change than most real corners — so heading magnitude
// alone cannot tell the two apart. The incoming and outgoing segments' chords
// are also compared as *undirected axes* (mod 180°): a reversal keeps the
// same axis, a real corner changes it. That axis check is evaluated before
// the corner-angle-range check below, per spec, so a near-180° reversal can
// never fall through to being scored as "just a very sharp corner."

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
// outgoing segment to count as an unambiguous corner. MIN is the brief's
// suggested default. MAX is deliberately tighter than "anything short of an
// exact reversal": angles above it are treated as ambiguous (see
// AXIS_REVERSAL_MAX_DEG and the vibrato tiebreaker in detectCorner) rather
// than automatically scored as a very sharp corner.
export const CORNER_ANGLE_MIN_DEG = 70;
export const CORNER_ANGLE_MAX_DEG = 135;
// The incoming/outgoing segments' UNDIRECTED axes (heading folded mod 180°)
// must differ by more than this for a candidate to be a genuine corner. An
// axis difference at or below this means the two segments are, within
// tolerance, the same line traveled in opposite directions — i.e. a
// same-axis reversal, not a corner, however large the *directed* heading
// swing looks. This is evaluated before the angle-range check above, so a
// near-180° reversal can never be scored as a sharp corner first. The value
// is deliberately generous (comfortably wider than the brief's 15-20°
// starting suggestion) because real hand-drawn reversals rarely retrace
// their own line to within better than ~20-25°.
export const AXIS_REVERSAL_MAX_DEG = 28;
// Between CORNER_ANGLE_MAX_DEG and an exact reversal sits a genuinely
// ambiguous band: a sharp isolated corner and an imprecisely-retraced
// same-axis reversal can look identical from local two-segment geometry
// alone. In that band only, whether there has been recent same-axis
// oscillation (the existing fine-grained vibrato detector, unchanged) breaks
// the tie: no recent oscillation reads as a genuine sharp corner; recent
// oscillation reads as continued scrubbing. See detectCorner() and
// PROCESS.md for the full reasoning and the deliberate trade-off this
// creates.
export const VIBRATO_AMBIGUOUS_MAX_INTENSITY = 0.15;
// After a corner confirms, the next candidate pivot must be at least this
// much further along the path — i.e. a fresh stable direction must actually
// establish itself — before another corner can fire. This is the primary
// rearm guard; CHORD_CHANGE_COOLDOWN_MS below is a secondary, short
// real-time guard only, never the sole mechanism (a fast re-traversal of a
// tiny loop should not be able to rearm on elapsed time alone).
export const CORNER_REARM_DISTANCE_PX = SEGMENT_LENGTH_PX;
export const CHORD_CHANGE_COOLDOWN_MS = 150;

// Curve/jitter discrimination (diagnostic labeling only — never gates
// whether a corner fires). A window is split into this many equal-distance
// sub-chords; consecutive sub-chord headings that keep turning the same way
// read as a genuine gradual curve, while a sign flip reads as jitter. See
// isMonotonicDrift() for why raw heading variance can't do this job.
export const DRIFT_CHUNK_COUNT = 4;
// Signed heading deltas between sub-chords smaller than this are treated as
// sampling noise, not a real rotation, when checking sign-consistency.
export const DRIFT_NOISE_FLOOR_DEG = 1.5;

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

// Explicit gesture states for the corner/curve/reversal classifier. This is
// a labeling of the branches inside detectCorner(), not a separate control
// flow — every addSample() still runs the same distance-windowed geometric
// core, but the phase a given call landed in is now a first-class,
// inspectable value (see getDiagnostics()) instead of being implicit in
// which `return false` fired.
export type GesturePhase =
  | "collectingIncomingSegment"
  | "candidateTurn"
  | "confirmingOutgoingSegment"
  | "cornerTriggered"
  | "stableAfterCorner";

export type ClassificationReason = "corner" | "curve" | "axis-reversal" | "jitter" | "insufficient-data";

export type GestureDiagnostics = {
  phase: GesturePhase;
  reason: ClassificationReason;
  triggered: boolean;
  detail: string;
  incomingHeadingDeg: number | null;
  outgoingHeadingDeg: number | null;
  headingDifferenceDeg: number | null;
  axisDifferenceDeg: number | null;
  incomingSegmentLengthPx: number | null;
  outgoingSegmentLengthPx: number | null;
  directionalVarianceDeg: number | null;
};

type PathPoint = { t: number; x: number; y: number; cumDist: number };

// Axis angle: a direction folded mod 180°, so a line and its exact reverse
// share one value. Used for two, and only two, purposes: (1) the reversal/
// vibrato baseline below, where "which line is the hand working along"
// matters more than which way along it, and (2) the corner-vs-reversal axis
// check in detectCorner(). It must NEVER be used to score corner sharpness
// (a sharp near-reversal V would fold close to 0° and a plain right angle
// would fold to its maximum — backwards from "how sudden is this turn").
// headingDegrees()/headingDifference() below are the unfolded pair that
// exists specifically so corner strength never touches this fold.
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

// Undirected difference between two already-folded (mod 180°) axis angles,
// clamped to [0, 90]. 0 means the two segments lie on the same line; 90
// means they are perpendicular.
function axisDifference(axisA: number, axisB: number): number {
  const diff = Math.abs(axisA - axisB) % 180;
  return Math.min(diff, 180 - diff);
}

// Signed rotation from heading a to heading b, in (-180, 180]. Unlike
// headingDifference() (unsigned magnitude), this preserves which way the
// heading turned — needed to tell a systematic drift (a curve, where
// successive sub-chords keep turning the same way) apart from jitter (where
// they wobble back and forth), since the two can have the *same* magnitude
// of local heading deviation (see isMonotonicDrift below).
function signedHeadingDelta(a: number, b: number): number {
  return (((b - a + 180) % 360) + 360) % 360 - 180;
}

const NO_DIAGNOSTICS: GestureDiagnostics = {
  phase: "collectingIncomingSegment",
  reason: "insufficient-data",
  triggered: false,
  detail: "no samples yet",
  incomingHeadingDeg: null,
  outgoingHeadingDeg: null,
  headingDifferenceDeg: null,
  axisDifferenceDeg: null,
  incomingSegmentLengthPx: null,
  outgoingSegmentLengthPx: null,
  directionalVarianceDeg: null,
};

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
  private diagnostics: GestureDiagnostics = NO_DIAGNOSTICS;

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
    this.diagnostics = NO_DIAGNOSTICS;
  }

  // Structured, always-available snapshot of the most recent classification
  // decision (see ClassificationReason/GesturePhase above). Kept available
  // in all builds for testability; only the console.debug narration below
  // is gated behind import.meta.env.DEV.
  getDiagnostics(): GestureDiagnostics {
    return this.diagnostics;
  }

  // Interpolates the exact point on the recorded path at a given cumulative
  // distance, linearly blending the two bracketing raw samples. This is
  // what makes segment boundaries distance-uniform rather than "whichever
  // raw sample happened to land near this distance" — the latter snaps to
  // different physical points depending on how far apart pointer events
  // were emitted, which is exactly the speed/device-frequency dependency
  // the brief calls out. Returns null when there isn't yet a raw sample on
  // both sides of the target distance (i.e. not enough data).
  private interpolateAtDistance(targetCumDist: number): { x: number; y: number; t: number; cumDist: number } | null {
    if (targetCumDist < 0) return null;
    let prev: PathPoint | null = null;
    for (const p of this.points) {
      if (p.cumDist >= targetCumDist) {
        if (!prev) return null;
        const span = p.cumDist - prev.cumDist;
        const frac = span > 0 ? (targetCumDist - prev.cumDist) / span : 0;
        return {
          x: prev.x + (p.x - prev.x) * frac,
          y: prev.y + (p.y - prev.y) * frac,
          t: prev.t + (p.t - prev.t) * frac,
          cumDist: targetCumDist,
        };
      }
      prev = p;
    }
    return null;
  }

  private detectCorner(t: number): boolean {
    if (this.activeAxis === null && this.points.length >= 2) {
      const end = this.points[this.points.length - 1];
      const prevPoint = this.points[this.points.length - 2];
      this.activeAxis = toAxisAngleDegrees(end.x - prevPoint.x, end.y - prevPoint.y);
    }

    // Both segment boundaries, and the current sample, are pinned to exact
    // multiples of SEGMENT_LENGTH_PX of travel via interpolation — so the
    // incoming and outgoing chords are always evaluated over the same
    // physical distance, regardless of how many raw pointer events arrived
    // along the way or how fast the pointer was moving.
    const pivotTarget = this.totalDist - SEGMENT_LENGTH_PX;
    const pivot = this.interpolateAtDistance(pivotTarget);
    if (!pivot) {
      this.diagnostics = { ...NO_DIAGNOSTICS, phase: "collectingIncomingSegment", detail: "not enough travel yet for an incoming segment" };
      return false;
    }
    const incomingStart = this.interpolateAtDistance(pivot.cumDist - SEGMENT_LENGTH_PX);
    if (!incomingStart) {
      this.diagnostics = { ...NO_DIAGNOSTICS, phase: "collectingIncomingSegment", detail: "not enough travel yet before the candidate pivot" };
      return false;
    }
    const end = { x: this.points[this.points.length - 1].x, y: this.points[this.points.length - 1].y, cumDist: this.totalDist };

    const incomingLength = pivot.cumDist - incomingStart.cumDist;
    const outgoingLength = end.cumDist - pivot.cumDist;
    const incomingStable = this.isStableSegment(incomingStart, pivot);
    const outgoingStable = this.isStableSegment(pivot, end);

    if (!incomingStable) {
      const ratio = this.segmentRatio(incomingStart, pivot);
      this.diagnostics = {
        ...NO_DIAGNOSTICS,
        phase: "collectingIncomingSegment",
        reason: this.isMonotonicDrift(incomingStart, pivot) ? "curve" : "jitter",
        detail: `incoming segment straightness ratio ${ratio.toFixed(2)} below ${SEGMENT_STRAIGHTNESS_MIN_RATIO}`,
        incomingSegmentLengthPx: incomingLength,
        outgoingSegmentLengthPx: outgoingLength,
      };
      return false;
    }
    if (!outgoingStable) {
      const ratio = this.segmentRatio(pivot, end);
      this.diagnostics = {
        ...NO_DIAGNOSTICS,
        phase: "confirmingOutgoingSegment",
        reason: this.isMonotonicDrift(pivot, end) ? "curve" : "jitter",
        detail: `outgoing segment straightness ratio ${ratio.toFixed(2)} below ${SEGMENT_STRAIGHTNESS_MIN_RATIO}`,
        incomingSegmentLengthPx: incomingLength,
        outgoingSegmentLengthPx: outgoingLength,
      };
      return false;
    }

    const incomingHeading = headingDegrees(pivot.x - incomingStart.x, pivot.y - incomingStart.y);
    const outgoingHeading = headingDegrees(end.x - pivot.x, end.y - pivot.y);
    const turnAngle = headingDifference(incomingHeading, outgoingHeading);
    const incomingAxis = toAxisAngleDegrees(pivot.x - incomingStart.x, pivot.y - incomingStart.y);
    const outgoingAxis = toAxisAngleDegrees(end.x - pivot.x, end.y - pivot.y);
    const axisDiff = axisDifference(incomingAxis, outgoingAxis);
    const variance = this.directionalVariance(incomingStart, end);

    const baseDiagnostics = {
      incomingHeadingDeg: incomingHeading,
      outgoingHeadingDeg: outgoingHeading,
      headingDifferenceDeg: turnAngle,
      axisDifferenceDeg: axisDiff,
      incomingSegmentLengthPx: incomingLength,
      outgoingSegmentLengthPx: outgoingLength,
      directionalVarianceDeg: variance,
    };

    if (turnAngle < CORNER_ANGLE_MIN_DEG) {
      const isCurve = this.isMonotonicDrift(incomingStart, end);
      this.diagnostics = {
        ...baseDiagnostics,
        phase: "collectingIncomingSegment",
        reason: isCurve ? "curve" : "jitter",
        triggered: false,
        detail: isCurve
          ? `heading change ${turnAngle.toFixed(1)}° below CORNER_ANGLE_MIN_DEG=${CORNER_ANGLE_MIN_DEG} but rotating steadily in one direction — smooth curve, not a corner`
          : `heading change ${turnAngle.toFixed(1)}° below CORNER_ANGLE_MIN_DEG=${CORNER_ANGLE_MIN_DEG} — continuing straight`,
      };
      return false;
    }

    // Same-axis exception, evaluated before the corner-angle-range check:
    // a candidate this collinear is a reversal regardless of how large the
    // directed heading swing looks.
    if (axisDiff <= AXIS_REVERSAL_MAX_DEG) {
      this.diagnostics = {
        ...baseDiagnostics,
        phase: "collectingIncomingSegment",
        reason: "axis-reversal",
        triggered: false,
        detail: `axis difference ${axisDiff.toFixed(1)}° at/under AXIS_REVERSAL_MAX_DEG=${AXIS_REVERSAL_MAX_DEG} — same-line reversal, not a corner`,
      };
      return false;
    }

    if (turnAngle > CORNER_ANGLE_MAX_DEG) {
      // Ambiguous band: axis difference alone did not classify this as an
      // obvious reversal, but the directed turn is also past the
      // unambiguous corner ceiling. Recent same-axis oscillation (from the
      // existing, unchanged fine-grained reversal/vibrato detector) is the
      // tiebreaker: a corner that arrives with no recent back-and-forth is
      // read as genuine; one arriving mid-oscillation is read as more of
      // the same scrubbing.
      if (this.vibratoIntensity >= VIBRATO_AMBIGUOUS_MAX_INTENSITY) {
        this.diagnostics = {
          ...baseDiagnostics,
          phase: "collectingIncomingSegment",
          reason: "axis-reversal",
          triggered: false,
          detail: `heading change ${turnAngle.toFixed(1)}° is in the ambiguous band above CORNER_ANGLE_MAX_DEG=${CORNER_ANGLE_MAX_DEG}, and recent vibrato intensity ${this.vibratoIntensity.toFixed(2)} indicates ongoing oscillation`,
        };
        return false;
      }
      // else: no recent oscillation — fall through and treat as a genuine,
      // if sharp, corner.
    }

    if (pivot.cumDist - this.lastConfirmedPivotDist < CORNER_REARM_DISTANCE_PX) {
      this.diagnostics = {
        ...baseDiagnostics,
        phase: "stableAfterCorner",
        reason: "corner",
        triggered: false,
        detail: "candidate corner geometry confirmed, but rearm distance since the last corner has not yet elapsed",
      };
      return false;
    }
    if (t - this.lastChangeAt < CHORD_CHANGE_COOLDOWN_MS) {
      this.diagnostics = {
        ...baseDiagnostics,
        phase: "stableAfterCorner",
        reason: "corner",
        triggered: false,
        detail: "candidate corner geometry confirmed, but within CHORD_CHANGE_COOLDOWN_MS of the last change",
      };
      return false;
    }

    this.activeAxis = outgoingHeading % 180;
    this.lastConfirmedPivotDist = pivot.cumDist;
    this.lastChangeAt = t;
    this.axisSign = 0;
    this.reversalTimes = [];
    this.diagnostics = {
      ...baseDiagnostics,
      phase: "cornerTriggered",
      reason: "corner",
      triggered: true,
      detail: `heading change ${turnAngle.toFixed(1)}° with axis difference ${axisDiff.toFixed(1)}° confirmed as a corner`,
    };

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug(
        `[gesture] corner turnAngle=${turnAngle.toFixed(1)} axisDiff=${axisDiff.toFixed(1)} in=${incomingLength.toFixed(0)}px out=${outgoingLength.toFixed(0)}px variance=${variance.toFixed(1)}`,
      );
    }
    return true;
  }

  private isStableSegment(start: { x: number; y: number; cumDist: number }, end: { x: number; y: number; cumDist: number }): boolean {
    return this.segmentRatio(start, end) >= SEGMENT_STRAIGHTNESS_MIN_RATIO;
  }

  // Distinguishes a genuine gradual curve from jitter/noise when the window
  // as a whole doesn't read as a corner. Raw heading variance can't do this:
  // an empirical trace showed a large gentle arc holding a *lower* RMS
  // per-step heading deviation (~6°) than a genuinely jittery straight line
  // (~17-20°) — jitter's per-step swings are bigger but uncorrelated, while a
  // curve's are small but systematic. What actually separates them is
  // whether the heading keeps rotating the *same way*: split the window into
  // a few equal-distance sub-chords and check the signed heading delta
  // between consecutive sub-chords never flips sign (ignoring deltas too
  // small to be more than sampling noise).
  private isMonotonicDrift(start: { x: number; y: number; cumDist: number }, end: { x: number; y: number; cumDist: number }): boolean {
    const span = end.cumDist - start.cumDist;
    const chunkLen = span / DRIFT_CHUNK_COUNT;
    if (chunkLen <= 0) return false;
    const boundaries: Array<{ x: number; y: number; cumDist: number }> = [start];
    for (let i = 1; i < DRIFT_CHUNK_COUNT; i++) {
      const p = this.interpolateAtDistance(start.cumDist + chunkLen * i);
      if (!p) return false;
      boundaries.push(p);
    }
    boundaries.push(end);

    const headings: number[] = [];
    for (let i = 1; i < boundaries.length; i++) {
      const a = boundaries[i - 1];
      const b = boundaries[i];
      if (a.x === b.x && a.y === b.y) return false;
      headings.push(headingDegrees(b.x - a.x, b.y - a.y));
    }

    let sign = 0;
    for (let i = 1; i < headings.length; i++) {
      const delta = signedHeadingDelta(headings[i - 1], headings[i]);
      if (Math.abs(delta) < DRIFT_NOISE_FLOOR_DEG) continue;
      const stepSign = delta > 0 ? 1 : -1;
      if (sign === 0) {
        sign = stepSign;
      } else if (stepSign !== sign) {
        return false;
      }
    }
    return sign !== 0;
  }

  private segmentRatio(start: { x: number; y: number; cumDist: number }, end: { x: number; y: number; cumDist: number }): number {
    const span = end.cumDist - start.cumDist;
    if (span <= 0) return 0;
    const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
    return chordLength / span;
  }

  // RMS deviation, in degrees, of each raw step's heading from the overall
  // chord heading across [start, end]. Purely a diagnostic label (jitter vs.
  // curve) — it never gates classification, only explains it.
  private directionalVariance(start: { x: number; y: number; cumDist: number }, end: { x: number; cumDist: number }): number {
    const chordHeading = headingDegrees(this.points[this.points.length - 1].x - start.x, this.points[this.points.length - 1].y - start.y);
    const steps = this.points.filter((p) => p.cumDist >= start.cumDist && p.cumDist <= end.cumDist);
    if (steps.length < 2) return 0;
    let sumSq = 0;
    let count = 0;
    for (let i = 1; i < steps.length; i++) {
      const dx = steps[i].x - steps[i - 1].x;
      const dy = steps[i].y - steps[i - 1].y;
      if (dx === 0 && dy === 0) continue;
      const stepHeading = headingDegrees(dx, dy);
      const deviation = headingDifference(stepHeading, chordHeading);
      sumSq += deviation * deviation;
      count++;
    }
    return count > 0 ? Math.sqrt(sumSq / count) : 0;
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
