/**
 * Calendar rituals: recurring world events on the engine's clock.
 *
 * Rituals give the calendar a shape. On Gathering Night the world leans
 * together — minds feel it in their connection and choose company more often.
 * On Quiet Day everything softens — meaning and rest rise, and the world
 * turns inward. They are the closest the engine comes to weather: nobody
 * decides them, everybody feels them.
 *
 * A ritual applies its need shifts once per day, the first tick it is active.
 * A phase-bound ritual (dusk, dawn) stays "active" for the whole phase so
 * intents can lean with it, but the needs only move once.
 */

import { livingAgents } from "../model/world.js";
import { logEvent } from "../model/events.js";
import { clamp } from "../config.js";

/**
 * The ritual active right now, if any.
 * @param {import("../model/world.js").World} world
 * @returns {any|null}
 */
export function activeRitual(world) {
  const list = world.config.rituals.list;
  for (const ritual of list) {
    if ((world.clock.day - ritual.offsetDays) % ritual.everyDays !== 0) continue;
    if (ritual.phase && world.clock.phase !== ritual.phase) continue;
    return ritual;
  }
  return null;
}

/**
 * Run once per tick. Applies a newly-active ritual's shifts exactly once.
 * @param {import("../model/world.js").World} world
 */
export function settleRituals(world) {
  const ritual = activeRitual(world);
  if (!ritual) return;
  const key = `${ritual.id}:${world.clock.day}`;
  if (world.lastRitualKey === key) return;
  world.lastRitualKey = key;

  const line = world.rng.pick(ritual.lines);
  for (const agent of livingAgents(world)) {
    for (const [need, delta] of Object.entries(ritual.needs || {})) {
      if (!(need in agent.needs)) continue;
      agent.needs[/** @type {keyof import("../model/agent.js").NeedSet} */ (need)] =
        clamp(agent.needs[/** @type {keyof import("../model/agent.js").NeedSet} */ (need)] + /** @type {number} */ (delta), 0, 100);
    }
  }

  logEvent(world, {
    kind: "ritual",
    agentId: null,
    text: line,
    significance: 0.5,
    regionId: undefined
  });
}
