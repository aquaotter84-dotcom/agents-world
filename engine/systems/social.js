/**
 * Social system: everything about relationships that happens passively.
 *
 * Minds do not only change how they feel about each other when something happens
 * — feelings also drift on their own. Affection fades with distance, familiarity
 * builds just from being in the same place, and resentment cools at its own,
 * much slower rate. This system is why a world left running develops a history
 * rather than a series of unrelated incidents.
 */

import { edgeToward, decayRelations, factions } from "../model/relationships.js";
import { recall } from "../model/memory.js";
import { livingAgents, agentById, privateSecretsHeld } from "../model/world.js";

/**
 * Time passing, applied to every relationship a mind holds.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function settleRelations(world, agent) {
  decayRelations(agent, world.clock.tick, world.config);
}

/**
 * Minds sharing a place grow familiar with each other just by being there.
 * Deliberately small: proximity alone should never make friends, only make
 * friendship possible.
 * @param {import("../model/world.js").World} world
 */
export function settleProximity(world) {
  const gain = world.config.relations.proximityFamiliarity;
  const byRegion = new Map();
  for (const agent of livingAgents(world)) {
    const list = byRegion.get(agent.regionId);
    if (list) list.push(agent);
    else byRegion.set(agent.regionId, [agent]);
  }
  for (const group of byRegion.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id) continue;
        const edge = edgeToward(a, b.id);
        edge.familiarity = Math.min(100, edge.familiarity + gain * 0.5);
      }
    }
  }
}

/**
 * Who is currently aligned with whom. Recomputed rather than cached so it can
 * never disagree with the underlying edges.
 * @param {import("../model/world.js").World} world
 */
export function currentFactions(world) {
  return factions(livingAgents(world), world.config);
}

/** Ways a mind's own conduct can turn into something it has to carry. */
const DEEDS = [
  (/** @type {string} */ a, /** @type {string} */ b) => `${a} did something to ${b} that ${b} never found out about`,
  (/** @type {string} */ a, /** @type {string} */ b) => `${a} was the one who started it with ${b}, not the other way around`,
  (/** @type {string} */ a, /** @type {string} */ b) => `${a} has been less honest with ${b} than anyone realises`,
  (/** @type {string} */ a, /** @type {string} */ b) => `${a} said something about ${b} that would end things if it got back to them`
];

/**
 * Deeds become secrets.
 *
 * Without this the world runs out of fuel. A world starts with a handful of
 * secrets, they all spread, they all go public, and after a couple of weeks
 * there is nothing left that anybody is holding — every conversation becomes
 * small talk. Here, a mind that has done something it would rather nobody knew
 * eventually starts carrying it as a secret, which it can then confide, which
 * can then be gossiped, which can then be used. The machinery feeds itself.
 *
 * @param {import("../model/world.js").World} world
 */
export function hatchSecrets(world) {
  const tick = world.clock.tick;
  const cfg = world.config.limits;
  if (world.secrets.length >= cfg.secretsInWorld) return;
  // Cheap to run, but there is no need to check every mind every tick.
  if (tick % 6 !== 0) return;
  const rng = world.rng;

  for (const agent of livingAgents(world)) {
    // A mind already carrying plenty has enough to think about.
    if (privateSecretsHeld(world, agent.id).length >= cfg.secretsPerAgent) continue;
    if (tick - (agent.lastSecretHatchTick ?? -9999) < 200) continue;
    const shaming = recall(agent.memory, {
      tick,
      kinds: ["betrayal", "conflict"],
      limit: 3,
      config: world.config
    }).filter(t => t.valence < -0.35 && t.subjectId && tick - t.tick <= 14);
    if (!shaming.length) continue;
    if (!rng.chance(0.12)) continue;

    const source = shaming[0];
    const other = agentById(world, /** @type {string} */ (source.subjectId));
    if (!other || other.retired) continue;

    const text = rng.pick(DEEDS)(agent.name, other.name);
    world.pendingOps = world.pendingOps || [];
    world.pendingOps.push({
      op: "secret_new",
      holder: agent.id,
      about: agent.id,
      kind: "crime",
      text
    });
    agent.lastSecretHatchTick = tick;
  }
}

/**
 * The world's social temperature: how much warmth versus friction exists right
 * now. Exposed for the UI and for tests that assert the world develops drama
 * rather than settling into a flat equilibrium.
 * @param {import("../model/world.js").World} world
 */
export function socialTemperature(world) {
  let affection = 0;
  let friction = 0;
  let pairs = 0;
  for (const agent of livingAgents(world)) {
    for (const edge of Object.values(agent.relations)) {
      affection += Math.max(0, edge.affinity);
      friction += edge.resentment;
      pairs += 1;
    }
  }
  if (!pairs) return { affection: 0, friction: 0, ratio: 0 };
  return {
    affection: affection / pairs,
    friction: friction / pairs,
    ratio: affection / Math.max(1, friction)
  };
}
