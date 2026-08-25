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
  `interaction.ts`, `visualization.ts`, `rng.ts`) stay flat at the root.
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
  `notation.ts` (pure pitch-to-staff-position geometry; the SVG score
  renderer itself is the next piece to land) both driven from the same
  `ChordEvent`. `gesture.ts` (`GestureAnalyzer`) is a pure, DOM-free module
  that turns a raw pointer trace into `{ speed, chordChangeTriggered,
  vibratoIntensity }` per sample — axis-based corner detection instead of
  accumulated-distance triggering, same-axis reversal drives vibrato instead
  of retriggering a chord. `interaction.ts` (`ConductingController`) wires
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
- **Chord lifecycle is pointer-driven, not timed**: `AudioEngine.startChord`
  (pointer-down, quick attack), `.changeChord` (confirmed corner — see below),
  `.releaseChord` (pointer-up, exponential-decay release — see below).
  `.setExpression(level, vibratoIntensity)` is called on every pointer move
  and only ever touches the *currently sustaining* chord's voices — a chord
  already fading out keeps its own envelope undisturbed.
- **A confirmed corner does NOT use one shared "crossfade" duration for the
  incoming and outgoing chords — that was a real bug, not just a constants
  choice.** The incoming chord ramps in over `INCOMING_ATTACK_SECONDS`
  (~40ms) while the outgoing one lingers over the separate, longer
  `OUTGOING_FADE_SECONDS` (~130ms). A single shared ~100ms constant meant the
  new chord's linear 0→full ramp spent its early portion at low, easily
  masked amplitude while the still-loud outgoing chord dominated — so the
  harmony change wasn't perceptually established until close to the full
  100ms had passed, well after the code had "already" started it. Splitting
  the two, and biasing the incoming ramp much shorter, is what actually
  fixes felt latency — tightening `gesture.ts`'s corner-confirmation
  thresholds further would only have traded discrimination for an illusion
  of responsiveness, since the corner→`changeChord()` call itself was already
  same-tick (verified: no React, no `setTimeout`/rAF/Promise anywhere between
  gesture confirmation and the audio call — this app has no framework at
  all, `visualization.ts`'s rAF/`setTimeout` only animate a decorative dot
  *after* audio has already been scheduled).
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
  `AudioParam.setTargetAtTime(RELEASE_FLOOR, now, RELEASE_TIME_CONSTANT_SECONDS)`
  (floor `0.0001`, time constant ~170ms, ≈`RELEASE_SECONDS` 850ms total audible
  tail) instead of a fixed-duration `linearRampToValueAtTime` — a visibly
  linear ramp reads as a cut no matter how long it's stretched, where an
  exponential decay reads as an ensemble settling. Oscillators are stopped
  only once the full `RELEASE_SECONDS` tail has had time to become
  inaudible, never at the moment the decay is scheduled.
- **Every linear gain ramp goes through a shared `rampParam` helper** (used
  for crossfade/steal/expression, never for release — see above). It reads
  the AudioParam's current (possibly still-interpolating) value, re-asserts
  it with `setValueAtTime(current, now)`, then ramps — this is what makes it
  safe to call repeatedly in quick succession (every pointer move, or a
  corner landing mid-crossfade) without audible zipper/steps. Do not call
  `cancelAndHoldAtTime`/`cancelScheduledValues` directly on a voice's gain
  elsewhere in this file — a bare `cancelScheduledValues` does not reliably
  hold the in-flight value across browsers. `releaseParam` is the equivalent
  helper for the exponential release path.
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
  EMA) and `DIRECTION_WINDOW_MS` (~75ms, the corner-axis window) are
  deliberately separate constants — speed-to-volume and corner detection are
  different signals with different responsiveness needs, and were never
  actually coupled, but this is called out explicitly so a future change
  doesn't accidentally merge them.
- **Vibrato is one shared LFO oscillator (sine, ~5.5Hz), never stopped once
  created**, fanned out through a per-voice gain node (`vibratoScaleGain`)
  into each oscillator's `detune` AudioParam. `GestureAnalyzer` tracks
  same-axis reversal (a sign flip in the projection of movement onto the
  locked axis) and reports a decaying `vibratoIntensity` (0-1);
  `setExpression` scales that by the ensemble's max cents (Brass ±6,
  Strings ±14) per voice, every pointer move.
- **Axis-based corner detection replaces distance-triggered chord changes.**
  `gesture.ts`'s axis angle is computed mod 180° (a line and its opposite
  direction are the same axis), a rolling ~60ms window smooths noisy
  instantaneous direction, and a candidate axis must both exceed a ~32°
  deviation from the locked axis *and* hold for ~14px/~40ms before it's
  confirmed as a corner (a ~90ms cooldown then guards against a second
  immediate re-trigger). These thresholds were tuned down from an initial
  wider set (100ms/40°/24px/75ms/150ms) after a first listening pass reported
  ~500ms of felt latency between a clear turn and the harmony actually
  changing — corner-to-chord response is a feel checkpoint, not something to
  get right on the first guess. This is a pure, DOM-free module —
  `spec/gesture.test.ts` drives it with synthetic pointer traces (straight
  lines, jitter, reversals, clean corners, cooldown, gentle curves, an
  explicit corner-latency-under-150ms assertion, an isolated speed-spike
  clamp) rather than requiring a human to judge gesture sensitivity by feel
  for every change.
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
  ledger-line conventions in `spec/notation.test.ts`. The SVG score renderer
  that consumes this (replacing the old fading-dot `visualization.ts`) has
  not been built yet.
- **Symphonic Strings preset exists in `audio.ts` and is reachable via the
  ensemble toggle / `2` key, but is untested by ear.** Brass Choir is the only
  ensemble that has been listened to and is confirmed as the safety-net MVP
  per the build brief; Strings should not be presented as verified until a
  human listening pass covers it too.
