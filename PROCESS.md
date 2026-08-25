# Process overview

A reading-guide to how the work came together, following
`C4_MVP_BUILD_PROMPT.md`'s scope and build order.

## What I built

The Living Score: a browser instrument where conducting an invisible ensemble
with mouse, touch, or keyboard triggers chords chosen by a small Markov
harmony system, voiced by a fixed four-part table, and briefly rendered as a
glowing chord symbol and four fading gold note-markers on a transient,
non-persistent score.

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
