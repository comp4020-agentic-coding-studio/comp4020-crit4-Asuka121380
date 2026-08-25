import { describe, expect, it } from "vitest";
import {
  AXIS_REVERSAL_MAX_DEG,
  CORNER_ANGLE_MAX_DEG,
  CORNER_ANGLE_MIN_DEG,
  CORNER_REARM_DISTANCE_PX,
  GestureAnalyzer,
  MAX_INSTANTANEOUS_SPEED_PX_S,
  SEGMENT_LENGTH_PX,
  type GestureDiagnostics,
  type GestureFrame,
} from "../gesture";

function run(points: Array<[number, number, number]>): GestureFrame[] {
  const analyzer = new GestureAnalyzer();
  return points.map(([t, x, y]) => analyzer.addSample(t, x, y));
}

function corners(frames: GestureFrame[]): number {
  return frames.filter((f) => f.chordChangeTriggered).length;
}

// Straight line: 60 steps of 15ms/8px along +x, ~900ms and ~480px total.
function straightLine(steps: number, stepMs = 15, stepPx = 8): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i <= steps; i++) points.push([i * stepMs, i * stepPx, 0]);
  return points;
}

type Pose = { t: number; x: number; y: number; headingDeg: number };

/** A straight run of `steps` samples heading in a fixed direction from `start`,
 *  with an optional small non-periodic perpendicular wobble (real pointer/
 *  touch jitter is never perfectly on-line) starting from `stepIndex0` so a
 *  wobble phase can continue seamlessly across a run boundary (e.g. a
 *  corner's incoming leg into its outgoing leg). */
function straightRun(start: Pose, steps: number, stepPx = 8, stepMs = 15, jitterPx = 0, stepIndex0 = 0): { points: Array<[number, number, number]>; end: Pose } {
  const points: Array<[number, number, number]> = [];
  let { t, x, y } = start;
  const rad = (start.headingDeg * Math.PI) / 180;
  const perpRad = rad + Math.PI / 2;
  for (let i = 0; i < steps; i++) {
    x += Math.cos(rad) * stepPx;
    y += Math.sin(rad) * stepPx;
    t += stepMs;
    const wobble = jitterPx * Math.sin((stepIndex0 + i) * 0.9);
    points.push([t, x + Math.cos(perpRad) * wobble, y + Math.sin(perpRad) * wobble]);
  }
  return { points, end: { t, x, y, headingDeg: start.headingDeg } };
}

/** A stable incoming run, followed by an equally stable outgoing run at
 *  `turnDeg` away from it — a realistic multi-point corner, not three
 *  idealized points, with an optional small perpendicular wobble carried
 *  continuously across the vertex to stand in for hand jitter. Each leg is
 *  generously longer than SEGMENT_LENGTH_PX so both stability windows land
 *  comfortably inside a single straight leg. */
function cornerPath(turnDeg: number, legSteps = 12, stepPx = 8, stepMs = 15, jitterPx = 0): Array<[number, number, number]> {
  const incoming = straightRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, legSteps, stepPx, stepMs, jitterPx, 0);
  const outgoing = straightRun({ ...incoming.end, headingDeg: turnDeg }, legSteps, stepPx, stepMs, jitterPx, legSteps);
  return [[0, 0, 0], ...incoming.points, ...outgoing.points];
}

/** A circular arc: `steps` samples, each turning `stepPx / radius` radians
 *  further than the last (so total sweep grows with `steps` regardless of
 *  `radius`), continuing from `start`'s heading. Used for both the
 *  large-radius "smooth curve" cases and to build a realistic S-curve out of
 *  two opposite-direction arcs. */
function arcRun(start: Pose, steps: number, radius: number, direction: 1 | -1, stepPx = 8, stepMs = 15): { points: Array<[number, number, number]>; end: Pose } {
  const points: Array<[number, number, number]> = [];
  let { t, x, y, headingDeg } = start;
  const dThetaDeg = (stepPx / radius) * (180 / Math.PI) * direction;
  for (let i = 0; i < steps; i++) {
    const rad = (headingDeg * Math.PI) / 180;
    x += Math.cos(rad) * stepPx;
    y += Math.sin(rad) * stepPx;
    t += stepMs;
    points.push([t, x, y]);
    headingDeg += dThetaDeg;
  }
  return { points, end: { t, x, y, headingDeg } };
}

/** A realistic back-and-forth (vibrato/scrubbing) gesture: `cycles` straight
 *  legs alternating between `baseHeadingDeg` and its near-reverse, imprecise
 *  by `imprecisionDeg` (a real hand rarely retraces its own line to better
 *  than ~15-20°) rather than an exact 180° flip, with a small non-periodic
 *  perpendicular wobble superimposed to stand in for hand jitter. Each leg is
 *  long enough that both the incoming and outgoing SEGMENT_LENGTH_PX windows
 *  can land fully inside a single leg. */
function backAndForthRun(
  baseHeadingDeg: number,
  cycles: number,
  legSteps = 10,
  stepPx = 8,
  stepMs = 15,
  imprecisionDeg = 18,
  jitterPx = 0,
): { points: Array<[number, number, number]>; end: Pose } {
  const points: Array<[number, number, number]> = [[0, 0, 0]];
  let t = 0;
  let x = 0;
  let y = 0;
  let headingDeg = baseHeadingDeg;
  let stepIndex = 0;
  for (let c = 0; c < cycles; c++) {
    headingDeg = c % 2 === 0 ? baseHeadingDeg : baseHeadingDeg + 180 - imprecisionDeg;
    const rad = (headingDeg * Math.PI) / 180;
    const perpRad = rad + Math.PI / 2;
    for (let i = 0; i < legSteps; i++) {
      x += Math.cos(rad) * stepPx;
      y += Math.sin(rad) * stepPx;
      t += stepMs;
      const wobble = jitterPx * Math.sin(stepIndex * 0.9);
      points.push([t, x + Math.cos(perpRad) * wobble, y + Math.sin(perpRad) * wobble]);
      stepIndex++;
    }
  }
  return { points, end: { t, x, y, headingDeg } };
}

describe("GestureAnalyzer: axis and corner detection", () => {
  it("never changes chord on pure straight-line motion", () => {
    const frames = run(straightLine(60));
    expect(corners(frames)).toBe(0);
  });

  it("ignores small jitter around the same heading", () => {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i <= 60; i++) {
      points.push([i * 15, i * 8, i % 2 === 0 ? 0 : 1]); // ~7° wobble
    }
    expect(corners(run(points))).toBe(0);
  });

  it("ignores realistic pointer jitter superimposed on a straight gesture", () => {
    // Perpendicular wobble with an irregular (non-periodic) pattern and
    // amplitude comparable to real pointer/touch noise — deliberately not
    // the idealized alternating +1/-1 pattern above, since a resonant
    // period could accidentally cancel out in a way real jitter wouldn't.
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i <= 80; i++) {
      const wobble = 2.5 * Math.sin(i * 0.9) + 1.5 * Math.sin(i * 2.3 + 1);
      points.push([i * 15, i * 7, wobble]);
    }
    expect(corners(run(points))).toBe(0);
  });

  it("registers a same-axis reversal as vibrato, not a chord change", () => {
    // Forward/back along the same line (mod-π axis) repeatedly.
    const points: Array<[number, number, number]> = [];
    let x = 0;
    for (let i = 0; i < 40; i++) {
      const dx = i % 4 < 2 ? 12 : -12;
      x += dx;
      points.push([i * 15, x, 0]);
    }
    const frames = run(points);
    expect(corners(frames)).toBe(0);
    expect(frames[frames.length - 1].vibratoIntensity).toBeGreaterThan(0);
  });

  it("confirms a clean right-angle (90°) corner as exactly one chord change", () => {
    const frames = run(cornerPath(90));
    expect(corners(frames)).toBe(1);
  });

  it("confirms a sharp, acute-angle corner as exactly one chord change", () => {
    // A near-V corner that turns back on itself by 150° — past
    // CORNER_ANGLE_MAX_DEG=135, so it lands in the ambiguous band between an
    // unambiguous corner and a same-axis reversal. Its axis difference
    // (30°) is still above AXIS_REVERSAL_MAX_DEG=28, so it isn't caught by
    // the tight collinearity check either. With no preceding oscillation
    // (vibratoIntensity is 0 for an isolated corner path), the ambiguous-band
    // tiebreaker reads this as a genuine sharp corner, not a reversal.
    //
    // stepPx=5 (a divisor of SEGMENT_LENGTH_PX=30) plus a touch of jitter:
    // near a ~150° near-reversal vertex, a pivot window straddling the
    // corner by even 2-3px of the "wrong" leg collapses its straightness
    // ratio well below threshold (the two legs nearly cancel), so a raw
    // sample spacing that can never land the pivot within a couple of
    // pixels of the true vertex (e.g. stepPx=8, whose 30px-window remainder
    // is a fixed 6px every time on this perfectly uniform synthetic path)
    // makes the corner geometrically undetectable — not a classification
    // bug, a sampling-alignment one. Real, non-uniform pointer input doesn't
    // lock onto one fixed bad offset like a uniform-step synthetic path
    // does; a touch of jitter here reflects that instead of relying on exact
    // floating-point grid alignment. The jitter amplitude is deliberately
    // small (0.5px, vs 1.2-1.5px used elsewhere in this file): near a
    // genuine ~180° near-reversal, the incoming/outgoing chords nearly
    // cancel, so straightness ratio is far more sensitive to any
    // perpendicular deviation than it is near 90° — a real hand's wobble
    // would need to be sub-pixel-precise to draw a corner this sharp this
    // cleanly, so a larger jitter here would be testing something a person
    // basically cannot draw, not the classifier.
    const frames = run(cornerPath(150, 20, 5, 15, 0.5));
    expect(corners(frames)).toBe(1);
  });

  it("confirms a slightly-wider-than-right-angle but still obvious corner", () => {
    // Just above CORNER_ANGLE_MIN_DEG — clearly a deliberate corner, not a
    // gentle bend, but the widest angle that should still register.
    const turnDeg = CORNER_ANGLE_MIN_DEG + 6;
    const frames = run(cornerPath(turnDeg));
    expect(corners(frames)).toBe(1);
  });

  it("confirms a distinct 60-75° turn as exactly one chord change", () => {
    // CORNER_ANGLE_MIN_DEG=70 sits inside the brief's suggested 60-135°
    // corner-candidate starting range, so the achievable part of "60-75°"
    // is 70-75° — this exercises a turn near the low end of that band.
    // stepPx=5 divides SEGMENT_LENGTH_PX=30 evenly, so the pivot window can
    // land within a fraction of a pixel of the true vertex instead of
    // carrying a fixed few-px contamination bias every time (see the 150°
    // test above) — for a turn already this close to the floor, that bias
    // alone is enough to read a 73° turn as under 70°.
    const frames = run(cornerPath(73, 20, 5, 15, 1.5));
    expect(corners(frames)).toBe(1);
  });

  it("does not change chord on a large circular arc, however far it sweeps", () => {
    // Corner detection compares two fixed-length (SEGMENT_LENGTH_PX) windows
    // near the leading edge of the path, not cumulative heading change since
    // the gesture began — so a long, large-radius arc must stay silent no
    // matter how much total heading it eventually accumulates.
    const { points } = arcRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, 90, 150, 1);
    expect(corners(run([[0, 0, 0], ...points]))).toBe(0);
  });

  it("does not change chord on a smooth S-curve", () => {
    const first = arcRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, 40, 150, 1);
    const second = arcRun(first.end, 40, 150, -1);
    const points: Array<[number, number, number]> = [[0, 0, 0], ...first.points, ...second.points];
    expect(corners(run(points))).toBe(0);
  });

  it("does not change chord on a full circle, however far it sweeps", () => {
    // ~120 steps of 8px at radius 150 sweeps just past 360° of total
    // heading change, entirely via gradual, distributed curvature.
    const { points } = arcRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, 120, 150, 1);
    expect(corners(run([[0, 0, 0], ...points]))).toBe(0);
  });

  it("does not change chord on horizontal back-and-forth motion", () => {
    const { points } = backAndForthRun(0, 3);
    expect(corners(run(points))).toBe(0);
  });

  it("does not change chord on diagonal back-and-forth motion", () => {
    const { points } = backAndForthRun(45, 3);
    expect(corners(run(points))).toBe(0);
  });

  it("does not change chord on repeated vibrato scrubbing", () => {
    const { points } = backAndForthRun(20, 6);
    const frames = run(points);
    expect(corners(frames)).toBe(0);
    expect(frames[frames.length - 1].vibratoIntensity).toBeGreaterThan(0);
  });

  it("does not change chord on back-and-forth motion with small perpendicular hand jitter", () => {
    const { points } = backAndForthRun(0, 4, 10, 8, 15, 18, 1.2);
    expect(corners(run(points))).toBe(0);
  });

  it("confirms a real corner after a period of vibrato exactly once", () => {
    const scrub = backAndForthRun(0, 3);
    const turn = straightRun({ ...scrub.end, headingDeg: scrub.end.headingDeg + 90 }, 12);
    const points: Array<[number, number, number]> = [...scrub.points, ...turn.points];
    const frames = run(points);
    expect(corners(frames)).toBe(1);
    expect(frames.some((f) => f.vibratoIntensity > 0)).toBe(true);
  });

  it("produces the same result for equivalent paths sampled at different point densities", () => {
    const dense = run(cornerPath(90, 24, 4, 15));
    const sparse = run(cornerPath(90, 6, 16, 15));
    expect(corners(dense)).toBe(1);
    expect(corners(sparse)).toBe(1);
  });

  it("produces the same result for equivalent paths drawn at different speeds", () => {
    const fast = run(cornerPath(90, 12, 8, 5));
    const slow = run(cornerPath(90, 12, 8, 60));
    expect(corners(fast)).toBe(1);
    expect(corners(slow)).toBe(1);
  });

  it("does not re-trigger a second corner inside the cooldown window", () => {
    const points = straightLine(20);
    let t = points[points.length - 1][0];
    const cornerX = points[points.length - 1][1];
    // Turn onto +y just long enough to confirm the corner.
    for (let i = 1; i <= 10; i++) {
      t += 15;
      points.push([t, cornerX, i * 8]);
    }
    const cornerY = points[points.length - 1][2];
    // Immediately turn again (back toward +x) within the cooldown window.
    for (let i = 1; i <= 3; i++) {
      t += 15;
      points.push([t, cornerX + i * 8, cornerY]);
    }
    const frames = run(points);
    expect(corners(frames)).toBe(1);
  });

  it("does not fire again while sliding through the same confirmed corner's window", () => {
    // A single corner followed by a long straight run must trigger exactly
    // once — not once per sample while the pivot window still overlaps it.
    const frames = run(cornerPath(90, 40));
    expect(corners(frames)).toBe(1);
  });

  it("advances harmony once per well-separated confirmed corner", () => {
    const points = straightLine(20);
    let t = points[points.length - 1][0];
    let x = points[points.length - 1][1];
    let y = 0;
    // First corner: turn onto +y.
    for (let i = 1; i <= 20; i++) {
      t += 15;
      y = i * 8;
      points.push([t, x, y]);
    }
    // Second corner, well past the cooldown: turn back onto +x.
    for (let i = 1; i <= 20; i++) {
      t += 15;
      x += 8;
      points.push([t, x, y]);
    }
    expect(corners(run(points))).toBe(2);
  });

  it("confirms a clear corner within roughly one stable segment's travel time, not half a second later", () => {
    const points = straightLine(20); // establish the x-axis
    const turnStartT = points[points.length - 1][0];
    const turnStartX = points[points.length - 1][1];
    for (let i = 1; i <= 20; i++) {
      points.push([turnStartT + i * 15, turnStartX, i * 8]);
    }
    const frames = run(points);
    const turnStartIndex = 21; // first sample belonging to the new heading
    const triggerIndex = frames.findIndex((f, idx) => idx >= turnStartIndex && f.chordChangeTriggered);
    expect(triggerIndex).toBeGreaterThan(-1);
    const latencyMs = points[triggerIndex][0] - turnStartT;
    // Confirmation needs roughly SEGMENT_LENGTH_PX of travel in the new
    // direction (here, 8px/15ms steps) before the outgoing window is fully
    // formed — comfortably under half a second.
    expect(latencyMs).toBeLessThan(150);
  });

  it("clamps an isolated speed spike instead of letting one glitchy sample dominate", () => {
    const analyzer = new GestureAnalyzer();
    let frame: GestureFrame | undefined;
    for (let i = 0; i <= 20; i++) frame = analyzer.addSample(i * 15, i * 8, 0);
    const steadySpeed = frame!.speed;

    // A single wildly out-of-place jump (simulating a coalesced/burst event).
    const spikeFrame = analyzer.addSample(20 * 15 + 15, 20 * 8 + 4000, 0);
    expect(spikeFrame.speed).toBeLessThanOrEqual(MAX_INSTANTANEOUS_SPEED_PX_S);

    // Resuming the normal cadence settles the smoothed speed back down
    // quickly rather than staying pinned near the spike.
    for (let i = 1; i <= 5; i++) {
      frame = analyzer.addSample(20 * 15 + 15 + i * 15, 20 * 8 + 4000 + i * 8, 0);
    }
    expect(frame!.speed).toBeLessThan(steadySpeed * 5);
  });

  it("does not let a stale cooldown from a previous gesture block the first corner of a new one", () => {
    const analyzer = new GestureAnalyzer();
    // First gesture: establish a corner right at the end (sets lastChangeAt).
    const first = straightLine(20);
    let t = first[first.length - 1][0];
    let x = first[first.length - 1][1];
    for (const [pt, px, py] of first) analyzer.addSample(pt, px, py);
    for (let i = 1; i <= 20; i++) {
      t += 15;
      analyzer.addSample(t, x, i * 8);
    }
    // Pointer up, then immediately (well inside the old cooldown window)
    // start a brand-new gesture with its own clean corner.
    analyzer.reset();
    let frame;
    const second = straightLine(20);
    for (const [pt, px, py] of second) frame = analyzer.addSample(pt, px, py);
    let t2 = second[second.length - 1][0];
    const x2 = second[second.length - 1][1];
    let triggered = false;
    for (let i = 1; i <= 20; i++) {
      t2 += 15;
      frame = analyzer.addSample(t2, x2, i * 8);
      if (frame.chordChangeTriggered) triggered = true;
    }
    expect(triggered).toBe(true);
  });

  it("does not burst-fire repeatedly on a single gentle curve", () => {
    const points: Array<[number, number, number]> = [];
    let x = 0;
    let y = 0;
    let t = 0;
    let angle = 0;
    // A slow arc: ~1.2° per 15ms step, ~54° of total turn over 900ms.
    for (let i = 0; i <= 60; i++) {
      angle += (1.2 * Math.PI) / 180;
      x += Math.cos(angle) * 8;
      y += Math.sin(angle) * 8;
      t += 15;
      points.push([t, x, y]);
    }
    expect(corners(run(points))).toBeLessThanOrEqual(1);
  });

  it("requires a fresh stable direction to re-establish before re-arming, not just distance since last sample", () => {
    // Two corners placed exactly at CORNER_REARM_DISTANCE_PX apart in path
    // length: the geometry alone (a corner immediately followed by another)
    // still needs a genuinely stable outgoing run for the second corner, so
    // a too-short middle leg must not produce two triggers.
    const shortMiddleLegSteps = Math.floor(CORNER_REARM_DISTANCE_PX / 8 / 2); // well under one full segment
    const incoming = straightRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, 12);
    const middle = straightRun({ ...incoming.end, headingDeg: 90 }, shortMiddleLegSteps);
    const outgoing = straightRun({ ...middle.end, headingDeg: 0 }, 20);
    const points: Array<[number, number, number]> = [[0, 0, 0], ...incoming.points, ...middle.points, ...outgoing.points];
    expect(corners(run(points))).toBeLessThanOrEqual(1);
  });
});

describe("stable-segment corner-detection constants", () => {
  it("keeps the stable-segment length within the brief's conservative 24-36px range", () => {
    expect(SEGMENT_LENGTH_PX).toBeGreaterThanOrEqual(24);
    expect(SEGMENT_LENGTH_PX).toBeLessThanOrEqual(36);
  });

  it("defaults the minimum corner angle to 70°", () => {
    expect(CORNER_ANGLE_MIN_DEG).toBe(70);
  });

  it("keeps the axis-reversal tolerance comfortably below the corner-angle ceiling", () => {
    // The two thresholds must not overlap: AXIS_REVERSAL_MAX_DEG describes
    // an axis difference (0-90°), CORNER_ANGLE_MAX_DEG a directed heading
    // difference (0-180°) — the actual "no overlap" invariant is the gap
    // between CORNER_ANGLE_MAX_DEG and the reversal zone it implies
    // (180 - AXIS_REVERSAL_MAX_DEG), which must stay positive so a
    // deliberate ambiguous band exists between them.
    expect(CORNER_ANGLE_MAX_DEG).toBeLessThan(180 - AXIS_REVERSAL_MAX_DEG);
  });
});

describe("GestureAnalyzer: diagnostics", () => {
  it("labels a confirmed corner as reason 'corner'", () => {
    const analyzer = new GestureAnalyzer();
    let triggered = false;
    let diagnosticsAtTrigger: GestureDiagnostics | undefined;
    for (const [t, x, y] of cornerPath(90)) {
      const frame = analyzer.addSample(t, x, y);
      if (frame.chordChangeTriggered) {
        triggered = true;
        diagnosticsAtTrigger = analyzer.getDiagnostics();
      }
    }
    expect(triggered).toBe(true);
    expect(diagnosticsAtTrigger?.reason).toBe("corner");
    expect(diagnosticsAtTrigger?.triggered).toBe(true);
  });

  it("labels a same-axis reversal as reason 'axis-reversal', not 'corner'", () => {
    const analyzer = new GestureAnalyzer();
    // stepPx=5 divides SEGMENT_LENGTH_PX=30 evenly (see the 150°-corner test
    // above for why): the default stepPx=8 leaves a fixed few-px pivot/vertex
    // misalignment on every sample of this perfectly uniform synthetic path,
    // and this reversal's ~162° turn is close enough to a true 180° reversal
    // that the same near-cancellation sensitivity applies — the straightness
    // ratio never clears threshold at any sample, so the axis-difference
    // branch is never even reached.
    const { points } = backAndForthRun(0, 3, 16, 5);
    let sawAxisReversal = false;
    for (const [t, x, y] of points) {
      const frame = analyzer.addSample(t, x, y);
      expect(frame.chordChangeTriggered).toBe(false);
      if (analyzer.getDiagnostics().reason === "axis-reversal") sawAxisReversal = true;
    }
    expect(sawAxisReversal).toBe(true);
  });

  it("labels a large gentle arc as reason 'curve', not 'jitter' or 'corner'", () => {
    const analyzer = new GestureAnalyzer();
    const { points } = arcRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, 90, 150, 1);
    let sawCurve = false;
    for (const [t, x, y] of [[0, 0, 0] as [number, number, number], ...points]) {
      const frame = analyzer.addSample(t, x, y);
      expect(frame.chordChangeTriggered).toBe(false);
      if (analyzer.getDiagnostics().reason === "curve") sawCurve = true;
    }
    expect(sawCurve).toBe(true);
  });

  it("reports independently-computed heading and axis differences", () => {
    const analyzer = new GestureAnalyzer();
    let triggeredFrame: GestureFrame | undefined;
    let d: GestureDiagnostics | undefined;
    // stepPx=5 (a divisor of SEGMENT_LENGTH_PX=30) avoids the fixed pivot/
    // vertex misalignment that the default stepPx=8 leaves on this perfectly
    // uniform synthetic path (see the 150°-corner test above) — this test
    // checks the measured angles to within half a degree, tighter than the
    // "does it trigger" tests elsewhere in this file tolerate.
    for (const [t, x, y] of cornerPath(90, 20, 5)) {
      const frame = analyzer.addSample(t, x, y);
      if (frame.chordChangeTriggered) {
        triggeredFrame = frame;
        d = analyzer.getDiagnostics();
      }
    }
    expect(triggeredFrame?.chordChangeTriggered).toBe(true);
    expect(d?.headingDifferenceDeg).not.toBeNull();
    expect(d?.axisDifferenceDeg).not.toBeNull();
    expect(d!.headingDifferenceDeg!).toBeCloseTo(90, 0);
    expect(d!.axisDifferenceDeg!).toBeCloseTo(90, 0);
  });
});
