/**
 * Turnover: the cast changes.
 *
 * A world where the same nine minds are still standing in the same rooms a
 * year later is a diorama, not a world. New minds wander in; old ones drift
 * away or, rarely and only when they are old, die. Two promises keep this from
 * feeling arbitrary:
 *
 *   1. The original cast and any mind the keeper made are protected. The world
 *      may surprise its keeper, but it may not erase what he built.
 *   2. Nobody leaves out of nowhere. Departure follows sustained loneliness —
 *      a mind that has felt unheld for a long time finally goes looking for
 *      somewhere else to be.
 */

import { createAgent } from "../model/agent.js";
import { createMemory, remember } from "../model/memory.js";
import { livingAgents, regionName } from "../model/world.js";
import { logEvent } from "../model/events.js";
import { phrase } from "../decision/prose.js";
import { WANDERERS, BACKSTORIES } from "../content.js";
import { callFuneral, mournDeparture } from "./mourning.js";
import { settlementActive, foodDays } from "../model/settlement.js";

/**
 * Minds the world may not take on its own: the seed cast and the keeper's own
 * creations. Retirement by the keeper is a separate, deliberate act.
 * @param {import("../model/agent.js").Agent} agent
 */
export function isProtected(agent) {
  if (agent.userCreated) return true;
  if (agent.seedCast !== undefined) return agent.seedCast;
  // Worlds saved before the seedCast flag existed predate arrivals entirely,
  // so anything created at tick 0 there is original cast.
  return agent.createdTick === 0;
}

/**
 * Run once per tick. Tracks who is adrift, and considers arrivals and
 * departures on their own slow intervals.
 * @param {import("../model/world.js").World} world
 */
export function settleTurnover(world) {
  const tick = world.clock.tick;
  const cfg = world.config.turnover;
  const living = livingAgents(world);

  for (const agent of living) {
    if (agent.needs.connection < cfg.lonelyThreshold) {
      agent.adriftTicks = (agent.adriftTicks ?? 0) + 1;
    } else {
      agent.adriftTicks = 0;
    }
  }

  if (tick - (world.lastArrivalTick ?? -9999) >= cfg.arrivalIntervalTicks) {
    world.lastArrivalTick = tick;
    // A camp that cannot feed the minds it has does not gain another
    // mouth: in the base game, arrivals respect the stores. (Game mode
    // only; a dormant settlement changes nothing here, not even a draw.)
    const campFull = settlementActive(world) && foodDays(world) < 2.5;
    if (!campFull && living.length < cfg.maxCast && world.rng.chance(cfg.arrivalChance)) {
      arrive(world);
    }
  }

  if (tick - (world.lastDepartureTick ?? -9999) >= cfg.departureIntervalTicks) {
    world.lastDepartureTick = tick;
    if (living.length > cfg.minCast && world.rng.chance(cfg.departureChance)) {
      depart(world, livingAgents(world));
    }
  }
}

/**
 * A wanderer arrives: a complete stranger with a name, a past, and somewhere
 * they belong. They start knowing no one, which is exactly as it should be.
 * @param {import("../model/world.js").World} world
 * @returns {import("../model/agent.js").Agent|null}
 */
export function arrive(world) {
  const taken = new Set(world.agents.map(a => a.name));
  const candidates = WANDERERS.filter(w => !taken.has(w.name));
  if (!candidates.length) return null;
  const spec = world.rng.pick(candidates);
  const region = world.rng.pick(world.regions);
  const tick = world.clock.tick;

  const agent = createAgent(
    {
      id: world.nextId("m"),
      name: spec.name,
      epithet: spec.epithet,
      class: spec.class,
      archetype: spec.archetype,
      personality: spec.personality,
      backstory: world.rng.pick(BACKSTORIES),
      color: spec.color,
      icon: spec.icon,
      regionId: region.id,
      goalText: spec.goalText,
      goalKind: "uncover"
    },
    world.rng,
    tick,
    createMemory(),
    world.config.progression.levelDivisor
  );
  world.agents.push(agent);

  remember(agent.memory, {
    tick,
    kind: "observation",
    text: `I arrived at ${region.name} with nothing settled and everything ahead of me.`,
    subjectId: null,
    valence: 0.2,
    salience: 0.7
  }, world.nextId);

  logEvent(world, {
    kind: "arrival",
    agentId: agent.id,
    text: phrase(world, agent, "arrival", { region: region.name }),
    significance: 0.55,
    regionId: region.id
  });
  return agent;
}

/**
 * Someone leaves, or — rarely, and only when they are old — dies. Only minds
 * that have been adrift a long time are even candidates, and the protected
 * cast never is.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent[]} living
 * @returns {import("../model/agent.js").Agent|null}
 */
export function depart(world, living) {
  const cfg = world.config.turnover;
  const tick = world.clock.tick;
  const candidates = living.filter(
    a => !isProtected(a) && (a.adriftTicks ?? 0) >= cfg.lonelyTicks
  );
  if (!candidates.length) return null;
  const agent = world.rng.pick(candidates);

  const old = tick - agent.createdTick >= cfg.deathAgeTicks;
  const died = old && world.rng.chance(cfg.deathChance);
  agent.retired = true;
  agent.departureKind = died ? "died" : "left";

  logEvent(world, {
    kind: died ? "death" : "departure",
    agentId: agent.id,
    text: phrase(world, agent, died ? "death" : "departure", {
      region: regionName(world, agent.regionId)
    }),
    significance: died ? 0.85 : 0.6,
    regionId: agent.regionId
  });

  // Nobody despawns quietly. A death calls a gathering the world attends and
  // leaves a memorial behind; a departure is written down before the map
  // forgets the name.
  if (died) callFuneral(world, agent);
  else mournDeparture(world, agent);
  return agent;
}
