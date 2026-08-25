# Crit 4 reflection

(Written mid-build, after the core signal chain landed and before the first
deployment or human listening pass — will be revisited before the cutoff.)

The breakthrough so far wasn't the harmony system or the synthesis graph
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
