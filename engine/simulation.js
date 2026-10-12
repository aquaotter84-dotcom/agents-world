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
import { applyEffects } from "./systems/effects.js";
import { settleNeeds, checkCollapse } from "./systems/needs.js";
import { settleRelations, settleProximity, hatchSecrets } from "./systems/social.js";
import { settleTurnover } from "./systems/turnover.js";
import { settleRituals } from "./systems/rituals.js";
import { trackFeuds } from "./systems/vendetta.js";
import { settleMemory } from "./systems/memory.js";
import { logEvent } from "./model/events.js";
import { phrase, momentLine } from "./decision/prose.js";
import { agentById, livingAgents } from "./model/world.js";

/**
 * @typedef {import("./model/world.js").World} World
 * @typedef {import("./model/agent.js").Agent} Agent
 * @typedef {import("./decision/intents.js").Intent} Intent
 * @typedef {import("./model/world.js").Moment} Moment
 * @typedef {import("./model/events.js").WorldEvent} WorldEvent
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
    settleNeeds(world, agent);
    settleRelations(world, agent);
    settleMemory(world, agent);
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
  for (const agent of world.rng.shuffle(living)) {
    if (!agent.awake) continue;
    const ranked = generateIntents(world, agent);
    const intent = ranked[0];
    if (!intent) continue;
    decisions.push({ agent, intent, ranked });
  }

  /* ---- 4. Moment admission ---- */
  /** @type {{ agent: Agent, intent: Intent, moment: Moment }[]} */
  const candidates = [];
  for (const decision of decisions) {
    if (!isMomentWorthy(world, decision.agent, decision.intent, decision.ranked)) continue;
    const moment = buildMoment(world, decision.agent, decision.intent, decision.ranked);
    if (moment) candidates.push({ agent: decision.agent, intent: decision.intent, moment });
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
  settleRituals(world);
  trackFeuds(world);
  // Systems queue ops rather than applying them mid-pass, so that nothing here
  // can mutate an agent halfway through another system's read of it.
  if (world.pendingOps && world.pendingOps.length) {
    applyEffects(world, /** @type {import("./systems/effects.js").EffectOp[]} */ (world.pendingOps), {});
    world.pendingOps = [];
  }
  expireMoments(world);

  /* ---- 7. Day boundary ---- */
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
 * Resolve one intent deterministically and write it into the world.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} ranked
 */
function resolveAndApply(world, agent, intent, ranked) {
  const resolution = resolveIntent(world, agent, intent, ranked);
  agent.lastActedTick = world.clock.tick;
  applyEffects(world, resolution.ops, { actorId: agent.id });

  // Texture stays out of the world's history. Nine minds taking a tick each
  // produces thousands of small acts a day, and a feed that shows all of them
  // shows nothing. Quiet actions still happen and are still remembered — they
  // just don't get a line in the record unless they earn one.
  if (resolution.quiet && !shouldSurface(world, agent, intent)) return;

  logEvent(world, {
    kind: resolution.eventKind,
    agentId: agent.id,
    text: resolution.text,
    significance: resolution.significance,
    regionId: agent.regionId,
    scene: resolution.scene
  });
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
      const option = chooseDefaultOption(world, agent, moment);
      applyMomentOption(world, moment, agent, option, null);
      moment.resolved = true;
      moment.optionId = option.id;
      moment.resolution = option.id;
      moment.engineResolved = true;
      rememberResolved(world, moment);
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
 * @param {{ optionId?: string, prose?: string, thought?: string, goal?: string, goalKind?: string }} answer
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
    subjectId: moment.participants[1] ?? null
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
