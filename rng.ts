// A small seedable PRNG (mulberry32) so harmony sampling can be deterministic
// in tests while still feeling random during actual play.
export type RandomSource = () => number;

export function mulberry32(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an index from `weights` (need not sum to 1) using `random() -> [0,1)`. */
export function weightedPick<T>(items: readonly T[], weights: readonly number[], random: RandomSource): T {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}
