/**
 * The map as a graph.
 *
 * Regions are nodes, paths are edges. Minds move one step per action, which
 * means distance is real: a mind at the wall cannot reach the marsh in the same
 * tick, and being far from someone is a genuine obstacle to a relationship.
 */

import { regionById } from "./world.js";

/**
 * Breadth-first shortest path between two regions.
 * @param {import("./world.js").World} world
 * @param {string} fromId
 * @param {string} toId
 * @returns {string[]} Region ids from (exclusive) to (inclusive). Empty if unreachable.
 */
export function regionPath(world, fromId, toId) {
  if (fromId === toId) return [];
  /** @type {Map<string, string>} */
  const cameFrom = new Map();
  const queue = [fromId];
  const seen = new Set([fromId]);

  while (queue.length) {
    const current = /** @type {string} */ (queue.shift());
    const region = regionById(world, current);
    if (!region) break;
    for (const nextId of region.links) {
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      cameFrom.set(nextId, current);
      if (nextId === toId) {
        /** @type {string[]} */
        const path = [nextId];
        let cursor = current;
        while (cursor !== fromId) {
          path.unshift(cursor);
          cursor = /** @type {string} */ (cameFrom.get(cursor));
        }
        return path;
      }
      queue.push(nextId);
    }
  }
  return [];
}

/**
 * The single next region to step into on the way to a destination.
 * @returns {string|null} Null when already there or unreachable.
 * @param {import("./world.js").World} world
 * @param {string} fromId
 * @param {string} toId
 */
export function nextStepToward(world, fromId, toId) {
  const path = regionPath(world, fromId, toId);
  return path.length ? path[0] : null;
}

/**
 * How many steps apart two regions are. Infinity when unreachable.
 * @param {import("../model/world.js").World} world
 * @param {string} fromId
 * @param {string} toId
 * @returns {number}
 */
export function regionDistance(world, fromId, toId) {
  if (fromId === toId) return 0;
  const path = regionPath(world, fromId, toId);
  return path.length || Infinity;
}

/**
 * Regions a mind has never been to. Used by the explore intent.
 *
 * "Been to" is modelled as having any memory trace mentioning a move there, or
 * simply as the set of regions in their relationship-free memory. Rather than
 * track visitation as separate state, the engine derives it from the events the
 * mind was present for — a region they have never acted in is new to them.
 * @param {import("./world.js").World} world
 * @param {string} agentId
 * @returns {string[]}
 */
export function unfamiliarRegions(world, agentId) {
  const visited = new Set();
  for (const event of world.events) {
    if (event.agentId === agentId && event.regionId) visited.add(event.regionId);
  }
  return world.regions.filter(r => !visited.has(r.id)).map(r => r.id);
}

/**
 * Regions that are quiet and untouched — good places to be alone.
 * @param {import("../model/world.js").World} world
 * @returns {string[]}
 */
export function solitaryRegions(world) {
  return world.regions.filter(r => r.kind === "wild" || r.kind === "frontier").map(r => r.id);
}

/**
 * Where a mind would go if it wanted company: the most populated region it can
 * reach, weighted toward ones that already hold people it knows.
 * @param {import("./world.js").World} world
 * @param {import("./agent.js").Agent} agent
 */
export function sociableTarget(world, agent) {
  const counts = new Map();
  for (const other of world.agents) {
    if (other.id === agent.id || other.retired || other.regionId === agent.regionId) continue;
    counts.set(other.regionId, (counts.get(other.regionId) || 0) + 1);
  }
  let best = null;
  let bestScore = 0;
  for (const [regionId, count] of counts) {
    const distance = regionDistance(world, agent.regionId, regionId);
    if (!Number.isFinite(distance)) continue;
    const score = count / (1 + distance * 0.6);
    if (score > bestScore) {
      bestScore = score;
      best = regionId;
    }
  }
  return best;
}
