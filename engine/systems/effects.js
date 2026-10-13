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
import { ruleStrength } from "../model/charter.js";
import { liveBlessingForAgent, liveBlessingForWork } from "../model/divine.js";
import { recordWallRaised } from "./charter.js";
import { applySettlementWork } from "./settlement.js";

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
 * Write a compact, directed account of a material relationship change. This is
 * opt-in per effect: routine passive drift does not flood the public timeline.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} from
 * @param {import("../model/agent.js").Agent} to
 * @param {Record<string, number>} before
 * @param {Record<string, number>} deltas
 * @param {string} reason
 * @param {number} tick
 * @param {string} [secretId]
 */
function logRelationshipChange(world, from, to, before, deltas, reason, tick, secretId) {
  const edge = edgeToward(from, to.id);
  const labels = {
    affinity: "affection", trust: "trust", fear: "fear", resentment: "resentment",
    familiarity: "familiarity", debts: "debt"
  };
  const changes = Object.entries(labels).flatMap(([axis, label]) => {
    const delta = deltas[axis] || 0;
    const oldValue = before[axis] ?? 0;
    const newValue = edge[/** @type {keyof typeof edge} */ (axis)];
    return Math.abs(delta) >= 0.5 && typeof newValue === "number" && oldValue !== newValue
      ? [{ axis: label, before: oldValue, after: newValue }]
      : [];
  });
  if (!changes.some(change => Math.abs(change.after - change.before) >= 3)) return null;
  const detail = changes.map(change => `${change.axis} ${Math.round(change.before)} → ${Math.round(change.after)}`).join(", ");
  return logEvent(world, {
    kind: "relationship",
    agentId: from.id,
    subjectId: to.id,
    tick,
    text: `${from.name}'s view of ${to.name} changed: ${detail}, after ${reason}.`,
    significance: 0.46,
    regionId: from.regionId,
    secretId,
    relationship: { reason, changes }
  });
}

/**
 * Complete the North Wall project. Construction becomes a permanent world
 * state, while contributors take a shared reputation and relationship reward.
 * @param {import("../model/world.js").World} world
 * @param {number} tick
 */
function completeNorthWall(world, tick) {
  const project = world.project;
  if (!project || project.status === "complete") return;
  project.status = "complete";
  project.completedTick = tick;
  const ids = Object.entries(project.contributors)
    .filter(([, record]) => record.work > 0 || record.help > 0)
    .map(([id]) => id)
    .sort();
  project.completionContributors = ids;

  for (const id of ids) {
    const agent = agentById(world, id);
    if (!agent) continue;
    const record = project.contributors[id];
    agent.standing = clamp((agent.standing ?? 0) + (record.work > 0 ? 9 : 6), -100, 100);
    triumph(agent, tick, world.config.progression.triumphDurationTicks, "helped raise the North Wall");
    remember(agent.memory, {
      tick,
      kind: "goal",
      text: "I helped raise the North Wall. The place is safer because we did the work together.",
      subjectId: null,
      valence: 0.85,
      salience: 0.95
    }, world.nextId);
  }

  // The wall is the world's shared win condition, so it is recorded where the
  // world keeps what it decided together — and it becomes the precedent every
  // later petition is measured against.
  recordWallRaised(world, ids);

  // Work done side by side leaves a durable mark on how the builders regard
  // one another; the project is not just a progress bar with a completion text.
  for (let i = 0; i < ids.length; i++) {
    const a = agentById(world, ids[i]);
    if (!a) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const b = agentById(world, ids[j]);
      if (!b) continue;
      const aBefore = { ...edgeToward(a, b.id) };
      const bBefore = { ...edgeToward(b, a.id) };
      const aDeltas = { affinity: 8, trust: 10, familiarity: 8 };
      const bDeltas = { affinity: 6, trust: 8, familiarity: 8 };
      adjustEdge(a, b.id, aDeltas, tick);
      adjustEdge(b, a.id, bDeltas, tick);
      logRelationshipChange(world, a, b, aBefore, aDeltas, "they raised the North Wall together", tick);
      logRelationshipChange(world, b, a, bBefore, bDeltas, "they raised the North Wall together", tick);
      remember(a.memory, {
        tick,
        kind: "goal",
        text: `We raised the North Wall together. ${b.name} was there when the stones went in.`,
        subjectId: b.id,
        valence: 0.75,
        salience: 0.85
      }, world.nextId);
      remember(b.memory, {
        tick,
        kind: "goal",
        text: `We raised the North Wall together. ${a.name} was there when the stones went in.`,
        subjectId: a.id,
        valence: 0.7,
        salience: 0.8
      }, world.nextId);
    }
  }
}

/** @param {import("../model/world.js").World} world @param {any} op @param {number} tick */
function applyProjectWork(world, op, tick) {
  const project = world.project;
  const actor = agentById(world, op.agent);
  if (!project || project.status !== "active" || !actor || actor.retired) return null;
  // An enacted "the wall comes first" makes the same effort go further, and so
  // does a blessing the keeper set on the work — or on this mind's own hands.
  // Both bonuses are the engine's, from state it already keeps, never the
  // model's.
  const blessed = Boolean(
    liveBlessingForWork(world.divine, tick) || liveBlessingForAgent(world.divine, tick, actor.id)
  );
  const bonus =
    (1 + ruleStrength(world.charter, "wall_first") * 0.15) *
    (blessed ? 1 + world.config.divine.blessingWorkBonus : 1);
  const amount = clamp(Math.round((Number(op.amount) || 0) * bonus), 1, 24);
  const record = project.contributors[actor.id] || (project.contributors[actor.id] = {
    work: 0, help: 0, interference: 0, lastTick: tick
  });
  if (op.kind === "help") record.help += amount;
  else record.work += amount;
  record.lastTick = tick;
  project.lastWorkTick = tick;
  project.progress = clamp(project.progress + amount, 0, 100);

  for (const milestone of project.milestones) {
    if (milestone.reached || project.progress < milestone.threshold) continue;
    milestone.reached = true;
    milestone.tick = tick;
    const helpers = Object.keys(project.contributors)
      .map(id => agentById(world, id))
      .filter((a) => a !== null);
    const named = helpers.length > 1
      ? ` ${helpers.map(a => a.name).slice(0, 4).join(", ")} have worked on it.`
      : "";
    logEvent(world, {
      kind: "project",
      agentId: actor.id,
      subjectId: op.targetId || null,
      text: `${milestone.title}.${named}`,
      significance: milestone.threshold === 100 ? 0.9 : 0.66,
      regionId: project.regionId,
      projectId: project.id
    });
    if (milestone.threshold === 100) completeNorthWall(world, tick);
  }
  return null;
}

/** @param {import("../model/world.js").World} world @param {any} op @param {number} tick */
function applyProjectInterference(world, op, tick) {
  const project = world.project;
  const actor = agentById(world, op.agent);
  if (!project || project.status !== "active" || !actor || actor.retired || project.progress <= 0) return null;
  const target = agentById(world, op.targetId) || Object.entries(project.contributors)
    .sort((a, b) => (b[1].work + b[1].help) - (a[1].work + a[1].help))
    .map(([id]) => agentById(world, id)).find(a => a && a.id !== actor.id);
  // A world that has legislated against undermining takes less damage from it:
  // people are watching for it now.
  const deterrence = 1 / (1 + ruleStrength(world.charter, "no_undermining") * 0.3);
  const loss = clamp(Math.round((Number(op.amount) || 8) * deterrence), 1, 12);
  project.progress = Math.max(0, project.progress - loss);
  project.interferenceCount += 1;
  const record = project.contributors[actor.id] || (project.contributors[actor.id] = {
    work: 0, help: 0, interference: 0, lastTick: tick
  });
  record.interference += 1;
  record.lastTick = tick;
  record.lastInterferenceTick = tick;

  if (target) {
    const actorBefore = { ...edgeToward(actor, target.id) };
    const targetBefore = { ...edgeToward(target, actor.id) };
    const actorDeltas = { resentment: 10, trust: -7 };
    const targetDeltas = { resentment: 6, trust: -5 };
    adjustEdge(actor, target.id, actorDeltas, tick);
    adjustEdge(target, actor.id, targetDeltas, tick);
    logRelationshipChange(world, actor, target, actorBefore, actorDeltas, "the North Wall interference", tick);
    logRelationshipChange(world, target, actor, targetBefore, targetDeltas, "the North Wall interference", tick);
    remember(target.memory, {
      tick,
      kind: "conflict",
      text: `${actor.name} damaged the North Wall work I had helped with. I know who set us back.`,
      subjectId: actor.id,
      valence: -0.8,
      salience: 0.9
    }, world.nextId);
  }
  actor.standing = clamp((actor.standing ?? 0) - 3, -100, 100);
  remember(actor.memory, {
    tick,
    kind: "conflict",
    text: "I set the North Wall work back. The choice may cost me more than it buys.",
    subjectId: target?.id ?? null,
    valence: -0.35,
    salience: 0.7
  }, world.nextId);
  return logEvent(world, {
    kind: "project",
    agentId: actor.id,
    subjectId: target?.id ?? null,
    text: `${actor.name} interfered with the North Wall work, undoing ${loss} points of progress${target ? ` and drawing ${target.name}'s anger` : ""}.`,
    significance: 0.62,
    regionId: project.regionId,
    projectId: project.id
  });
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
      // gets an explicit delta. Material changes can also be followed in a pair
      // thread; the caller supplies a cause so routine churn stays out of history.
      const before = { ...edgeToward(from, to.id) };
      adjustEdge(from, to.id, op.deltas || {}, tick);
      if (op.reason) logRelationshipChange(world, from, to, before, op.deltas || {}, op.reason, tick, op.secretId);
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
      const giverBefore = { ...giverEdge };
      const receiverBefore = { ...edgeToward(receiver, giver.id) };
      const giverDeltas = { debts: amount, familiarity: 3, trust: 2, affinity: 4 };
      const receiverDeltas = { debts: -amount, familiarity: 3, trust: 3 };
      adjustEdge(giver, receiver.id, giverDeltas, tick);
      adjustEdge(receiver, giver.id, receiverDeltas, tick);
      logRelationshipChange(world, giver, receiver, giverBefore, giverDeltas, "the favour", tick);
      logRelationshipChange(world, receiver, giver, receiverBefore, receiverDeltas, "the favour", tick);
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
      const creditorEdge = edgeToward(creditor, debtor.id);
      const owed = creditorEdge.debts;
      if (owed <= 0) return null;
      const amount = Math.min(owed, clamp(op.amount ?? owed, 0, 100));
      if (amount <= 0) return null;
      const creditorBefore = { ...creditorEdge };
      const debtorBefore = { ...edgeToward(debtor, creditor.id) };
      const creditorDeltas = { debts: -amount };
      const debtorDeltas = { debts: amount };
      adjustEdge(creditor, debtor.id, creditorDeltas, tick);
      adjustEdge(debtor, creditor.id, debtorDeltas, tick);
      logRelationshipChange(world, creditor, debtor, creditorBefore, creditorDeltas, "the debt being called in", tick);
      logRelationshipChange(world, debtor, creditor, debtorBefore, debtorDeltas, "the debt being called in", tick);
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
      const alreadyHeld = secret.holders[to.id] !== undefined;
      learnSecret(world, secret, to.id, clamp(op.fidelity ?? 1, 0, 1));
      const newlyLearned = !alreadyHeld && secret.holders[to.id] !== undefined;
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
      return newlyLearned ? logEvent(world, {
        kind: "secret",
        agentId: from ? from.id : null,
        subjectId: to.id,
        text: `${from ? from.name : "Someone"} trusted ${to.name} with a secret.`,
        significance: 0.38,
        regionId: from ? from.regionId : to.regionId,
        secretId: secret.id
      }) : null;
    }

    case "secret_new": {
      // The effect interpreter is the shared creation path for hatching,
      // betrayal and model moments. Check the hard cap here on every op; a
      // batch may contain several creations and each sees the prior one.
      if (world.secrets.length >= world.config.limits.secretsInWorld) return null;

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
      if (!secret) return null;
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
      const originator = agentById(world, op.originatorId) || agentById(world, eligible[0]);
      return logEvent(world, {
        kind: "secret",
        agentId: originator ? originator.id : null,
        subjectId: about ? about.id : null,
        text: `A new ${secret.kind} secret began circulating among ${eligible.map(id => agentById(world, id)?.name).filter(Boolean).join(", ")}.`,
        significance: 0.34,
        regionId: originator ? originator.regionId : undefined,
        secretId: secret.id
      });
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
      const publisher = agentById(world, op.by);
      return logEvent(world, {
        kind: "secret",
        agentId: publisher ? publisher.id : null,
        subjectId: secret.aboutId,
        text: `${publisher ? publisher.name + " made it public" : "It became public"}: ${secret.text}`,
        significance: 0.78,
        regionId: publisher ? publisher.regionId : undefined,
        secretId: secret.id
      });
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

    case "project_work":
      return applyProjectWork(world, op, tick);

    case "project_interfere":
      return applyProjectInterference(world, op, tick);

    case "settlement_work":
      return applySettlementWork(world, { agent: op.agent, buildingId: op.buildingId, mode: "work", amount: op.amount });

    case "settlement_build":
      return applySettlementWork(world, { agent: op.agent, buildingId: op.buildingId, mode: "build", amount: op.amount });

    case "settlement_repair":
      return applySettlementWork(world, { agent: op.agent, buildingId: op.buildingId, mode: "repair", amount: op.amount });

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
