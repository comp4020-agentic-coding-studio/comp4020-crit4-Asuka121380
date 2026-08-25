import type { ChordEvent } from "./chordEvent";
import type { Ensemble, Voice, VoicedNote } from "./voicing";

// Polyphony cap (refinement section 3): four voices for the sustaining chord
// plus four for the previous chord while a crossfade is still in flight —
// never more, because a confirmed corner always steals any leftover
// crossfade-out group immediately rather than letting a third generation
// accumulate. A "voice" here is one chord note (soprano/alto/tenor/bass),
// even though each now drives 2-3 real oscillators internally (see
// `OscillatorLayer` below) — the cap is about chord polyphony, not raw
// oscillator count.
export const MAX_ACTIVE_VOICES = 8;

const MASTER_GAIN = 0.22;
const MASTER_HIGHPASS_HZ = 36;

// Scheduling every automation event exactly at `context.currentTime` races
// the audio render thread: by the time the main-thread call reaches the
// renderer, the requested time can already be inside (or just behind) the
// block currently being rendered, silently pushing the actual change out to
// the next render quantum. That race is more visible on a larger render
// quantum, which is why it read as Mac/Safari-specific even though the
// gesture-confirmation -> `changeChord()` call itself was already measured
// same-tick everywhere (see PROCESS.md). The fix is not a Safari branch — a
// small forward lookahead applied identically on every platform gives the
// renderer guaranteed lead time to enqueue the change before it's due.
export const SCHEDULING_LOOKAHEAD_SECONDS = 0.008;

// --- A: beginning a new conducting gesture (pointer-down) ------------------
// Starts from near-silence with a gentle attack. This applies ONLY to the
// first chord of a gesture, never to a corner arriving mid-gesture — see
// startChord() vs changeChord() below.
export const GESTURE_START_ATTACK_SECONDS = 0.22;

// --- B: a confirmed corner during an ongoing gesture ------------------------
// The incoming and outgoing voices deliberately do NOT share one "crossfade"
// duration: making the incoming chord audible fast is what makes a corner
// feel immediate; how long the outgoing chord lingers is a separate, purely
// cosmetic tail that can be slower without costing any felt latency.
// Conflating the two (one shared duration) was a root cause of "the audible
// chord still changes noticeably later than confirmation" in an earlier
// round — a linear ramp from 0 spends most of its early portion at low,
// easily-masked amplitude, so the incoming chord wasn't perceptually
// dominant until close to the full attack had elapsed, by which point the
// still-loud outgoing chord had been masking it the whole time.
export const INCOMING_ATTACK_SECONDS = 0.035;
export const OUTGOING_FADE_SECONDS = 0.15;
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

// --- C: releasing the pointer -----------------------------------------------
// Pointer-up preserves whatever gain the chord was already at and decays
// exponentially toward near-silence — a natural "ensemble settling" tail,
// not a linear cut — before the oscillators are stopped/disconnected.
// Extended from an earlier 0.85s: a listening pass on the deployed build
// still read the shorter tail as "fades out too quickly." 1.5s is the
// brief's suggested starting point within its 1.2-1.8s range. Strings uses
// its own, longer release (see STRINGS_PRESET) — a bowed ensemble settles
// more slowly than articulate brass, and release duration is exactly the
// kind of per-ensemble character difference Part B asks for, so it is no
// longer a single shared constant (see `ActiveVoice.releaseSeconds` below).
export const RELEASE_SECONDS = 1.5;
export const RELEASE_TIME_CONSTANT_SECONDS = 0.3; // ~5 time constants ≈ RELEASE_SECONDS
export const RELEASE_FLOOR = 0.0001; // exponential decay can only approach 0, never reach it

const STEAL_FADE_SECONDS = 0.03;
// Continuous speed-to-volume response is asymmetric: quicker to rise (a
// sudden increase in speed should be heard right away) than to fall (so a
// momentary dip in the smoothed speed doesn't read as a stutter).
const LEVEL_RISE_SECONDS = 0.09;
const LEVEL_FALL_SECONDS = 0.18;
const EXPRESSION_SMOOTHING_SECONDS = 0.06;
const VIBRATO_RATE_HZ = 5.5;
const NOISE_BUFFER_SECONDS = 0.5;

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

// A single note is no longer one oscillator: it's a small fixed unison of
// 2-3 layers (a "core" fundamental plus one or two "color" layers) summed
// before filtering. This is what actually separates Brass from Strings —
// a darker filter alone on the same lone sawtooth was explicitly rejected
// (see CLAUDE.md/PROCESS.md) as "a darker version of the same oscillator."
// Layer gains are chosen to sum to ~1.0 per preset so neither ensemble reads
// louder purely from having more oscillators summed into the same filter.
type OscillatorLayer = {
  type: OscillatorType;
  detuneCents: number;
  gain: number;
  /** Only "color" layers are scaled by a voice's brightnessByVoice entry —
   *  the "core" layer always carries the fundamental at full weight so the
   *  note never loses its pitch identity at low brightness. */
  role: "core" | "color";
};

type Preset = {
  layers: OscillatorLayer[];
  filterFrequencyByVoice: Record<Voice, number>;
  filterQ: number;
  /** How much the filter brightens with rising speed/volume, centred on
   *  filterFrequencyByVoice (0 = filter ignores movement entirely). Brass's
   *  breath-driven brightness should track how hard the ensemble is
   *  "blown"; a bowed string section changes tone color far less with bow
   *  speed, so this stays small for strings rather than off entirely. */
  filterBrightnessRange: number;
  /** 0-1 per voice: scales each note's "color" layer(s), the attack
   *  transient, and the pitch-scoop depth. Trumpet/Violin (soprano) is
   *  brightest/clearest; Tuba/Double Bass (bass) is the most restrained. */
  brightnessByVoice: Record<Voice, number>;
  vibratoCentsByVoice: Record<Voice, number>;
  /** 0 = vibrato is at full requested depth immediately; >0 = depth fades
   *  in over this many seconds after the note starts. Brass vibrato is
   *  immediate; bowed strings settle into vibrato only once a note is
   *  established. */
  vibratoOnsetSeconds: number;
  /** Multiplies whatever attack duration the caller passes to createVoice
   *  (GESTURE_START_ATTACK_SECONDS or INCOMING_ATTACK_SECONDS) — brass is
   *  articulate (a near-instant onset), bowed strings swell in gradually.
   *  Brass stays at 1 (the un-scaled baseline the existing attack-timing
   *  tests were written against); only strings scales up. */
  attackScale: number;
  releaseSeconds: number;
  releaseTimeConstantSeconds: number;
  /** Precomputed waveshaper curve — a mild, blended soft-clip. Brass uses a
   *  larger amount for a breath-driven "edge"; strings a much smaller one,
   *  just enough to avoid a perfectly clean, synth-like tone. */
  saturationCurve: Float32Array<ArrayBuffer>;
  /** Pitch instability at the front of a note (brass only): each layer
   *  starts this many cents flat and settles to its steady detune over
   *  scoopSeconds — a breath-driven attack "scoop" rather than a perfectly
   *  tuned onset. */
  scoopCents?: number;
  scoopSeconds?: number;
  /** Brief brighter filter opening at the front of a note (brass only): the
   *  filter cutoff starts above its steady-state value and settles down
   *  over transientSeconds. */
  transientSeconds?: number;
  transientPeakMultiplierByVoice?: Record<Voice, number>;
  /** Subtle filtered bow-noise burst at the front of a note (strings only):
   *  peak linear gain (kept low deliberately — this must read as breath/bow
   *  texture, never as broadband hiss), scaled per voice. */
  noiseAmount?: number;
  noiseByVoice?: Record<Voice, number>;
};

/** A mild, blended soft-clip curve: `amount` 0 is a pure linear pass-through
 *  (no waveshaping at all), 1 is a fully saturated tanh curve. Used at small
 *  amounts only — this is meant to add a breath-driven "edge" (brass) or a
 *  touch of bowed warmth (strings), not distortion. */
function makeSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 256;
  const curve = new Float32Array(samples);
  const normalizer = Math.tanh(3);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = (1 - amount) * x + amount * (Math.tanh(x * 3) / normalizer);
  }
  return curve;
}

// Brass Choir (Part B, section 8): bright/firm/breath-driven. A layered
// saw+square unison (not a lone sawtooth) gives the "brassy" edge a filter
// alone cannot; the square layer and the attack transient/scoop are both
// scaled down toward the bass voices so Tuba stays a restrained foundation
// rather than as bright as Trumpet.
const BRASS_BRIGHTNESS_BY_VOICE: Record<Voice, number> = { soprano: 1, alto: 0.75, tenor: 0.55, bass: 0.35 };

const BRASS_PRESET: Preset = {
  layers: [
    { type: "sawtooth", detuneCents: 0, gain: 0.58, role: "core" },
    { type: "square", detuneCents: 6, gain: 0.27, role: "color" },
    { type: "sawtooth", detuneCents: -8, gain: 0.15, role: "color" },
  ],
  filterFrequencyByVoice: { soprano: 3400, alto: 2800, tenor: 1800, bass: 1100 },
  filterQ: 1.0,
  filterBrightnessRange: 0.35,
  brightnessByVoice: BRASS_BRIGHTNESS_BY_VOICE,
  vibratoCentsByVoice: { soprano: 7, alto: 6, tenor: 5, bass: 3 },
  vibratoOnsetSeconds: 0,
  attackScale: 1,
  releaseSeconds: RELEASE_SECONDS,
  releaseTimeConstantSeconds: RELEASE_TIME_CONSTANT_SECONDS,
  saturationCurve: makeSaturationCurve(0.22),
  scoopCents: 9,
  scoopSeconds: 0.045,
  transientSeconds: 0.07,
  transientPeakMultiplierByVoice: { soprano: 1.6, alto: 1.45, tenor: 1.3, bass: 1.15 },
};

// Symphonic Strings (Part B, section 9): warm/bowed/evolving — deliberately
// not "brass with a lower filter." A triangle-led unison (instead of brass's
// saw+square) is the fundamental timbral difference; a slower bow-swell
// attack, delayed vibrato onset, a subtle filtered bow-noise burst, and a
// longer settling release are the bowed-specific character on top of that.
const STRINGS_BRIGHTNESS_BY_VOICE: Record<Voice, number> = { soprano: 1, alto: 0.8, tenor: 0.6, bass: 0.4 };
const STRINGS_RELEASE_SECONDS = RELEASE_SECONDS * 1.5;
const STRINGS_RELEASE_TIME_CONSTANT_SECONDS = RELEASE_TIME_CONSTANT_SECONDS * 1.5;

const STRINGS_PRESET: Preset = {
  layers: [
    { type: "triangle", detuneCents: 0, gain: 0.5, role: "core" },
    { type: "sawtooth", detuneCents: -5, gain: 0.3, role: "color" },
    { type: "sawtooth", detuneCents: 6, gain: 0.2, role: "color" },
  ],
  filterFrequencyByVoice: { soprano: 2600, alto: 2000, tenor: 1300, bass: 800 },
  filterQ: 0.7,
  filterBrightnessRange: 0.08,
  brightnessByVoice: STRINGS_BRIGHTNESS_BY_VOICE,
  vibratoCentsByVoice: { soprano: 16, alto: 14, tenor: 11, bass: 6 },
  vibratoOnsetSeconds: 0.4,
  attackScale: 1.6,
  releaseSeconds: STRINGS_RELEASE_SECONDS,
  releaseTimeConstantSeconds: STRINGS_RELEASE_TIME_CONSTANT_SECONDS,
  saturationCurve: makeSaturationCurve(0.05),
  noiseAmount: 0.05,
  noiseByVoice: { soprano: 1, alto: 0.85, tenor: 0.6, bass: 0.35 },
};

function presetFor(ensemble: Ensemble): Preset {
  return ensemble === "brass" ? BRASS_PRESET : STRINGS_PRESET;
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Ramps an AudioParam to `value` by `targetTime`, explicitly pinning its
 *  current (possibly still-ramping) value at `now` first, then holding flat
 *  until `now + SCHEDULING_LOOKAHEAD_SECONDS` before the ramp actually
 *  starts. The hold-flat step is what gives the audio render thread
 *  guaranteed lead time to enqueue the change (see SCHEDULING_LOOKAHEAD_SECONDS
 *  above) without producing any audible jump, since the held value is
 *  identical to what the param was already doing. Reading `.value` and
 *  re-asserting it before the ramp is what makes this safe to call
 *  repeatedly in quick succession (every pointer move, or a corner arriving
 *  mid-crossfade) without relying on `cancelAndHoldAtTime` support: a bare
 *  `cancelScheduledValues` alone does not guarantee the param holds its
 *  current interpolated value, which is what produced audible zipper/steps
 *  under rapid successive calls. */
function rampParam(param: AudioParam, value: number, now: number, targetTime: number): void {
  const current = param.value;
  const scheduledNow = now + SCHEDULING_LOOKAHEAD_SECONDS;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.setValueAtTime(current, scheduledNow);
  param.linearRampToValueAtTime(value, targetTime + SCHEDULING_LOOKAHEAD_SECONDS);
}

/** Same safe cancel-then-reassert-then-lookahead pattern as `rampParam`, but
 *  decays exponentially toward `floor` instead of linearly to an exact
 *  target — used for pointer-release, where a natural decaying tail (not a
 *  visibly linear cut) is the point. `setTargetAtTime` only approaches
 *  `floor` asymptotically; the caller schedules cleanup a fixed time later
 *  rather than waiting for an exact-equality target that will never
 *  arrive. */
function releaseParam(param: AudioParam, floor: number, now: number, timeConstant: number): void {
  const current = param.value;
  const scheduledNow = now + SCHEDULING_LOOKAHEAD_SECONDS;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.setValueAtTime(current, scheduledNow);
  param.setTargetAtTime(floor, scheduledNow, timeConstant);
}

type VoiceRole = "current" | "fading";

type ActiveVoice = {
  oscillators: OscillatorNode[];
  layerGains: GainNode[];
  shaper: WaveShaperNode;
  filter: BiquadFilterNode;
  levelGain: GainNode;
  envelopeGain: GainNode;
  vibratoScaleGain: GainNode;
  vibratoOnsetGain: GainNode;
  maxVibratoCents: number;
  baseFilterFrequency: number;
  filterBrightnessRange: number;
  releaseSeconds: number;
  releaseTimeConstantSeconds: number;
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
  private noiseBuffer: AudioBuffer | null = null;
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

      // Dev-only diagnostic (stripped from production by Vite's
      // `import.meta.env.DEV` inlining, same as main.ts): logs every
      // AudioContext state transition. On Mac Safari specifically, this is
      // what would reveal repeated suspend/resume or an `interrupted` state
      // as the actual cause of a corner-to-audio delay, rather than
      // guessing at one.
      if (import.meta.env.DEV) {
        context.addEventListener("statechange", () => {
          // eslint-disable-next-line no-console
          console.debug(`[timing] AudioContext state -> ${context.state} at performance.now()=${performance.now().toFixed(2)}`);
        });
      }
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

  /** Begins sustaining a chord from silence (pointer-down): a gentle fade-in
   *  (GESTURE_START_ATTACK_SECONDS), distinct from the fast attack a
   *  mid-gesture corner gets in changeChord(). Any leftover voices from an
   *  incomplete previous release are cut short first — this should not
   *  normally happen, since release only starts on pointer-up. */
  startChord(event: ChordEvent): void {
    if (!this.context || !this.masterHighpass) return;
    for (const voice of this.activeVoices.filter((v) => v.role === "current")) {
      this.fadeOutVoice(voice, STEAL_FADE_SECONDS);
    }
    const preset = presetFor(event.ensemble);
    for (const note of event.notes) this.createVoice(note, preset, GESTURE_START_ATTACK_SECONDS);
  }

  /** Crossfades from the currently-sustaining chord to a new one (a
   *  confirmed corner), scheduled directly and synchronously off
   *  `context.currentTime` — never behind a React render, effect,
   *  `setTimeout`, `requestAnimationFrame`, or promise. The incoming chord
   *  is made audible fast (INCOMING_ATTACK_SECONDS) while the outgoing
   *  chord lingers longer (OUTGOING_FADE_SECONDS) — the two durations are
   *  deliberately different, not one shared "crossfade" window (see the
   *  constants' comments). The incoming chord also gets a guaranteed
   *  presence floor so a momentary dip in speed-driven volume right at the
   *  turn can't silence the very thing announcing the corner. */
  changeChord(event: ChordEvent): void {
    if (!this.context || !this.masterHighpass) return;
    if (this.activeVoices.every((v) => v.role !== "current")) {
      this.startChord(event);
      return;
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug(
        `[timing] audio engine received chord at performance.now()=${performance.now().toFixed(2)}, context.currentTime=${this.context.currentTime.toFixed(4)}, scheduled start=${(this.context.currentTime + SCHEDULING_LOOKAHEAD_SECONDS).toFixed(4)}`,
      );
    }
    this.crossfadeToCurrent(event);
  }

  /** Re-voices the chord currently sustaining under a new ensemble preset,
   *  using the exact same crossfade timing as a confirmed corner
   *  (changeChord above) — so switching Brass/Strings mid-hold is audible
   *  immediately rather than waiting for the next corner. A no-op when
   *  nothing is currently sustaining: toggling the ensemble control while
   *  idle must never start sound playing on its own. */
  retimbreChord(event: ChordEvent): void {
    if (!this.context || !this.masterHighpass) return;
    if (this.activeVoices.every((v) => v.role !== "current")) return;
    this.crossfadeToCurrent(event);
  }

  private crossfadeToCurrent(event: ChordEvent): void {
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
   *  (0-1) drives the shared LFO's per-voice modulation depth. Brass also
   *  brightens its filter with rising level ("movement-linked filter
   *  brightness", Part B section 8); strings brightens far less
   *  (filterBrightnessRange is small — see STRINGS_PRESET), keeping its
   *  tone evolving gently rather than snapping bright. Only the
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
      if (voice.filterBrightnessRange > 0) {
        const brightnessTarget =
          voice.baseFilterFrequency * (1 - voice.filterBrightnessRange / 2 + voice.filterBrightnessRange * level);
        rampParam(voice.filter.frequency, brightnessTarget, now, levelTarget);
      }
    }
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = Math.max(1, Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    return this.noiseBuffer;
  }

  /** A brief, filtered noise burst under a string note's attack (Part B
   *  section 9) — bow friction texture, not broadband hiss: band-limited
   *  around the note's own pitch, low peak gain, and gone again well before
   *  the note settles into its sustained tone. A no-op for presets without
   *  noiseAmount (brass has none at all). */
  private playBowNoiseBurst(note: VoicedNote, preset: Preset, startAt: number, attackSeconds: number): void {
    const context = this.context;
    const masterHighpass = this.masterHighpass;
    if (!context || !masterHighpass || !preset.noiseAmount) return;
    const amount = preset.noiseAmount * (preset.noiseByVoice?.[note.voice] ?? 1);
    if (amount <= 0) return;

    const source = context.createBufferSource();
    source.buffer = this.getNoiseBuffer(context);

    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = midiToFrequency(note.midi) * 3;
    noiseFilter.Q.value = 0.8;

    const noiseGain = context.createGain();
    const noiseAttack = Math.min(0.03, attackSeconds * 0.3);
    noiseGain.gain.setValueAtTime(0, startAt);
    noiseGain.gain.linearRampToValueAtTime(amount, startAt + noiseAttack);
    noiseGain.gain.linearRampToValueAtTime(0, startAt + attackSeconds);

    source.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterHighpass);
    source.start(startAt);

    const stopAt = startAt + attackSeconds + 0.05;
    try {
      source.stop(stopAt);
    } catch {
      // already scheduled to stop — nothing to do.
    }
    source.addEventListener(
      "ended",
      () => {
        noiseGain.disconnect();
        noiseFilter.disconnect();
        source.disconnect();
      },
      { once: true },
    );
  }

  private createVoice(note: VoicedNote, preset: Preset, attackSeconds: number, levelOverride?: number): void {
    const context = this.context;
    const masterHighpass = this.masterHighpass;
    if (!context || !masterHighpass) return;
    this.stealOldestIfAtCap();

    const now = context.currentTime;
    const startAt = now + SCHEDULING_LOOKAHEAD_SECONDS;
    const voice = note.voice;
    const baseFrequency = midiToFrequency(note.midi);
    const brightness = preset.brightnessByVoice[voice];

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    const baseFilterFrequency = preset.filterFrequencyByVoice[voice];
    filter.frequency.value = baseFilterFrequency;
    filter.Q.value = preset.filterQ;
    // Brief brighter attack transient (brass only): the filter opens up
    // above its steady-state cutoff for an instant, then settles — a
    // breath-driven "bite" at the front of the note rather than a flat
    // onset. Scaled down toward the bass voices, same as the scoop below.
    if (preset.transientSeconds && preset.transientPeakMultiplierByVoice) {
      const peak = baseFilterFrequency * preset.transientPeakMultiplierByVoice[voice];
      filter.frequency.setValueAtTime(peak, startAt);
      filter.frequency.linearRampToValueAtTime(baseFilterFrequency, startAt + preset.transientSeconds);
    }

    const shaper = context.createWaveShaper();
    shaper.curve = preset.saturationCurve;

    const oscillators: OscillatorNode[] = [];
    const layerGains: GainNode[] = [];
    for (const layer of preset.layers) {
      const oscillator = context.createOscillator();
      oscillator.type = layer.type;
      oscillator.frequency.value = baseFrequency;
      // Subtle pitch instability at onset (brass only): each layer starts a
      // little flat and settles up to its steady unison detune — a
      // breath-driven "scoop" rather than a perfectly tuned attack.
      if (preset.scoopCents && preset.scoopSeconds) {
        const scoop = preset.scoopCents * (0.5 + 0.5 * brightness);
        oscillator.detune.setValueAtTime(layer.detuneCents - scoop, startAt);
        oscillator.detune.linearRampToValueAtTime(layer.detuneCents, startAt + preset.scoopSeconds);
      } else {
        oscillator.detune.value = layer.detuneCents;
      }

      const layerGain = context.createGain();
      // Only the colour layers vary with per-voice brightness — the core
      // layer always carries the fundamental at full weight.
      layerGain.gain.value = layer.role === "core" ? layer.gain : layer.gain * brightness;

      oscillator.connect(layerGain);
      layerGain.connect(shaper);
      oscillator.start(startAt);

      oscillators.push(oscillator);
      layerGains.push(layerGain);
    }
    shaper.connect(filter);

    const levelGain = context.createGain();
    levelGain.gain.value = levelOverride ?? this.currentLevel;

    const envelopeGain = context.createGain();
    envelopeGain.gain.setValueAtTime(0, startAt);
    const effectiveAttackSeconds = attackSeconds * preset.attackScale;
    envelopeGain.gain.linearRampToValueAtTime(VOICE_RELATIVE_GAIN[voice], startAt + effectiveAttackSeconds);

    const vibratoScaleGain = context.createGain();
    vibratoScaleGain.gain.value = this.currentVibratoIntensity * preset.vibratoCentsByVoice[voice];

    // Vibrato onset (Part B section 9): brass reaches its requested vibrato
    // depth immediately; strings fades depth in from 0 over
    // vibratoOnsetSeconds — a bowed note settles into vibrato rather than
    // starting with it. Chained after vibratoScaleGain so the two multiply:
    // final depth = (gesture-driven intensity * per-voice max) * onset ramp.
    const vibratoOnsetGain = context.createGain();
    if (preset.vibratoOnsetSeconds > 0) {
      vibratoOnsetGain.gain.setValueAtTime(0, startAt);
      vibratoOnsetGain.gain.linearRampToValueAtTime(1, startAt + preset.vibratoOnsetSeconds);
    } else {
      vibratoOnsetGain.gain.value = 1;
    }

    filter.connect(levelGain);
    levelGain.connect(envelopeGain);
    envelopeGain.connect(masterHighpass);

    if (this.lfoOsc) {
      this.lfoOsc.connect(vibratoScaleGain);
      vibratoScaleGain.connect(vibratoOnsetGain);
      for (const oscillator of oscillators) vibratoOnsetGain.connect(oscillator.detune);
    }

    this.playBowNoiseBurst(note, preset, startAt, effectiveAttackSeconds);

    this.activeVoices.push({
      oscillators,
      layerGains,
      shaper,
      filter,
      levelGain,
      envelopeGain,
      vibratoScaleGain,
      vibratoOnsetGain,
      maxVibratoCents: preset.vibratoCentsByVoice[voice],
      baseFilterFrequency,
      filterBrightnessRange: preset.filterBrightnessRange,
      releaseSeconds: preset.releaseSeconds,
      releaseTimeConstantSeconds: preset.releaseTimeConstantSeconds,
      role: "current",
    });
  }

  private disconnectVoice(voice: ActiveVoice): void {
    voice.envelopeGain.disconnect();
    voice.filter.disconnect();
    voice.levelGain.disconnect();
    voice.vibratoScaleGain.disconnect();
    voice.vibratoOnsetGain.disconnect();
    voice.shaper.disconnect();
    for (const layerGain of voice.layerGains) layerGain.disconnect();
    for (const oscillator of voice.oscillators) oscillator.disconnect();
    this.activeVoices = this.activeVoices.filter((v) => v !== voice);
  }

  private fadeOutVoice(voice: ActiveVoice, fadeSeconds: number): void {
    const context = this.context;
    if (!context) return;
    voice.role = "fading";

    const now = context.currentTime;
    // Preserve whatever gain this voice is already at (mid-attack, mid-crossfade,
    // or fully sustained) and ramp smoothly from there — never a jump to 0.
    rampParam(voice.envelopeGain.gain, 0, now, now + fadeSeconds);

    const stopAt = now + fadeSeconds + SCHEDULING_LOOKAHEAD_SECONDS + 0.02;
    for (const oscillator of voice.oscillators) {
      try {
        oscillator.stop(stopAt);
      } catch {
        // already scheduled to stop — nothing to do.
      }
    }

    voice.oscillators[0].addEventListener("ended", () => this.disconnectVoice(voice), { once: true });
  }

  /** Pointer-up release: an exponential decay toward near-silence, holding
   *  from whatever gain the chord was already at — a natural "settling" tail
   *  rather than the visibly linear cut a fixed-duration `linearRampToValueAtTime`
   *  produces. Duration/time-constant come from the voice's own preset (see
   *  ActiveVoice.releaseSeconds) — strings settles noticeably slower than
   *  brass. Cleanup (stop/disconnect) is scheduled only once the decay has
   *  had the full release duration to become inaudible, not the moment the
   *  ramp is scheduled. */
  private releaseVoice(voice: ActiveVoice): void {
    const context = this.context;
    if (!context) return;
    voice.role = "fading";

    const now = context.currentTime;
    releaseParam(voice.envelopeGain.gain, RELEASE_FLOOR, now, voice.releaseTimeConstantSeconds);

    const stopAt = now + voice.releaseSeconds + SCHEDULING_LOOKAHEAD_SECONDS;
    for (const oscillator of voice.oscillators) {
      try {
        oscillator.stop(stopAt);
      } catch {
        // already scheduled to stop — nothing to do.
      }
    }

    voice.oscillators[0].addEventListener("ended", () => this.disconnectVoice(voice), { once: true });
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
    for (const oscillator of oldest.oscillators) {
      try {
        oscillator.stop(now + STEAL_FADE_SECONDS + SCHEDULING_LOOKAHEAD_SECONDS + 0.01);
      } catch {
        // already scheduled to stop — nothing to do.
      }
    }
  }
}
