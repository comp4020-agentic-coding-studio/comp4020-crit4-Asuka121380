# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The link-preview card

`public/card.png` (1200x630) is the image a shared link shows; `index.html`'s
head points at it. Replace it and the `description` meta, and copy the head
block into any new page. The card URL resolves against the page that names it,
like any link --- `./card.png` is wrong one directory down, and nothing in CI
checks it, so look at the deployed head when you add pages.

## The checks

`pnpm check` runs them (`pnpm check:evidence` is the extra gate before you
ship); CI runs the same plus links, secrets and the deploy. Read the failure.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## This file is yours

A starting point, not a rulebook. As you learn what your prototype needs --- a
convention the work has to hold to, a sensor that keeps catching you out (a
linter, say), a fact about the stack that is easy to get wrong --- write it down
here and wire it into `check`. Growing this file is the work.

## Facts about this stack that keep coming up

- **`.ts` extensions in relative imports are allowed but not used here.**
  This repo's `tsconfig.json` sets `allowImportingTsExtensions: true` (a prior
  week's carried-forward note claimed the opposite — that was wrong for this
  checkout). Both `from "./harmony"` and `from "./harmony.ts"` typecheck; this
  project writes extensionless imports for consistency with Vite's own
  resolution, not because the extension is rejected.
- **All app modules live at the repo root, not under `src/`.**
  `tsconfig.json`'s `include` is `["*.ts", "spec", "scripts"]` — a bare `*.ts`
  glob matches only root-level files, not a subdirectory. Adding a `src/`
  folder would silently drop those files from typecheck. `main.ts` and every
  module it imports (`harmony.ts`, `voicing.ts`, `chordEvent.ts`, `audio.ts`,
  `interaction.ts`, `notation.ts`, `score.ts`, `rng.ts`) stay flat at the
  root.
- **`stylelint-config-standard` rejects BEM naming.** Its default
  `selector-class-pattern` is strict kebab-case (`^[a-z]([-a-z0-9]+)?$`), so
  `__element` and `--modifier` class names (e.g. `.tile__art`,
  `.alternating-section--reverse`) fail lint outright. Use plain single-dash
  kebab-case for every class (`.tile-art`, `.alternating-section-reverse`).
- **Its `media-feature-range-notation` rule wants range syntax.**
  `@media (max-width: 780px)` fails; write `@media (width <= 780px)` (and
  `(width >= …)` for min-width) instead.
- **`no-descending-specificity` cares about *file order*, not just selector
  shape.** A base class rule must appear before any rule that adds a
  pseudo-class or extra class to the same element. Group a component's base
  rules together, then its state/variant rules, in that order --- don't
  interleave by "which section of the page this affects."
- **`spec/invariants.test.ts` parses built HTML without running scripts** ---
  `doc.querySelectorAll("h1").length === 1` sees every `<h1>` in the markup
  regardless of `hidden` or CSS `display: none`. Never duplicate a semantic
  landmark merely to support alternate visual states; keep one landmark in
  the static document and vary content inside it when necessary.
- **Static tests cannot validate runtime interaction.** Dragging, wheel input,
  focus order, motion preferences, viewport overflow, computed transforms,
  and audio timing need a real browser at the two marked viewport sizes.
  Treat screenshots and observed runtime values as evidence alongside
  `pnpm check`, not as a substitute for it.
- **Compose independent transforms on separate elements, not the same one.**
  When two effects animate the same visual property (position, rotation,
  scale) on one node, the later write overwrites the earlier one. Give each
  independent effect its own element in the DOM.
- **Asset paths are case-sensitive after deployment.** Copy user-supplied
  media into the repo, reference the committed filename rather than an
  absolute local path, and verify the exact extension casing in a production
  build.
- **Two VexFlow staves only share an x-grid if you force it.** Matching
  clefs/time-signatures on two `Stave`s does not guarantee matching
  `getNoteStartX()` --- different modifier glyphs measure different widths, so
  each stave's own computed note-start x can differ even with the same time
  signature added to both. When two staves must share a rhythmic grid, call
  `staveB.setNoteStartX(staveA.getNoteStartX())` explicitly --- and note jsdom
  can't catch a regression here (no canvas text metrics), so a real-browser
  check is required alongside any spy-based unit test.
- **`AudioContext.currentTime` is the clock for scheduled audio.**
  `setTimeout`/`requestAnimationFrame` may wake a scheduler or drive a visual
  cursor, but never gate *when a sound plays* --- always compute playback
  timing against the audio clock, not wall-clock timers.
- **Construct `AudioContext` only inside an explicit user-gesture handler.**
  Browsers block autoplay; building the context earlier either throws or
  leaves it suspended.

## The Living Score (Crit 4 instrument)

- **Architecture (post gesture/audio refinement)**: `harmony.ts` (Markov
  transition + chord-colour sampling, seeded via `rng.ts`'s `mulberry32`) →
  `voicing.ts` (fixed four-part voicing table, pitch-name-to-MIDI,
  `diatonicStep`/`parsePitchName` shared by notation) → `chordEvent.ts` (the
  single `ChordEvent` record, no duration field — a sustained chord has no
  fixed length) → `audio.ts` (`AudioEngine`: sustained oscillator voices with
  pointer-lifecycle start/change/release, not timed one-shots) and
  `notation.ts` (pure pitch-to-staff-position geometry) + `score.ts`
  (`ScoreRenderer`: builds/updates four real SVG staves — clefs, labels,
  noteheads, accidentals, ledger lines — from a `ChordEvent`, replacing the
  old fading-dot `visualization.ts`) both driven from the same
  `ChordEvent`. `gesture.ts` (`GestureAnalyzer`) is a pure, DOM-free module
  that turns a raw pointer trace into `{ speed, chordChangeTriggered,
  vibratoIntensity }` per sample — stable-segment corner detection (a
  concentrated turn between two independently-straight runs, not a
  cumulative-direction-change threshold; see below), same-axis reversal
  drives vibrato instead of retriggering a chord. `interaction.ts` (`ConductingController`) wires
  pointer lifecycle (down starts sustain, move feeds `gesture.ts` and reports
  baton position/rotation, up releases) plus `1`/`2` keydown shortcuts for
  ensemble selection — this is what keeps the crit-4 "more than one input
  modality" contract satisfied now that Space/arrow-key conducting is gone.
  `main.ts` wires it all to the DOM.
- **Polyphony cap is 8 active voices** (`MAX_ACTIVE_VOICES` in `audio.ts`) —
  four for the currently-sustaining chord, four more for the previous chord
  while a crossfade is still in flight. A confirmed corner always steals any
  leftover crossfade-out generation immediately (same "remove from the
  bookkeeping array the instant it's stolen, don't wait for `ended`" pattern
  proven in the MVP build) rather than letting a third generation
  accumulate — see `spec/audio.test.ts`'s "keeps at most one crossfading-out
  generation alive" test.
- **Chord lifecycle has three independent envelope configurations — never
  share a duration constant across them.** (A) `AudioEngine.startChord`
  (pointer-down): begins from silence with a gentle
  `GESTURE_START_ATTACK_SECONDS` (~220ms) attack — applies only to the first
  chord of a gesture. (B) `.changeChord` (confirmed corner — see below): a
  fast, asymmetric crossfade. (C) `.releaseChord` (pointer-up): an
  exponential decay — see below. `.setExpression(level, vibratoIntensity)`
  is called on every pointer move and only ever touches the *currently
  sustaining* chord's voices — a chord already fading out keeps its own
  envelope undisturbed. A cross-device retest treating A and B as
  interchangeable (or B's shape as "close enough" for A) is exactly the bug
  this separation exists to prevent — `spec/audio.test.ts` has a dedicated
  test asserting `GESTURE_START_ATTACK_SECONDS` and
  `INCOMING_ATTACK_SECONDS` are genuinely different values.
- **A confirmed corner does NOT use one shared "crossfade" duration for the
  incoming and outgoing chords — that was a real bug, not just a constants
  choice.** The incoming chord ramps in over `INCOMING_ATTACK_SECONDS`
  (~35ms) while the outgoing one lingers over the separate, longer
  `OUTGOING_FADE_SECONDS` (~150ms). A single shared duration meant the new
  chord's linear 0→full ramp spent its early portion at low, easily masked
  amplitude while the still-loud outgoing chord dominated — so the harmony
  change wasn't perceptually established until close to the full ramp had
  passed, well after the code had "already" started it. Splitting the two,
  and biasing the incoming ramp much shorter, is what actually fixes felt
  latency — tightening `gesture.ts`'s corner-confirmation thresholds further
  would only have traded discrimination for an illusion of responsiveness,
  since the corner→`changeChord()` call itself was already same-tick
  (verified: no React, no `setTimeout`/rAF/Promise anywhere between gesture
  confirmation and the audio call — this app has no framework at all, and
  `ScoreRenderer.showChord()` updates the notation only *after* audio has
  already been scheduled).
- **Every automation call schedules from `context.currentTime +
  SCHEDULING_LOOKAHEAD_SECONDS` (8ms), never from `context.currentTime`
  directly — this is the fix for Mac/Safari-specific chord-change latency.**
  Scheduling exactly at "now" races the audio render thread: the requested
  time can land inside the block already being rendered, silently deferring
  the change to the next render quantum — more visible on a renderer with a
  larger quantum, which is consistent with the delay reading as Mac/Safari-
  specific even though the JS-side gesture→`changeChord()` path is identical
  on every platform. The lookahead is universal (not a browser check) and
  is within the brief's explicit "~5-10ms safety offset if necessary"
  allowance. **Do not "fix" a future latency report by lowering
  `gesture.ts`'s corner thresholds or by adding a browser-name check** —
  both were explicitly ruled out once already; if a real device still shows
  a delay after this, re-measure with the dev-only timing/statechange
  instrumentation before changing anything.
- **`changeChord` also guarantees the incoming chord a `CORNER_PRESENCE_FLOOR`
  (~0.5) minimum level**, regardless of the continuously speed-driven
  `currentLevel` at that instant. A hand naturally slows down while pivoting
  through a sharp turn, which can drive the smoothed speed (and thus volume)
  to its quietest point at exactly the moment a corner fires — without this
  floor, the new chord could start on time but be nearly inaudible until the
  hand re-accelerates, which reads as "the change happened late" even though
  it didn't. This is the structural link between the corner-latency and
  speed-to-volume-jumpiness complaints reported after the first tuning pass.
- **Pointer-release now decays exponentially, not linearly.** `releaseChord`
  calls `releaseVoice`, which holds the chord's current gain and uses
  `AudioParam.setTargetAtTime(RELEASE_FLOOR, scheduledNow, RELEASE_TIME_CONSTANT_SECONDS)`
  (floor `0.0001`, time constant ~300ms, ≈`RELEASE_SECONDS` 1.5s total audible
  tail) instead of a fixed-duration `linearRampToValueAtTime` — a visibly
  linear ramp reads as a cut no matter how long it's stretched, where an
  exponential decay reads as an ensemble settling. Oscillators are stopped
  only once the full `RELEASE_SECONDS` tail (plus the scheduling lookahead)
  has had time to become inaudible, never at the moment the decay is
  scheduled. 1.5s was chosen after a retest reported the previous 0.85s
  release as still too fast — it's the brief's suggested starting point
  within its 1.2-1.8s range, not a hard floor.
- **Every linear gain ramp goes through a shared `rampParam` helper** (used
  for crossfade/steal/expression, never for release — see above); the
  equivalent exponential-decay helper for release is `releaseParam`. Both
  read the AudioParam's current (possibly still-interpolating) value,
  re-assert it with `setValueAtTime(current, now)`, hold it flat through
  `setValueAtTime(current, now + SCHEDULING_LOOKAHEAD_SECONDS)`, and only
  then schedule the actual ramp/decay from `now + SCHEDULING_LOOKAHEAD_SECONDS`
  — the "hold through lookahead" step is what lets every automation call use
  the lookahead without producing an audible jump in still-ramping
  automation. This is what makes it safe to call repeatedly in quick
  succession (every pointer move, or a corner landing mid-crossfade) without
  audible zipper/steps. Do not call `cancelAndHoldAtTime`/`cancelScheduledValues`
  directly on a voice's gain elsewhere in this file — a bare
  `cancelScheduledValues` does not reliably hold the in-flight value across
  browsers.
- **Speed-to-volume mapping lives in `audio.ts`'s `speedToLevel`** (a pure,
  directly-tested function): below `SPEED_FLOOR_PX_S` the level is a held
  minimum (never silent while holding still), above `SPEED_CEILING_PX_S` it's
  full volume, linear in between. The resulting level is applied
  asymmetrically in `setExpression` — a faster ramp (~90ms) when volume is
  rising than when it's falling (~180ms), since a momentary dip in the
  smoothed speed reading otherwise reads as a stutter. `gesture.ts` also
  clamps any single instantaneous speed sample above
  `MAX_INSTANTANEOUS_SPEED_PX_S` before it reaches the EMA, so one
  event-rate/coalescing glitch can't punch a spike through the smoothed
  speed the volume is driven from. `SPEED_SMOOTHING_MS` (~80ms, the raw-speed
  EMA) and `SEGMENT_LENGTH_PX` (30px, the corner-detection stability window —
  see below) are deliberately separate mechanisms on different units
  (time vs. distance) — speed-to-volume and corner detection are different
  signals with different responsiveness needs, and were never actually
  coupled, but this is called out explicitly so a future change doesn't
  accidentally merge them.
- **Vibrato is one shared LFO oscillator (sine, ~5.5Hz), never stopped once
  created**, fanned out through a per-voice gain node (`vibratoScaleGain`)
  into each oscillator's `detune` AudioParam. `GestureAnalyzer` tracks
  same-axis reversal (a sign flip in the projection of movement onto the
  locked axis) and reports a decaying `vibratoIntensity` (0-1);
  `setExpression` scales that by the ensemble's max cents (Brass ±6,
  Strings ±14) per voice, every pointer move.
- **Corner detection is a stable-segment model with an explicit axis-reversal
  exception, not a cumulative-direction-change threshold and not directed-
  heading-alone** (`gesture.ts`). The stable-segment shape (`stable incoming
  segment → short turning region → stable outgoing segment`) replaced a
  rolling-window/candidate-hysteresis model that let smooth curves accumulate
  enough total heading change to misfire. A later round then found that
  scoring *only directed* heading difference between the two segments cannot
  tell a real corner apart from vibrato/scrubbing: a same-axis reversal
  (pointer retracing roughly the same line) also produces a large — often
  near-180° — directed heading swing, so a corner-angle range wide enough to
  admit sharp near-reversal V-corners also lets ordinary back-and-forth
  through as a false "corner." The fix is to check heading and axis as two
  independent quantities, not one.
  - A pivot candidate is found by walking back `SEGMENT_LENGTH_PX` (30px, a
    *distance* window via `interpolateAtDistance`, not a time window or a
    raw-sample snap — this is what keeps classification independent of
    pointer-event frequency/speed) from the latest sample; the incoming
    segment's start is another `SEGMENT_LENGTH_PX` back from the pivot.
  - Both the incoming (start→pivot) and outgoing (pivot→end) segments must
    independently pass `isStableSegment`: straight-line chord length ÷ path
    length traveled ≥ `SEGMENT_STRAIGHTNESS_MIN_RATIO` (0.92). One ratio
    check rejects both curvature and in-place jitter/wandering, and needs no
    DPI scaling since pointer coordinates already arrive in DPI-independent
    CSS px. **Known sensitivity**: this ratio nearly cancels near an exact
    180° turn (a 2px pivot/vertex misalignment in a 30px window can drop a
    150° turn's ratio well below threshold, vs. barely moving a 90° turn's) —
    an inherent property of ratio-based straightness near reversal angles,
    not a bug; see `PROCESS.md`'s gesture-classification-fix section.
  - **Two independent checks, in this order, before a corner can confirm**:
    (1) undirected axis difference (`axisDifference`, the two segments'
    headings folded mod 180° and compared, 0-90°) — if
    `axisDiff <= AXIS_REVERSAL_MAX_DEG` (28°) the candidate is an
    `axis-reversal`, rejected regardless of how large the directed heading
    swing is, **checked before** the angle-range check so a near-180°
    reversal can never fall through and score as a sharp corner; (2) directed
    heading difference (`headingDifference`, the *true* 0-180° unfolded
    change) must then fall in `[CORNER_ANGLE_MIN_DEG=70, CORNER_ANGLE_MAX_DEG=135]`
    to be an unambiguous corner. Between 135° and an exact reversal is a
    deliberate ambiguous band, broken by recent vibrato-oscillation intensity
    (`VIBRATO_AMBIGUOUS_MAX_INTENSITY=0.15`): no recent oscillation → genuine
    sharp corner; recent oscillation → continued scrubbing.
  - **Do not reuse the mod-180 axis-difference helper (`toAxisAngleDegrees`)
    for corner-*strength* scoring** — it exists for exactly the axis-reversal
    comparison above, which needs "same line, either direction" semantics.
    Folding a true heading change mod 180° inverts corner-sharpness scoring
    near a reversal (a sharp ~150° V-corner folds to a *low* score, a plain
    90° turn folds to the *maximum* score) — use the separate unfolded
    `headingDegrees`/`headingDifference` helpers for that, always.
  - Re-arming a confirmed corner requires the next pivot to be at least
    `CORNER_REARM_DISTANCE_PX` (30px) further along the path *and*
    `CHORD_CHANGE_COOLDOWN_MS` (150ms) since the last confirmed corner —
    both guards, not just one, since the geometry's natural self-limiting
    tendency alone is tolerance-fragile.
  - **Known trade-off**: very tight arcs (radius roughly ≲40-60px) sit near
    the stability/angle classification boundary and could rarely misfire.
    This was not loosened away, since doing so reopens the "smooth curve
    triggers a chord" complaint this model exists to fix.
  - **Stale-history recovery**: a failed stability check alone does nothing
    but return `false` — the windows are recomputed fresh from the buffered
    `points` array every sample. But if `SEGMENT_STRAIGHTNESS_MIN_RATIO`
    stays unmet on *both* windows for more than `STALE_HISTORY_RESET_DISTANCE_PX`
    (120px = `SEGMENT_LENGTH_PX*4`) of travel since the last time they were
    jointly stable, `discardStaleHistory()` drops every buffered point except
    the current pointer position and resets `activeAxis`/vibrato state too.
    This exists so a rejected candidate or a genuinely irregular stretch
    (tight scribble, jittery circle) can never later blend with an unrelated
    movement's points into a "delayed" corner — after a reset,
    `interpolateAtDistance` cannot resolve any pre-reset distance, so a fresh
    `SEGMENT_LENGTH_PX*2` of independently-stable travel must accumulate
    before a candidate is considered again. Ordinary corner formation and
    smooth curves never approach the 120px bound (each window stays
    individually stable throughout a curve, just with a small turn angle, so
    it keeps re-marking itself "resolved" every sample). See `PROCESS.md`'s
    "stale-history recovery" section for the diagnosed root cause.
  - **Diagnostics** (`getDiagnostics()`, dev-only console output gated behind
    `import.meta.env.DEV`): reports an explicit `phase`
    (`collectingIncomingSegment`/`candidateTurn`/`confirmingOutgoingSegment`/
    `cornerTriggered`/`stableAfterCorner`) and `reason`
    (`corner`/`curve`/`axis-reversal`/`jitter`/`insufficient-data`) after
    every sample, plus both raw headings, the heading difference, the axis
    difference, both segment lengths, and directional variance. The
    curve-vs-jitter label is decided by `isMonotonicDrift` — sub-chord
    heading deltas that keep the same sign read as a genuine gradual curve,
    a sign flip reads as jitter — **not** by raw directional-variance
    magnitude, which was found empirically to rank a genuine curve *lower*
    in variance than genuine jitter (the opposite of the naive assumption).
  - This is a pure, DOM-free module — `spec/gesture.test.ts` drives it with
    realistic multi-point synthetic pointer traces built with a `jitterPx`
    parameter (straight lines, non-periodic jitter, same-axis reversal in
    both horizontal and diagonal orientations, a right-angle corner, a sharp
    ~150° corner, a 60-75°-band corner, a large-radius arc at any total
    sweep, a smooth S-curve, cooldown/re-arm guards, equal results across
    different point densities and drawing speeds, and a dedicated
    diagnostics suite asserting `reason`/`phase` values directly) rather than
    requiring a human to judge gesture sensitivity by feel for every change.
- **Master gain is 0.22, plus a ~36Hz master high-pass filter** to remove
  unnecessary sub-bass energy — chosen and checked on this machine's laptop
  speakers/headphones only. **A real-phone listening pass has not yet been
  done** — do not treat this level, the per-voice balance table (soprano
  1.00 / alto 0.75 / tenor 0.52 / bass 0.33), or the vibrato depth as
  confirmed until that happens (see `PROCESS.md`/`reflections/crit-4.md` for
  current verification status).
- **Notation is computed, never hand-positioned.** `notation.ts`'s
  `pitchToStaffPosition(pitchName, clef)` derives a note's staff line/space
  from `diatonicStep` relative to each clef's bottom-line reference note —
  verified against the reference SVG's exact G7 layout and standard
  ledger-line conventions in `spec/notation.test.ts`. `score.ts`'s
  `ScoreRenderer` consumes this to build/update four real five-line SVG
  staves (Trumpet/Violin treble, Horn treble/Viola alto, Trombone/Cello bass,
  Tuba/Double Bass bass), one notehead per voice, concert pitch only —
  `spec/score.test.ts` drives the actual renderer (not just the pure geometry
  function) with real `ChordEvent`s and reads the resulting SVG DOM, so a
  wiring regression between `score.ts` and `notation.ts` fails there even
  when `notation.test.ts` alone would still pass.
- **An SVG gradient with the default `gradientUnits="objectBoundingBox"`
  silently fails to paint on a shape with a degenerate (zero-width or
  zero-height) bounding box** — a perfectly horizontal or vertical `<line>`
  is exactly this case. No console warning, no error, and jsdom-based tests
  can't catch it (there's no real paint pipeline) — this only surfaced via a
  real-browser screenshot, where the conductor's baton's shaft rendered as
  completely invisible despite correct markup and Web Animations-driven
  transforms. Fix: give the gradient explicit `gradientUnits="userSpaceOnUse"`
  with coordinates matching the shape's actual endpoints, bypassing the
  bounding-box-relative coordinate system. Any future SVG gradient applied to
  a `<line>` (as opposed to a shape with real width/height) needs this.
- **An absolutely-positioned overlay that follows the pointer needs
  `overflow: hidden` on its containing block**, not just careful transform
  math. The conductor's baton (`#baton`, `position: absolute` inside `.score`,
  `position: relative`) has a real, un-rotated layout box even though its
  *visual* content is rotated/translated via CSS custom properties — near an
  edge of the surface, that layout box can extend past `.score`'s own bounds
  without being clipped by anything, which inflates the *page's* own
  `scrollWidth` and produces real horizontal overflow on a narrow viewport.
  This was invisible in every desktop-sized check and only appeared once a
  375px-wide viewport was actually driven with pointer events at
  `interaction.ts`'s reported edge coordinates — `.score { overflow: hidden }`
  is the fix, not clamping the baton's tracked position in `interaction.ts`.
- **Brass and Strings are separate layered synthesis presets, selected by two
  inline-SVG buttons in `index.html` (or `1`/`2`).** Brass uses a sawtooth
  core, square/saw colour layers, a short pitch scoop, a brighter attack
  transient, stronger movement-linked filter opening, restrained vibrato and
  mild saturation. Strings uses a triangle core with detuned saw colour
  layers, a subtle filtered bow-noise burst, delayed/deeper vibrato, a slower
  attack, darker filtering and a longer release. Per-voice oscillator mix,
  filter, gain, vibrato, noise and transient values distinguish the four
  register roles while retaining the quieter bass balance. Switching while a
  chord is sustaining crossfades immediately through
  `AudioEngine.retimbreChord()`/`crossfadeToCurrent()`; switching while idle
  deliberately starts no sound. The graph and scheduling differences are
  tested, but the latest presets still require a human listening pass before
  their realism and perceived-loudness match can be claimed as verified.
