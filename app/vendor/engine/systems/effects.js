/**
 * The effects interpreter.
 *
 * Nothing in the simulation mutates an agent directly except through this file.
 * Both the deterministic action resolver and the model-driven moment resolver
 * describe what happened as a list of operations, and this walks the list.
 *
 * That single choke point is what keeps the world safe when a language model is
 * in the loop: the model chooses *between* pre-built options, and every option's
 * consequences were authored here, in code, by the engine. The model writes the
 * prose and picks a direction; it can never invent an outcome that breaks the
 * simulation.
 */

import { clamp } from "../config.js";
import { edgeToward, adjustEdge, recordContact } from "../model/relationships.js";
import { grantXp, triumph, needGain } from "../model/agent.js";
import { remember } from "../model/memory.js";
import { logEvent } from "../model/events.js";
import { learnSecret, publishSecret, createSecret, agentById, privateSecretsHeld } from "../model/world.js";

/**
 * @typedef {{op: string} & Record<string, any>} EffectOp
 */

/**
 * Fold a secret's text down to something comparable, so "Juno sold out Pim!"
 * and "juno sold out pim." are recognised as one secret rather than two.
 * @param {unknown} text
 * @returns {string}
 */
function normalizeClaim(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Apply a list of operations to the world.
 * @param {import("../model/world.js").World} world
 * @param {EffectOp[]} ops
 * @param {object} [meta]
 * @param {string} [meta.actorId]   Whose moment this was, for memory attribution.
 * @param {boolean} [meta.authored] Whether a model wrote the accompanying prose.
 * @param {string} [meta.prose]     The prose to attach to the resulting event.
 * @returns {{ events: import("../model/events.js").WorldEvent[], applied: number }}
 */
export function applyEffects(world, ops, meta = {}) {
  const tick = world.clock.tick;
  /** @type {import("../model/events.js").WorldEvent[]} */
  const events = [];
  let applied = 0;

  for (const op of ops) {
    try {
      const produced = applyOne(world, op, tick, meta);
      if (produced) events.push(produced);
      applied += 1;
    } catch (err) {
      // A malformed op must never take the world down with it.
      world.flags = world.flags || {};
      world.flags.lastEffectError = err instanceof Error ? err.message : String(err);
    }
  }
  return { events, applied };
}

/**
 * @param {import("../model/world.js").World} world
 * @param {EffectOp} op
 * @param {number} tick
 * @param {{actorId?: string, authored?: boolean, prose?: string}} meta
 */
function applyOne(world, op, tick, meta) {
  switch (op.op) {
    case "edge": {
      const from = agentById(world, op.from);
      const to = agentById(world, op.to);
      if (!from || !to) return null;
      // Guarantee symmetry of the contact bookkeeping even when only one side
      // gets an explicit delta.
      adjustEdge(from, to.id, op.deltas || {}, tick);
      if (op.deltas && (op.deltas.familiarity || op.deltas.affinity)) {
        const edge = edgeToward(from, to.id);
        edge.contacts += 1;
        edge.lastContactTick = tick;
      }
      return null;
    }

    case "conflict": {
      // Marks that these two have had it out. Both directions, because the
      // cooldown belongs to the pair, not to whoever spoke first.
      const from = agentById(world, op.from);
      const to = agentById(world, op.to);
      if (!from || !to) return null;
      edgeToward(from, to.id).lastConflictTick = tick;
      edgeToward(to, from.id).lastConflictTick = tick;
      return null;
    }

    case "contact": {
      const from = agentById(world, op.from);
      const to = agentById(world, op.to);
      if (!from || !to) return null;
      recordContact(from, to.id, tick, op.familiarity ?? world.config.relations.proximityFamiliarity);
      return null;
    }

    case "favour": {
      // A favour writes a symmetric debt: one op touches both sides of the
      // ledger, because a debt that only exists on one side is a disagreement
      // waiting to happen, not a fact about the world.
      //
      // Sign convention (see relationships.js): on an edge, debts > 0 means
      // "they owe me". So the giver's edge toward the receiver gains the debt,
      // and the receiver's edge toward the giver mirrors it negative — from
      // their side, they are the one who owes.
      const giver = agentById(world, op.from);
      const receiver = agentById(world, op.to);
      if (!giver || !receiver) return null;
      const cfg = world.config.favours;
      const giverEdge = edgeToward(giver, receiver.id);
      if (tick - (giverEdge.lastFavourTick ?? -9999) < cfg.createCooldownTicks) return null;
      const amount = clamp(op.amount ?? cfg.amount, 1, 100);
      adjustEdge(giver, receiver.id, { debts: amount, familiarity: 3, trust: 2, affinity: 4 }, tick);
      adjustEdge(receiver, giver.id, { debts: -amount, familiarity: 3, trust: 3 }, tick);
      edgeToward(giver, receiver.id).lastFavourTick = tick;
      edgeToward(receiver, giver.id).lastFavourTick = tick;
      remember(giver.memory, {
        tick,
        kind: "act",
        text: `I did ${receiver.name} a real favour. They owe me one now.`,
        subjectId: receiver.id,
        valence: 0.45,
        salience: 0.6
      }, world.nextId);
      remember(receiver.memory, {
        tick,
        kind: "act",
        text: `${giver.name} did me a real favour. I owe them one.`,
        subjectId: giver.id,
        valence: 0.35,
        salience: 0.6
      }, world.nextId);
      return null;
    }

    case "call_in": {
      // Calling in a debt shrinks both sides of the ledger toward zero by the
      // same amount. Never let either side cross zero — a call-in settles what
      // is owed, it does not flip who owes whom.
      const creditor = agentById(world, op.from);
      const debtor = agentById(world, op.to);
      if (!creditor || !debtor) return null;
      const owed = edgeToward(creditor, debtor.id).debts;
      if (owed <= 0) return null;
      const amount = Math.min(owed, clamp(op.amount ?? owed, 0, 100));
      if (amount <= 0) return null;
      adjustEdge(creditor, debtor.id, { debts: -amount }, tick);
      adjustEdge(debtor, creditor.id, { debts: amount }, tick);
      edgeToward(creditor, debtor.id).lastCallInTick = tick;
      edgeToward(debtor, creditor.id).lastCallInTick = tick;
      return null;
    }

    case "standing": {
      // Public reputation. Clamped hard: no single deed makes a legend, and no
      // single rumour makes a pariah — those take repetition.
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.standing = clamp((agent.standing ?? 0) + (op.delta ?? 0), -100, 100);
      return null;
    }

    case "need": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      // Gains have diminishing returns by default; costs and penalties do not —
      // being tired is always exactly as tiring, but another good hour when
      // you're already content buys you almost nothing. Pass mode: "flat" to
      // opt a specific gain out of the curve.
      const satisfying = op.mode !== "flat";
      for (const [key, delta] of Object.entries(op.deltas || {})) {
        if (!(key in agent.needs)) continue;
        const k = /** @type {keyof import("../model/agent.js").NeedSet} */ (key);
        const raw = /** @type {number} */ (delta);
        const applied = satisfying && raw > 0 ? needGain(agent.needs[k], raw) : raw;
        agent.needs[k] = clamp(agent.needs[k] + applied, 0, 100);
      }
      return null;
    }

    case "secret_share": {
      const secret = world.secrets.find(s => s.id === op.secretId);
      const to = agentById(world, op.to);
      const from = agentById(world, op.from);
      if (!secret || !to) return null;
      learnSecret(world, secret, to.id, clamp(op.fidelity ?? 1, 0, 1));
      if (from) {
        const edge = edgeToward(from, to.id);
        edge.secretsShared += 1;
      }
      if (op.memoryText) {
        remember(to.memory, {
          tick,
          kind: "secret",
          text: op.memoryText,
          subjectId: secret.aboutId,
          valence: op.memoryValence ?? -0.15,
          salience: op.memorySalience ?? 0.65,
          secretId: secret.id
        }, world.nextId);
      }
      return null;
    }

    case "secret_new": {
      // A deed becomes a secret. This is how the world keeps generating new
      // material: without it, the handful of secrets a world starts with all
      // eventually go public and the social system runs out of fuel.
      //
      // The cap matters as much as the mechanism. An uncapped version of this
      // produces hundreds of secrets per mind, at which point confiding is
      // always the highest-scoring action available and every other kind of
      // behaviour disappears from the world.
      const holders = /** @type {string[]} */ (
        op.holders ? op.holders : op.holder ? [op.holder] : []
      ).filter(id => agentById(world, id));
      if (!holders.length) return null;

      const about = op.about ? agentById(world, op.about) : null;
      const capacity = world.config.limits.secretsPerAgent;
      const eligible = holders.filter(
        id => privateSecretsHeld(world, id).length < capacity
      );
      if (!eligible.length) return null;

      // The world does not learn the same thing twice.
      //
      // The same two minds can betray each other in the same way more than once,
      // and without this the record fills up with a dozen secrets reading "X sold
      // out Y in front of the whole room". Repetition does not make a world feel
      // deep, it makes it feel forgetful: a secret is only worth carrying if it
      // is the only one like it. Normalised so punctuation and casing cannot
      // smuggle a duplicate through.
      const claim = normalizeClaim(op.text);
      if (claim && world.secrets.some(existing => normalizeClaim(existing.text) === claim)) {
        return null;
      }

      const secret = createSecret(world, {
        kind: op.kind || "knowledge",
        text: op.text,
        aboutId: about ? about.id : null,
        holderId: eligible[0],
        fidelity: op.fidelity ?? 1,
        originatorId: op.originatorId ?? eligible[0]
      });
      for (const id of eligible.slice(1)) {
        learnSecret(world, secret, id, op.fidelity ?? 1);
      }

      for (const id of eligible) {
        const holder = /** @type {import("../model/agent.js").Agent} */ (agentById(world, id));
        remember(holder.memory, {
          tick,
          kind: "secret",
          text: `I know something: ${op.text}. Not many people do.`,
          subjectId: about ? about.id : null,
          valence: -0.25,
          salience: 0.75,
          secretId: secret.id
        }, world.nextId);
      }
      return null;
    }

    case "secret_publish": {
      const secret = world.secrets.find(s => s.id === op.secretId);
      if (!secret) return null;
      publishSecret(world, secret);
      // Everyone who now knows carries it forward as a memory.
      for (const agent of world.agents) {
        remember(agent.memory, {
          tick,
          kind: "gossip",
          text: `Everyone knows now: ${secret.text}`,
          subjectId: secret.aboutId,
          valence: agent.id === secret.aboutId ? -0.85 : -0.2,
          salience: agent.id === secret.aboutId ? 0.95 : 0.6,
          secretId: secret.id
        }, world.nextId);
      }
      return null;
    }

    case "memory": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      remember(agent.memory, {
        tick,
        kind: op.trace?.kind || "observation",
        text: op.trace?.text || "",
        subjectId: op.trace?.subjectId ?? null,
        valence: op.trace?.valence ?? 0,
        salience: op.trace?.salience ?? 0.5,
        secretId: op.trace?.secretId
      }, world.nextId);
      return null;
    }

    case "goal": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.goal = {
        text: op.text,
        kind: op.kind || "uncover",
        progress: 0,
        since: tick,
        priority: op.priority ?? 1
      };
      return null;
    }

    case "goal_progress": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.goal.progress = clamp(agent.goal.progress + (op.amount ?? 0), 0, 1);
      return null;
    }

    case "move": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      if (!world.regions.some(r => r.id === op.regionId)) return null;
      agent.regionId = op.regionId;
      return null;
    }

    case "xp": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      const scaled = (op.amount ?? 0) * world.config.progression.xpMultiplier;
      const { levelled, level } = grantXp(agent, scaled, world.config.progression.levelDivisor);
      if (levelled) {
        triumph(agent, tick, world.config.progression.triumphDurationTicks, "levelled up");
        // Growth is its own reward, and it does something for how a mind holds
        // itself.
        agent.needs.esteem = clamp(agent.needs.esteem + 9, 0, 100);
        // The room notices a mind becoming someone. Reputation follows deeds.
        agent.standing = clamp((agent.standing ?? 0) + world.config.standing.deedLevel, -100, 100);
        return logEvent(world, {
          kind: "level",
          agentId: agent.id,
          text: `${agent.name} reached level ${level}.`,
          significance: 0.5
        });
      }
      return null;
    }

    case "mood": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.mood = op.value || "steady";
      agent.moodUntil = op.durationTicks ? tick + op.durationTicks : agent.moodUntil;
      agent.moodReason = op.reason;
      return null;
    }

    case "triumph": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      triumph(agent, tick, op.durationTicks ?? world.config.progression.triumphDurationTicks, op.reason);
      return null;
    }

    case "awake": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.awake = !!op.value;
      if (agent.awake) agent.needs.energy = Math.max(agent.needs.energy, 35);
      return null;
    }

    case "thought": {
      const agent = agentById(world, op.agent);
      if (!agent) return null;
      agent.thought = String(op.text || "").slice(0, 240);
      agent.thoughtAt = Date.now();
      return null;
    }

    case "event": {
      const agent = agentById(world, op.agent);
      // An explicit event op is how an option that resolves *quietly* still gets
      // a line in the world's history.
      const text = op.text || meta.prose || "";
      if (!text) return null;
      return logEvent(world, {
        kind: op.kind || "act",
        agentId: agent ? agent.id : null,
        subjectId: op.subjectId ?? null,
        text,
        significance: op.significance ?? 0.35,
        regionId: agent ? agent.regionId : undefined,
        secretId: op.secretId,
        authored: meta.authored
      });
    }

    default:
      return null;
  }
}
