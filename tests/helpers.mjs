/**
 * Shared test scaffolding.
 *
 * The important helper here is `advanceWithModel`: it plays the part the server
 * plays in production, answering every moment that gets offered. Without it,
 * tests would only ever exercise the deterministic half of the simulation and
 * the entire moment-resolution path would go untested.
 */

import { createWorld } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { agentById } from "../engine/model/world.js";

/**
 * A stand-in for a language model: picks the option whose tone best matches the
 * mind's temperament, and supplies no prose so the engine's own narration is
 * exercised too.
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/world.js").Moment} moment
 */
export function stubbedAnswer(world, moment) {
  /** Which drive each tone answers to. */
  /** @type {Record<string, string>} */
  const TONE_DRIVE = {
    bold: "courage", ruthless: "courage", measured: "focus", calculated: "focus",
    guarded: "focus", warm: "social", open: "social", easy: "social", probing: "social",
    stoic: "focus", still: "focus", restrained: "focus", dark: "esteem",
    graceful: "meaning", restless: "creativity", steady: "focus"
  };
  const agent = agentById(world, moment.agentId);
  if (!agent) return {};
  if (moment.kind === "cognition") {
    return {
      plan: "I will pay attention to what the world needs next.",
      action: "observe",
      target: "NONE",
      priority: "Notice what is changing around me",
      summary: "I chose to look carefully before deciding what matters."
    };
  }
  if (moment.kind === "goal_approach") {
    // A proposal has no menu. The model names one of the approaches on offer and
    // writes it in the mind's own words; cycling keeps long runs from repeating.
    const offered = /** @type {any} */ (moment.context).availableMethods || ["focus"];
    const method = offered[agent.proposal.count % offered.length];
    return {
      method,
      approach: `Pushing at ${agent.goal.text.toLowerCase()} — ${method.replace(/_/g, " ")} while it still feels right.`
    };
  }
  let best = moment.options[0];
  let bestScore = -1;
  for (const option of moment.options) {
    const drive = TONE_DRIVE[option.tone] || "focus";
    const value =
      drive === "esteem" ? 100 - agent.needs.esteem
      : drive === "meaning" ? agent.needs.meaning
      : /** @type {Record<string, number>} */ (/** @type {unknown} */ (agent.drives))[drive] ?? 50;
    if (value > bestScore) {
      bestScore = value;
      best = option;
    }
  }
  return { optionId: best.id };
}

/**
 * Advance a world, answering its moments as a model would.
 * @param {import("../engine/model/world.js").World} world
 * @param {number} ticks
 */
export function advanceWithModel(world, ticks) {
  let answered = 0;
  for (let i = 0; i < ticks; i++) {
    step(world);
    for (const moment of [...world.pending]) {
      const result = resolveMoment(world, moment.id, stubbedAnswer(world, moment));
      if (result.ok) answered += 1;
    }
  }
  return { answered };
}

/**
 * A world advanced without any model at all — everything decided by the engine.
 * @param {object} [opts]
 * @param {number|string} [opts.seed]
 * @param {number} [opts.ticks]
 */
export function offlineWorld(opts = {}) {
  const world = createWorld({ seed: opts.seed ?? 4711 });
  const ticks = opts.ticks ?? 400;
  for (let i = 0; i < ticks; i++) {
    step(world);
    // Let expired moments resolve themselves, exactly as an absent model would.
    for (const moment of [...world.pending]) {
      resolveMoment(world, moment.id, {});
    }
  }
  return world;
}

/**
 * A stable fingerprint of everything that should be reproducible. Used to assert
 * that the same seed produces the same world and that snapshots resume exactly.
 * @param {import("../engine/model/world.js").World} world
 */
export function fingerprint(world) {
  const agents = world.agents
    .map(a =>
      [
        a.id,
        a.name,
        a.level,
        a.xp.toFixed(4),
        a.regionId,
        a.homeRegionId,
        Object.values(a.needs).map(n => n.toFixed(3)).join(","),
        a.memory.traces.length,
        a.memory.traces.map(t => t.id).join("+")
      ].join("|")
    )
    .join("\n");
  const secrets = world.secrets
    .map(s => `${s.id}:${Object.keys(s.holders).sort().join(",")}:${s.isPublic ? 1 : 0}`)
    .join("\n");
  return [
    `tick=${world.clock.tick}`,
    `seq=${world.seq}`,
    `events=${world.events.slice(0, 25).map(e => e.id + e.kind).join(",")}`,
    `tallies=${JSON.stringify(world.tallies)}`,
    agents,
    secrets
  ].join("\n");
}
