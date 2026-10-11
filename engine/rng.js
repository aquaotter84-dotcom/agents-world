/**
 * Deterministic seeded randomness.
 *
 * Every stochastic decision in the simulation draws from here, so a world with a
 * given seed always replays identically. That makes the sim testable and makes
 * bug reports reproducible ("seed 4711, tick 300").
 *
 * No dependencies, no globals — safe to embed in a browser or a server.
 */

/**
 * Turn an arbitrary seed (number or string) into a 32-bit integer.
 * @param {number|string} seed
 * @returns {number}
 */
function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * @typedef {object} Rng
 * @property {() => number} float    Uniform in [0, 1).
 * @property {(min: number, max: number) => number} range  Uniform real in [min, max).
 * @property {(min: number, max: number) => number} int    Uniform integer, inclusive.
 * @property {<T>(arr: readonly T[]) => T} pick           Uniform element (empty-safe: throws).
 * @property {(p: number) => boolean} chance              True with probability p.
 * @property {<T>(arr: T[]) => T[]} shuffle               Fisher-Yates copy.
 * @property {(mean: number, sd: number) => number} gauss  Normal, clamped to +/- 3sd.
 * @property {(label?: string) => Rng} fork                Independent substream.
 * @property {() => number} state                          Current raw counter (for snapshots).
 * @property {(n: number) => void} restore                 Restore a raw counter.
 */

/**
 * Create a deterministic RNG.
 *
 * The generator's entire state is one 32-bit counter, which makes it exactly
 * snapshot-restorable: save the state, save the world, and a restored world
 * continues to produce the same sequence it would have. A generator holding
 * hidden internal state could not do that, and a world you cannot rewind is a
 * world you cannot debug.
 *
 * @param {number|string} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = hashSeed(seed) || 1;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  /** @type {Rng} */
  const rng = {
    float: () => next(),

    range(min, max) {
      return min + next() * (max - min);
    },

    int(min, max) {
      if (max < min) return min;
      return Math.floor(min + next() * (max - min + 1));
    },

    pick(arr) {
      if (!arr.length) throw new Error("rng.pick: empty array");
      return arr[Math.floor(next() * arr.length)];
    },

    chance(p) {
      return next() < p;
    },

    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },

    /** Box-Muller, clamped so one bad draw can't produce an absurd value. */
    gauss(mean, sd) {
      const u = Math.max(next(), 1e-9);
      const v = next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + Math.max(-3, Math.min(3, z)) * sd;
    },

    /**
     * Derive a sub-stream from the current counter so callers can get an
     * independent sequence without disturbing the parent's advancement.
     */
    fork(label = "") {
      const derived = (Math.imul(state ^ hashSeed(label), 2654435761) >>> 0);
      return createRng(derived);
    },

    state: () => state,

    restore(n) {
      state = n >>> 0;
    }
  };

  return rng;
}

/**
 * Weighted pick. Weights need not sum to 1; negatives are treated as 0.
 * @template T
 * @param {Rng} rng
 * @param {readonly T[]} items
 * @param {(item: T) => number} weightOf
 * @returns {T}
 */
export function weightedPick(rng, items, weightOf) {
  if (!items.length) throw new Error("weightedPick: empty array");
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total <= 0) return rng.pick(items);
  let roll = rng.float() * total;
  for (const it of items) {
    roll -= Math.max(0, weightOf(it));
    if (roll <= 0) return it;
  }
  return items[items.length - 1];
}
