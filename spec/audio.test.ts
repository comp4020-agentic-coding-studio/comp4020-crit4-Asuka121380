import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AudioEngine,
  CORNER_PRESENCE_FLOOR,
  GESTURE_START_ATTACK_SECONDS,
  INCOMING_ATTACK_SECONDS,
  MAX_ACTIVE_VOICES,
  OUTGOING_FADE_SECONDS,
  RELEASE_FLOOR,
  RELEASE_SECONDS,
  SCHEDULING_LOOKAHEAD_SECONDS,
  speedToLevel,
} from "../audio";
import { buildChordEvent } from "../chordEvent";
import { voiceChord } from "../voicing";

// jsdom does not implement Web Audio, so the sustained-voice lifecycle is
// exercised against a minimal fake graph that stands in for the real
// AudioContext — enough to observe node creation and gain-envelope calls
// without needing real audio hardware. Real click-free/level/balance checks
// still need a human listening pass (see PROCESS.md / reflections/crit-4.md).
type ParamCall = { method: string; value: number; time?: number; timeConstant?: number };

class FakeAudioParam {
  value = 0;
  calls: ParamCall[] = [];
  setValueAtTime(v: number, t?: number) {
    this.value = v;
    this.calls.push({ method: "setValueAtTime", value: v, time: t });
    return this;
  }
  linearRampToValueAtTime(v: number, t?: number) {
    this.value = v;
    this.calls.push({ method: "linearRampToValueAtTime", value: v, time: t });
    return this;
  }
  setTargetAtTime(v: number, t?: number, timeConstant?: number) {
    this.value = v;
    this.calls.push({ method: "setTargetAtTime", value: v, time: t, timeConstant });
    return this;
  }
  cancelScheduledValues(t?: number) {
    this.calls.push({ method: "cancelScheduledValues", value: 0, time: t });
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
  stopScheduledAt: number | null = null;
  private endedListeners: Array<() => void> = [];
  start() {}
  // Deliberately does NOT fire 'ended' — real hardware only fires it once
  // playback time is reached, well after `.stop()` is scheduled, so tests
  // that need cleanup to have happened call `fireEnded()` explicitly.
  stop(t?: number) {
    this.stopScheduledAt = t ?? null;
  }
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
  addEventListener() {}
  removeEventListener() {}
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

  it("on release, preserves the current gain and decays exponentially instead of jumping to zero", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    const internals = engine as unknown as {
      activeVoices: Array<{ oscillator: FakeOscillatorNode; envelopeGain: { gain: FakeAudioParam } }>;
    };
    const [voice] = internals.activeVoices;
    const gainBeforeRelease = voice.envelopeGain.gain.value;
    expect(gainBeforeRelease).toBeGreaterThan(0);

    engine.releaseChord();

    // The decay must start from the value the chord already had, not 0 — the
    // last setValueAtTime call before the exponential decay should re-assert
    // that same value rather than resetting it.
    const calls = voice.envelopeGain.gain.calls;
    const decayIndex = calls.findIndex((c) => c.method === "setTargetAtTime");
    expect(decayIndex).toBeGreaterThan(0);
    expect(calls[decayIndex].value).toBeCloseTo(RELEASE_FLOOR);
    const precedingSetValue = calls[decayIndex - 1];
    expect(precedingSetValue.method).toBe("setValueAtTime");
    expect(precedingSetValue.value).toBeCloseTo(gainBeforeRelease);

    // No abrupt linear ramp-to-zero is scheduled alongside the decay.
    expect(calls.some((c) => c.method === "linearRampToValueAtTime" && c.value === 0)).toBe(false);

    // The oscillator is scheduled to stop only once the full release tail
    // has had time to become inaudible, not stopped immediately.
    expect(voice.oscillator.stopScheduledAt).not.toBeNull();
    expect(voice.oscillator.stopScheduledAt as number).toBeCloseTo(RELEASE_SECONDS + SCHEDULING_LOOKAHEAD_SECONDS);
  });

  it("on a confirmed corner, the incoming chord becomes audible much faster than the outgoing chord fades", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    engine.changeChord(chordEvent("G"));

    const internals = engine as unknown as {
      activeVoices: Array<{ role: string; envelopeGain: { gain: FakeAudioParam } }>;
    };
    const outgoing = internals.activeVoices.find((v) => v.role === "fading")!;
    const incoming = internals.activeVoices.find((v) => v.role === "current")!;

    const outgoingRamp = outgoing.envelopeGain.gain.calls.find(
      (c) => c.method === "linearRampToValueAtTime" && c.value === 0,
    )!;
    const incomingRamp = incoming.envelopeGain.gain.calls.find(
      (c) => c.method === "linearRampToValueAtTime" && c.value > 0,
    )!;

    // Every scheduled time carries the same forward lookahead (see
    // SCHEDULING_LOOKAHEAD_SECONDS in audio.ts) on top of its nominal
    // duration — this is what gives the audio render thread guaranteed lead
    // time to enqueue the change.
    expect(incomingRamp.time).toBeCloseTo(INCOMING_ATTACK_SECONDS + SCHEDULING_LOOKAHEAD_SECONDS);
    expect(outgoingRamp.time).toBeCloseTo(OUTGOING_FADE_SECONDS + SCHEDULING_LOOKAHEAD_SECONDS);
    // The incoming chord must reach full amplitude well before the outgoing
    // one has faded out — this is what makes the harmony change read as
    // immediate rather than gradually crossfading in under the old chord.
    expect(incomingRamp.time as number).toBeLessThan(outgoingRamp.time as number);
  });

  it("begins a brand-new gesture with a slower, gentler attack than a mid-gesture corner change", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));

    const internals = engine as unknown as {
      activeVoices: Array<{ envelopeGain: { gain: FakeAudioParam } }>;
    };
    const [voice] = internals.activeVoices;
    const startRamp = voice.envelopeGain.gain.calls.find(
      (c) => c.method === "linearRampToValueAtTime" && c.value > 0,
    )!;

    // Envelope A (gesture-start) and envelope B (corner change) are
    // independent configurations — the gesture-start attack must not equal,
    // and must be well slower than, the fast corner-change attack.
    expect(startRamp.time).toBeCloseTo(GESTURE_START_ATTACK_SECONDS + SCHEDULING_LOOKAHEAD_SECONDS);
    expect(GESTURE_START_ATTACK_SECONDS).toBeGreaterThan(INCOMING_ATTACK_SECONDS);
  });

  it("schedules new automation a small lookahead ahead of currentTime, never exactly at it", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));

    const internals = engine as unknown as {
      activeVoices: Array<{ envelopeGain: { gain: FakeAudioParam } }>;
    };
    const [voice] = internals.activeVoices;
    const zeroPin = voice.envelopeGain.gain.calls.find((c) => c.method === "setValueAtTime" && c.value === 0)!;

    // The fake context's currentTime is 0 for the whole test, so any
    // scheduled time greater than 0 is evidence a lookahead was applied
    // rather than scheduling flush against "now".
    expect(zeroPin.time).toBeCloseTo(SCHEDULING_LOOKAHEAD_SECONDS);
    expect(zeroPin.time as number).toBeGreaterThan(0);
  });

  it("guarantees the incoming chord a minimum presence even if speed-driven volume had dipped", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    // Simulate a hand slowing to a near-stop while pivoting through a corner.
    engine.setExpression(0.05, 0);
    engine.changeChord(chordEvent("G"));

    const internals = engine as unknown as {
      activeVoices: Array<{ role: string; levelGain: { gain: FakeAudioParam } }>;
    };
    const incoming = internals.activeVoices.find((v) => v.role === "current")!;
    expect(incoming.levelGain.gain.value).toBeGreaterThanOrEqual(CORNER_PRESENCE_FLOOR);
  });

  it("ramps volume up faster than it ramps volume down", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    const internals = engine as unknown as {
      activeVoices: Array<{ levelGain: { gain: FakeAudioParam } }>;
    };
    const [voice] = internals.activeVoices;

    engine.setExpression(0.95, 0); // a rise from the initial held-minimum level
    const riseCalls = voice.levelGain.gain.calls.filter((c) => c.method === "linearRampToValueAtTime");
    const riseTarget = riseCalls[riseCalls.length - 1].time ?? 0;

    engine.setExpression(0.1, 0); // a fall back down
    const fallCalls = voice.levelGain.gain.calls.filter((c) => c.method === "linearRampToValueAtTime");
    const fallTarget = fallCalls[fallCalls.length - 1].time ?? 0;

    // Both ramps are scheduled from the same `now` (the fake context's
    // currentTime never advances), so a larger target time means a longer
    // (slower) ramp.
    expect(fallTarget).toBeGreaterThan(riseTarget);
  });

  it("cancels a previous move's still-pending ramp instead of stacking automation events", () => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.startChord(chordEvent("C"));
    const internals = engine as unknown as {
      activeVoices: Array<{ levelGain: { gain: FakeAudioParam } }>;
    };
    const [voice] = internals.activeVoices;

    engine.setExpression(0.4, 0);
    engine.setExpression(0.9, 0);

    // Every ramp after the first must be preceded by a cancel, so rapid
    // successive pointer moves replace the in-flight automation rather than
    // layering a second ramp on top of one still interpolating.
    const calls = voice.levelGain.gain.calls;
    const secondRampIndex = calls.map((c) => c.method).lastIndexOf("linearRampToValueAtTime");
    const priorCalls = calls.slice(0, secondRampIndex);
    expect(priorCalls.some((c) => c.method === "cancelScheduledValues")).toBe(true);
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
