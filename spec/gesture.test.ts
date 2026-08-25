import { describe, expect, it } from "vitest";
import {
  CORNER_ANGLE_MIN_DEG,
  CORNER_REARM_DISTANCE_PX,
  GestureAnalyzer,
  MAX_INSTANTANEOUS_SPEED_PX_S,
  SEGMENT_LENGTH_PX,
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

/** A straight run of `steps` samples heading in a fixed direction from `start`. */
function straightRun(start: Pose, steps: number, stepPx = 8, stepMs = 15): { points: Array<[number, number, number]>; end: Pose } {
  const points: Array<[number, number, number]> = [];
  let { t, x, y } = start;
  const rad = (start.headingDeg * Math.PI) / 180;
  for (let i = 0; i < steps; i++) {
    x += Math.cos(rad) * stepPx;
    y += Math.sin(rad) * stepPx;
    t += stepMs;
    points.push([t, x, y]);
  }
  return { points, end: { t, x, y, headingDeg: start.headingDeg } };
}

/** A stable incoming run, followed by an equally stable outgoing run at
 *  `turnDeg` away from it — a realistic multi-point corner, not three
 *  idealized points. Each leg is generously longer than SEGMENT_LENGTH_PX so
 *  both stability windows land comfortably inside a single straight leg. */
function cornerPath(turnDeg: number, legSteps = 12, stepPx = 8, stepMs = 15): Array<[number, number, number]> {
  const incoming = straightRun({ t: 0, x: 0, y: 0, headingDeg: 0 }, legSteps, stepPx, stepMs);
  const outgoing = straightRun({ ...incoming.end, headingDeg: turnDeg }, legSteps, stepPx, stepMs);
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
    // A near-V corner: the path turns back on itself by 150°, well short of
    // an exact reversal (180°), which stays inside CORNER_ANGLE_MAX_DEG so
    // it's still classified as a sharp corner rather than excluded as a
    // same-axis reversal.
    const frames = run(cornerPath(150));
    expect(corners(frames)).toBe(1);
  });

  it("confirms a slightly-wider-than-right-angle but still obvious corner", () => {
    // Just above CORNER_ANGLE_MIN_DEG — clearly a deliberate corner, not a
    // gentle bend, but the widest angle that should still register.
    const turnDeg = CORNER_ANGLE_MIN_DEG + 6;
    const frames = run(cornerPath(turnDeg));
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
});
