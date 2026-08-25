import { describe, expect, it } from "vitest";
import { GestureAnalyzer, MAX_INSTANTANEOUS_SPEED_PX_S, type GestureFrame } from "../gesture";

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

describe("GestureAnalyzer: axis and corner detection", () => {
  it("never changes chord on pure straight-line motion", () => {
    const frames = run(straightLine(60));
    expect(corners(frames)).toBe(0);
  });

  it("ignores small jitter around the same heading", () => {
    const points: Array<[number, number, number]> = [];
    for (let i = 0; i <= 60; i++) {
      points.push([i * 15, i * 8, i % 2 === 0 ? 0 : 1]); // ~7° wobble, well under the 40° candidate threshold
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

  it("confirms a clean 90° corner as exactly one chord change", () => {
    const points = straightLine(20); // establish the x-axis first
    const lastX = points[points.length - 1][0];
    const lastT = points[points.length - 1][1];
    // Now turn 90° and travel along +y for long enough to pass both the
    // confirm-distance and confirm-time thresholds.
    for (let i = 1; i <= 20; i++) {
      points.push([lastX + i * 15, lastT, i * 8]);
    }
    const frames = run(points);
    expect(corners(frames)).toBe(1);
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

  it("confirms a clear L-turn quickly rather than half a second later", () => {
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
});
