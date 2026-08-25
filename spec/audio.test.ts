import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioEngine, MAX_ACTIVE_VOICES, speedToLevel } from "../audio";
import { buildChordEvent } from "../chordEvent";
import { voiceChord } from "../voicing";

// jsdom does not implement Web Audio, so the sustained-voice lifecycle is
// exercised against a minimal fake graph that stands in for the real
// AudioContext — enough to observe node creation and gain-envelope calls
// without needing real audio hardware. Real click-free/level/balance checks
// still need a human listening pass (see PROCESS.md / reflections/crit-4.md).
class FakeAudioParam {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  cancelAndHoldAtTime() {
    return this;
  }
}

class FakeAudioNode {
  connect() {
    return this;
  }
  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = "lowpass";
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = "sawtooth";
  frequency = new FakeAudioParam();
  detune = new FakeAudioParam();
  private endedListeners: Array<() => void> = [];
  start() {}
  // Deliberately does NOT fire 'ended' — real hardware only fires it once
  // playback time is reached, well after `.stop()` is scheduled, so tests
  // that need cleanup to have happened call `fireEnded()` explicitly.
  stop() {}
  fireEnded() {
    for (const fn of this.endedListeners) fn();
  }
  addEventListener(type: string, fn: () => void) {
    if (type === "ended") this.endedListeners.push(fn);
  }
  removeEventListener() {}
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = new FakeAudioNode();
  createGain() {
    return new FakeGainNode();
  }
  createBiquadFilter() {
    return new FakeBiquadFilterNode();
  }
  createOscillator() {
    return new FakeOscillatorNode();
  }
  resume() {
    return Promise.resolve();
  }
}

let originalAudioContext: unknown;

beforeEach(() => {
  originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  (globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
});

function chordEvent(symbol: string) {
  return buildChordEvent({
    harmonicState: "I",
    chordSymbol: symbol,
    notes: voiceChord(symbol, "brass"),
    ensemble: "brass",
  });
}

describe("AudioEngine: sustained pointer-lifecycle voices", () => {
  it("is not constructed until ensureContext() is called", () => {
    const engine = new AudioEngine();
    expect(engine.isReady).toBe(false);
    engine.ensureContext();
    expect(engine.isReady).toBe(true);
  });

  it("holds exactly four voices while a single chord sustains", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    expect(engine.activeVoiceCount).toBe(4);
  });

  it("never grows the active-voice pool past the documented cap across many corners", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    const symbols = ["G", "Am", "F", "Dm7", "Em", "G7", "C"];
    for (let i = 0; i < 30; i++) {
      engine.changeChord(chordEvent(symbols[i % symbols.length]));
      expect(engine.activeVoiceCount).toBeLessThanOrEqual(MAX_ACTIVE_VOICES);
    }
  });

  it("keeps at most one crossfading-out generation alive alongside the current chord", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    engine.changeChord(chordEvent("G")); // C now fading, G current: 8 voices
    expect(engine.activeVoiceCount).toBe(8);
    engine.changeChord(chordEvent("Am")); // G now fading, Am current — C's
    // generation must have been stolen immediately rather than left to pile
    // up, or this would grow to 12.
    expect(engine.activeVoiceCount).toBe(8);
  });

  it("releases the held chord's voices once they finish fading", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    engine.releaseChord();
    expect(engine.activeVoiceCount).toBe(4); // still fading, not yet cleaned up

    const context = engine.ensureContext() as unknown as FakeAudioContext;
    void context;
    // Simulate playback reaching the end of the release ramp.
    const engineInternals = engine as unknown as { activeVoices: Array<{ oscillator: FakeOscillatorNode }> };
    for (const voice of engineInternals.activeVoices) voice.oscillator.fireEnded();
    expect(engine.activeVoiceCount).toBe(0);
  });

  it("does not throw when starting a fresh chord immediately after release", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    engine.releaseChord();
    expect(() => engine.startChord(chordEvent("G"))).not.toThrow();
    expect(engine.activeVoiceCount).toBeLessThanOrEqual(MAX_ACTIVE_VOICES);
  });

  it("does not throw when applying continuous expression with no chord sustaining", () => {
    const engine = new AudioEngine();
    expect(() => engine.setExpression(0.5, 0.3)).not.toThrow();
  });
});

describe("speedToLevel: continuous speed-to-volume mapping", () => {
  it("never falls silent — holding still still sounds the chord", () => {
    expect(speedToLevel(0)).toBeGreaterThan(0);
  });

  it("is monotonically non-decreasing with speed", () => {
    const speeds = [0, 20, 40, 100, 300, 600, 900, 2000];
    const levels = speeds.map(speedToLevel);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
  });

  it("never exceeds full volume", () => {
    expect(speedToLevel(10_000)).toBeLessThanOrEqual(1);
  });
});
