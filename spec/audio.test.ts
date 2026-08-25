import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioEngine, MAX_ACTIVE_VOICES, noteDurationSeconds } from "../audio";
import { buildChordEvent } from "../chordEvent";
import { voiceChord } from "../voicing";

// jsdom does not implement Web Audio, so the polyphony/voice-stealing logic
// is exercised against a minimal fake graph that stands in for the real
// AudioContext — enough to observe node creation and gain-envelope calls
// without needing real audio hardware. Real click-free/level checks still
// need a human listening pass (see PROCESS.md / reflections/crit-4.md).
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

function playOneChord(engine: AudioEngine): void {
  const notes = voiceChord("C", "brass");
  const context = engine.ensureContext();
  const event = buildChordEvent({
    harmonicState: "I",
    chordSymbol: "C",
    notes,
    ensemble: "brass",
    startedAtSeconds: context.currentTime,
    durationSeconds: noteDurationSeconds("brass"),
  });
  engine.playChord(event);
}

describe("AudioEngine: polyphony cap and voice stealing", () => {
  it("never grows the active-voice pool past the documented cap", () => {
    const engine = new AudioEngine();
    for (let i = 0; i < 30; i++) {
      playOneChord(engine);
      expect(engine.activeVoiceCount).toBeLessThanOrEqual(MAX_ACTIVE_VOICES);
    }
  });

  it("keeps triggering more chords responsive instead of throwing once at the cap", () => {
    const engine = new AudioEngine();
    for (let i = 0; i < 10; i++) playOneChord(engine);
    expect(() => playOneChord(engine)).not.toThrow();
  });
});

describe("AudioEngine: context construction", () => {
  it("is not constructed until ensureContext() is called", () => {
    const engine = new AudioEngine();
    expect(engine.isReady).toBe(false);
    engine.ensureContext();
    expect(engine.isReady).toBe(true);
  });
});
