# Crit 4 reflection

(First written mid-build, after the core signal chain landed and before the
first deployment or human listening pass. Revised after the MVP was deployed
and after a first refinement pass rebuilt the audio/gesture model — still not
the final entry, since the notation/UI slice and the human listening pass are
both still pending.)

The original breakthrough wasn't the harmony system or the synthesis graph
themselves — it was writing the polyphony-cap test *before* trusting the
cap. I'd written `stealOldestIfAtCap` believing it enforced a hard limit, and
it read as obviously correct: check the length, fade the oldest, move on.
Feeding it thirty rapid chords through a fake `AudioContext` showed the pool
at 20 active voices against a documented cap of 16 — the "stopped" voice was
still sitting in the bookkeeping array because it was only ever removed by a
browser event that, in the test, never fired. Real hardware fires that event
too, just slightly late, which is exactly the gap "rapid, sustained
conducting" in the brief is warning about.

That's changed how I want to treat the safety properties of anything
synthesis- or resource-bounded: a cap I can't watch fail under an adversarial
input isn't verified, it's assumed. Before this, I'd have called a plausible-
looking guard clause "done." Now the instinct is to ask what input would make
the plausible version lie, and write that input down as a test before moving
on — especially for anything that only misbehaves under timing pressure a
casual manual check would never happen to hit.

## After the refinement pass

The same instinct paid off again, in almost the same shape, while building
`gesture.ts`. The axis-detection logic looked correct by inspection: take the
first and last point in a short rolling window, compute the angle between
them, compare it to the locked axis. What I didn't notice until I sat down to
write the test suite is that on the very first qualifying sample, that window
holds exactly one point — so the "angle between first and last point" is the
angle of a zero-length vector, which every implementation I tried quietly
returns as 0°. That 0° then gets locked in as the gesture's real axis no
matter which way the pointer is actually moving, which would falsely fire a
harmony change on the second sample of nearly any diagonal gesture. Nothing
in the code *looked* wrong; it took deliberately writing down "what happens
on the very first sample" as its own test case to notice the window could
still be a single point. I'm treating this as the same lesson as the
polyphony cap, generalised: for anything with an implicit "this only becomes
well-defined after N samples/events" assumption, write the N=0 and N=1 cases
down explicitly, because they're exactly the cases a plausible-looking
implementation slides past.

The other thing worth naming honestly: I followed the refinement prompt's
instruction not to let notation/visual polish block shipping the corrected
audio and gesture model, which meant deliberately *not* touching
`visualization.ts` or `styles.css` in this pass even though the interaction
model driving them changed underneath. That was the right call for staying
unblocked, but it leaves the current interim state slightly uncomfortable —
the score still shows fading gold dots rather than real notation, and the old
Clear/single-toggle buttons are still there — and I want to be honest that
this is a deliberately incomplete snapshot, not a finished one. The bigger
open question, though, is one no test can answer: does any of this — the
per-voice balance, the speed curve, the corner sensitivity, the vibrato
depth — actually feel right to a person conducting with their hand, on a
phone speaker, rather than to a synthetic pointer trace on a laptop. That's
still waiting on a real listening pass.
