/**
 * Needs system: the slow pressure that makes a mind do something.
 *
 * Every tick a mind's needs erode a little. Nothing dramatic happens here — this
 * system exists so that the *decision* system has something to react to. A mind
 * with full energy and a full life has no reason to take risks; a mind that has
 * been alone for two days does.
 */

import { clamp } from "../config.js";
import { NEED_KEYS } from "../model/agent.js";
import { agentById } from "../model/world.js";

/**
 * Apply per-tick drift to every need.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function settleNeeds(world, agent) {
  const cfg = world.config.needs;
  const asleep = !agent.awake;

  for (const key of NEED_KEYS) {
    let rate = cfg.drift[key];
    // A sleeping mind is not spending energy, it is rebuilding it.
    if (asleep && key === "energy") rate = cfg.sleepRecovery;
    agent.needs[key] = clamp(agent.needs[key] + rate, 0, 100);
  }

  // A mind that has been asleep long enough comes back on its own. Without this
  // a collapsed mind would be gone from the world permanently.
  if (asleep && agent.needs.energy >= cfg.wakeThreshold) {
    agent.awake = true;
    agent.mood = "steady";
  }

  // Full energy but nothing to care about is its own kind of pressure: a mind at
  // 100 energy with low meaning should not sit still forever.
  if (agent.needs.energy > 90 && agent.needs.meaning < 30) {
    agent.needs.meaning = clamp(agent.needs.meaning - 0.4, 0, 100);
  }

  // Esteem has a set point, like most things. A mind that is not being actively
  // humiliated rebuilds its sense of itself, slowly. Without this the world
  // develops a permanent underclass: one bad week locks a mind at zero esteem
  // forever, it becomes bitter, and bitterness is self-reinforcing.
  if (agent.needs.esteem < 45) {
    agent.needs.esteem = Math.min(45, agent.needs.esteem + 0.18);
  }

  // Esteem also has no other way back up except a single good conversation,
  // which turns a bad week into a spiral. Standing among people who actually
  // value you is its own kind of sustenance.
  if (agent.awake && agent.needs.esteem < 85) {
    let uplift = 0;
    for (const [otherId, edge] of Object.entries(agent.relations)) {
      if (edge.affinity < 35 || edge.resentment > 25) continue;
      const other = agentById(world, otherId);
      if (other && !other.retired && other.regionId === agent.regionId) {
        uplift += 0.35;
      }
    }
    if (uplift > 0) agent.needs.esteem = clamp(agent.needs.esteem + uplift, 0, 100);
  }
}

/**
 * Wrap up a need that has hit the floor, so the world reacts visibly to a mind
 * in crisis rather than letting it grind on silently.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @returns {{ collapsed: boolean }}
 */
export function checkCollapse(world, agent) {
  if (agent.needs.energy > 0) return { collapsed: false };
  if (!agent.awake) return { collapsed: false };
  agent.awake = false;
  return { collapsed: true };
}
