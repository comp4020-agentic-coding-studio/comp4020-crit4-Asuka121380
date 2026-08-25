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

- **No `.ts` extension in relative imports.** This repo's `tsconfig.json` does
  not set `allowImportingTsExtensions`, so `import { x } from "./content.ts"`
  fails typecheck with `TS5097`. Write `from "./content"`; Vite resolves it
  fine.
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
