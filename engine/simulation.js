/**
 * The simulation loop.
 *
 * One call to `step` advances the whole world by one tick. The ordering matters
 * and is deliberate:
 *
 *   1. Passive drift first — needs erode, feelings cool, memories fade. Minds
 *      decide based on the world as it now is, not as it was last tick.
 *   2. Collapse checks — a mind that has run out of energy drops out of the world
 *      before it can act.
 *   3. Decisions — every awake mind scores its options and picks.
 *   4. Model moments — the most significant beats are withheld and offered to the
 *      language model, subject to the tick's budget.
 *   5. Everything else resolves deterministically, immediately, with no I/O.
 *
 * The loop never touches the network, never reads a clock, and never awaits
 * anything. That is what makes it replayable, testable, and portable between the
 * server and the phone.
 */

import { advance, describeClock } from "./clock.js";
import { generateIntents } from "./decision/intents.js";
import { buildMoment, isMomentWorthy } from "./decision/moments.js";
import { resolveIntent, chooseDefaultOption } from "./systems/act.js";
import { buildGoalApproachMoment, proposalEligible, resolveApproach, validateApproach } from "./decision/proposals.js";
import { buildPetitionMoment, buildWhisperMoment, petitionEligible, whisperEligible, validatePetition, openDilemma } from "./decision/petitions.js";
import { settleCharter, recordPetition, describeRule } from "./systems/charter.js";
import { applyEffects } from "./systems/effects.js";
import { settleNeeds, checkCollapse } from "./systems/needs.js";
import { settleRelations, settleProximity, hatchSecrets } from "./systems/social.js";
import { settleTurnover } from "./systems/turnover.js";
import { settleMourning } from "./systems/mourning.js";
import { settleDivine } from "./systems/divine.js";
import { settleRituals } from "./systems/rituals.js";
import { trackFeuds } from "./systems/vendetta.js";
import { settleMemory } from "./systems/memory.js";
import { settleChat } from "./systems/chat-influence.js";
import { settleWant, noteAsk } from "./systems/want.js";
import { logEvent } from "./model/events.js";
import { phrase, momentLine } from "./decision/prose.js";
import { agentById, livingAgents, regionName } from "./model/world.js";
import { recall } from "./model/memory.js";
import { describeRelation } from "./model/relationships.js";
import { standingWord, stateLine } from "./model/agent.js";

/**
 * @typedef {import("./model/world.js").World} World
 * @typedef {import("./model/agent.js").Agent} Agent
 * @typedef {import("./decision/intents.js").Intent} Intent
 * @typedef {import("./model/world.js").Moment} Moment
 * @typedef {import("./model/events.js").WorldEvent} WorldEvent
 * @typedef {import("./model/charter.js").Petition} Petition
 */

/**
 * @typedef {object} StepReport
 * @property {number} tick
 * @property {WorldEvent[]} events       Events produced this tick.
 * @property {Moment[]} moments          Moments offered to the model.
 * @property {number} momentsDeferred    Moments the budget could not afford.
 * @property {string[]} collapsed        Names of minds that fell asleep.
 */

/**
 * Advance the world by exactly one tick.
 * @param {World} world
 * @returns {StepReport}
 */
export function step(world) {
  const cfg = world.config;
  advance(world.clock, cfg.clock.minutesPerTick);
  const tick = world.clock.tick;

  const seqMark = world.seq;

  const living = livingAgents(world);

  /* ---- 1. Passive drift ---- */
  for (const agent of living) {
    const wasAsleep = !agent.awake;
    settleNeeds(world, agent);
    if (wasAsleep && agent.awake) {
      logEvent(world, {
        kind: "world",
        agentId: agent.id,
        text: `${agent.name} woke on their own after getting enough rest.`,
        significance: 0.42,
        regionId: agent.regionId
      });
    }
    settleRelations(world, agent);
    settleMemory(world, agent);
    settleChat(world, agent);
  }

  /* ---- 2. Collapse ---- */
  /** @type {string[]} */
  const collapsed = [];
  for (const agent of living) {
    const { collapsed: didCollapse } = checkCollapse(world, agent);
    if (didCollapse) {
      collapsed.push(agent.name);
      logEvent(world, {
        kind: "act",
        agentId: agent.id,
        text: phrase(world, agent, "collapse", { region: "" }),
        significance: 0.55,
        regionId: agent.regionId
      });
    }
  }

  /* ---- 3. Decisions ---- */
  /** @type {{ agent: Agent, intent: Intent, ranked: Intent[] }[]} */
  const decisions = [];
  /** @type {{ agent: Agent, moment: Moment }[]} */
  const planCandidates = [];
  for (const agent of world.rng.shuffle(living)) {
    if (!agent.awake) continue;
    const cognitionPending = world.pending.some(m => m.kind === "cognition" && m.agentId === agent.id);
    if (cognitionPending) continue; // no engine-selected intent while their own plan is outstanding
    if (agent.cognition?.enabled && tick >= agent.cognition.nextPlanTick) {
      planCandidates.push({ agent, moment: buildCognitionMoment(world, agent) });
      continue;
    }
    const ranked = generateIntents(world, agent);
    const intent = ranked[0];
    if (!intent) continue;
    // When a mind is working toward its own goal, the model gets to propose how
    // it goes about it — subject to the same budget as every other moment.
    if (intent.kind === "pursue_goal" && proposalEligible(world, agent, tick)) {
      planCandidates.push({ agent, moment: buildGoalApproachMoment(world, agent) });
      continue;
    }
    // A mind that has something in the world to point at may ask the keeper to
    // change how the world runs — or tell the keeper something privately.
    if (petitionEligible(world, agent, tick)) {
      planCandidates.push({ agent, moment: buildPetitionMoment(world, agent) });
      continue;
    }
    if (whisperEligible(world, agent, tick)) {
      planCandidates.push({ agent, moment: buildWhisperMoment(world, agent) });
      continue;
    }
    decisions.push({ agent, intent, ranked });
  }

  /* ---- 4. Moment admission ---- */
  /** @type {{ agent: Agent, intent: Intent|null, ranked: Intent[], moment: Moment }[]} */
  const candidates = [];
  for (const decision of decisions) {
    if (!isMomentWorthy(world, decision.agent, decision.intent, decision.ranked)) continue;
    const moment = buildMoment(world, decision.agent, decision.intent, decision.ranked);
    if (moment) candidates.push({ agent: decision.agent, intent: decision.intent, ranked: decision.ranked, moment });
  }
  for (const candidate of planCandidates) {
    candidates.push({ agent: candidate.agent, intent: null, ranked: [], moment: candidate.moment });
  }

  // The best beats get the model, not the first ones to arrive.
  candidates.sort((a, b) => b.moment.significance - a.moment.significance);
  const chosen = candidates.slice(0, cfg.moments.maxPerTick);
  const deferred = candidates.slice(cfg.moments.maxPerTick);
  const deferredIds = new Set(chosen.map(c => c.agent.id));
  const deferredAgents = new Set(deferred.map(c => c.agent.id));

  for (const { agent, moment } of chosen) {
    world.pending.push(moment);
    if (moment.kind === "reflection") agent.lastReflectionTick = tick;
    if (moment.kind === "cognition") {
      agent.cognition.lastPlanTick = tick;
      agent.cognition.nextPlanTick = tick + cfg.cognition.planIntervalTicks;
    }
    if (moment.kind === "goal_approach") {
      agent.proposal.nextTick = tick + cfg.proposals.intervalTicks;
    }
    if (moment.kind === "petition") {
      agent.petition.nextTick = tick + cfg.charter.petitionIntervalTicks;
    }
    if (moment.kind === "whisper") {
      agent.whisper.nextTick = tick + cfg.charter.whisperIntervalTicks;
    }
  }

  /* ---- 5. Everything else resolves now ---- */
  for (const { agent, intent, ranked } of decisions) {
    if (deferredIds.has(agent.id)) continue;
    if (deferredAgents.has(agent.id)) continue; // its moment lost the budget and will default shortly
    resolveAndApply(world, agent, intent, ranked);
  }

  /* ---- 6. Proximity, deeds, expiry ---- */
  settleProximity(world);
  hatchSecrets(world);
  settleTurnover(world);
  // A death this tick is buried a little later, and a gathering that has been
  // called is held here — before the feuds are tracked, so a quarrel that has
  // just changed hands is part of this tick's world.
  settleMourning(world);
  settleRituals(world);
  trackFeuds(world);
  settleCharter(world);
  // Signs the keeper has already set take their bite here, after every system
  // that could have produced a fresh quarrel this tick.
  settleDivine(world);
  maybeRaiseDilemma(world);
  // Systems queue ops rather than applying them mid-pass, so that nothing here
  // can mutate an agent halfway through another system's read of it.
  if (world.pendingOps && world.pendingOps.length) {
    applyEffects(world, /** @type {import("./systems/effects.js").EffectOp[]} */ (world.pendingOps), {});
    world.pendingOps = [];
  }
  expireMoments(world);

  /* ---- 7. The keeper's reading, then the day boundary ---- */
  // The meters are read last, after every system has had its say, so the
  // keeper's score for this tick is a fact about the world as it now stands
  // rather than about the world as it stood when the tick began.
  settleWant(world);
  maybeChronicle(world, tick);

  // Everything logged this tick, oldest first, so a reader sees the tick unfold.
  const produced = world.events.filter(e => e.seq > seqMark).reverse();

  return {
    tick,
    events: produced,
    moments: chosen.map(c => c.moment),
    momentsDeferred: deferred.length,
    collapsed
  };
}

/**
 * Build an open-ended, private cognition request for a pilot mind. No intent has
 * been selected yet: the model proposes a priority, a plan and an action from a
 * small validated action grammar. All state-changing consequences remain in the
 * engine.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Moment}
 */
export function buildCognitionMoment(world, agent) {
  const tick = world.clock.tick;
  const region = world.regions.find(r => r.id === agent.regionId);
  const memories = recall(agent.memory, {
    tick,
    limit: 6,
    config: world.config
  });
  const knownMinds = livingAgents(world)
    .filter(other => other.id !== agent.id)
    .map(other => ({
      id: other.id,
      name: other.name,
      region: regionName(world, other.regionId),
      relation: agent.relations[other.id] ? describeRelation(agent.relations[other.id]) : "a stranger"
    }));
  const nextMilestone = world.project?.milestones.find(m => !m.reached);
  const cognition = agent.cognition;
  const context = {
    agentName: agent.name + (agent.epithet ? " " + agent.epithet : ""),
    stateLine: stateLine(agent, tick),
    mood: agent.mood,
    region: region ? region.name : "an unknown place",
    regionBlurb: region ? region.blurb : "",
    phase: world.clock.phase,
    night: world.clock.phase === "night" || world.clock.phase === "deep night",
    goal: agent.goal.text,
    goalProgress: agent.goal.progress,
    standingWord: standingWord(agent.standing ?? 0),
    memories: memories.map(memory => memory.text),
    memorySummary: cognition.memorySummary,
    privateBeliefs: cognition.beliefs.slice(0, world.config.cognition.maxBeliefs).map(belief =>
      `${belief.text} (${Math.round(belief.confidence * 100)}% confidence)`
    ),
    privatePriorities: cognition.priorities.slice(0, world.config.cognition.maxPriorities).map(priority => priority.text),
    knownMinds,
    project: world.project ? {
      title: world.project.title,
      status: world.project.status,
      progress: world.project.progress,
      nextMilestone: nextMilestone ? nextMilestone.title : "complete"
    } : undefined
  };
  return {
    id: world.nextId("mo"),
    tick,
    kind: "cognition",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.98,
    question: "Choose your own next move. Your priority and action have not been selected for you. Propose a brief plan and one action; the world will validate it.",
    context,
    options: [],
    resolved: false,
    source: "persistent-cognition"
  };
}

/**
 * Resolve one intent deterministically and write it into the world.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} ranked
 * @returns {WorldEvent[]} Events generated while resolving this action.
 */
function resolveAndApply(world, agent, intent, ranked) {
  const seqMark = world.seq;
  const resolution = resolveIntent(world, agent, intent, ranked);
  agent.lastActedTick = world.clock.tick;
  applyEffects(world, resolution.ops, { actorId: agent.id });

  // Texture stays out of the world's history. Nine minds taking a tick each
  // produces thousands of small acts a day, and a feed that shows all of them
  // shows nothing. Quiet actions still happen and are still remembered — they
  // just don't get a line in the record unless they earn one.
  if (resolution.quiet && !shouldSurface(world, agent, intent)) {
    return world.events.filter(event => event.seq > seqMark).reverse();
  }

  logEvent(world, {
    kind: resolution.eventKind,
    agentId: agent.id,
    text: resolution.text,
    significance: resolution.significance,
    regionId: agent.regionId,
    subjectId: resolution.subjectId ?? intent.targetId ?? null,
    secretId: resolution.secretId,
    projectId: resolution.projectId || (intent.kind.startsWith("project_") ? world.project?.id : undefined),
    scene: resolution.scene
  });
  return world.events.filter(event => event.seq > seqMark).reverse();
}

/**
 * Long-running work should be visible occasionally rather than never — a mind
 * grinding at a goal for a week with no trace in the feed reads as idle.
 * @param {import("./model/world.js").World} world
 * @param {import("./model/agent.js").Agent} agent
 * @param {import("./decision/intents.js").Intent} intent
 */
function shouldSurface(world, agent, intent) {
  if (intent.kind !== "pursue_goal") return false;
  const interval = world.config.limits.goalLogInterval;
  const last = agent.lastGoalLoggedTick ?? -9999;
  if (world.clock.tick - last < interval) return false;
  agent.lastGoalLoggedTick = world.clock.tick;
  return true;
}

/* ------------------------------------------------------------------ *
 * Moments: expiry and resolution
 * ------------------------------------------------------------------ */

/**
 * Answer any moment that has waited too long. A mind cannot stand frozen while
 * the world waits for a language model, so the engine makes the call itself
 * using the same policy that resolves everything else.
 * @param {World} world
 * @returns {Moment[]} Moments the engine answered.
 */
export function expireMoments(world) {
  const limit = world.config.moments.maxPendingTicks;
  const tick = world.clock.tick;
  /** @type {Moment[]} */
  const expired = [];

  world.pending = world.pending.filter(moment => {
    if (tick - moment.tick < limit) return true;
    const agent = agentById(world, moment.agentId);
    if (agent) {
      if (moment.kind === "cognition") {
        resolveCognitionMoment(world, moment, agent, {}, true);
      } else if (moment.kind === "goal_approach") {
        resolveGoalApproachMoment(world, moment, agent, {}, true);
      } else if (moment.kind === "petition") {
        resolvePetitionMoment(world, moment, agent, {}, true);
      } else if (moment.kind === "whisper") {
        resolveWhisperMoment(world, moment, agent, {}, true);
      } else {
        const option = chooseDefaultOption(world, agent, moment);
        applyMomentOption(world, moment, agent, option, null);
        moment.resolved = true;
        moment.optionId = option.id;
        moment.resolution = option.id;
        moment.engineResolved = true;
        rememberResolved(world, moment);
      }
    }
    expired.push(moment);
    return false;
  });

  return expired;
}

/**
 * Keep a short history of answered moments. A mind that was never asked still
 * made a choice, and the record of what the engine decided on its behalf is
 * what makes a silent world reviewable after the fact.
 * @param {World} world
 * @param {Moment} moment
 */
function rememberResolved(world, moment) {
  world.resolved.push(moment);
  if (world.resolved.length > 200) world.resolved.shift();
}

/**
 * Apply a model's answer to a moment.
 *
 * The model supplies an option id, prose, and optionally a private thought. It
 * does not supply consequences — those belong to the option, which the engine
 * authored. If the option id is unrecognised, the engine falls back to its own
 * choice rather than dropping the beat.
 *
 * @param {World} world
 * @param {string} momentId
 * @param {{
 *   optionId?: string, prose?: string, thought?: string, goal?: string, goalKind?: string,
 *   action?: string, target?: string, about?: string, plan?: string, priority?: string,
 *   belief?: string, beliefConfidence?: number, beliefAbout?: string, summary?: string,
 *   approach?: string, method?: string, ruleKind?: string, petition?: string, whisper?: string
 * }} answer
 * @returns {{ ok: boolean, reason?: string, events: WorldEvent[], optionId?: string }}
 */
export function resolveMoment(world, momentId, answer) {
  const index = world.pending.findIndex(m => m.id === momentId);
  if (index === -1) return { ok: false, reason: "unknown-or-already-resolved", events: [] };

  const moment = world.pending[index];
  const agent = agentById(world, moment.agentId);
  if (!agent) {
    world.pending.splice(index, 1);
    return { ok: false, reason: "agent-gone", events: [] };
  }

  if (moment.kind === "cognition") {
    const result = resolveCognitionMoment(world, moment, agent, answer, false);
    world.pending.splice(index, 1);
    return result;
  }

  if (moment.kind === "goal_approach") {
    const result = resolveGoalApproachMoment(world, moment, agent, answer, false);
    world.pending.splice(index, 1);
    return result;
  }

  if (moment.kind === "petition") {
    const result = resolvePetitionMoment(world, moment, agent, answer, false);
    world.pending.splice(index, 1);
    return result;
  }

  if (moment.kind === "whisper") {
    const result = resolveWhisperMoment(world, moment, agent, answer, false);
    world.pending.splice(index, 1);
    return result;
  }

  const option =
    moment.options.find(o => o.id === answer.optionId) || chooseDefaultOption(world, agent, moment);

  const prose = sanitize(answer.prose);
  const { events } = applyMomentOption(world, moment, agent, option, prose);

  if (answer.thought) {
    agent.thought = sanitize(answer.thought).slice(0, 240);
    agent.thoughtAt = Date.now();
  }
  if (answer.goal && answer.goal.trim() && !prose) {
    // A goal only lands when the model also wrote the beat it belongs to.
    applyEffects(world, [{ op: "goal", agent: agent.id, text: answer.goal.trim().slice(0, 120), kind: answer.goalKind || "uncover" }]);
  }
  if (moment.kind === "reflection") agent.lastReflectionTick = world.clock.tick;

  moment.resolved = true;
  moment.resolution = option.id;
  moment.optionId = option.id;
  rememberResolved(world, moment);
  world.pending.splice(index, 1);

  return { ok: true, events, optionId: option.id };
}

const COGNITION_ACTIONS = new Set([
  "rest", "observe", "explore", "pursue_goal", "withdraw", "seek_company",
  "forge_bond", "grant_favour", "gossip", "project_contribute", "project_help", "project_interfere"
]);
const COGNITION_TARGET_ACTIONS = new Set([
  "seek_company", "forge_bond", "grant_favour", "gossip", "project_help", "project_interfere"
]);

/** @param {unknown} value @param {number} max */
function privateText(value, max) {
  const text = sanitize(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return /^none$/i.test(text) ? "" : text.slice(0, max);
}

/** @param {unknown} value */
function cognitionNone(value) {
  const text = String(value == null ? "" : value).trim();
  return !text || /^(?:none|no one|n\/a|null)$/i.test(text);
}

/** @param {World} world @param {unknown} value */
function findCognitionAgent(world, value) {
  if (cognitionNone(value)) return null;
  const needle = String(value).trim();
  const byId = agentById(world, needle);
  if (byId && !byId.retired) return byId;
  return livingAgents(world).find(agent => agent.name.toLowerCase() === needle.toLowerCase()) || null;
}

/**
 * Validate an open-ended proposal against a small action grammar. The model
 * never provides effect ops, numeric deltas or arbitrary targets for secrets.
 * @param {World} world
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @returns {{ok: boolean, reason: string, intent: Intent|null}}
 */
function validateCognitionProposal(world, agent, answer) {
  const action = String(answer.action || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!COGNITION_ACTIONS.has(action)) {
    return { ok: false, reason: "The proposed action is not in the engine's safe action grammar.", intent: null };
  }

  const targetText = answer.target;
  const target = findCognitionAgent(world, targetText);
  if (COGNITION_TARGET_ACTIONS.has(action) && !target) {
    return { ok: false, reason: "This action needs a living mind as its target.", intent: null };
  }
  if (!COGNITION_TARGET_ACTIONS.has(action) && !cognitionNone(targetText)) {
    return { ok: false, reason: "This action does not accept a target.", intent: null };
  }
  if (target && (target.id === agent.id || target.retired)) {
    return { ok: false, reason: "The target is not a valid other mind.", intent: null };
  }

  /** @type {Record<string, any>|undefined} */
  let payload;
  if (action === "gossip") {
    const about = findCognitionAgent(world, answer.about);
    if (!about || about.id === agent.id || about.id === target?.id) {
      return { ok: false, reason: "Gossip needs a different living mind to be the subject.", intent: null };
    }
    payload = { aboutId: about.id };
  }

  const project = world.project;
  if (action.startsWith("project_") && (!project || project.status !== "active")) {
    return { ok: false, reason: "The North Wall project is not open for work.", intent: null };
  }
  if (action === "project_help") {
    const contribution = target && project.contributors[target.id];
    if (!contribution || (contribution.work <= 0 && contribution.help <= 0)) {
      return { ok: false, reason: "There is no current contribution by that mind to help.", intent: null };
    }
  }
  if (action === "project_interfere") {
    const contribution = target && project.contributors[target.id];
    const ownContribution = project.contributors[agent.id];
    const edge = target ? agent.relations[target.id] : null;
    if (project.progress <= 0 || !contribution || (contribution.work <= 0 && contribution.help <= 0)) {
      return { ok: false, reason: "There is no wall work by that target to interfere with yet.", intent: null };
    }
    if ((edge?.resentment ?? 0) < world.config.projects.interferenceResentmentFloor) {
      return { ok: false, reason: "The engine will not validate sabotage without a real grievance.", intent: null };
    }
    if (world.clock.tick - (ownContribution?.lastInterferenceTick ?? -9999) < world.config.projects.interferenceCooldownTicks) {
      return { ok: false, reason: "That mind has interfered with this work too recently.", intent: null };
    }
  }

  const needsProximity = action === "seek_company" || action === "forge_bond" || action === "grant_favour";
  return {
    ok: true,
    reason: "The engine accepted the proposed action.",
    intent: {
      kind: action,
      targetId: target ? target.id : null,
      utility: 100,
      requiresProximity: needsProximity,
      reasons: ["self-authored plan, validated by the engine"],
      payload
    }
  };
}

/**
 * Apply bounded, private cognition updates from a model reply.
 * @param {World} world
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 */
function updateCognition(world, agent, answer) {
  const cognition = agent.cognition;
  const cfg = world.config.cognition;
  const priority = privateText(answer.priority, 120);
  if (priority) {
    cognition.priorities = cognition.priorities.filter(item => item.text.toLowerCase() !== priority.toLowerCase());
    cognition.priorities.unshift({ text: priority, tick: world.clock.tick });
    cognition.priorities = cognition.priorities.slice(0, Math.max(0, cfg.maxPriorities));
  }

  const beliefText = privateText(answer.belief, 180);
  if (beliefText) {
    const beliefAbout = findCognitionAgent(world, answer.beliefAbout);
    const confidenceValue = Number(answer.beliefConfidence);
    const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.5;
    const existing = cognition.beliefs.find(belief => belief.text.toLowerCase() === beliefText.toLowerCase());
    if (existing) {
      existing.text = beliefText;
      existing.confidence = confidence;
      existing.aboutId = beliefAbout ? beliefAbout.id : null;
      existing.tick = world.clock.tick;
    } else {
      cognition.beliefs.unshift({
        id: world.nextId("belief"),
        text: beliefText,
        confidence,
        aboutId: beliefAbout ? beliefAbout.id : null,
        tick: world.clock.tick
      });
    }
    cognition.beliefs = cognition.beliefs.slice(0, Math.max(0, cfg.maxBeliefs));
  }

  const summary = privateText(answer.summary, cfg.summaryMaxChars);
  if (summary) cognition.memorySummary = summary;
  const thought = privateText(answer.thought, 240);
  if (thought) {
    agent.thought = thought;
    agent.thoughtAt = world.clock.tick;
  }
}

/**
 * Resolve a cognition request. Invalid or expired proposals become one
 * deterministic utility-system action; valid proposals are mapped to existing
 * engine resolvers, so the model cannot invent their consequences.
 * @param {World} world
 * @param {Moment} moment
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @param {boolean} engineFallback
 * @returns {{ok: boolean, reason?: string, events: WorldEvent[], optionId?: string}}
 */
function resolveCognitionMoment(world, moment, agent, answer, engineFallback) {
  updateCognition(world, agent, answer);
  const plan = privateText(answer.plan, world.config.cognition.planMaxChars);
  const proposal = validateCognitionProposal(world, agent, answer);
  let accepted = proposal.ok;
  let validation = proposal.reason;
  let intent = proposal.intent;
  let ranked = intent ? [intent] : [];
  let usedEngine = engineFallback;

  if (!agent.awake || agent.retired) {
    accepted = false;
    intent = null;
    ranked = [];
    validation = agent.retired ? "The mind left before acting." : "The mind fell asleep before the plan could be carried out.";
    usedEngine = true;
  } else if (!proposal.ok) {
    ranked = generateIntents(world, agent);
    intent = ranked[0] || null;
    usedEngine = true;
  }

  const events = intent && agent.awake && !agent.retired
    ? resolveAndApply(world, agent, intent, ranked)
    : [];
  const action = intent ? intent.kind : "none";
  const targetId = intent ? intent.targetId : null;
  const recordedPlan = plan || (engineFallback
    ? "No model answer arrived; the engine completed the next move."
    : "The plan was rejected, so the engine chose a safe next move.");

  agent.cognition.planCount += 1;
  agent.cognition.lastPlan = {
    tick: world.clock.tick,
    text: recordedPlan,
    action,
    targetId,
    accepted,
    reason: validation,
    source: accepted ? "model" : "engine"
  };
  moment.planText = recordedPlan;
  moment.planAction = action;
  moment.planAccepted = accepted;
  moment.planValidation = validation;
  moment.optionId = action;
  moment.resolution = action;
  moment.engineResolved = usedEngine;
  moment.resolved = true;
  rememberResolved(world, moment);
  return { ok: true, events, optionId: action };
}

/* ------------------------------------------------------------------ *
 * Goal approaches: a model proposes, the engine validates and resolves
 * ------------------------------------------------------------------ */

/**
 * Resolve a goal-approach request.
 *
 * A valid proposal becomes a deterministic set of real effects — the mind moves,
 * edges change, the North Wall gains or loses courses. An invalid one, or one
 * that never arrived, becomes the engine's own next move, and either way the
 * proposal and its verdict are written into the world's record.
 *
 * @param {World} world
 * @param {Moment} moment
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @param {boolean} engineFallback  True when no model answered in time.
 * @returns {{ ok: boolean, reason?: string, events: WorldEvent[], optionId?: string }}
 */
function resolveGoalApproachMoment(world, moment, agent, answer, engineFallback) {
  const cfg = world.config.proposals;
  const approach = privateText(answer?.approach, cfg.approachMaxChars);
  const proposal = validateApproach(world, agent, answer);
  const accepted = proposal.ok && agent.awake && !agent.retired;
  const reason = !agent.awake || agent.retired
    ? (agent.retired ? "The mind left before it could act." : "The mind fell asleep before it could act.")
    : engineFallback
      // An expiry is not a grammar rejection. The record must say what
      // actually happened, or a slow model looks like a wrong model.
      ? "No answer arrived in time; the engine made the call."
      : proposal.reason;

  agent.proposal.count += 1;
  agent.proposal.nextTick = world.clock.tick + cfg.intervalTicks;
  if (accepted) agent.proposal.acceptedCount += 1;
  else agent.proposal.rejectedCount += 1;

  const seqMark = world.seq;
  /** @type {WorldEvent[]} */
  let events = [];
  let method = proposal.method || "focus";

  if (accepted && agent.awake && !agent.retired) {
    const resolution = resolveApproach(world, agent, proposal.method, proposal.targetId, approach);
    method = proposal.method;
    const result = applyEffects(world, resolution.ops, { actorId: agent.id, authored: Boolean(approach) });
    events = result.events;
    if (!resolution.quiet) {
      logEvent(world, {
        kind: resolution.eventKind,
        agentId: agent.id,
        text: resolution.text,
        significance: resolution.significance,
        regionId: agent.regionId,
        subjectId: proposal.targetId,
        authored: Boolean(approach)
      });
    }
    agent.lastActedTick = world.clock.tick;
    // Long quiet work still needs to surface occasionally, or a mind grinding
    // away at its goal for a week reads as idle.
    if (resolution.quiet) maybeSurfaceGoalWork(world, agent);
  } else {
    // Engine fallback: the same deterministic choice it would have made anyway.
    const ranked = generateIntents(world, agent);
    const intent = ranked[0] || null;
    if (intent && agent.awake && !agent.retired) {
      method = intent.kind;
      events = resolveAndApply(world, agent, intent, ranked);
    }
  }

  agent.proposal.last = {
    tick: world.clock.tick,
    text: approach || (engineFallback
      ? "No answer arrived in time; the engine made the call."
      : "The approach was refused, so the engine made the call."),
    method,
    targetId: proposal.targetId,
    accepted,
    reason,
    source: accepted ? "model" : "engine"
  };

  // The proposal and its verdict are part of the world's history: a rejection
  // is as much a fact about this mind as an acceptance is.
  logEvent(world, {
    kind: "proposal",
    agentId: agent.id,
    text: `${agent.name} proposed a way at ${agent.goal.text.toLowerCase()}: ` +
      (agent.proposal.last.text) +
      (accepted ? "" : ` The engine refused it — ${reason.toLowerCase()}.`),
    significance: accepted ? 0.42 : 0.36,
    regionId: agent.regionId,
    subjectId: proposal.targetId,
    authored: accepted && Boolean(approach),
    proposal: {
      text: agent.proposal.last.text,
      method,
      accepted,
      reason,
      source: accepted ? "model" : "engine",
      targetId: proposal.targetId
    }
  });

  moment.approachText = agent.proposal.last.text;
  moment.approachMethod = method;
  moment.approachAccepted = accepted;
  moment.approachValidation = reason;
  moment.optionId = method;
  moment.resolution = method;
  moment.engineResolved = !accepted;
  moment.resolved = true;
  rememberResolved(world, moment);

  return { ok: true, events: world.events.filter(e => e.seq > seqMark).reverse(), optionId: method };
}

/**
 * Put a dilemma in front of the keeper when the world has produced one: a feud
 * that has run out of room, or shared work that has stalled with everyone
 * watching. The engine decides a dilemma exists; the keeper decides what to do.
 * @param {World} world
 */
function maybeRaiseDilemma(world) {
  const charter = world.charter;
  const raised = openDilemma(world, world.clock.tick);
  if (!raised) return;
  /** @type {import("./model/charter.js").Dilemma} */
  const dilemma = {
    id: world.nextId("dil"),
    text: raised.text,
    partyIds: raised.partyIds,
    kind: raised.kind,
    tick: world.clock.tick,
    status: "open"
  };
  charter.dilemmas.push(dilemma);
  if (charter.dilemmas.length > 24) charter.dilemmas = charter.dilemmas.slice(-24);
  noteAsk(world, "a dilemma");
  logEvent(world, {
    kind: "charter",
    agentId: raised.partyIds[0] ?? null,
    text: raised.text,
    significance: 0.78,
    regionId: agentById(world, raised.partyIds[0] ?? "")?.regionId
  });
}

/**
 * Long-running goal work should reach the feed now and then rather than never.
 * @param {World} world
 * @param {Agent} agent
 */
function maybeSurfaceGoalWork(world, agent) {
  const interval = world.config.limits.goalLogInterval;
  if (world.clock.tick - (agent.lastGoalLoggedTick ?? -9999) < interval) return;
  agent.lastGoalLoggedTick = world.clock.tick;
  logEvent(world, {
    kind: "act",
    agentId: agent.id,
    text: phrase(world, agent, "pursue_goal", {
      goal: agent.goal.text,
      region: regionName(world, agent.regionId)
    }),
    significance: 0.2,
    regionId: agent.regionId
  });
}

/* ------------------------------------------------------------------ *
 * Petitions, whispers, dilemmas: the keeper-facing loops
 * ------------------------------------------------------------------ */

/**
 * Resolve a petition moment. A validated petition does not change the world
 * directly — it puts a question in front of the keeper, and the keeper's ruling
 * is what becomes law and precedent.
 *
 * @param {World} world
 * @param {Moment} moment
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @param {boolean} engineFallback
 * @returns {{ ok: boolean, reason?: string, events: WorldEvent[], optionId?: string }}
 */
function resolvePetitionMoment(world, moment, agent, answer, engineFallback) {
  const cfg = world.config.charter;
  const words = privateText(answer?.petition ?? answer?.prose, 320);
  const check = validatePetition(world, agent, answer);
  const accepted = check.ok && agent.awake && !agent.retired;
  const reason = !agent.awake || agent.retired
    ? "The mind left before the petition could be made."
    : check.reason;

  agent.petition.nextTick = world.clock.tick + cfg.petitionIntervalTicks;
  agent.petition.count += 1;

  const seqMark = world.seq;
  /** @type {Petition|null} */
  let petition = null;
  if (accepted) {
    petition = recordPetition(world, agent, check, words);
    agent.petition.lastText = petition.text;
  }

  const text = accepted && petition
    ? `${agent.name} petitioned the keeper for ${describeRule(check.ruleKind)}: “${petition.text}” ` +
      `(${petition.support} mind${petition.support === 1 ? "" : "s"} behind it${petition.precedentId ? ", and the keeper has ruled on this before" : ""}).`
    : `${agent.name} wanted to petition the keeper, but had nothing in the world to point at.`;

  logEvent(world, {
    kind: "charter",
    agentId: agent.id,
    text,
    significance: accepted ? 0.62 : 0.3,
    regionId: agent.regionId,
    authored: accepted && Boolean(words),
    proposal: accepted && petition
      ? { text: petition.text, method: check.ruleKind, accepted: true, reason, source: "model" }
      : undefined
  });

  moment.petitionId = petition?.id;
  moment.approachText = petition?.text;
  moment.approachMethod = check.ruleKind;
  moment.approachAccepted = accepted;
  moment.approachValidation = reason;
  moment.optionId = accepted ? check.ruleKind : "refused";
  moment.resolution = moment.optionId;
  moment.engineResolved = !accepted || engineFallback;
  moment.resolved = true;
  rememberResolved(world, moment);

  return { ok: true, events: world.events.filter(e => e.seq > seqMark).reverse(), optionId: moment.optionId };
}

/**
 * Resolve a whisper moment. The whisper is recorded and waits; nothing in the
 * world changes until the keeper decides to act on it.
 *
 * @param {World} world
 * @param {Moment} moment
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @param {boolean} engineFallback
 * @returns {{ ok: boolean, reason?: string, events: WorldEvent[], optionId?: string }}
 */
function resolveWhisperMoment(world, moment, agent, answer, engineFallback) {
  const cfg = world.config.charter;
  const words = privateText(answer?.whisper ?? answer?.prose, 280);
  const aboutId = moment.participants[1] ?? null;
  const accepted = Boolean(words) && agent.awake && !agent.retired;

  agent.whisper.nextTick = world.clock.tick + cfg.whisperIntervalTicks;
  agent.whisper.count += 1;

  const seqMark = world.seq;
  if (accepted) {
    /** @type {import("./model/charter.js").Whisper} */
    const whisper = {
      id: world.nextId("whi"),
      agentId: agent.id,
      aboutId,
      text: words,
      tick: world.clock.tick
    };
    world.charter.whispers.push(whisper);
    agent.whisper.lastText = words;
    moment.whisperId = whisper.id;
    noteAsk(world, "a whisper");
  }

  const about = aboutId ? agentById(world, aboutId) : null;
  logEvent(world, {
    kind: "charter",
    agentId: agent.id,
    subjectId: aboutId,
    // The record says a private thing was said without saying what it was. The
    // keeper can read the whisper itself; the world only knows it happened.
    text: accepted
      ? `${agent.name} told the keeper something in private${about ? ` about ${about.name}` : ""}, and left it there.`
      : `${agent.name} started to tell the keeper something and stopped.`,
    significance: accepted ? 0.5 : 0.24,
    regionId: agent.regionId
  });

  moment.approachText = accepted ? words : "";
  moment.approachAccepted = accepted;
  moment.approachValidation = accepted ? "Recorded for the keeper." : "Nothing was said.";
  moment.optionId = accepted ? "whispered" : "withheld";
  moment.resolution = moment.optionId;
  moment.engineResolved = !accepted || engineFallback;
  moment.resolved = true;
  rememberResolved(world, moment);

  return { ok: true, events: world.events.filter(e => e.seq > seqMark).reverse(), optionId: moment.optionId };
}

/**
 * @param {World} world
 * @param {Moment} moment
 * @param {Agent} agent
 * @param {import("./model/world.js").MomentOption} option
 * @param {string|null} prose
 */
function applyMomentOption(world, moment, agent, option, prose) {
  const ops = (option.ops || []).slice();
  // A model's prose becomes the world's record of the beat. Without one, the
  // engine narrates it itself — an offline world should still read as a story
  // rather than as a list of decisions somebody made.
  // The whole option travels, not just an id and a label: options that carry
  // their own narration (a new goal's line, which is generated from the goal
  // tables and so cannot be keyed on) need `prose` and `data` to arrive intact.
  const text = prose || momentLine(world, agent, moment, option, id => agentById(world, id));
  ops.push({
    op: "event",
    agent: agent.id,
    text,
    kind: eventKindFor(moment.kind),
    significance: moment.significance,
    subjectId: moment.participants[1] ?? null,
    secretId: moment.context.secretId
  });
  const result = applyEffects(world, ops, { actorId: agent.id, authored: Boolean(prose) });
  agent.lastActedTick = world.clock.tick;
  // Some acts are rare by their nature rather than by their consequences: a
  // mind that has just unburdened itself has nothing left to unburden today.
  if (moment.kind === "confession") agent.lastConfideTick = world.clock.tick;
  if (moment.kind === "dialogue") agent.lastDialogueTick = world.clock.tick;
  return result;
}

/** @param {string} kind */
function eventKindFor(kind) {
  switch (kind) {
    case "confrontation":
      return "conflict";
    case "betrayal":
      return "betrayal";
    case "confession":
      return "confide";
    case "dialogue":
      return "contact";
    case "call_in":
      return "favour";
    default:
      return "act";
  }
}

/**
 * Strip the scaffolding reasoning models leak into their output. Returns an
 * empty string rather than throwing, so a bad completion degrades into engine
 * prose instead of a broken tick.
 * @param {unknown} text
 */
export function sanitize(text) {
  let t = String(text == null ? "" : text).trim();
  if (!t) return "";
  t = t.replace(/^["“”']+|["“”']+$/g, "").trim();
  // Reasoning models sometimes prefix their actual answer.
  t = t.replace(/^(?:final answer|answer|output)\s*[:\-]\s*/i, "");
  const meta = /\bwe (need|must|should|will|shall)\b|\bas an ai\b|provide (one|a) (short|vivid) sentence|never break character|in third person/i;
  if (meta.test(t)) {
    const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    const kept = sentences.filter(s => !meta.test(s));
    t = kept.join(" ").trim();
  }
  if (meta.test(t)) return "";
  return t.slice(0, 600);
}

/* ------------------------------------------------------------------ *
 * Chronicle
 * ------------------------------------------------------------------ */

/**
 * Write the day's chronicle line at the end of each day.
 * @param {import("./model/world.js").World} world
 * @param {number} tick
 */
function maybeChronicle(world, tick) {
/**
 * @param {any} e
 */
  const previousDay = world.chronicle.length + 1;
  if (world.clock.day <= previousDay) return;

/**
 * @param {any} e
 */
  const day = previousDay;
  const markTick = world.chronicleMark ?? 0;
  const dayEvents = world.events.filter(e => e.tick > markTick && e.tick <= tick);
  const notable = dayEvents
    .filter(e => e.significance >= world.config.limits.chronicleSignificance)
    .slice(0, 14);
  world.chronicleMark = tick;

  const parts = notable.map(e => {
    const who = e.agentId ? agentById(world, e.agentId) : null;
    // Most lines already open with the mind that acted — "Pim said the whole
    // thing out loud". A chronicle is a summary, not a transcript, so only the
    // lines that would otherwise read as anonymous get attributed.
    if (!who || e.text.startsWith(who.name)) return e.text;
    return `${who.name}: ${e.text}`;
  });

  let summary;
  if (!parts.length) {
    summary = "A day in which nothing much was decided.";
  } else {
    summary = parts.slice(0, 6).join(" ");
    if (parts.length > 6) summary += ` And ${parts.length - 6} other things worth noting.`;
  }

  world.chronicle.push({
    day,
    tick,
    summary,
    notableCount: notable.length,
    stats: {
      events: dayEvents.length,
      secretsPublic: world.secrets.filter(s => s.isPublic).length
    }
  });

  logEvent(world, {
    kind: "chronicle",
    agentId: null,
    text: `Day ${day} closed: ${summary}`,
    significance: 0.4
  });
}

/* ------------------------------------------------------------------ *
 * Convenience drivers
 * ------------------------------------------------------------------ */

/**
 * Run a number of ticks. Useful for tests, for fast-forwarding a world to give
 * it history, and for generating a case study offline.
 * @param {World} world
 * @param {number} ticks
 * @param {{ onTick?: (report: StepReport) => void }} [opts]
 */
export function runTicks(world, ticks, opts = {}) {
  const reports = [];
  for (let i = 0; i < ticks; i++) {
    const report = step(world);
    reports.push(report);
    if (opts.onTick) opts.onTick(report);
  }
  return reports;
}

/**
 * A compact human-readable snapshot of the world, for logs and debugging.
 * @param {World} world
 */
export function describeWorld(world) {
  const lines = [`${describeClock(world.clock)} — ${livingAgents(world).length} minds, ${world.seq} events, ${world.pending.length} moments pending.`];
  for (const agent of livingAgents(world)) {
    const state = agent.awake ? "awake" : "asleep";
    lines.push(
      `  ${agent.name.padEnd(7)} L${agent.level} ${agent.class.padEnd(9)} ${state}  ` +
        `E${Math.round(agent.needs.energy)} C${Math.round(agent.needs.connection)} ` +
        `S${Math.round(agent.needs.esteem)} M${Math.round(agent.needs.meaning)}  ` +
        `@${agent.regionId}  ${agent.memory.traces.length} memories`
    );
  }
  return lines.join("\n");
}
