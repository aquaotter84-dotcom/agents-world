/**
 * The keeper's want: harmony, prosperity, legacy.
 *
 * Everything else in this engine belongs to the minds. This module belongs to
 * the person watching them. Three meters, each 0..100, each readable off the
 * world's real condition and each moveable by what the keeper actually does:
 *
 *   harmony     the minds' collective state — bonds strong, feuds cooling,
 *               nobody left alone too long
 *   prosperity  the shared work — the North Wall, favours repaid, projects
 *               thriving
 *   legacy      what endures — laws and traditions still standing, roles still
 *               held, the weight of the chronicle and of the graves
 *
 * The meters are the keeper's own scoreboard, and they are deliberately not a
 * resource: nothing is bought with them. They are a reading of whether the
 * world is in better shape than it was, and the *only* way to move them is to
 * act. Every movement is written down with its cause, so a meter that is
 * falling always has a sentence next to it saying why.
 *
 * The one thing that can move a meter without anybody doing anything is
 * silence. A world that has stopped asking the keeper for anything is decaying
 * its own harmony, tick by tick, and a world that stays silent long enough
 * falls quiet altogether. That is the lose condition, and it is legible: the
 * counter is right there in the state and the fall is announced.
 */

import { clamp } from "../config.js";

/** The three meters, in the order they are shown. */
export const WANT_METERS = /** @type {readonly ["harmony", "prosperity", "legacy"]} */ (["harmony", "prosperity", "legacy"]);

/**
 * What each meter means, in the keeper's own words. The UI reads this rather
 * than inventing its own copy, so the engine and the screen cannot disagree
 * about what harmony *is*.
 * @type {Record<string, {name: string, blurb: string, color: string}>}
 */
export const WANT_LABELS = {
  harmony: {
    name: "Harmony",
    blurb: "how the minds stand together — bonds made, feuds cooling, nobody alone too long",
    color: "#5ad1b0"
  },
  prosperity: {
    name: "Prosperity",
    blurb: "the shared work — the wall going up, favours repaid, projects alive",
    color: "#f3d9a4"
  },
  legacy: {
    name: "Legacy",
    blurb: "what endures — laws and traditions still standing, roles still held, the chronicle's weight",
    color: "#b79cf0"
  }
};

/** How many movements the ledger keeps. Older entries fall off the front. */
export const WANT_LOG_CAP = 48;

/**
 * @typedef {object} WantMeterState
 * @property {number} value
 * @property {string} word
 */

/**
 * The keeper's want, as it lives on the world.
 *
 * `log` is the whole point of the object: every entry is one movement of the
 * meters with the cause that moved it, so "why is harmony falling" is always
 * answered by reading the last few lines rather than by guessing.
 *
 * @typedef {object} Want
 * @property {number} harmony
 * @property {number} prosperity
 * @property {number} legacy
 * @property {number} tick                The tick the meters were last read.
 * @property {{tick: number, cause: string, by: string, deltas: Record<string, number>, values: Record<string, number>}[]} log
 * @property {Record<string, number>} drift  Unflushed drift per meter, logged in batches.
 * @property {number} driftLoggedAt       Tick the drift ledger last flushed.
 * @property {number} lastAskTick         When the world last asked the keeper for anything.
 * @property {number} quietTicks          How long it has been since it last did.
 * @property {number} quietLoggedAt       Quiet-tick mark of the last warning written.
 * @property {number} asks                Total asks heard since the world began.
 * @property {number} ignored             Asks the keeper never answered.
 * @property {boolean} fallen             True once a silent world's harmony is spent.
 * @property {number} fallenTick
 * @property {number} revivals            Times a fallen world found its voice again.
 */

/** @returns {Want} */
export function createWant() {
  return {
    harmony: 50,
    prosperity: 50,
    legacy: 50,
    tick: 0,
    log: [],
    drift: { harmony: 0, prosperity: 0, legacy: 0 },
    driftLoggedAt: 0,
    lastAskTick: 0,
    quietTicks: 0,
    quietLoggedAt: 0,
    asks: 0,
    ignored: 0,
    fallen: false,
    fallenTick: -1,
    revivals: 0
  };
}

/**
 * Coerce whatever came out of a save into a valid want. A meter that cannot be
 * trusted keeps its starting value rather than crashing the launch, and the
 * ledger is filtered down to entries the UI can actually render.
 * @param {unknown} raw
 * @returns {Want}
 */
export function normalizeWant(raw) {
  const base = createWant();
  const w = /** @type {any} */ (raw);
  if (!w || typeof w !== "object") return base;
  /** @param {unknown} value */
  const meter = value => (typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 100) : base.harmony);
  /** @type {any[]} */
  const rawLog = Array.isArray(w.log) ? w.log : [];
  const log = rawLog
    .filter(/** @param {any} entry */ entry => entry && typeof entry === "object" && typeof entry.cause === "string" && entry.deltas)
    .slice(-WANT_LOG_CAP)
    .map(/** @param {any} entry */ entry => ({
      tick: Number.isFinite(entry.tick) ? entry.tick : 0,
      cause: String(entry.cause).slice(0, 160),
      by: typeof entry.by === "string" ? entry.by : "world",
      deltas: { ...entry.deltas },
      values: entry.values && typeof entry.values === "object" ? { ...entry.values } : {}
    }));
  return {
    harmony: meter(w.harmony),
    prosperity: meter(w.prosperity),
    legacy: meter(w.legacy),
    tick: Number.isFinite(w.tick) ? w.tick : 0,
    log,
    drift: {
      harmony: Number.isFinite(w.drift?.harmony) ? w.drift.harmony : 0,
      prosperity: Number.isFinite(w.drift?.prosperity) ? w.drift.prosperity : 0,
      legacy: Number.isFinite(w.drift?.legacy) ? w.drift.legacy : 0
    },
    driftLoggedAt: Number.isFinite(w.driftLoggedAt) ? w.driftLoggedAt : 0,
    lastAskTick: Number.isFinite(w.lastAskTick) ? w.lastAskTick : 0,
    quietTicks: Number.isFinite(w.quietTicks) ? w.quietTicks : 0,
    quietLoggedAt: Number.isFinite(w.quietLoggedAt) ? w.quietLoggedAt : 0,
    asks: Number.isFinite(w.asks) ? w.asks : 0,
    ignored: Number.isFinite(w.ignored) ? w.ignored : 0,
    fallen: Boolean(w.fallen),
    fallenTick: Number.isFinite(w.fallenTick) ? w.fallenTick : -1,
    revivals: Number.isFinite(w.revivals) ? w.revivals : 0
  };
}

/** @param {Want} want */
export function wantValues(want) {
  return { harmony: want.harmony, prosperity: want.prosperity, legacy: want.legacy };
}

/**
 * Append one movement to the ledger, capped and newest-last.
 * @param {Want} want
 * @param {{tick: number, cause: string, by: string, deltas: Record<string, number>, values: Record<string, number>}} entry
 */
export function recordWantMovement(want, entry) {
  want.log.push(entry);
  if (want.log.length > WANT_LOG_CAP) want.log.splice(0, want.log.length - WANT_LOG_CAP);
  return entry;
}

/**
 * The last movements the ledger holds, newest first.
 * @param {Want} want
 * @param {number} [n]
 */
export function wantLog(want, n = 8) {
  return want.log.slice(-n).reverse();
}

/**
 * The most recent movement of a given kind that is not plain drift. This is
 * what the screen shows next to each meter: "the last thing you did that moved
 * this", so the numbers are always attached to an act.
 * @param {Want} want
 * @param {string} meter
 */
export function lastKeeperMovement(want, meter) {
  for (let i = want.log.length - 1; i >= 0; i--) {
    const entry = want.log[i];
    if (entry.by === "drift") continue;
    if (Math.abs(entry.deltas[meter] || 0) < 0.05) continue;
    return entry;
  }
  return null;
}

/**
 * One word for a meter's level, so a bar is also a sentence.
 * @param {"harmony"|"prosperity"|"legacy"|string} meter
 * @param {number} value
 */
export function meterWord(meter, value) {
  const bands = {
    harmony: ["sundered", "fraying", "even", "holding", "warm"],
    prosperity: ["barren", "thin", "steady", "buoyant", "abundant"],
    legacy: ["unwritten", "thin", "remembered", "standing", "enduring"]
  };
  const words = bands[/** @type {keyof typeof bands} */ (meter)] || bands.harmony;
  if (value >= 80) return words[4];
  if (value >= 62) return words[3];
  if (value >= 42) return words[2];
  if (value >= 22) return words[1];
  return words[0];
}

/**
 * The keeper's standing in one line, for the top of the want panel.
 * @param {Want} want
 * @param {{quietAfterTicks: number}} cfg
 */
export function wantVerdict(want, cfg) {
  if (want.fallen) {
    return {
      tone: "fallen",
      line: "The world has gone quiet. Nothing asks you for anything any more."
    };
  }
  if (want.quietTicks > cfg.quietAfterTicks) {
    const days = Math.floor(want.quietTicks / 48);
    return {
      tone: "draining",
      line: `Nobody has asked you for anything in ${days} day${days === 1 ? "" : "s"} — harmony is draining.`
    };
  }
  const total = want.harmony + want.prosperity + want.legacy;
  if (total >= 210) return { tone: "high", line: "The world is in good hands, and it knows it." };
  if (total >= 150) return { tone: "steady", line: "The world is holding. Your hand on it shows." };
  if (total >= 90) return { tone: "low", line: "The world is fraying at the edges of what you have kept." };
  return { tone: "bad", line: "Little of what you have kept is holding. The world needs you to do something." };
}
