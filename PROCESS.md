# Process overview

A reading-guide to how the work came together, following
`C4_MVP_BUILD_PROMPT.md`'s scope and build order.

## What I built

The Living Score is a browser instrument conducted with pointer or touch.
Movement speed shapes dynamics, same-axis reversals add vibrato, and a clear
corner advances a chord chosen by a small Markov harmony system. Each chord is
voiced by a fixed four-part table and drives both the Web Audio ensemble and a
real four-stave SVG conductor score from the same `ChordEvent`. The player can
switch between distinct synthetic Brass Choir and Symphonic Strings presets
with two visible controls or the `1`/`2` keys. The current concert-pitch notes,
clefs, accidentals and ledger lines update together, while a visible baton
follows and rotates with the conducting gesture. There is no score history,
rhythm notation, keyboard conducting, or Clear/reset control in the final UI.

## The moments that mattered

1. **The core signal chain landed as one vertical slice, not stage-by-stage.**
   Rather than building a placeholder chord first and wiring harmony/voicing
   in later, I wrote the whole pipeline in one pass — `harmony.ts` (Markov
   transitions + chord-colour sampling, derived from the corpus rather than
   hand-copied from the published percentage table) through `voicing.ts`
   (fixed table, pitch-name-to-MIDI), `audio.ts` (Brass Choir synthesis with
   a capped, voice-stealing polyphony pool), and `visualization.ts` (the
   transient chord animation), all sharing one `ChordEvent`. I checked this
   was right by writing the harmony tests against the *published* transition
   table (section 7) as a fixture, not as the implementation itself — every
   state's derived probabilities matched within rounding tolerance, and a
   dedicated test asserts `IV` and `iv` are never confused.
   ([`70e2079`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Asuka121380/commit/70e2079))
2. **The polyphony cap didn't actually cap anything on the first pass.**
   `stealOldestIfAtCap` marked the oldest voice `stopped` but left it in the
   `activeVoices` array until the browser's `ended` event fired later, so
   under rapid triggering (four notes per chord, many chords per second) the
   pool grew past the documented limit before cleanup caught up. A test that
   fires 30 chords through a fake `AudioContext` and asserts the pool never
   exceeds `MAX_ACTIVE_VOICES` caught this immediately (`20` active voices
   against a cap of `16`) — the fix was to remove the stolen voice from the
   bookkeeping array the instant it's stolen, not wait for `ended`. Recorded
   as a fact in `CLAUDE.md` so a later session doesn't reintroduce it.
   ([`70e2079`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Asuka121380/commit/70e2079))
3. **`CLAUDE.md` carried a wrong fact forward.** It claimed this repo's
   `tsconfig.json` rejects `.ts` extensions in imports; reading the actual
   file showed `allowImportingTsExtensions: true`. Corrected the note rather
   than silently working around it, and added a fact about `include`'s bare
   `*.ts` glob only matching root-level files (so every module stays flat at
   the repo root, not under `src/`) before it could cause a confusing
   "file not typechecked" surprise later.
   ([`70e2079`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-Asuka121380/commit/70e2079))

## Verification status as of the MVP commit

- `pnpm check` was green: 57 tests pass, including the pre-existing crit-4
  contract tests (Web Audio synthesis present, no `<audio>`/`<video>`
  fallback, pointer *and* keyboard input both wired) and the invariants.
- **Not yet done at that point**: any real-browser interaction test, any
  mobile/touch device test, any viewport check at 1920×1080 or 390×844, and
  deployment. `pnpm preview` was used only to confirm the built page serves
  valid markup; no audio or gesture behaviour had been observed running.
- The MVP was subsequently deployed to GitHub Pages (repo made public, Pages
  enabled, CI green) and the live URL was verified with `curl`.

## Refinement: sustained pointer-lifecycle audio + axis-based gesture model

Following `C4_GESTURE_AUDIO_UI_REFINEMENT_PROMPT.md`, the MVP's timed
one-shot chords and distance-threshold triggering were replaced with the
interaction model that document specifies: `pointer down → sustain current
chord → speed controls volume → same movement axis keeps harmony →
same-axis reversal increases vibrato → confirmed corner advances harmony →
audio and displayed notation update from the same voicing object → pointer
up releases the chord`. The prompt's own ordering instruction ("do not let
notation or visual polish block deployment of the corrected audio and
gesture model") was followed deliberately: this pass covers only the
audio/gesture vertical slice (steps 1-7 of the refinement's priority list);
the notation renderer, ensemble icon buttons, obsolete-instruction removal,
and baton/visual-reference work are still pending and are the next slice.

1. **`audio.ts` was rewritten around sustained voices, not timed envelopes.**
   `AudioEngine.startChord`/`.changeChord`/`.releaseChord` now track a flat,
   role-tagged (`"current" | "fading"`) `activeVoices` array instead of
   firing a fixed-duration chord per trigger. A confirmed corner crossfades
   the previous chord out while the new one comes in, and the polyphony cap
   dropped from 16 (four-per-chord, multiple overlapping one-shots) to 8
   (four for the current chord, four for at most one fading-out generation)
   because sustained chords no longer need headroom for several overlapping
   one-shots at once. The MVP's proven fix — remove a stolen voice from the
   bookkeeping array immediately, don't wait for the browser's `ended` event
   — was reused and generalised so it also governs the crossfade-out path; a
   new stress test in `spec/audio.test.ts` runs 30 corners across 7 chord
   symbols and a second asserts two back-to-back `changeChord` calls never
   let three generations coexist (would show 12 voices; caps at 8).
2. **Voice balance and speed-to-volume are now separate, composable
   controls.** A static per-voice relative-gain table (soprano 1.00 / alto
   0.75 / tenor 0.52 / bass 0.33) is baked into each voice's envelope peak so
   the bass never dominates regardless of how loud the chord is overall; a
   pure, independently-tested `speedToLevel` function maps pointer speed to
   an overall level with a held-minimum floor (holding still never goes
   silent) and is applied continuously via `linearRampToValueAtTime`, not as
   a step function.
3. **`gesture.ts` is a new, pure, DOM-free module replacing the old
   accumulated-distance trigger.** It computes a movement axis modulo 180°
   (so a line and its reverse are the same axis), requires both an angle
   deviation and a sustained distance/time before confirming a corner (so a
   gentle curve or hand jitter doesn't retrigger harmony), and separately
   tracks same-axis reversal as a decaying vibrato intensity rather than a
   harmony change. Being pure and DOM-independent meant this could be
   verified with synthetic pointer traces (`spec/gesture.test.ts`: straight
   lines, jitter, reversals, a clean corner, a cooldown-guarded second turn,
   two well-separated corners, a slow arc) instead of only by feel.
   **Bug found and fixed during this**: the very first qualifying sample had
   only one point in its direction-estimation window, so `dx=dy=0` and the
   axis came out as a degenerate 0° — locked in as the gesture's real axis
   regardless of its actual direction, which would have falsely registered a
   corner on the second sample of almost any diagonal gesture. Fixed by
   requiring at least two points in the window before computing an axis.
4. **Vibrato is one shared LFO, not one per voice.** A single sine
   oscillator at ~5.5Hz, created once and never stopped, fans out through a
   per-voice gain node into each oscillator's `detune` AudioParam — the
   standard Web Audio parameter-modulation pattern — scaled per pointer move
   by the gesture analyzer's decaying reversal-intensity signal.
5. **A TypeScript narrowing bug surfaced while rewiring `main.ts`.** Three
   helper functions that read DOM elements already null-checked by an outer
   `if` were declared with `function`, and `tsc --noEmit` still reported them
   as possibly `null` — TypeScript doesn't propagate narrowing from an
   enclosing block into a *hoisted* function declaration's body. Converting
   them to `const fn = (...) => {...}` arrow expressions (matching the
   pattern the rest of the file already used for its callbacks) restored the
   narrowing and cleared the error.
6. **Space/arrow-key conducting and the distance-threshold trigger were
   removed outright**, not kept behind a flag — `interaction.ts` now
   recognises only pointer lifecycle plus `1`/`2` keydown shortcuts for
   ensemble selection, per the refinement prompt's explicit "do not restore
   Clear or keyboard conducting" constraint (keyboard input for ensemble
   selection is retained deliberately, to keep the "more than one input
   modality" contract satisfied). The `index.html` aria-label and
   keyboard-hint text, which had gone stale the moment Space/arrow handling
   was removed, were corrected in the same pass so the shipped interim state
   doesn't mislead a user about how to operate it — the Clear button and
   single-toggle ensemble button themselves are unchanged for now; their
   removal/replacement is part of the still-pending notation/UI slice.

## Verification status after the first shipped refinement

- `pnpm check` was green: **9 test files, 82 tests passing**, including new
  suites for `gesture.ts` (axis/corner/vibrato, all synthetic-trace-driven)
  and the rewritten `audio.ts` (sustained-voice lifecycle, cap-under-stress,
  crossfade-generation limits), plus additions to `spec/voicing.test.ts`
  (exact-G7 voicing, `diatonicStep`/`parsePitchName` behaviour).
- This was deployed and the live URL was verified to serve the updated
  bundle. A human listening/gesture pass then reported three feel issues
  (see below) — none of which any of the above tests could have caught,
  since they're about *timing feel*, not correctness of the state machine.

## Tuning pass: corner latency, release smoothness, volume response

A real listening/gesture pass on the deployed refinement reported three
concrete problems, each addressed directly:

1. **Corner-to-chord latency was ~500ms — too slow to feel responsive.**
   `gesture.ts`'s direction-window and corner-confirmation thresholds were
   tuned down: `DIRECTION_WINDOW_MS` 100→60, `CORNER_CANDIDATE_DEG` 40→32,
   `CORNER_CANCEL_DEG` 20→16 (kept at half the candidate angle),
   `CONFIRM_DISTANCE_PX` 24→14, `CONFIRM_TIME_MS` 75→40,
   `CHORD_CHANGE_COOLDOWN_MS` 150→90 — a clear L-turn now confirms within a
   bounded, tested latency (`spec/gesture.test.ts` asserts under 150ms from
   the start of the new heading), while the existing jitter/gentle-curve
   tests (unchanged) still pass at the tighter thresholds, confirming the
   detector didn't just get twitchier along with faster. `audio.ts`'s
   crossfade window was also tightened (130ms→100ms) since `changeChord`
   already started the incoming chord immediately from
   `context.currentTime` — the latency was entirely in gesture confirmation,
   not audio scheduling, which is worth having actually checked rather than
   assumed.
2. **Pointer release read as abrupt.** The release path already preserved
   gain and ramped rather than cutting, but relied on
   `cancelAndHoldAtTime`/`cancelScheduledValues` directly, which doesn't
   reliably hold an in-flight ramping value across browsers. Replaced with a
   shared `rampParam` helper used everywhere a voice's gain is ramped
   (release, crossfade-out, cap-steal): it reads the param's current value,
   re-asserts it with `setValueAtTime`, then ramps — a defensive pattern that
   doesn't depend on `cancelAndHoldAtTime` support. Release duration went
   130ms→400ms (crossfade stayed short; release is the one that should feel
   like a tail, not a cut). A new test asserts the ramp-to-zero call is
   immediately preceded by a `setValueAtTime` reasserting the pre-release
   gain (not 0), and that the oscillator's `stop()` is scheduled for a later
   time, not called for "now."
3. **Speed-to-volume still felt jumpy.** Two causes, both fixed: (a)
   `setExpression` was issuing a bare `linearRampToValueAtTime` on every
   pointer move without cancelling the previous move's still-pending ramp,
   so overlapping automation events could produce a sawtooth-like volume
   under rapid movement — fixed by routing through the same `rampParam`
   helper. (b) volume response is now asymmetric: rising faster (~50ms) than
   falling (~100ms), so a momentary dip in the smoothed speed reading (hand
   pausing mid-gesture) doesn't read as a stutter. A test drives
   `setExpression` with a rise then a fall and asserts the fall's scheduled
   ramp target is later (slower) than the rise's. Separately, `gesture.ts`
   now clamps any single instantaneous speed sample above
   `MAX_INSTANTANEOUS_SPEED_PX_S` before it reaches the EMA, so one
   event-rate/coalescing glitch can't punch a spike through the smoothed
   speed the volume is driven from — tested by injecting one wildly
   out-of-place sample into an otherwise steady trace and confirming the
   smoothed speed neither exceeds the clamp nor stays pinned near it once
   normal movement resumes.

## Verification status (honest, as of this tuning pass)

- `pnpm check` is green: **9 test files, 86 tests passing** (4 new: corner
  latency bound, speed-spike clamp, release-preserves-gain, asymmetric
  rise/fall ramp targets).
- **Not yet done**: a second real-device listening/gesture pass confirming
  these three fixes actually feel right — the new tests check the mechanism
  (ramp sequencing, latency bound, clamp behaviour) against synthetic fakes,
  not the felt result on a phone. Notation rendering, the two ensemble icon
  buttons, Clear-button removal, and the baton/visual-reference restyle are
  still not built.
- Deployed: commit `d66faf4` pushed to `main`, CI run `32811004086`
  completed with `conclusion=success`. Verified the live URL
  (`https://comp4020-agentic-coding-studio.github.io/comp4020-crit4-Asuka121380/`)
  serves this exact build — downloaded the live `index-CgvIYUQI.js` and
  diffed it byte-for-byte against a clean local `pnpm build` output; they
  are identical, and the bundle contains the new spike-clamp constant
  (`4000` minified to `4e3`).
- Second listening/gesture checkpoint requested from the user (sharp
  corner, gentle curve, jitter, slow-to-fast, fast-to-slow, release at low
  and high volume) — awaiting their retest before starting the notation/UI
  slice, per their explicit instruction not to begin it until these three
  feel issues are retested and confirmed.

## Failed tuning attempt: diagnosis and architectural rework

The second checkpoint came back negative: the user reported the deployed
tuning pass "still does not feel meaningfully better" and explicitly framed
it as a **failed tuning attempt requiring diagnosis and rework, not another
small constants-only adjustment** — with five concrete complaints (corner
detection too permissive, audible chord change still lagging visibly behind
corner confirmation, release still too abrupt, speed-to-volume still stepped,
overall feel too close to pre-tuning). This section documents the actual
investigation, because the previous round's mistake was tuning constants
without first confirming where in the pipeline the delay lived.

1. **Measured the confirmation→invocation leg directly, instead of assuming
   it was fine.** Grepped every app module (`gesture.ts`, `audio.ts`,
   `interaction.ts`, `main.ts`, `chordEvent.ts`, `harmony.ts`, `voicing.ts`)
   for `requestAnimationFrame`/`setTimeout`/`Promise`/`async`/`await` — the
   only hits are in `visualization.ts`'s decorative fading-dot animation,
   called *after* `audioEngine.changeChord()` has already run. There is no
   framework in this app to defer through (no React, no render/effect
   cycle). Added dev-only `performance.now()` instrumentation around the
   confirmed-corner branch in `main.ts`, gated by `import.meta.env.DEV` (Vite
   inlines this to `false` in production, so esbuild/terser dead-code-
   eliminate the whole branch — confirmed empirically by grepping the built
   bundle for the debug string and for any `console` reference at all: zero
   hits either way). **Conclusion: the confirmation→invocation leg was
   already same-tick.** The felt latency was never there — it was
   downstream, in the shape of the audio graph's crossfade itself.
2. **Root cause: a shared crossfade duration was masking the new chord, and
   the new chord's starting volume could coincide with a natural dip.**
   `changeChord` previously ramped the incoming and outgoing chords over one
   shared ~100ms constant. Because a linear 0→target ramp spends most of its
   early duration at low, easily masked amplitude, the incoming chord wasn't
   perceptually dominant until nearly the full 100ms had elapsed, while the
   still-loud outgoing chord masked it throughout — a real, structural cause
   of the reported post-confirmation lag, not something a tighter gesture
   threshold could ever fix. Separately, a hand naturally decelerates while
   pivoting through a sharp corner, so the continuously speed-driven
   `currentLevel` (which the incoming voice's starting volume was tied to)
   is often at its lowest exactly when a corner fires — silencing the very
   sound meant to announce the change. **Both fixes were architectural, not
   constants-only**: split `INCOMING_ATTACK_SECONDS` (0.04s) from
   `OUTGOING_FADE_SECONDS` (0.13s) so the new chord establishes fast while
   the old one can fade more slowly without adding felt latency; added
   `CORNER_PRESENCE_FLOOR` (0.5) applied only to the incoming voice's
   initial level at chord-change time, so a corner never starts on a
   near-silent dip.
3. **Found and fixed a genuine state-leakage bug, not previously
   suspected.** `GestureAnalyzer.reset()` had been deliberately preserving
   `lastChangeAt` (the chord-change cooldown timestamp) across gesture
   boundaries, on the theory that the cooldown is a real-time guard. On
   inspection this is a real bug matching the user's own diagnostic
   question ("cooldown logic delaying the current confirmed chord instead
   of only blocking later triggers"): a stale cooldown from the end of one
   gesture could suppress the very first corner of a brand-new gesture
   (release, then immediately start a new phrase with an immediate turn).
   Fixed by resetting `lastChangeAt = -Infinity` in `reset()`. A new test
   (`spec/gesture.test.ts`) runs a first gesture to a confirmed corner,
   calls `reset()`, then runs a second gesture with its own corner inside
   the old cooldown window, and asserts it still fires.
4. **Verified, rather than assumed, that gain automation wasn't stale.**
   `rampParam` already reads the AudioParam's current value before
   scheduling every non-release ramp, so no change was needed there — this
   is recorded as a finding, not left as an unstated assumption.
5. **Release reworked from a fixed-duration linear ramp to an exponential
   decay.** `releaseChord` now calls a new `releaseVoice`, which holds the
   current gain and uses `AudioParam.setTargetAtTime(RELEASE_FLOOR, now,
   RELEASE_TIME_CONSTANT_SECONDS)` — floor `0.0001`, time constant `0.17s`,
   oscillators stopped only after the full `RELEASE_SECONDS` (0.85s) tail —
   instead of `linearRampToValueAtTime` over a fixed duration. A visibly
   linear ramp reads as a cut regardless of length; an exponential decay
   reads as settling. A new test asserts the release schedules
   `setTargetAtTime` toward the floor (preceded by `setValueAtTime`
   reasserting the pre-release gain) and asserts no `linearRampToValueAtTime`
   call to 0 exists on that path.
6. **Corner-detection thresholds restored to conservative values within the
   user's specified ranges**, per their explicit "do not lower thresholds
   further" — `DIRECTION_WINDOW_MS` 60→75, `CORNER_CANDIDATE_DEG` 32→40,
   `CORNER_CANCEL_DEG` 16→20, `CONFIRM_DISTANCE_PX` 14→20, `CONFIRM_TIME_MS`
   40→55, `CHORD_CHANGE_COOLDOWN_MS` 90→110. All pre-existing
   discrimination tests (jitter, gentle curve, same-axis reversal, cooldown
   non-retrigger) re-verified passing at these tighter values — the fix for
   felt latency lives entirely in item 2 above, not in loosening detection.
7. **Speed-to-volume rise/fall retuned within the user's specified
   ranges**: `LEVEL_RISE_SECONDS` 0.05→0.09, `LEVEL_FALL_SECONDS` 0.1→0.18.
   Confirmed (rather than assumed) that `SPEED_SMOOTHING_MS` (raw-speed EMA)
   and `DIRECTION_WINDOW_MS` (corner-axis window) were already structurally
   separate constants — addressing the user's concern about shared
   smoothing windows by verification, not restructuring, since they were
   never actually coupled.
8. **New tests added** covering exactly the items the user's checkpoint
   asked for: incoming chord audible much faster than outgoing fades;
   corner-presence floor guarantees a minimum incoming level even after a
   low-speed dip; exponential-decay release (no linear-to-zero ramp exists);
   cooldown does not leak across a `reset()` gesture boundary;
   `setExpression` cancels a previous move's pending ramp before scheduling
   a new one instead of stacking automation events. All pre-existing tests
   (straight-line, jitter, reversal, clean 90° corner, cooldown
   non-retrigger, two well-separated corners, corner-latency-under-150ms,
   speed-spike clamp, gentle-curve non-burst-fire) unchanged and re-verified
   passing under the new thresholds.

### Verification status (honest, as of this rework)

- `pnpm check` is green: **9 test files, 90 tests passing** (4 new since the
  previous tuning pass).
- **Structurally verified** (not merely asserted): the corner-
  confirmation→`changeChord()` invocation leg is same-tick (no timers, no
  framework render cycle in this codebase at all); the dev-only timing
  instrumentation is fully absent from the production bundle (grepped for
  both the literal debug string and any `console` reference — zero hits).
- **Not yet done**: a third real-device listening/gesture pass. Every fix in
  this section addresses a specific, named complaint from the user's
  message with a structural cause, not a guessed constant — but per their
  explicit instruction, none of this is being claimed as *resolved* until
  they retest the deployed build against the eight gestures they specified
  (sharp L-shape, gentle continuous curve, small hand jitter, reversal along
  the same straight axis, slow→fast→slow, release while quiet, release
  while loud, several rapid intentional corners). Notation/UI work remains
  explicitly not started, per their instruction not to begin it until this
  checkpoint passes.

## Cross-device retest: Mac-only latency, envelope separation, corner rework

The third checkpoint came back with a cross-device test (Mac, Windows, phone):
Windows and mobile were "mostly responsive," but the Mac specifically still
showed noticeable chord-change latency, plus three feel complaints that
applied everywhere (release still too fast, gesture-start too abrupt, corner
detection still too sensitive to smooth curves). The user gave an explicit,
detailed diagnostic checklist and two hard constraints: don't fix the Mac
latency by lowering corner-detection thresholds again, and don't add a fixed
Safari-specific delay without first finding the actual cause. Both are
respected below — the fix applied everywhere, not branched by browser name.

1. **Diagnosed the Mac-specific latency as a Web Audio scheduling race, not a
   gesture-confirmation delay.** The previous round already established the
   corner-confirmation→`changeChord()` leg is same-tick everywhere (no
   timers, no framework render cycle in this codebase). Every one of this
   round's automation calls (`rampParam`, `releaseParam`, voice creation,
   `oscillator.start()`) was scheduling exactly at `context.currentTime`.
   Scheduling exactly at "now" races the audio render thread: by the time a
   `setValueAtTime`/`start()` call reaches the renderer, the requested time
   can already be inside (or just behind) the block currently being
   rendered, silently deferring the actual change to the next render
   quantum. That race is inherently more visible on a renderer with a larger
   render quantum or more scheduling jitter — which is consistent with it
   reading as Mac/Safari-specific even though nothing about the JS-side path
   differs between platforms. This is a hypothesis derived from how the Web
   Audio spec's scheduling model works, not something verifiable from this
   environment (no real Safari/CoreAudio access here) — it is reported
   honestly as *diagnosed and structurally addressed*, not *confirmed fixed*,
   pending the user's own Mac retest.
2. **Fix: a single, universal 8ms scheduling lookahead (`SCHEDULING_LOOKAHEAD_SECONDS`
   in `audio.ts`), applied identically on every platform.** Every "now"-based
   schedule (`rampParam`, `releaseParam`, `createVoice`'s attack/`start()`,
   `fadeOutVoice`/`releaseVoice`/`stealOldestIfAtCap`'s stop times) now
   anchors at `context.currentTime + 0.008`, never at `context.currentTime`
   directly. This is within the user's explicit "~5-10ms safety offset if
   necessary" allowance, is not a browser check of any kind, and costs
   nothing perceptually (8ms is far below the ~20-50ms incoming-attack
   target). `rampParam`/`releaseParam` use a two-step "pin then hold-through-
   lookahead" pattern — `setValueAtTime(current, now)` then
   `setValueAtTime(current, now + lookahead)` before the actual
   ramp/decay — so the lookahead never introduces an audible jump in
   still-ramping automation (e.g. a corner arriving mid-crossfade).
3. **Added dev-only diagnostics matching the user's checklist**, gated by
   `import.meta.env.DEV` (confirmed dead-code-eliminated from the production
   bundle — see verification below): an `AudioContext` `statechange`
   listener in `ensureContext()` (surfaces repeated suspend/resume/
   `interrupted` transitions, one of the user's named suspects); a
   `changeChord()` entry log comparing `performance.now()` against
   `context.currentTime` and the lookahead-shifted scheduled start; and
   `main.ts`'s single corner-confirmed timing log expanded into a four-stage
   breakdown (corner-confirmed → harmony-selected → event-built → audio-
   engine-invoked) so a future report can name which leg, if any, still
   contributes measurable delay on real hardware.
4. **Separated the three envelope behaviours into fully independent
   configurations**, replacing the previous shared-ish attack constant:
   - **A — gesture start** (`GESTURE_START_ATTACK_SECONDS = 0.22`, used only
     in `startChord`): begins from silence with a gentle ~220ms attack,
     applying only to the first chord of a new gesture.
   - **B — mid-gesture corner change** (`INCOMING_ATTACK_SECONDS = 0.035`,
     `OUTGOING_FADE_SECONDS = 0.15`, used only in `changeChord`): the
     incoming chord reaches full level in 35ms while the outgoing chord
     lingers for 150ms — unchanged in kind from the previous round, both
     values nudged slightly within the brief's 20-50ms/100-180ms ranges.
   - **C — pointer release** (`RELEASE_SECONDS` 0.85s→**1.5s**,
     `RELEASE_TIME_CONSTANT_SECONDS` 0.17s→**0.3s**, ≈5 time constants ≈
     `RELEASE_SECONDS`): extended because the previous round's release,
     while already exponential rather than linear, still read as "too fast"
     on retest — 1.5s is the brief's suggested starting point within its
     1.2-1.8s range. Voice cleanup (`oscillator.stop`) still waits for the
     full release duration (now including the lookahead) before firing, so
     nothing is cut short.
   A new test (`spec/audio.test.ts`: "begins a brand-new gesture with a
   slower, gentler attack than a mid-gesture corner change") asserts A and B
   are genuinely different values, not the same constant reused — the exact
   failure mode this separation is meant to prevent.
5. **Reimplemented corner detection around a stable-segment model**,
   replacing the previous rolling-window/candidate-hysteresis approach
   entirely (`gesture.ts`, fully rewritten). The new model looks for the
   concrete shape of a real corner — `stable incoming segment → short
   turning region → stable outgoing segment` — rather than asking whether
   cumulative direction change since some earlier point exceeds a threshold
   (the old model's actual failure mode: a long, gradual arc can accumulate
   the same total heading change as a short sharp turn, so a threshold on
   accumulated change alone cannot tell them apart).
   - A small buffer of noise-filtered path points is kept, each annotated
     with cumulative path distance. A candidate pivot is found by walking
     back `SEGMENT_LENGTH_PX` (30px) from the latest point; the incoming
     segment's start is another `SEGMENT_LENGTH_PX` back from the pivot.
   - **Stability check**: both the incoming (start→pivot) and outgoing
     (pivot→end) segments must have a straight-line chord length at least
     `SEGMENT_STRAIGHTNESS_MIN_RATIO` (0.92) of the path length actually
     traveled across them. This single ratio rejects both curvature
     (wandering off the chord) and in-place jitter/backtracking (traveling
     far without displacing) in one check, and needs no device-pixel-ratio
     scaling since pointer coordinates already arrive in DPI-independent CSS
     px.
   - **Angle check**: the *true* (0-360°, unfolded) heading difference
     between the two stable segments must fall in
     `[CORNER_ANGLE_MIN_DEG=70, CORNER_ANGLE_MAX_DEG=165]`. The upper bound
     matters: an exact reversal (180°) is deliberately excluded from corner
     detection and left to the existing same-axis reversal/vibrato
     mechanism, which needs "same line, either direction" semantics rather
     than corner-sharpness semantics — conflating the two would have made a
     sharp near-reversal V-corner indistinguishable from an out-and-back
     wobble.
   - **Re-arming**: a confirmed corner requires the new pivot to be at least
     `CORNER_REARM_DISTANCE_PX` (30px) further along the path *and*
     `CHORD_CHANGE_COOLDOWN_MS` (150ms, unchanged) since the last confirmed
     corner — a distance guard and a time guard together, rather than
     relying only on the geometry's natural (but tolerance-fragile) tendency
     to self-limit.
   - **Design trade-off, disclosed rather than hidden**: very tight arcs
     (radius roughly ≲40-60px) sit near the classification boundary between
     "stable segment" and "curve" at this segment length/ratio, and could in
     rare cases misfire as a corner. This wasn't loosened away because doing
     so would reopen the "smooth curve triggers a chord change" complaint
     this round exists to fix; a real conducting gesture's natural arc
     radius is expected to sit well above this range, and the deployed build
     is the way to find out if that assumption holds.
6. **New/updated tests added to `spec/gesture.test.ts`** covering exactly
   the shapes the user asked for, built from realistic multi-point paths
   (not idealized 3-point corners): a clean right-angle corner, a sharp
   acute-angle (150°) corner, a corner just above the minimum angle
   ("slightly wider but still obvious"), a large-radius circular arc (no
   trigger, regardless of how far it sweeps — the local-window design means
   total accumulated heading is irrelevant), a smooth S-curve built from two
   opposite-direction arcs (no trigger), realistic non-periodic pointer
   jitter (no trigger), and an explicit "does not fire again while sliding
   through the same confirmed corner's window" test. Pre-existing tests
   (straight line, alternating jitter, same-axis reversal, cooldown
   non-retrigger, two well-separated corners, corner-latency bound,
   speed-spike clamp, gentle-curve non-burst-fire, stale-cooldown-across-reset)
   were re-verified passing against the new model, with the corner-latency
   bound's rationale updated to reflect the new distance-based confirmation
   mechanism rather than the old time-window one.

### Verification status (honest, as of this cross-device round)

- `pnpm check` is green: **9 test files, 101 tests passing** (11 new since
  the previous round).
- **Structurally verified**: dev-only timing/statechange instrumentation is
  fully absent from the production bundle (grepped the built `dist/assets/*.js`
  for `"timing"` and `console.debug` — zero hits either way); the gesture-
  start attack (A) and corner-change attack (B) are distinct constants, not
  a shared one reused; every automation call schedules from
  `context.currentTime + SCHEDULING_LOOKAHEAD_SECONDS`, verified by a
  dedicated test against the fake `AudioContext` (whose `currentTime` never
  advances, so any scheduled time greater than zero is direct evidence of
  the lookahead).
- **Not verified, and not claimed as verified**: whether the scheduling
  lookahead actually resolves the Mac/Safari latency on real hardware — this
  environment has no access to real Safari/CoreAudio, so the fix is reported
  as a diagnosed, structural change with a specific mechanism, not as a
  confirmed resolution. The user's own Mac retest, together with the new
  dev-console timing/statechange output, is what will confirm or refute the
  render-quantum-race hypothesis.
- Deployment and the fourth cross-device retest checkpoint are the next
  steps (see below); notation/UI work remains explicitly not started, per
  the user's instruction not to begin it until this checkpoint is approved.

## Gesture classification fix: axis-reversal exception and monotonic drift

The fourth checkpoint's report was narrower than the previous rounds: audio
envelopes, balance, and harmony were accepted as-is, with one remaining
functional problem — chord-change detection was inconsistent, sometimes
missing an obvious corner and sometimes firing on a vibrato wobble. The user
asked for this to be fixed in isolation, with an explicit state machine, a
same-axis-reversal exception evaluated before the corner-angle check, distance-
based (not time-based) sampling, dev-only diagnostics, and a specific test
matrix built from realistic multi-point paths. Nothing outside `gesture.ts`
and `spec/gesture.test.ts` was touched.

### Root cause of the inconsistent behaviour

The previous round's stable-segment rewrite (see "Cross-device retest" above)
already fixed the smooth-curve false positives, but it still treated the
*directed* heading difference between the incoming and outgoing segments as
the only signal for "is this a corner." That conflates two geometrically
different situations that happen to produce the same large directed heading
change:

- A real corner: the incoming and outgoing segments sit on genuinely
  different lines.
- A same-axis reversal (vibrato/scrubbing): the pointer retraces
  approximately the same line in the opposite direction. Directed heading
  flips by close to 180° — a *larger* raw heading change than most real
  corners — even though geometrically the two segments are the same
  undirected axis.

Scoring only directed heading meant a wide corner-angle ceiling was needed to
admit sharp near-reversal V-corners, and that same wide ceiling let ordinary
back-and-forth vibrato through as a false "corner." Narrowing the ceiling to
exclude vibrato would have also excluded genuine sharp corners — the two
cannot be separated on directed heading alone, which is exactly what made the
old detector feel simultaneously too conservative and too sensitive depending
on which failure mode a given retest happened to hit.

### How same-axis reversal is distinguished from a real corner

Every candidate now computes **two** independent quantities from the same
incoming/outgoing segment pair:

- **Directed heading difference** (`headingDifferenceDeg`, 0-180°): how far
  the pointer's direction of travel actually turned.
- **Undirected axis difference** (`axisDifferenceDeg`, 0-90°): the incoming
  and outgoing segments' headings folded modulo 180° and compared — a line
  and its exact opposite fold to the same axis, so this measures "are these
  two segments on the same line," independent of which way the pointer moved
  along it.

The axis-reversal check is evaluated **before** the corner-angle-range check,
per the brief: if `axisDifferenceDeg <= AXIS_REVERSAL_MAX_DEG` (28°), the
candidate is classified `axis-reversal` and rejected as a corner regardless of
how large the directed heading swing is — a near-180° reversal can never fall
through and get scored as "just a very sharp corner." Only once a candidate
clears the axis-reversal exception does its directed heading get checked
against the corner-angle range.

Between the unambiguous corner ceiling (`CORNER_ANGLE_MAX_DEG=135°`) and an
exact reversal there remains a genuinely ambiguous band (an imprecisely
retraced reversal and a very sharp isolated corner can look identical from
local two-segment geometry alone). In that band only, recent same-axis
oscillation intensity (the existing fine-grained vibrato detector, unchanged)
breaks the tie: no recent oscillation reads as a genuine sharp corner; recent
oscillation reads as continued scrubbing (`VIBRATO_AMBIGUOUS_MAX_INTENSITY=0.15`).

### How a sharp corner is distinguished from a smooth curve

This part was already correct in the previous round's stable-segment model
and is unchanged in its gating logic: both the incoming and outgoing segments
must independently pass a straightness-ratio check
(`chordLength / pathLength >= SEGMENT_STRAIGHTNESS_MIN_RATIO=0.92`) before any
angle is even computed. A smooth curve's local segments never get straight
enough to pass this gate at the 30px segment length used here, so a circle,
arc, or S-curve never reaches the angle/axis comparison at all — it's
rejected at the stability check, not at the angle check. This is why a large
arc that sweeps 360° still never fires: the corner detector has no
"cumulative direction change" state to accumulate against in the first place.

What changed this round is **diagnostic accuracy, not the gate**: the
`turnAngle < CORNER_ANGLE_MIN_DEG` branch (heading changed a little, but not
enough to be a corner candidate) and the two `!isStableSegment` branches
previously used raw directional-variance/ratio magnitude to *label* the
rejection as `"jitter"` or `"curve"` for diagnostics. An empirical trace
showed this magnitude heuristic backwards: a large gentle arc's per-step
heading deviation was consistently lower (~6°) than a genuinely jittery
straight line's (~17-20°), because jitter's per-step swings are larger but
uncorrelated while a curve's are small but systematic — the opposite of what
a "low variance = curve" heuristic assumes. The fix
(`GestureAnalyzer.isMonotonicDrift`) splits the window into
`DRIFT_CHUNK_COUNT=4` equal-distance sub-chords (via the same
`interpolateAtDistance` used for the main segments) and checks whether
consecutive sub-chord headings keep rotating the *same way* (signed, not
unsigned, heading delta), ignoring deltas below `DRIFT_NOISE_FLOOR_DEG=1.5°`
as sampling noise. Same-signed throughout → `curve`; any sign flip → `jitter`.
This is purely a diagnostic label — it never gates whether a corner fires,
only explains why one didn't.

### Final parameters

| Constant | Value | Role |
|---|---|---|
| `NOISE_DISTANCE_PX` | 4px | minimum raw-sample spacing before a point is even recorded |
| `SEGMENT_LENGTH_PX` | 30px | length of each stable window (incoming/outgoing), distance-based |
| `SEGMENT_STRAIGHTNESS_MIN_RATIO` | 0.92 | chord/path-length ratio a segment must clear to count as "stable" |
| `CORNER_ANGLE_MIN_DEG` | 70° | minimum directed heading change to be a corner candidate |
| `CORNER_ANGLE_MAX_DEG` | 135° | unambiguous corner ceiling; above this is the ambiguous band |
| `AXIS_REVERSAL_MAX_DEG` | 28° | undirected axis difference at/under this = same-line reversal, checked before the angle range |
| `VIBRATO_AMBIGUOUS_MAX_INTENSITY` | 0.15 | tiebreaker for the 135°-180° ambiguous band |
| `CORNER_REARM_DISTANCE_PX` | 30px | distance the pivot must advance past a confirmed corner before another can fire |
| `CHORD_CHANGE_COOLDOWN_MS` | 150ms | secondary real-time guard, never the sole rearm mechanism |
| `DRIFT_CHUNK_COUNT` / `DRIFT_NOISE_FLOOR_DEG` | 4 / 1.5° | diagnostic-only curve-vs-jitter sub-chord check |

These are the same core values carried forward from the previous round's
stable-segment model (unchanged: `SEGMENT_LENGTH_PX`, `SEGMENT_STRAIGHTNESS_MIN_RATIO`,
`CORNER_ANGLE_MIN_DEG`, `CORNER_REARM_DISTANCE_PX`, `CHORD_CHANGE_COOLDOWN_MS`),
narrowed once (`CORNER_ANGLE_MAX_DEG` 165°→135°) and given a dedicated
axis-reversal threshold and ambiguous-band tiebreaker this round to actually
implement the axis/heading distinction, rather than trying to make one wide
angle ceiling do both jobs.

### Independence from pointer-event frequency

Unchanged from the previous round and re-verified this round: every segment
boundary (`incomingStart`, `pivot`, `end`) is pinned to an exact multiple of
`SEGMENT_LENGTH_PX` of cumulative path distance via `interpolateAtDistance`,
which linearly interpolates between whichever two raw samples bracket that
exact distance. This means the incoming/outgoing windows always cover the
same physical 30px of travel regardless of how many raw pointer events
arrived along the way or how fast the pointer was moving — a device emitting
events at 60Hz and one emitting at 120Hz produce the same windows for the
same physical gesture. The existing "produces the same result for equivalent
paths sampled at different point densities" and "...drawn at different
speeds" tests (unchanged, still passing) are the concrete evidence for this.

### A known geometric sensitivity, disclosed honestly

While building the required test matrix, closed-form analysis showed that
straightness-ratio near-cancellation makes near-180° turns dramatically more
sensitive to a segment window straddling the vertex by even a couple of
pixels than moderate-angle corners are — at a 150° turn, 2px of "wrong-leg"
contamination in a 30px window drops the ratio from ~1.0 to ~0.876 (below the
0.92 gate); at 90°, the same 2px only drops it to ~0.936 (still passing).
This is an inherent property of ratio-based straightness detection near
reversal angles, not a defect in the classification logic — it means a
genuinely very sharp, very precisely-drawn near-reversal corner needs a
somewhat cleaner incoming/outgoing line than a right-angle corner does to be
recognized at all. This wasn't loosened away (doing so would reopen the
vibrato false-positive problem this round exists to fix); it's named here so
a future report of "very sharp corners feel slightly less reliable than
right-angle ones" has a documented, understood cause rather than reading as a
new regression.

### Diagnostics

`GestureAnalyzer.getDiagnostics()` now returns, after every `addSample()`
call: `phase` (`collectingIncomingSegment` / `candidateTurn` /
`confirmingOutgoingSegment` / `cornerTriggered` / `stableAfterCorner`),
`reason` (`corner` / `curve` / `axis-reversal` / `jitter` /
`insufficient-data`), `triggered`, a human-readable `detail` string naming
the exact accept/reject reason, both directed headings, the directed heading
difference, the undirected axis difference, both segment lengths, and the
directional-variance diagnostic. This is a plain getter with no console
output in production paths; the one `console.debug` call (corner-confirmed
summary) remains gated behind `import.meta.env.DEV`, unchanged from the
previous round, and confirmed still absent from the built bundle (see
verification below).

### Test results

`spec/gesture.test.ts`: **33/33 passing**, built from realistic multi-point
paths (not idealized 3-point corners) with human-jitter helpers
(`straightRun`/`cornerPath`/`backAndForthRun`/`arcRun` all take a `jitterPx`
parameter). Covers every case in the brief's required matrix: 90° L-shape
(once), acute 150° V-shape (once), 60-75°-band turn (once, at 73°), gentle
arc (zero), full circle (zero), smooth S-curve (zero), horizontal/diagonal/
repeated-vibrato back-and-forth (zero each), back-and-forth with small
perpendicular jitter (zero), a real corner after a period of vibrato
(exactly once), two separated corners (exactly twice), equal results across
different point densities and different drawing speeds, plus a dedicated
`GestureAnalyzer: diagnostics` suite asserting `reason` is exactly `corner`
for a confirmed corner, `axis-reversal` (not `corner`) for a same-axis
reversal, `curve` (not `jitter` or `corner`) for a gentle arc, and that
`headingDifferenceDeg`/`axisDifferenceDeg` are independently reported and
numerically correct (≈90°/≈90° for a right-angle corner).

Two synthetic-test-only pitfalls were found and fixed in the test file, not
in `gesture.ts`: (1) a uniform `stepPx` that doesn't evenly divide
`SEGMENT_LENGTH_PX=30` leaves a fixed, deterministic pivot-to-vertex
misalignment on a perfectly uniform synthetic path (real, non-uniform pointer
input never locks onto one fixed bad offset the way a uniform-step synthetic
path does) — fixed by using `stepPx=5` for the angle-sensitive tests; (2)
three diagnostics tests were checking `getDiagnostics()`/`chordChangeTriggered`
after the whole sample loop finished rather than at the specific sample where
the event of interest occurred — fixed by capturing state inside the loop, at
the trigger.

A pre-existing `directionalVariance` parameter-type gap (`start` was typed as
`{x, cumDist}`, missing `y`, though the function body used `start.y`) was
also found and fixed while running `pnpm typecheck` — a type-checking gap
rather than a runtime bug (the actual call site always passed a full
`{x,y,cumDist}` object), unrelated to this round's classification logic but
caught and corrected as part of getting `pnpm check` fully green.

### Verification status (honest, as of this classification round)

- `pnpm check` is green: **9 test files, 115 tests passing**, `tsc --noEmit`
  clean, `vite build` succeeds.
- **Structurally verified**: every segment boundary is distance-interpolated,
  not raw-sample-snapped (re-confirmed by re-reading `interpolateAtDistance`
  and its call sites); the axis-reversal check runs before the corner-angle
  check in `detectCorner()`'s control flow (re-confirmed by reading the
  function top-to-bottom); the curve/jitter diagnostic label now depends on
  sign-consistency across sub-chords, not raw variance magnitude, for all
  three branches that assign it.
- **Not verified, and not claimed as verified**: whether this reads as
  "right" on a real hand-drawn gesture across Mac/Windows/mobile — every test
  above runs against synthetic pointer traces in this environment, which has
  no access to real touch/mouse hardware or human motor noise. That is
  exactly what the user's manual cross-device retest below is for.
- Deployment (see below) and the user's manual retest are the next and final
  steps for this round; per standing instruction, no further tuning or
  notation/UI work proceeds until that retest comes back.

## Gesture classification fix: stale-history recovery after a rejected/irregular candidate

Time-boxed corrective pass (~25 min), scoped strictly to the reported "stuck,
then delayed" chord-change behaviour. No thresholds were broadly loosened, no
test architecture was expanded beyond the four tests the brief asked for, and
no other gesture behaviour was touched.

### Root cause

Verified with the existing `getDiagnostics()` API (not assumed): before this
fix, `detectCorner()`'s incoming/outgoing SEGMENT_LENGTH_PX windows are
recomputed every sample from whatever is still sitting in the raw `points`
buffer, and a failed stability check (`!incomingStable`/`!outgoingStable`) did
nothing but return `false` — it never discarded anything. The only thing that
ever aged points out of the buffer was `trimPoints()`'s passive, fixed
`SEGMENT_LENGTH_PX*3` (90px) distance cutoff, which trims for memory, not for
correctness, and has no notion of "this history was part of a
rejected/unstable candidate."

A quick trace (via a scratch `_debug.test.ts`, since deleted per "no large
diagnostic framework") of a short-legged same-axis scrub followed by a clean
turn showed the mechanism directly: while both windows kept failing the
straightness gate, every sample reported `reason: "jitter"`/`"curve"` with
`triggered: false` — a silent, unresponsive stretch from the user's point of
view. Nothing in that stretch was ever discarded, so the *same* contaminated
points kept being re-evaluated, sample after sample, until enough new travel
happened to independently push them past the passive 90px trim window. If the
tail of that irregular stretch and the start of an unrelated later movement
were locally straight enough, in combination, to clear
`SEGMENT_STRAIGHTNESS_MIN_RATIO=0.92` by coincidence, the resulting corner
would use a heading blended from two unrelated pieces of motion — which is
exactly the "several shapes, no response, then a sudden late change" the user
described. This matches the user's own hypothesis; the cooldown constants
(`CHORD_CHANGE_COOLDOWN_MS`, `CORNER_REARM_DISTANCE_PX`) were checked and
ruled out — both are no-ops before any corner has ever fired in a gesture,
which is exactly the situation the report describes (several *non*-corner
shapes drawn first).

### The fix: an explicit stale-history reset

Added `STALE_HISTORY_RESET_DISTANCE_PX = SEGMENT_LENGTH_PX * 4` (120px) and a
`lastResolvedDist` field. Every `detectCorner()` call now records the
cumulative distance of the most recent sample where *both* the incoming and
outgoing windows were jointly stable at once (regardless of what they were
then classified as — corner, curve, or axis-reversal all count as
"resolved", since in every one of those cases the geometry is internally
straight, just possibly not corner-shaped). If instead a window is
unstable and more than 120px has passed since the last such resolution, the
buffered history is treated as stale:

```ts
if (incomingStable && outgoingStable) {
  this.lastResolvedDist = this.totalDist;
} else if (this.totalDist - this.lastResolvedDist > STALE_HISTORY_RESET_DISTANCE_PX) {
  this.discardStaleHistory();
  ...
  return false;
}
```

`discardStaleHistory()` drops every buffered point except the current pointer
position, and also resets `activeAxis`, `axisSign`, `reversalTimes`, and
`vibratoIntensity` — all of it was derived from the same stale geometry, so
none of it should carry forward into the fresh baseline. This is the
"forget stale/rejected candidate history and begin establishing a fresh
incoming baseline" mechanism the brief asked for, rather than a broader
threshold change.

### How stale points are prevented from firing later

After a reset, `interpolateAtDistance()` cannot resolve any distance older
than the single retained point — it returns `null`, which `detectCorner()`
already treats as "not enough travel yet" (`reason: "insufficient-data"`).
So a corner literally cannot be evaluated using any pre-reset geometry: the
detector is forced to accumulate a full fresh `SEGMENT_LENGTH_PX*2` (60px) of
new, independently-stable travel before it will consider a candidate again.
A rejected/unstable candidate can therefore never later combine with an
unrelated movement's points — by the time any classification runs again, the
old points are gone from the buffer entirely, not merely aged out on a
schedule that happened not to matter.

120px (4×) was chosen deliberately above the ~60-90px that ordinary corner
formation and gentle curves take to resolve (both stay individually stable
throughout — see the existing circle/S-curve/arc tests — so they update
`lastResolvedDist` every sample and never approach the bound). Threshold
values (`SEGMENT_STRAIGHTNESS_MIN_RATIO=0.92`, `SEGMENT_LENGTH_PX=30`) were
left untouched, per the brief's stated preference for a recovery rule over
lowering thresholds.

### Targeted tests added (`spec/gesture.test.ts`, describe block "GestureAnalyzer: stale-history recovery")

1. Tight, hand-jittery circle (radius small enough to genuinely fail the
   straightness gate, unlike the large-radius arc tests) then a clean
   right-angle corner: circle fires 0, corner fires exactly 1, within the
   corner's own two-segment window (not after burning through most of the
   outgoing leg).
2. Repeated same-axis vibrato (realistic leg length, matching the existing
   vibrato tests) then a clear corner: vibrato fires 0, corner fires exactly
   1 — a direct regression guard, since ordinary vibrato with legs longer
   than `SEGMENT_LENGTH_PX` resolves every sample and never needs the new
   reset path.
3. Jagged, non-axis-aligned noise (decorrelated direction every step) then a
   fresh straight baseline and corner: noise fires 0, and the one corner
   trigger lands promptly in the new baseline, not delayed by leftover noise
   geometry.
4. A legitimately rejected candidate (a 40° bend, under
   `CORNER_ANGLE_MIN_DEG`, classified "continuing straight") followed by
   unrelated later movement and a real corner: exactly 1 trigger overall,
   and it's attributable to the later corner, not a revival of the earlier
   bend.

All four pass, and all 33 pre-existing gesture tests (sharp corners, curves,
S-curves, full circles, vibrato, density/speed invariance, cooldown/rearm)
remain green with no parameter changes — `pnpm check`: **9 test files, 120
tests passing**, `tsc --noEmit` clean, `vite build` succeeds.

One design note worth recording: an early draft of test 2 deliberately used
vibrato legs *shorter* than `SEGMENT_LENGTH_PX` to stress the new reset path
harder. That variant failed — not because the fix is wrong, but because
legs shorter than the corner window mean no 30px stretch of the scrub is
ever internally stable in the first place, so a corner immediately following
it genuinely cannot resolve an incoming segment until 30px of clean travel
exists *purely* in the new direction (60px total including the outgoing
side). That's correct, conservative behaviour, not a bug, so the test was
rewritten to use realistic leg lengths instead of chasing that edge case.

## Ensemble UI: two explicit controls, and switching is now audible

Verified rather than reimplemented first: `BRASS_PRESET`/`STRINGS_PRESET`
already existed in `audio.ts` (differing in filter frequency/Q and vibrato
depth; both sawtooth), and ensemble selection already worked via a single
cycling `#ensemble-toggle` button plus `1`/`2` keys wired through
`ConductingController`'s `onSelectEnsemble` callback. Reading `selectEnsemble()`
in `main.ts` confirmed switching mid-sustain only relabelled the current
`ChordEvent` and re-voiced it for the score display — it never called
`audioEngine.changeChord()`, so a held chord kept its old timbre until the
next corner or the next gesture.

Two changes, both additive:

1. **Two visible controls.** `index.html`'s single toggle became a labelled
   `role="group"` of two buttons (`#ensemble-brass` 🎺, `#ensemble-strings`
   🎻), each driving its own `aria-pressed` state (the existing
   `.controls button[aria-pressed="true"]` gold-highlight styling in
   `styles.css` applies unchanged). `main.ts` wires each button directly to
   `selectEnsemble("brass")`/`selectEnsemble("strings")` instead of a
   toggle-and-cycle click handler. The `1`/`2` keyboard shortcuts needed no
   change — they already called `onSelectEnsemble` with an explicit target.

2. **Switching is audible immediately.** Added `AudioEngine.retimbreChord()`,
   which reuses `changeChord()`'s exact crossfade path (extracted into a
   shared private `crossfadeToCurrent()`) but is a deliberate no-op when no
   voice currently has `role: "current"` — toggling the ensemble control
   while idle must never start sound playing on its own. `selectEnsemble()`
   now calls it after re-voicing the display copy, so a chord already
   sustaining crossfades into the new timbre on the same button click, with
   no need to wait for the next corner or the next hold.

3. **Brass and Strings are more clearly distinct.** Both already differed in
   filter frequency/Q and vibrato depth; added a third, more perceptually
   obvious cue — attack shape. `Preset` gained `attackScale`, multiplying
   whatever attack duration `createVoice` is given. Brass keeps
   `attackScale: 1` (the exact pre-existing baseline the older attack-timing
   tests assert against, so nothing about brass's sound changed). Strings
   gets `attackScale: 1.6` — a slower bow-like swell instead of brass's
   near-instant onset, audible on every new chord and on every ensemble
   switch alike, without a second oscillator, samples, or any other
   synthesis-architecture change.

Three new tests cover this in `spec/audio.test.ts`: `retimbreChord` no-ops
with no chord sustaining, crossfades correctly (4 fading + 4 current voices,
darker filtering on the incoming strings voices) when one is, and Strings'
attack ramp lands later than Brass's while Brass's stays exactly at the old
baseline. `pnpm check`: **9 test files, 124 tests passing**, `tsc --noEmit`
clean, `vite build` succeeds. As before, `spec/audio.test.ts`'s fake
`AudioContext` graph verifies node-level scheduling correctness only — actual
click-free/timbre/balance perception still needs a human listening pass.

## Part B: giving Brass and Strings genuinely distinct synthetic identities

The single-oscillator-plus-filter design (a lone sawtooth per voice, Brass and
Strings differing only in filter cutoff/Q and vibrato depth) was rejected
outright as "a darker version of the same oscillator" — the brief asks for
audibly distinct ensembles, and a shared waveform with a lower cutoff cannot
produce that regardless of how the filter is tuned. `audio.ts` was reworked
around a small per-voice oscillator layer stack (`OscillatorLayer[]`, a "core"
fundamental plus one or two "color" layers, gains chosen to sum to ~1.0 per
preset so neither ensemble reads louder purely from having more layers), with
the actual differences deliberately spread across several independent axes
rather than one knob:

1. **Different waveform combinations, not the same waveform darkened.** Brass
   is a sawtooth core with a detuned square color layer and a second detuned
   sawtooth (`BRASS_PRESET`) — the square layer is what gives the "brassy"
   edge a low-pass filter alone cannot produce. Strings is a triangle core
   with two detuned sawtooth color layers (`STRINGS_PRESET`) — a rounder
   fundamental, closer to a bowed tone's spectrum, with the saws adding body
   rather than edge.
2. **Brass gets an attack transient and a pitch "scoop"; Strings does not.**
   `scoopCents`/`scoopSeconds` starts each Brass layer flat and settles it up
   to steady pitch over ~45ms (a breath-driven attack instability); a
   `transientSeconds`/`transientPeakMultiplierByVoice` pair briefly opens the
   filter above its steady-state cutoff at note-on before settling — a
   breath "bite." Both are absent from `STRINGS_PRESET` entirely (no
   `scoopCents`/`transientSeconds` keys).
3. **Strings gets a filtered bow-noise burst; Brass does not.** A shared
   noise buffer (`getNoiseBuffer`, generated once) is band-limited around each
   note's own pitch (bandpass at `midi frequency * 3`) and enveloped to a low
   peak gain (`noiseAmount = 0.05`, further scaled per voice via
   `noiseByVoice`) for roughly the attack's duration, then gone — meant to
   read as bow friction texture, not broadband hiss. `playBowNoiseBurst` is a
   no-op whenever `preset.noiseAmount` is unset, i.e. always for Brass.
4. **Vibrato onset differs, not just depth.** Brass vibrato is present at
   full requested depth from the first sample (`vibratoOnsetSeconds: 0`);
   Strings fades vibrato in from 0 over 0.4s (`vibratoOnsetSeconds: 0.4`) via
   a dedicated `vibratoOnsetGain` node chained after the existing
   `vibratoScaleGain` — a bowed note settles into vibrato rather than
   starting with it, on top of Strings already having a larger max-depth
   table (±16/14/11/6 cents vs Brass's ±7/6/5/3).
5. **Movement-linked filter brightness is asymmetric.** Both presets already
   brighten their filter cutoff with rising speed/level in `setExpression`
   (unchanged mechanism), but `filterBrightnessRange` is 0.35 for Brass and
   only 0.08 for Strings — a breath-driven instrument's tone color should
   track how hard it's "blown" far more than a bowed section's does with bow
   speed.
6. **Different attack shape and release length.** `Preset.attackScale`
   multiplies whichever base attack duration the caller passes: Brass stays
   at 1 (the unscaled baseline the pre-existing attack-timing tests were
   written against), Strings is 1.6 (a slower bow-swell). Release duration
   and time constant are also no longer one shared constant — Strings' are
   1.5× Brass's (`STRINGS_RELEASE_SECONDS`/`STRINGS_RELEASE_TIME_CONSTANT_SECONDS`),
   since a bowed ensemble settles more slowly than articulate brass; this
   required threading `releaseSeconds`/`releaseTimeConstantSeconds` onto each
   `ActiveVoice` instead of the two release constants living only at module
   scope.
7. **A shared, mild waveshaper curve gives each preset a different amount of
   soft-clip "edge"**, not distortion: `makeSaturationCurve(amount)`
   interpolates between a pure linear pass-through (`amount=0`) and a
   normalized `tanh` curve (`amount=1`). Brass uses `0.22` (audible warmth/
   edge), Strings a much smaller `0.05` (just enough to avoid reading as a
   perfectly clean synth tone).
8. **Loudness matching is a design-level choice, not a listening-verified
   one.** Per-voice `VOICE_RELATIVE_GAIN` and `MASTER_GAIN` are unchanged and
   shared by both presets; each preset's oscillator-layer gains were chosen
   to sum to roughly the same total energy (~1.0) into the same filter/
   envelope chain so neither preset should read as structurally louder. This
   is a mechanism-level design decision, explicitly **not** a claim that the
   two ensembles have been confirmed to match in perceived loudness by ear —
   see the honesty note below.

**New tests** (`spec/audio.test.ts`) assert, against the fake `AudioContext`,
that: Brass creates 3 oscillators per voice with the documented waveform
types, Strings' core layer is `"triangle"` (not the same sawtooth as Brass),
a Brass voice's oscillator detune is scheduled away from its steady value at
onset (the scoop) while a Strings voice's is not, a Strings voice's vibrato
gain ramps in from 0 while a Brass voice's is already at full depth from the
first sample, a Strings note creates a `BufferSource` (the noise burst) while
a Brass note does not, and Strings' filter-brightness response to a level
change is smaller in magnitude than Brass's for the same level delta.

### Honest verification status for Part B

- `pnpm check` is green (see the current test count below — Part B's tests
  are additive to the totals reported in this document's later sections).
- **Structurally verified**: every one of the eight differences above exists
  in the actual audio-graph wiring and scheduling, confirmed by reading
  `audio.ts` and by dedicated tests against the fake `AudioContext` — this is
  evidence the *mechanism* is genuinely different between presets, not that
  the same preset is reused with a relabelled name.
- **Not verified, and not claimed as verified: how any of this actually
  sounds.** This environment has no speakers, no way to play audio, and no
  way to judge timbre, perceived loudness, or "does Strings sound like
  strings" by ear. Every claim above is about the *audio graph's structure*
  (which node types exist, what values are scheduled, in what order), not
  about the subjective listening experience. A human listening pass — on
  real hardware, ideally more than one device — is required before Part B can
  be reported as actually achieving "audibly distinct" or "matched loudness"
  rather than "structurally distinct by design."

## Part A: a real four-stave SVG conductor's score

The transient fading-dot `visualization.ts` was deleted outright and replaced
with `score.ts`'s `ScoreRenderer`, which builds and updates four real
five-line SVG staves from the same `ChordEvent` that drives `audio.ts` —
notation is a second consumer of the existing pipeline, not a parallel
implementation that could drift out of sync with what's actually sounding.

- **Clef selection is per-voice, per-ensemble, computed, not hardcoded per
  staff.** Soprano and tenor keep the same clef (treble, bass) in both
  ensembles; alto reads treble for Horn and alto clef for Viola — `score.ts`
  picks the clef from `(voice, ensemble)` and `notation.ts`'s
  `pitchToStaffPosition(pitchName, clef)` derives the note's line/space from
  that clef's own bottom-line reference note, so the same sounded pitch (Horn
  and Viola both play the identical F4 in the reference G7 chord) lands at
  the geometrically correct position for whichever clef is showing, rather
  than the renderer assuming alto and treble share a layout.
- **Exactly one notehead per voice, concert pitch only, only the current
  chord shown** — `showChord` clears and redraws the four staves' note
  content from `event.notes` on every call; there's no persisted history and
  no transposition step, matching the brief's "current chord only, concert
  pitch" requirement directly rather than as an afterthought.
- **Ledger lines and accidentals come from the same computed geometry as
  everything else** — `pitchToStaffPosition`'s `ledgerLines`/`accidental`
  fields are rendered as-is; a chord voiced with a pitch below/above the
  staff, or with a sharp/flat, needs no special-casing in `score.ts` itself.
- **Ensemble-specific instrument labels update immediately on switch** — the
  four staff groups' `text.instrument-label` elements are rewritten from
  `voicing.ts`'s per-voice instrument name every time `showChord` runs,
  including from a bare ensemble switch via `retimbreChord`/`selectEnsemble`.

`spec/score.test.ts` was added specifically because `spec/notation.test.ts`
only exercises the pure `pitchToStaffPosition` geometry function in
isolation — it cannot catch a regression in the *wiring* between `score.ts`
and `notation.ts` (e.g. the wrong voice's label updated, the wrong clef
picked for an ensemble, a rendered position that doesn't match the pitch
actually in the `ChordEvent`). The new suite instead drives the real
`ScoreRenderer` with real `ChordEvent`s and reads the resulting SVG DOM:

- The reference G7 chord renders at the exact staff positions/clefs the
  brief specifies for both ensembles (Trumpet/Violin B4, Horn F4 read on
  treble, Viola's identical F4 read on alto at the geometrically correct
  alto-clef position, Trombone/Cello D3, Tuba/Double Bass G2) — read from the
  DOM's own staff-line `y` coordinates, not hand-computed pixel constants, so
  a future change to staff spacing can't silently desync the test from the
  renderer.
- Ledger-line count matches `pitchToStaffPosition`'s own computed count for
  both an in-staff chord (zero ledger lines) and a chord voiced below the
  staff (`C`'s Tuba `C2`, two ledger lines).
- Accidentals: a flatted voice shows the flat glyph, a natural voice shows
  none, a sharped voice shows the sharp glyph.
- Instrument labels are exactly `TRUMPET`/`HORN`/`TROMBONE`/`TUBA` for Brass
  and `VIOLIN`/`VIOLA`/`CELLO`/`DOUBLE BASS` for Strings, and update
  immediately on `showChord` with the other ensemble.
- A sweep across four chord/ensemble combinations asserts every rendered
  voice's ledger-line count and accidental class matches what
  `pitchToStaffPosition` independently computes for that voice's *sounded*
  pitch — the displayed/sounded-pitch-consistency requirement, checked
  exhaustively rather than for the one worked reference example only.

One jsdom-specific quirk was worked around in the test file, not in
`score.ts`: `.accidental > *` reliably returns `null` under jsdom's SVG
child-combinator handling even when the child element demonstrably exists
(confirmed by walking to `.firstElementChild` directly instead) — this is a
test-harness limitation, not a renderer bug, and is called out in the test
file's own comment so it isn't mistaken for one later.

`pnpm check` is green with `spec/score.test.ts` added; see the current test
count in the verification section below.

## Part C: real-browser responsive and interaction verification

Static/jsdom tests cannot see a real layout, a real paint pipeline, or real
pointer/touch geometry — this section covers driving the actual built page in
headless Chrome via raw CDP (`Runtime.evaluate`, `Input.dispatchMouseEvent`,
`Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot`) at the three
required viewport classes (Mac desktop ~1440×900, Windows desktop 1920×1080,
narrow mobile 375×812 with touch emulation and a 2x device scale factor), and
two genuine bugs this process found that no unit test could have caught.

### Methodology

A small Node script (no new project dependency — CDP's HTTP/WebSocket
protocol is reachable directly with Node's built-in `fetch`/`WebSocket`)
opens a fresh page at each target viewport, dispatches a synthetic but
realistic conducting gesture (`mousePressed` → several `mouseMoved` samples
forming a genuine corner per `gesture.ts`'s stable-segment model → a pause →
`mouseReleased`), then reads back: `document.documentElement.scrollWidth`
vs. `window.innerWidth` (any excess is real page-level horizontal overflow),
every element whose bounding rect extends past the viewport, the baton's
computed transform/position, the rendered clef/label/notehead DOM, and the
`#status`/`#invitation` live-region text — plus a full-page screenshot for
visual inspection. The built `dist/` output is served with a plain
`python3 -m http.server`, not the dev server, so what's verified is the
actual production bundle.

### Bug found: page-level horizontal overflow from the baton's un-rotated layout box

At 375×812 only, `scrollWidth` (409) exceeded `innerWidth` (375) by 34px —
Mac and Windows desktop sizes showed no overflow. The baton (`#baton`,
`position: absolute` inside `.score`, `position: relative`) is visually
rotated/translated purely via CSS custom properties
(`--baton-x`/`--baton-y`/`--baton-angle`), but its *layout* box is the
un-rotated `210×40px` `.baton-svg` — `interaction.ts`'s `moveBatonTo` does
not clamp the tracked pointer position to the surface's bounds, so near the
right edge of a narrow surface that 210px-wide un-rotated box extends past
`.score`'s own right edge. `.score` had no `overflow` set, and nothing
between it and the document root clipped either, so the box's overhang
inflated the *page's* own `scrollWidth`.

**Fix**: added `overflow: hidden` to `.score` in `styles.css` — one line.
This clips the baton to the visual container it's meant to render within
without touching `interaction.ts`'s tracking/rotation math at all (clamping
the tracked position was considered and rejected: it would make the baton
visually stop short of the true pointer position near an edge, which is a
worse user-facing behaviour than clipping an already-off-screen sliver of
its layout box).

**Verification**: re-ran the CDP script at all three viewports. `scrollWidth`,
`window.innerWidth`, and `document.body.scrollWidth` are now exactly equal
to the emulated device width at all three sizes (375, 1440, 1920) — zero
overflow, confirmed by both the numeric report and visual screenshot
inspection at multiple baton positions including deliberately near the
narrow viewport's right edge.

### Bug found: the baton's shaft never renders at all, in any real browser

While screenshot-inspecting the fix above, the baton appeared on screen as
two disconnected floating shapes — a dark handle and a gold tip/glow — with
no connecting shaft between them, at every viewport and every baton
position. This is a completely different, previously-undiscovered defect
from the overflow bug, and directly undermines the brief's explicit "ivory/
pale-wood shaft, darker handle, gold highlight" requirement (Part A.5) — the
shaft is supposed to be the ivory-to-gold gradient piece connecting the two.

**Diagnosis**: `pip3 install --quiet --user pillow` gave pixel-level access
to the screenshots (no `convert`/`magick` available on this machine).
Sampling pixels directly along the shaft's expected on-screen path returned
the exact paper background color, not a low-contrast version of the
gradient — i.e. genuinely unpainted, not merely hard to see. Reading the
live `<line class="baton-shaft">` element's `getBBox()` in the browser
returned `{ width: 145, height: 0 }` — a perfectly horizontal line has a
zero-height bounding box. Its `stroke="url(#baton-shaft-gradient)"`
referenced a `<linearGradient>` using the SVG default
`gradientUnits="objectBoundingBox"`. Per the SVG spec, a paint server using
object-bounding-box coordinates on a shape with a degenerate (zero-area)
bounding box does not render at all — silently, with no console warning.
This is invisible to every jsdom-based test in this project (jsdom has no
real paint pipeline to catch it) and was only discoverable via a real
browser's actual rendering.

**Fix**: changed `#baton-shaft-gradient` in `index.html` from the default
fractional `objectBoundingBox` coordinates to
`gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="165" y2="20"` — matching
the shaft line's own actual endpoint coordinates, which bypasses the
bounding-box-relative coordinate system that fails on this shape entirely.
The handle's separate gradient (applied to a `<rect>` with real width *and*
height, so a non-degenerate bounding box) was unaffected and left unchanged.

**Verification**: re-inspected `getBBox()` and the live gradient's
`outerHTML` after the fix, and re-captured clipped screenshots at several
baton positions (including near the narrow viewport's right edge). The baton
now renders as one visually coherent shape — dark handle, ivory-to-gold
gradient shaft, gold tip and pulsing glow — matching the brief's description,
where before it was silently two disconnected pieces in every browser this
project has ever been checked in.

### Full three-viewport verification after both fixes

Re-ran `pnpm check` (green: 10 test files, 140 tests, `tsc --noEmit` clean,
`vite build` succeeds) and the full CDP gesture-driven script at 1440×900,
1920×1080, and 375×812 (with touch emulation and 2x device scale factor).
At every size: zero page-level horizontal overflow; the correct staff/clef/
label/notehead content renders for the reference chord; the baton follows
the synthetic pointer trace, rotates to reflect its movement direction, and
renders as one connected shape; the invitation text and `aria-live` status
region behave correctly through the gesture lifecycle; the score's SVG
scales via `preserveAspectRatio` without overflowing its container at any of
the three widths.

### Genuine touch-event verification (closing the gap above)

The three-viewport pass above used `Input.dispatchMouseEvent` everywhere,
including at the 375px width — mouse events, not touch events, even though
Pointer Events are supposed to unify the two. Since the brief specifically
says "the baton follows touch," that claim needed its own evidence rather
than an assumption that mouse emulation covers it.

A second CDP script drove the mobile viewport (375×812, 2x device scale,
`Emulation.setTouchEmulationEnabled`) with a real `Input.dispatchTouchEvent`
sequence — `touchStart`, six `touchMove` samples moving right, six more
moving down (tracing a corner), then `touchEnd` — and read back the baton's
CSS custom properties mid-gesture and the page's scroll width before/after
release. Result: `--baton-x`/`--baton-y` tracked the touch trace, `--baton-
angle` showed the expected ~90° turn at the corner, the invitation text
hid on touch start, and `document.documentElement.scrollWidth` stayed
exactly equal to `window.innerWidth` (375) both mid-gesture and after
`touchEnd` — no overflow introduced by real touch input either. This
directly exercises Part C.13's "baton follows touch" wording with actual
touch events, not an inference from mouse-event behaviour.

### What Part C has *not* yet verified, disclosed honestly

- **Real hardware.** Everything above runs against headless Chrome via CDP
  on this machine, not an actual Mac Safari session, a physical Windows
  machine, or a physical phone. It is real-browser-pipeline verification
  (real layout, real paint, real SVG rendering), which is why it caught two
  bugs no unit test could — but it is not a substitute for the human
  cross-device retest this project's audio-tuning history (see the
  "Cross-device retest" section above) has repeatedly shown to surface
  issues invisible from a single machine.
- **No manual audio listening has been performed at any point in this
  project's Part A/B/C work** (this environment has no speakers and no way
  to play audio) — see Part B's honesty note above. This is stated plainly
  here rather than implied, since Part C's browser-based visual verification
  could otherwise be mistaken for having covered the audio requirements too.
