/**
 * Snapshots: turning a living world into something that can be written to disk
 * and back without it noticing.
 *
 * The only awkward part is the generator, whose state is a single integer, and
 * the id factory, which is a closure over a counter object. Both are restored
 * exactly, so a reloaded world continues the same sequence it would have
 * continued had it never been saved. That is what makes it possible to rewind
 * to a save and watch an interesting week play out differently.
 */

import { createRng } from "./rng.js";
import { makeConfig } from "./config.js";
import { makeIdFactory } from "./model/world.js";

/**
 * The parts of a world worth persisting. Derived data (factions, stats) is
 * deliberately left out — recomputing is cheaper and it can't fall out of sync.
 */
const PERSISTED = [
  "id",
  "seed",
  "clock",
  "agents",
  "regions",
  "events",
  "tallies",
  "secrets",
  "pending",
  "resolved",
  "chronicle",
  "chronicleMark",
  "seq",
  "flags"
];

/**
 * @param {import("./model/world.js").World} world
 * @returns {string}
 */
export function serializeWorld(world) {
  /** @type {Record<string, any>} */
  const out = {};
  const source = /** @type {Record<string, any>} */ (/** @type {unknown} */ (world));
  for (const key of PERSISTED) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  out.idCounters = world.idCounters;
  out.rngState = world.rng.state();
  out.config = world.config;
  return JSON.stringify(out);
}

/**
 * @param {string|object} input
 * @returns {import("./model/world.js").World}
 */
export function deserializeWorld(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const rng = createRng(data.seed);
  rng.restore(data.rngState);

  const counters = data.idCounters || {};
  /** @type {any} */
  const world = {};
  for (const key of PERSISTED) {
    if (data[key] !== undefined) world[key] = data[key];
  }
  world.config = makeConfig(data.config);
  world.rng = rng;
  world.idCounters = counters;
  world.nextId = makeIdFactory(counters);
  return world;
}

/**
 * Deep-copy a world by round-tripping it through a snapshot. Useful for tests
 * that want to explore two futures from the same moment.
 * @param {import("./model/world.js").World} world
 * @returns {import("./model/world.js").World}
 */
export function forkWorld(world) {
  return deserializeWorld(serializeWorld(world));
}
