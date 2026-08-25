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

## After the first real listening pass

That listening pass came back, and it was useful precisely because it
surfaced things no synthetic test could: corner-to-chord latency read as
"roughly half a second," pointer release felt abrupt, and speed-to-volume
still felt jumpy. None of my `gesture.test.ts`/`audio.test.ts` suites flagged
any of this, because they were built to check the *state machine's logic* —
does a corner fire once, does the cap hold, is the axis math right — not
*how it feels in time*. That's a distinction I want to hold onto: a green
test suite proves the mechanism does what I told it to do; it says nothing
about whether what I told it to do is the right target. Timing/feel
parameters (latency thresholds, ramp durations, response asymmetry) are a
different category of thing from correctness, and they need a human in the
loop by construction — no amount of additional synthetic testing before
shipping would have caught "this feels slow," because "feels slow" isn't a
property of the code, it's a property of the code plus a nervous system.

Investigating the abrupt-release complaint also surfaced a subtler point:
the release code already *looked* like it was doing the right thing —
preserving gain, ramping instead of cutting — and technically it mostly was.
The actual gap was in a browser-compatibility corner (`cancelAndHoldAtTime`
support and behavior varies) that a fake `AudioContext` in a test can't
expose, because the fake doesn't have divergent implementations to be
inconsistent between. That's a real limit of the fake-graph testing strategy
this whole build has leaned on: it verifies the *shape* of the calls I make,
not whether real engines interpret those calls the way I expect. I addressed
it by not depending on the ambiguous API at all (reading `.value` and
re-asserting it explicitly before every ramp) rather than by trying to test
around the ambiguity — sometimes the fix for "my test can't see this bug" is
to remove the code path the test can't see, not to write a cleverer test.

Once this second pass comes back, the honest move if it's still not right is
the same as it was the first time: report exactly what's still off, tune the
specific constant it points at, and ask again — rather than guessing at a
"probably good enough" set of numbers and moving on to the notation/UI work
the brief explicitly said not to let this block. The instruction to stop and
ask at named checkpoints (balance/clarity, speed-to-volume, corner
sensitivity, vibrato depth) rather than compressing rounds "until it seems
right" isn't formality — it's how a feel property with no test actually gets
verified: by trading with a real listener across as many rounds as it takes,
not by getting to a checkpoint once and assuming it stuck.

## After the failed tuning attempt

The second pass came back, and it was a genuinely different kind of failure
than the first: not "these three numbers are off," but "the previous round's
whole framing was wrong." I had treated the first listening pass's latency
complaint as a gesture-confirmation problem and tuned `gesture.ts`'s
thresholds down to fix it. The user's follow-up message pointed out,
correctly, that this could not have been the real cause on its own — if
confirmation gets faster but the *audible* chord still lags, the delay must
be downstream of confirmation, in the audio graph itself. That's an
uncomfortable thing to have missed, because I had, in the previous round,
written down "the crossfade window was already narrow, so the latency must
be in gesture confirmation" as if it were a finding — but I had never
actually instrumented the confirmation→audio boundary to check. It was an
inference from "I don't see another candidate," not a measurement. This
round I did the measurement first: grepped for every possible deferral
mechanism across the whole codebase and found none, which is what let me
say with actual confidence (not just structural plausibility) that the
confirmation→invocation leg was same-tick. Only after ruling that leg out
did I go looking inside the crossfade shape itself, where the real cause
was — a shared attack/fade duration whose linear ramp shape kept the new
chord perceptually masked by the old one for most of its early duration.
The lesson I want to carry forward: "I checked the code path and it looks
fine" is not the same claim as "I measured the code path and it is fine,"
and when a human reports a *timing* complaint, only the second claim is
worth writing down as an explanation.

The second thing this round surfaced was a bug hiding behind a decision I'd
mentally filed as "deliberate": `GestureAnalyzer.reset()` preserving the
cooldown timestamp across gesture boundaries. I'd reasoned, when I wrote it,
that the cooldown is "a real-time guard, not a per-gesture counter," and
that reasoning felt complete enough that I never wrote a test for what
happens right after a `reset()`. It took the user explicitly naming
"cooldown logic delaying the current confirmed chord instead of only
blocking later triggers" as a thing to check before I went back and noticed
the theory didn't hold: a cooldown that outlives the gesture it was set
during can suppress the very first corner of an unrelated, later gesture,
which is indistinguishable from "corner detection missed a clear turn" to
the person conducting. This is the same shape of mistake as the polyphony
cap and the first-sample axis bug from earlier in this build — a piece of
logic that looked complete because I could narrate a coherent justification
for it, not because I had tried to break it. The justification itself was
the trap.

What I'm taking into the next round, if there is one: when a listening pass
reports "still not better," the right first move is not to retune whatever
constant looks closest to the complaint — it's to ask "did my previous
explanation of the cause actually get verified, or did it just sound
plausible at the time," and go re-check that before touching anything else.
