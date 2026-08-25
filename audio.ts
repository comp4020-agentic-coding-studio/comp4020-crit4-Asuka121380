import type { ChordEvent } from "./chordEvent";
import type { Ensemble, Voice, VoicedNote } from "./voicing";

// Polyphony cap (refinement section 3): four voices for the sustaining chord
// plus four for the previous chord while a crossfade is still in flight —
// never more, because a confirmed corner always steals any leftover
// crossfade-out group immediately rather than letting a third generation
// accumulate.
export const MAX_ACTIVE_VOICES = 8;

const MASTER_GAIN = 0.22;
const MASTER_HIGHPASS_HZ = 36;

const ATTACK_SECONDS = 0.05;
// A confirmed corner starts the new chord immediately (from
// `context.currentTime`, never a delayed timer). The incoming and outgoing
// voices deliberately do NOT share one "crossfade" duration any more: making
// the incoming chord audible fast is what makes a corner feel immediate;
// how long the outgoing chord lingers is a separate, purely cosmetic tail
// that can be slower without costing any felt latency. Conflating the two
// (one shared ~100ms constant) was a root cause of "the audible chord still
// changes noticeably later than confirmation" — a linear ramp from 0 spends
// most of its early portion at low, easily-masked amplitude, so with a
// 100ms attack the incoming chord wasn't perceptually dominant until close
// to the full 100ms had elapsed, by which point the still-loud outgoing
// chord had been masking it the whole time.
export const INCOMING_ATTACK_SECONDS = 0.04;
export const OUTGOING_FADE_SECONDS = 0.13;
// A confirmed corner is, by definition, a deliberate gesture — but a hand
// physically slows down while pivoting through a sharp turn, which can drive
// the continuously speed-driven volume level to its quietest point at
// exactly the moment the new chord starts. Left alone, that starves the new
// chord of the very presence that's supposed to announce the corner, and
// reads as "the change happened late" even though it started on time. This
// floor guarantees the incoming chord is never quieter than a clearly
// audible presence at the moment it's created; ordinary speed-driven
// `setExpression` calls immediately continue adjusting it from there.
export const CORNER_PRESENCE_FLOOR = 0.5;
// Pointer-up preserves whatever gain the chord was already at and decays
// exponentially toward near-silence — a natural "ensemble settling" tail,
// not a linear cut — before the oscillators are stopped/disconnected.
export const RELEASE_SECONDS = 0.85;
export const RELEASE_TIME_CONSTANT_SECONDS = 0.17; // ~5 time constants ≈ RELEASE_SECONDS
export const RELEASE_FLOOR = 0.0001; // exponential decay can only approach 0, never reach it
const STEAL_FADE_SECONDS = 0.03;
// Continuous speed-to-volume response is asymmetric: quicker to rise (a
// sudden increase in speed should be heard right away) than to fall (so a
// momentary dip in the smoothed speed doesn't read as a stutter).
const LEVEL_RISE_SECONDS = 0.09;
const LEVEL_FALL_SECONDS = 0.18;
const EXPRESSION_SMOOTHING_SECONDS = 0.06;
const VIBRATO_RATE_HZ = 5.5;

// Per-voice relative gain balance (section 2): upper voices carry the melodic
// line clearly, the bass anchors without dominating.
const VOICE_RELATIVE_GAIN: Record<Voice, number> = {
  soprano: 1.0,
  alto: 0.75,
  tenor: 0.52,
  bass: 0.33,
};

// Continuous-dynamics mapping (section 3): smoothed pointer speed (px/s) to a
// gain level, with a held-minimum floor so holding the pointer still doesn't
// silence the chord.
const SPEED_FLOOR_PX_S = 40;
const SPEED_CEILING_PX_S = 900;
const HELD_MINIMUM_LEVEL = 0.13;

export function speedToLevel(speedPxPerSec: number): number {
  if (speedPxPerSec <= SPEED_FLOOR_PX_S) return HELD_MINIMUM_LEVEL;
  if (speedPxPerSec >= SPEED_CEILING_PX_S) return 1;
  const t = (speedPxPerSec - SPEED_FLOOR_PX_S) / (SPEED_CEILING_PX_S - SPEED_FLOOR_PX_S);
  return HELD_MINIMUM_LEVEL + t * (1 - HELD_MINIMUM_LEVEL);
}

type Preset = {
  oscillatorType: OscillatorType;
  filterFrequencyByVoice: Record<Voice, number>;
  filterQ: number;
  /** Detune depth in cents at full (1.0) vibrato intensity. */
  vibratoCents: number;
};

// Brass Choir (section 6): bright sawtooth, brighter filtering on upper
// voices than the bass, modest vibrato depth (±4-8 cents at full intensity).
const BRASS_PRESET: Preset = {
  oscillatorType: "sawtooth",
  filterFrequencyByVoice: { soprano: 3400, alto: 2800, tenor: 1800, bass: 1100 },
  filterQ: 1.0,
  vibratoCents: 6,
};

// Symphonic Strings: darker filtering, wider vibrato depth (±10-18 cents).
const STRINGS_PRESET: Preset = {
  oscillatorType: "sawtooth",
  filterFrequencyByVoice: { soprano: 2600, alto: 2000, tenor: 1300, bass: 800 },
  filterQ: 0.7,
  vibratoCents: 14,
};

function presetFor(ensemble: Ensemble): Preset {
  return ensemble === "brass" ? BRASS_PRESET : STRINGS_PRESET;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Ramps an AudioParam to `value` by `targetTime`, explicitly pinning its
 *  current (possibly still-ramping) value at `now` first. Reading `.value`
 *  and re-asserting it with `setValueAtTime` before the ramp is what makes
 *  this safe to call repeatedly in quick succession (every pointer move, or
 *  a corner arriving mid-crossfade) without relying on `cancelAndHoldAtTime`
 *  support: a bare `cancelScheduledValues` alone does not guarantee the
 *  param holds its current interpolated value, which is what produced
 *  audible zipper/steps under rapid successive calls. */
function rampParam(param: AudioParam, value: number, now: number, targetTime: number): void {
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.linearRampToValueAtTime(value, targetTime);
}

/** Same safe cancel-then-reassert pattern as `rampParam`, but decays
 *  exponentially toward `floor` instead of linearly to an exact target —
 *  used for pointer-release, where a natural decaying tail (not a visibly
 *  linear cut) is the point. `setTargetAtTime` only approaches `floor`
 *  asymptotically; the caller schedules cleanup a fixed time later rather
 *  than waiting for an exact-equality target that will never arrive. */
function releaseParam(param: AudioParam, floor: number, now: number, timeConstant: number): void {
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.setTargetAtTime(floor, now, timeConstant);
}

type VoiceRole = "current" | "fading";

type ActiveVoice = {
  oscillator: OscillatorNode;
  filter: BiquadFilterNode;
  levelGain: GainNode;
  envelopeGain: GainNode;
  vibratoScaleGain: GainNode;
  maxVibratoCents: number;
  role: VoiceRole;
};

/** Sustained-voice audio engine (refinement sections 1-4): a chord's four
 *  voices persist for as long as the pointer holds it, rather than firing a
 *  timed one-shot envelope. A confirmed corner crossfades from the outgoing
 *  chord to the incoming one; pointer-up releases the held chord. Continuous
 *  pointer speed drives a shared gain level, and same-axis reversal drives a
 *  shared vibrato LFO's modulation depth per voice. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterHighpass: BiquadFilterNode | null = null;
  private lfoOsc: OscillatorNode | null = null;
  private activeVoices: ActiveVoice[] = [];
  private currentLevel = HELD_MINIMUM_LEVEL;
  private currentVibratoIntensity = 0;

  /** Must be called synchronously from inside a user-gesture handler
   *  (pointerdown / keydown) — never at module load. */
  ensureContext(): AudioContext {
    if (!this.context) {
      const context = new AudioContext();

      const masterGain = context.createGain();
      masterGain.gain.value = MASTER_GAIN;

      const masterHighpass = context.createBiquadFilter();
      masterHighpass.type = "highpass";
      masterHighpass.frequency.value = MASTER_HIGHPASS_HZ;
      masterHighpass.connect(masterGain);
      masterGain.connect(context.destination);

      const lfoOsc = context.createOscillator();
      lfoOsc.type = "sine";
      lfoOsc.frequency.value = VIBRATO_RATE_HZ;
      lfoOsc.start();

      this.context = context;
      this.masterGain = masterGain;
      this.masterHighpass = masterHighpass;
      this.lfoOsc = lfoOsc;
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

  /** Begins sustaining a chord from silence (pointer-down). Any leftover
   *  voices from an incomplete previous release are cut short first — this
   *  should not normally happen, since release only starts on pointer-up. */
  startChord(event: ChordEvent): void {
    if (!this.context || !this.masterHighpass) return;
    for (const voice of this.activeVoices.filter((v) => v.role === "current")) {
      this.fadeOutVoice(voice, STEAL_FADE_SECONDS);
    }
    const preset = presetFor(event.ensemble);
    for (const note of event.notes) this.createVoice(note, preset, ATTACK_SECONDS);
  }

  /** Crossfades from the currently-sustaining chord to a new one (a
   *  confirmed corner). The incoming chord is made audible fast
   *  (INCOMING_ATTACK_SECONDS) while the outgoing chord lingers longer
   *  (OUTGOING_FADE_SECONDS) — the two durations are deliberately different,
   *  not one shared "crossfade" window (see the constants' comments). The
   *  incoming chord also gets a guaranteed presence floor so a momentary dip
   *  in speed-driven volume right at the turn can't silence the very thing
   *  announcing the corner. */
  changeChord(event: ChordEvent): void {
    if (!this.context || !this.masterHighpass) return;
    if (this.activeVoices.every((v) => v.role !== "current")) {
      this.startChord(event);
      return;
    }
    for (const voice of this.activeVoices.filter((v) => v.role === "current")) {
      this.fadeOutVoice(voice, OUTGOING_FADE_SECONDS);
    }
    const preset = presetFor(event.ensemble);
    const incomingLevel = Math.max(this.currentLevel, CORNER_PRESENCE_FLOOR);
    for (const note of event.notes) this.createVoice(note, preset, INCOMING_ATTACK_SECONDS, incomingLevel);
  }

  /** Releases the held chord (pointer-up): an exponential decay toward
   *  near-silence, not a linear fade — see `releaseVoice`. */
  releaseChord(): void {
    for (const voice of this.activeVoices.filter((v) => v.role === "current")) {
      this.releaseVoice(voice);
    }
  }

  /** Continuous expression update, called on every pointer move: `level`
   *  (0-1, see `speedToLevel`) drives the shared volume, `vibratoIntensity`
   *  (0-1) drives the shared LFO's per-voice modulation depth. Only the
   *  currently-sustaining chord responds — a chord already fading out keeps
   *  its own envelope, undisturbed. */
  setExpression(level: number, vibratoIntensity: number): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    // Rising and falling volume get different response times (see
    // LEVEL_RISE_SECONDS/LEVEL_FALL_SECONDS above) — compare against the
    // level already in effect, not the raw input, since `level` already
    // includes the held-minimum floor from `speedToLevel`.
    const levelSmoothingSeconds = level >= this.currentLevel ? LEVEL_RISE_SECONDS : LEVEL_FALL_SECONDS;
    const levelTarget = now + levelSmoothingSeconds;
    const vibratoTarget = now + EXPRESSION_SMOOTHING_SECONDS;
    this.currentLevel = level;
    this.currentVibratoIntensity = vibratoIntensity;
    for (const voice of this.activeVoices) {
      if (voice.role !== "current") continue;
      rampParam(voice.levelGain.gain, level, now, levelTarget);
      rampParam(voice.vibratoScaleGain.gain, vibratoIntensity * voice.maxVibratoCents, now, vibratoTarget);
    }
  }

  private createVoice(note: VoicedNote, preset: Preset, attackSeconds: number, levelOverride?: number): void {
    const context = this.context;
    const masterHighpass = this.masterHighpass;
    if (!context || !masterHighpass) return;
    this.stealOldestIfAtCap();

    const now = context.currentTime;

    const oscillator = context.createOscillator();
    oscillator.type = preset.oscillatorType;
    oscillator.frequency.value = midiToFrequency(note.midi);

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = preset.filterFrequencyByVoice[note.voice];
    filter.Q.value = preset.filterQ;

    const levelGain = context.createGain();
    levelGain.gain.value = levelOverride ?? this.currentLevel;

    const envelopeGain = context.createGain();
    envelopeGain.gain.setValueAtTime(0, now);
    envelopeGain.gain.linearRampToValueAtTime(VOICE_RELATIVE_GAIN[note.voice], now + attackSeconds);

    const vibratoScaleGain = context.createGain();
    vibratoScaleGain.gain.value = this.currentVibratoIntensity * preset.vibratoCents;

    oscillator.connect(filter);
    filter.connect(levelGain);
    levelGain.connect(envelopeGain);
    envelopeGain.connect(masterHighpass);

    if (this.lfoOsc) {
      this.lfoOsc.connect(vibratoScaleGain);
      vibratoScaleGain.connect(oscillator.detune);
    }

    oscillator.start(now);

    this.activeVoices.push({
      oscillator,
      filter,
      levelGain,
      envelopeGain,
      vibratoScaleGain,
      maxVibratoCents: preset.vibratoCents,
      role: "current",
    });
  }

  private fadeOutVoice(voice: ActiveVoice, fadeSeconds: number): void {
    const context = this.context;
    if (!context) return;
    voice.role = "fading";

    const now = context.currentTime;
    // Preserve whatever gain this voice is already at (mid-attack, mid-crossfade,
    // or fully sustained) and ramp smoothly from there — never a jump to 0.
    rampParam(voice.envelopeGain.gain, 0, now, now + fadeSeconds);

    const stopAt = now + fadeSeconds + 0.02;
    try {
      voice.oscillator.stop(stopAt);
    } catch {
      // already scheduled to stop — nothing to do.
    }

    const cleanup = () => {
      voice.envelopeGain.disconnect();
      voice.filter.disconnect();
      voice.levelGain.disconnect();
      voice.vibratoScaleGain.disconnect();
      this.activeVoices = this.activeVoices.filter((v) => v !== voice);
    };
    voice.oscillator.addEventListener("ended", cleanup, { once: true });
  }

  /** Pointer-up release: an exponential decay toward near-silence, holding
   *  from whatever gain the chord was already at — a natural "settling" tail
   *  rather than the visibly linear cut a fixed-duration `linearRampToValueAtTime`
   *  produces. Cleanup (stop/disconnect) is scheduled only once the decay has
   *  had the full RELEASE_SECONDS to become inaudible, not the moment the
   *  ramp is scheduled. */
  private releaseVoice(voice: ActiveVoice): void {
    const context = this.context;
    if (!context) return;
    voice.role = "fading";

    const now = context.currentTime;
    releaseParam(voice.envelopeGain.gain, RELEASE_FLOOR, now, RELEASE_TIME_CONSTANT_SECONDS);

    const stopAt = now + RELEASE_SECONDS;
    try {
      voice.oscillator.stop(stopAt);
    } catch {
      // already scheduled to stop — nothing to do.
    }

    const cleanup = () => {
      voice.envelopeGain.disconnect();
      voice.filter.disconnect();
      voice.levelGain.disconnect();
      voice.vibratoScaleGain.disconnect();
      this.activeVoices = this.activeVoices.filter((v) => v !== voice);
    };
    voice.oscillator.addEventListener("ended", cleanup, { once: true });
  }

  private stealOldestIfAtCap(): void {
    if (this.activeVoices.length < MAX_ACTIVE_VOICES) return;
    const context = this.context;
    const oldest = this.activeVoices[0];
    if (!context || !oldest) return;

    // Drop it from the pool immediately so the cap is enforced the instant
    // it's exceeded — bookkeeping never waits for the browser's 'ended'
    // event to catch up during a rapid run of corner changes.
    this.activeVoices.shift();

    const now = context.currentTime;
    rampParam(oldest.envelopeGain.gain, 0, now, now + STEAL_FADE_SECONDS);
    try {
      oldest.oscillator.stop(now + STEAL_FADE_SECONDS + 0.01);
    } catch {
      // already scheduled to stop — nothing to do.
    }
  }
}
