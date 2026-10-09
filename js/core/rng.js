// rng.js - seeded, deterministic random numbers.
//
// Every random decision in the game (damage rolls, AI jitter, bracket draws,
// roster generation) must come from a seeded stream so a season can be
// replayed or reproduced from a save file. Math.random() is banned in logic.

// mulberry32: tiny, fast, good enough statistically, trivially portable.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,                                            // [0, 1)
    float: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),  // inclusive
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // Fisher-Yates on a copy, so callers never mutate shared data.
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    // Expose the state so a save file can resume the exact same stream.
    getState: () => a,
    setState: (s) => { a = s >>> 0; },
  };
}

// Stable string -> seed, so "season-3-group-B" always draws the same way.
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
