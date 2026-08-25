import { describe, expect, it } from "vitest";
import { CHORD_COLOUR_TABLE } from "../harmony";
import { INSTRUMENT_NAMES, VOICING_TABLE, VOICE_ORDER, pitchNameToMidi, voiceChord } from "../voicing";

describe("voicing: pitch-name to MIDI", () => {
  it.each([
    ["C4", 60],
    ["A4", 69],
    ["C2", 36],
    ["G3", 55],
    ["Ab3", 56],
    ["F#2", 42],
  ])("%s -> midi %i", (name, midi) => {
    expect(pitchNameToMidi(name)).toBe(midi);
  });
});

describe("voicing: fixed fallback table", () => {
  it("has a row for every chord symbol the harmony engine can produce", () => {
    const allSymbols = Object.values(CHORD_COLOUR_TABLE).flatMap((rows) => rows.map((r) => r.symbol));
    for (const symbol of allSymbols) {
      expect(VOICING_TABLE[symbol], `missing voicing row for ${symbol}`).toBeDefined();
    }
  });

  it("produces exactly four voiced notes, one per voice role, for every chord", () => {
    for (const symbol of Object.keys(VOICING_TABLE)) {
      const notes = voiceChord(symbol, "brass");
      expect(notes).toHaveLength(4);
      expect(notes.map((n) => n.voice).sort()).toEqual([...VOICE_ORDER].sort());
    }
  });

  it("keeps bass lowest and soprano highest for every fixed voicing", () => {
    for (const symbol of Object.keys(VOICING_TABLE)) {
      const notes = voiceChord(symbol, "brass");
      const byVoice = Object.fromEntries(notes.map((n) => [n.voice, n.midi]));
      expect(byVoice.bass).toBeLessThanOrEqual(byVoice.tenor);
      expect(byVoice.tenor).toBeLessThanOrEqual(byVoice.alto);
      expect(byVoice.alto).toBeLessThanOrEqual(byVoice.soprano);
    }
  });

  it("labels instruments per ensemble using concert-pitch instrument names", () => {
    const brassNotes = voiceChord("C", "brass");
    const stringNotes = voiceChord("C", "strings");
    expect(brassNotes.find((n) => n.voice === "bass")?.instrument).toBe(INSTRUMENT_NAMES.brass.bass);
    expect(stringNotes.find((n) => n.voice === "bass")?.instrument).toBe(INSTRUMENT_NAMES.strings.bass);
  });

  it("throws for a chord symbol with no fixed voicing", () => {
    expect(() => voiceChord("Xmaj9", "brass")).toThrow();
  });
});
