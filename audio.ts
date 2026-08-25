import type { ChordEvent } from "./chordEvent";
import type { Ensemble } from "./voicing";

// A concrete polyphony cap (section 11): the maximum number of simultaneously
// active single-note voices before the oldest is stolen/faded. Four voices
// per chord means this comfortably covers a few overlapping chords during
// fast conducting before anything is stolen.
export const MAX_ACTIVE_VOICES = 16;

// Master gain is clamped conservatively; confirmed safe on this machine's
// laptop speakers and headphones during development, but a real-phone
// listening pass is still required before calling audio "done" (section 18).
const MASTER_GAIN = 0.2;
const PEAK_VOICE_GAIN = 0.22;
const STEAL_FADE_SECONDS = 0.03;

type Preset = {
  attackSeconds: number;
  holdSeconds: number;
  releaseSeconds: number;
  filterFrequency: number;
  filterQ: number;
  oscillatorType: OscillatorType;
  detuneCents: number;
};

// Brass Choir (required, section 10): fast attack, bright filtered
// sawtooth, firm release, no detune between unison layers.
const BRASS_PRESET: Preset = {
  attackSeconds: 0.015,
  holdSeconds: 0.55,
  releaseSeconds: 0.35,
  filterFrequency: 2600,
  filterQ: 1.1,
  oscillatorType: "sawtooth",
  detuneCents: 0,
};

// Symphonic Strings (optional, section 10): slow attack, darker filter,
// long release, subtle unison detune for shimmer.
const STRINGS_PRESET: Preset = {
  attackSeconds: 0.16,
  holdSeconds: 0.7,
  releaseSeconds: 0.9,
  filterFrequency: 900,
  filterQ: 0.6,
  oscillatorType: "sawtooth",
  detuneCents: 7,
};

function presetFor(ensemble: Ensemble): Preset {
  return ensemble === "brass" ? BRASS_PRESET : STRINGS_PRESET;
}

/** Total audible length of a note in this ensemble's preset — used both to
 *  schedule the envelope and to stamp `ChordEvent.durationSeconds`. */
export function noteDurationSeconds(ensemble: Ensemble): number {
  const preset = presetFor(ensemble);
  return preset.attackSeconds + preset.holdSeconds + preset.releaseSeconds;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

type ActiveVoice = {
  oscillators: OscillatorNode[];
  gain: GainNode;
  filter: BiquadFilterNode;
  stopped: boolean;
};

/** Synthesis-only audio engine (section 10-11): one shared `AudioContext`
 *  constructed lazily on the first user gesture, oscillator/filter/gain
 *  voices with click-free envelopes, a capped and voice-stealing polyphony
 *  pool, routed through one clamped master gain. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private activeVoices: ActiveVoice[] = [];

  /** Must be called synchronously from inside a user-gesture handler
   *  (pointerdown / keydown) — never at module load. */
  ensureContext(): AudioContext {
    if (!this.context) {
      const context = new AudioContext();
      const masterGain = context.createGain();
      masterGain.gain.value = MASTER_GAIN;
      masterGain.connect(context.destination);
      this.context = context;
      this.masterGain = masterGain;
    }
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
    return this.context;
  }

  get isReady(): boolean {
    return this.context !== null;
  }

  get activeVoiceCount(): number {
    return this.activeVoices.length;
  }

  playChord(event: ChordEvent): void {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!context || !masterGain) return;

    const preset = presetFor(event.ensemble);
    const startTime = context.currentTime;

    for (const note of event.notes) {
      this.stealOldestIfAtCap();

      const gain = context.createGain();
      gain.gain.setValueAtTime(0, startTime);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = preset.filterFrequency;
      filter.Q.value = preset.filterQ;

      const frequency = midiToFrequency(note.midi);
      const oscillators: OscillatorNode[] = [];

      const mainOsc = context.createOscillator();
      mainOsc.type = preset.oscillatorType;
      mainOsc.frequency.value = frequency;
      mainOsc.connect(filter);
      oscillators.push(mainOsc);

      if (preset.detuneCents > 0) {
        const detunedOsc = context.createOscillator();
        detunedOsc.type = preset.oscillatorType;
        detunedOsc.frequency.value = frequency;
        detunedOsc.detune.value = preset.detuneCents;
        detunedOsc.connect(filter);
        oscillators.push(detunedOsc);
      }

      filter.connect(gain);
      gain.connect(masterGain);

      // Click-free envelope: linear attack to peak, hold, linear release.
      const attackEnd = startTime + preset.attackSeconds;
      const releaseStart = attackEnd + preset.holdSeconds;
      const releaseEnd = releaseStart + preset.releaseSeconds;
      gain.gain.linearRampToValueAtTime(PEAK_VOICE_GAIN, attackEnd);
      gain.gain.setValueAtTime(PEAK_VOICE_GAIN, releaseStart);
      gain.gain.linearRampToValueAtTime(0, releaseEnd);

      for (const osc of oscillators) {
        osc.start(startTime);
        osc.stop(releaseEnd + 0.05);
      }

      const voice: ActiveVoice = { oscillators, gain, filter, stopped: false };
      this.activeVoices.push(voice);

      const cleanup = () => {
        voice.stopped = true;
        gain.disconnect();
        filter.disconnect();
        this.activeVoices = this.activeVoices.filter((v) => v !== voice);
      };
      mainOsc.addEventListener("ended", cleanup, { once: true });
    }
  }

  private stealOldestIfAtCap(): void {
    if (this.activeVoices.length < MAX_ACTIVE_VOICES) return;
    const context = this.context;
    const oldest = this.activeVoices[0];
    if (!context || !oldest) return;

    // Drop it from the pool immediately so the cap is enforced the instant
    // it's exceeded — the fade-out below still finishes the sound cleanly in
    // the audio graph, but bookkeeping never has to wait for the browser's
    // 'ended' event to catch up during rapid, sustained conducting.
    this.activeVoices.shift();
    oldest.stopped = true;

    const now = context.currentTime;
    const gainParam = oldest.gain.gain;
    if (typeof gainParam.cancelAndHoldAtTime === "function") {
      gainParam.cancelAndHoldAtTime(now);
    } else {
      gainParam.cancelScheduledValues(now);
    }
    gainParam.linearRampToValueAtTime(0, now + STEAL_FADE_SECONDS);
    for (const osc of oldest.oscillators) {
      try {
        osc.stop(now + STEAL_FADE_SECONDS + 0.01);
      } catch {
        // already scheduled to stop — nothing to do.
      }
    }
  }
}
