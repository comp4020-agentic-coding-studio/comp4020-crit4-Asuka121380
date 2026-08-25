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

## Verification status (honest, as of this commit)

- `pnpm check` is green: 57 tests pass, including the pre-existing crit-4
  contract tests (Web Audio synthesis present, no `<audio>`/`<video>`
  fallback, pointer *and* keyboard input both wired) and the invariants.
- **Not yet done**: any real-browser interaction test (dragging, the actual
  sound, click-free envelope confirmation by ear), any mobile/touch device
  test, any viewport check at 1920×1080 or 390×844, and deployment. These
  require a real browser and, for the mobile checks, a physical phone —
  outside what this environment can do. `pnpm preview` was used only to
  confirm the built page serves valid markup; no audio or gesture behaviour
  has been observed running.
- Symphonic Strings is implemented (reachable via the `E` key / ensemble
  toggle) but has not been listened to — Brass Choir is the only ensemble
  currently claimed as working.
- Next: get a human (device + ears) to confirm first-gesture sound, then
  deploy the Brass-only safety-net version per section 16 step 8.
