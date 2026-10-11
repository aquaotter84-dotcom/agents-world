/**
 * Memory system: what a mind keeps, and what it lets go of.
 *
 * This runs every tick for every mind. It is cheap and constant, and it is the
 * reason a mind that has been treated badly for a week behaves differently from
 * one that hasn't — even though nothing in the decision system reads history
 * directly. History reaches decisions only through the shape memory has taken.
 */

import { decayAndConsolidate, recall } from "../model/memory.js";
import { livingAgents } from "../model/world.js";

/**
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function settleMemory(world, agent) {
  return decayAndConsolidate(agent.memory, {
    tick: world.clock.tick,
    config: world.config,
    makeId: world.nextId,
    capacity: world.config.limits.agentMemories
  });
}

/**
 * What a mind is currently chewing on — its strongest live concerns. Used for
 * prompts and for the debug view, and useful in tests to prove that significant
 * events actually stick.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {number} [limit]
 */
export function preoccupations(world, agent, limit = 4) {
  return recall(agent.memory, {
    tick: world.clock.tick,
    limit,
    config: world.config
  });
}

/**
 * Memory pressure across the whole world: who is carrying the most.
 * @param {import("../model/world.js").World} world
 * @returns {{agentId: string, traces: number}[]}
 */
export function memoryLoad(world) {
/**
 * @param {any} t
 */
  const rows = livingAgents(world).map(a => ({
    agentId: a.id,
    name: a.name,
    traces: a.memory.traces.length,
    summaries: a.memory.traces.filter(t => t.consolidated).length
  }));
  rows.sort((a, b) => b.traces - a.traces);
  return rows;
}
