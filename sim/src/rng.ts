// Seeded RNG (mulberry32). The state is a plain number kept in GameState, so a saved game
// resumes with the same random sequence.

export function seedRng(seed: number): number {
  return seed >>> 0;
}

/** Returns a float in [0, 1) and the next RNG state. */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** A random factor of 1 ± spread, and the next RNG state. */
export function vary(rng: number, spread: number): [factor: number, next: number] {
  const [r, next] = nextRandom(rng);
  return [1 + spread * (2 * r - 1), next];
}
