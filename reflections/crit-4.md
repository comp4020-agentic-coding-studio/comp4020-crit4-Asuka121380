# Crit 4 reflection

The breakthrough that moved *The Living Score* forward was learning to
separate mechanically correct behaviour from an interaction that actually
feels musical. My first gesture and audio implementations passed their tests,
yet real use exposed delayed chord changes, abrupt releases and unreliable
corners. Instead of continuing to lower thresholds, I traced the complete
path from pointer input to Web Audio scheduling. That revealed several
different causes: an outgoing chord masked the incoming one, scheduling at
`currentTime` could race Safari's audio renderer, and rejected gesture history
could later combine with unrelated movement. Treating those as separate
problems produced a more responsive instrument without making smooth curves
or vibrato trigger harmony changes.

The same lesson shaped the visual and timbre work. Audio and notation now
consume the same `ChordEvent`, so the four SVG staves display the pitches that
actually sound rather than decorative marks. Real-browser inspection also
caught an invisible baton shaft and mobile overflow that unit tests could not
see. Brass and Strings now use genuinely different synthesis structures, but
I have kept the distinction between a structurally verified audio graph and a
timbre verified by human listening.

This work changed the kind of developer I want to be. I do not want to confuse
a green test suite, a plausible explanation, or an agent's confident report
with evidence that a product works for a person. I want to combine adversarial
tests for invariants, instrumentation for timing, browser inspection for
rendering, and repeated human evaluation for feel. Agentic coding is most
useful to me when the agent accelerates implementation and records its
assumptions, while I remain responsible for challenging those assumptions and
judging the experience on real devices.
