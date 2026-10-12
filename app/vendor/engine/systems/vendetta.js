/**
 * Vendettas: feuds that escalate through stages.
 *
 * Resentment between a pair is a number; a feud is a story. When the hotter
 * side of a pair crosses a threshold, the relationship changes kind — grudge
 * becomes rivalry, rivalry becomes vendetta — and the world is told. The
 * stages are sticky in memory even as the numbers cool: both minds remember
 * what the feud *was*, which is why old enemies stay careful around each
 * other long after the heat fades.
 *
 * Stage transitions are the only thing logged here. The teeth of each stage
 * live in intents (a vendetta wants settling; betrayal scores harder) and in
 * moments (a vendetta-stage confrontation gets its own option).
 */

import { livingAgents } from "../model/world.js";
import { feudStage, FEUD_STAGES, edgeToward } from "../model/relationships.js";
import { logEvent } from "../model/events.js";
import { remember } from "../model/memory.js";

/** @param {"grudge"|"rivalry"|"vendetta"|null} stage */
function rank(stage) {
  return stage ? FEUD_STAGES.indexOf(stage) + 1 : 0;
}

/**
 * @param {string} aName
 * @param {string} bName
 * @param {"rivalry"|"vendetta"} stage
 */
function escalationLine(aName, bName, stage) {
  if (stage === "vendetta") {
    return `${aName} and ${bName} are past quarrelling now. This is a vendetta, and the world knows it.`;
  }
  return `${aName} and ${bName} are no longer just at odds. This is a rivalry now.`;
}

/**
 * Run once per tick. Detects feud stage changes and writes them into the
 * world's history. Only escalations to rivalry and vendetta are announced —
 * grudges form quietly, the way they do.
 * @param {import("../model/world.js").World} world
 */
export function trackFeuds(world) {
  const living = livingAgents(world);
  world.flags = world.flags || {};
  /** @type {Record<string, string>} */
  const known = world.flags.feudStages || (world.flags.feudStages = {});
  // The highest stage ever announced for each pair. Resentment oscillates, so
  // without this a pair hovering on a threshold would be announced every time
  // it crosses back up.
  /** @type {Record<string, number>} */
  const announced = world.flags.feudAnnounced || (world.flags.feudAnnounced = {});

  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i];
      const b = living[j];
      const stage = feudStage(a.relations[b.id], b.relations[a.id], world.config);
      const key = [a.id, b.id].sort().join("|");
      const prev = known[key] || null;

      if (stage === prev) continue;
      if (stage) known[key] = stage;
      else delete known[key];

      // Announce only genuine first escalations into the named stages — never
      // twice for the same pair at the same height.
      const height = rank(/** @type {any} */ (stage));
      if ((stage === "rivalry" || stage === "vendetta") && height > (announced[key] ?? 0)) {
        announced[key] = height;
        const tick = world.clock.tick;
        logEvent(world, {
          kind: "feud",
          agentId: a.id,
          subjectId: b.id,
          text: escalationLine(a.name, b.name, stage),
          significance: stage === "vendetta" ? 0.8 : 0.65,
          regionId: a.regionId
        });
        for (const [self, other] of [[a, b], [b, a]]) {
          remember(self.memory, {
            tick,
            kind: "conflict",
            text: stage === "vendetta"
              ? `It is a vendetta now, between me and ${other.name}. There is no version of this that ends quietly.`
              : `${other.name} and I are rivals in earnest now. I will be watching.`,
            subjectId: other.id,
            valence: -0.6,
            salience: 0.85
          }, world.nextId);
        }
      }
    }
  }
}
