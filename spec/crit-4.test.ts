import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Crit 4 ("An instrument") contract:
// https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/
//
// Most of this week's spec is judged live at the crit --- expressiveness,
// feel, whether a stranger picks it up unprompted, whether there's really no
// way to play it wrong --- and no static test can stand in for a person
// playing the thing. These tests cover only the lines that are mechanically
// checkable from the built output: that it actually ships Web Audio synthesis
// rather than a pre-recorded clip, and that it responds to more than one
// input modality. Everything else in the spec is judged at the crit, not
// tested here.

const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const shipped = files();
const scripts = shipped.filter((path) => path.endsWith(".js"));
const bundleText = scripts.map((path) => readFileSync(path, "utf8")).join("\n");

const htmlPages = shipped
  .filter((path) => path.endsWith(".html"))
  .map((path) => ({
    path,
    doc: new JSDOM(readFileSync(path, "utf8")).window.document,
  }));

describe("crit 4: an instrument", () => {
  it("shipped at least one script bundle to inspect", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it("uses Web Audio synthesis, not just markup", () => {
    expect(
      bundleText.includes("AudioContext"),
      "the spec asks for sound made live by an AudioContext-based graph --- no AudioContext reference found in the built JS",
    ).toBe(true);

    const usesASource =
      bundleText.includes("createOscillator") || bundleText.includes("createBufferSource");
    expect(
      usesASource,
      "expected an OscillatorNode (createOscillator) or AudioBufferSourceNode (createBufferSource) somewhere in the built JS",
    ).toBe(true);
  });

  it("does not fall back on pre-recorded playback elements", () => {
    for (const { path, doc } of htmlPages) {
      expect(
        doc.querySelector("audio, video"),
        `${path} ships an <audio>/<video> element --- the spec wants sound made live by the player, not played back`,
      ).toBeNull();
    }
  });

  it("wires up more than one input modality", () => {
    const hasPointerInput =
      bundleText.includes("pointerdown") ||
      bundleText.includes("mousedown") ||
      bundleText.includes('addEventListener("click"') ||
      bundleText.includes("addEventListener('click'");
    const hasKeyboardInput = bundleText.includes("keydown");

    expect(hasPointerInput, "expected a pointer/mouse/click handler somewhere in the built JS").toBe(
      true,
    );
    expect(
      hasKeyboardInput,
      "the spec asks for keyboard play too --- no keydown handler found in the built JS",
    ).toBe(true);
  });
});
