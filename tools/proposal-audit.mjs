#!/usr/bin/env node
/**
 * Proposal acceptance audit — the evidence behind "Phase A proposals actually
 * get accepted, not just rejected more gracefully."
 *
 * The old build's Threads view showed a wall of ENGINE FALLBACKs: every
 * model-authored proposal was refused with "not in the engine's safe action
 * grammar", so the model's voice never landed in the world. The new approach
 * grammar (engine/decision/proposals.js) is supposed to fix that. This tool
 * proves it, or measures exactly how far short it falls.
 *
 * What it does:
 *
 *   - Seeds a world (createWorld, deterministic) and runs it for a number of
 *     world days, exactly as the headless server would.
 *   - For every goal_approach moment the engine offers, a scripted "model"
 *     answers in the exact shape the prompt asks for (APPROACH: ... plus a
 *     METHOD line), and the answer goes through the real parseReply and
 *     resolveMoment — the same path the app and the moment worker use.
 *   - A reply can be delivered with a latency in ticks, which is what actually
 *     happens when a language model answers a few ticks after being asked.
 *
 * Four temperaments, so the audit covers both the fix and the guardrails:
 *
 *   compliant    — names a METHOD token from the list it was offered. This is
 *                  the model the grammar is for; its accept rate is the number
 *                  that matters.
 *   sloppy       — writes the approach in prose and never a METHOD line; the
 *                  token is only named inside the sentences. Exercises the
 *                  loose parse path that rescued reworded replies.
 *   misbehaving  — always proposes a token the world cannot resolve ("summon
 *                  a storm"). The old build refused these silently; the new
 *                  one must refuse them *in the record*, with a reason.
 *
 * The report ends with the one invariant the brief makes non-negotiable:
 * there are no invisible rejections. Every proposal — accepted or refused —
 * has a proposal event in the world's record carrying the verdict and the
 * reason, and every mind's bookkeeping tallies.
 *
 * Usage:
 *   node tools/proposal-audit.mjs [--seed 4711] [--days 10] [--json]
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { createWorld } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { createRng } from "../engine/rng.js";
import { parseReply } from "../server/prompt.js";

/* ------------------------------------------------------------------ *
 * The scripted model
 * ------------------------------------------------------------------ */

/**
 * Third-person approach sentences, one per method. Deliberately the texture a
 * language model would produce in this prompt: vivid, no numbers, no prompt
 * scaffolding. (Anything echoing the prompt is dropped by parseReply, and an
 * audit that fed the engine its own scaffolding would be proving nothing.)
 * @type {Record<string, string>}
 */
const APPROACH_LINES = {
  focus: "Went at it alone, the same slow pass again, until the work sat truer than it had that morning.",
  study: "Read the old survey notes and checked them against what the wall actually does in frost.",
  practice: "Drilled the one part of it that keeps failing, out where anyone passing could watch.",
  recruit: "Made the rounds to recruit a pair of willing hands, and did not pester anyone twice.",
  consult: "Put it to someone here, a quiet consult, and listened for what they knew that she did not.",
  explore: "Chose to explore the far side of the world first, and let the road teach her the shape of it.",
  organise: "Spent the day on the organising of it: courses, a rota, and a place for every stone.",
  push_through: "Decided to push through whatever came of it, and the arms paid the bill for the ambition.",
  undermine: "Let the old grudge pick the hour; a short, quiet bit of undermine while they were not looking."
};

/**
 * The same sentences reworded so the token only appears inside the prose —
 * no METHOD line at all. This is what a model that answers freehand produces,
 * and it is the shape the loose parser has to save.
 * @type {Record<string, string>}
 */
const SLOPPY_LINES = {
  focus: "The whole plan was focus — one course at a time, nothing borrowed, nobody asked.",
  study: "Went back to study, the notes and the ledgers and the frost line, before touching the work at all.",
  practice: "Set an open hour for practice where whoever passed by could watch the part that keeps failing.",
  recruit: "Made the rounds to recruit a pair of willing hands; a fair ask, and a free one for the asker.",
  consult: "It came down to a consult — one question, put to the person here who had seen the old courses.",
  explore: "Chose to explore the far side of it first; a walk, then the work would know where it stood.",
  organise: "The day went to the organising of it — rosters, stones, and an order that could outlive the weather.",
  push_through: "There was no middle way, so the answer was to push through, whatever the day cost in the end.",
  undermine: "The grudge chose the hour, and the work took a short, quiet bit of undermine while no one watched."
};

/** A token the world can never resolve — the old build's favourite reply. */
const STORM_LINE = "Rode the pressure change and called the weather down on the work.";

/**
 * Make one scripted model. Deterministic: the same seed, world and tick
 * produce the same reply, which is what makes the audit reproducible.
 * @param {"compliant"|"sloppy"|"misbehaving"} temperament
 * @param {ReturnType<typeof createRng>} rng  A private substream — the world's
 *   own rng is never touched, so the audit cannot move the world's determinism.
 */
function makeModel(temperament, rng) {
  /**
   * @param {object} world
   * @param {import("../engine/model/agent.js").Agent} agent
   * @param {string[]} offered
   */
  return function model(world, agent, offered) {
    if (temperament === "misbehaving") {
      return `APPROACH: ${STORM_LINE}\nMETHOD: summon_a_storm\nTHOUGHT: The wall would respect a real storm.`;
    }
    const method = offered.length ? offered[rng.int(0, offered.length - 1)] : "focus";
    if (temperament === "sloppy") {
      return `APPROACH: ${SLOPPY_LINES[method] || APPROACH_LINES[method]}`;
    }
    return `APPROACH: ${APPROACH_LINES[method]}\nMETHOD: ${method}\nTHOUGHT: One more pass at it today.`;
  };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} AuditStats
 * @property {string} label
 * @property {"compliant"|"sloppy"|"misbehaving"} temperament
 * @property {number} seed
 * @property {number} ticks
 * @property {number} days
 * @property {number} offered
 * @property {number} accepted
 * @property {number} rejected
 * @property {number} expiredBeforeReply
 * @property {number} acceptRate
 * @property {number} rejectRate
 * @property {Record<string, number>} rejectReasons
 * @property {Record<string, number>} acceptedMethods
 * @property {{tick: number, agent: string, reason: string, resolution: string}[]} rejections
 * @property {number} invisible
 * @property {import("../engine/model/events.js").WorldEvent[]} proposalEvents
 * @property {{name: string, count: number, accepted: number, rejected: number}[]} perAgent
 */

/**
 * Run one audit: a seeded world, N days, one scripted model answering every
 * goal_approach moment the engine offers, replies delivered `latency` ticks
 * after they are asked.
 *
 * @param {{
 *   seed: number,
 *   days: number,
 *   temperament: "compliant"|"sloppy"|"misbehaving",
 *   latency: number,
 *   modelSeed?: number
 * }} opts
 * @returns {AuditStats}
 */
export function runAudit(opts) {
  const { seed, days, temperament, latency, modelSeed } = opts;
  const ticks = days * 48;
  const world = createWorld({ seed });
  const rng = createRng(modelSeed ?? seed * 1000 + 17);
  const model = makeModel(temperament, rng);

  /** @type {{moment: import("../engine/model/world.js").Moment, agent: import("../engine/model/agent.js").Agent, dueTick: number}[]} */
  const inbox = [];

  /** @type {Record<string, number>} */
  const rejectReasons = {};
  /** @type {Record<string, number>} */
  const acceptedMethods = {};
  let offered = 0;
  let accepted = 0;
  let rejected = 0;
  let expiredBeforeReply = 0;
  /**
   * The event stream as produced, in order. The engine's own world.events and
   * world.resolved lists are capped, but a live reader (the app's Threads
   * view, the server's log) sees every event as it is produced — so this is
   * what "visible in the record" means, and what the invisibility check runs
   * against.
   * @type {import("../engine/model/events.js").WorldEvent[]}
   */
  const record = [];
  /** @type {{tick: number, agent: string, reason: string, resolution: string}[]} Every refusal the run produced, so a reader can check them by hand. */
  const rejections = [];

  /**
   * Deliver every reply that is due at the current tick, before the world
   * moves on — the way the app lands a model answer between ticks.
   */
  function deliverInbox() {
    const tick = world.clock.tick;
    for (let i = inbox.length - 1; i >= 0; i--) {
      const entry = /** @type {{moment: import("../engine/model/world.js").Moment, agent: import("../engine/model/agent.js").Agent, dueTick: number}} */ (inbox[i]);
      if (entry.dueTick > tick) continue;
      inbox.splice(i, 1);
      const stillPending = world.pending.some(m => m.id === entry.moment.id);
      if (!stillPending) {
        // The engine already answered it — the reply is too late, not wrong.
        expiredBeforeReply += 1;
        continue;
      }
      const offeredMethods = /** @type {string[]} */ (entry.moment.context.availableMethods ?? []);
      const raw = model(world, entry.agent, offeredMethods);
      const answer = parseReply(raw, /** @type {any} */ (entry.moment));
      const result = resolveMoment(world, entry.moment.id, answer);
      record.push(...result.events);
      tally(entry.moment);
    }
  }

  /**
   * Record one resolved goal_approach moment in the running report.
   * @param {import("../engine/model/world.js").Moment} moment
   */
  function tally(moment) {
    const agent = world.agents.find(a => a.id === moment.agentId);
    if (moment.approachAccepted) {
      accepted += 1;
      acceptedMethods[/** @type {string} */ (moment.approachMethod)] =
        (acceptedMethods[/** @type {string} */ (moment.approachMethod)] || 0) + 1;
    } else {
      rejected += 1;
      /** @type {string} */
      const reason = moment.approachValidation || "unrecorded";
      rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
      rejections.push({
        tick: moment.tick,
        agent: agent ? agent.name : moment.agentId,
        reason,
        resolution: moment.approachMethod ?? ""
      });
    }
  }

  /**
   * Answer or queue every goal_approach moment a tick produced.
   * @param {import("../engine/simulation.js").StepReport} report
   */
  function handleReport(report) {
    record.push(...report.events);
    for (const moment of report.moments) {
      if (moment.kind !== "goal_approach") continue;
      offered += 1;
      const agent = world.agents.find(a => a.id === moment.agentId);
      if (!agent) continue;
      if (latency === 0) {
        const offeredMethods = /** @type {string[]} */ (moment.context.availableMethods ?? []);
        const raw = model(world, agent, offeredMethods);
        const answer = parseReply(raw, /** @type {any} */ (moment));
        const result = resolveMoment(world, moment.id, answer);
        record.push(...result.events);
        tally(moment);
      } else {
        inbox.push({ moment, agent, dueTick: world.clock.tick + latency });
      }
    }
  }

  for (let i = 0; i < ticks; i++) {
    deliverInbox();
    handleReport(step(world));
  }
  // The app keeps ticking while model replies are in flight, so let the world
  // turn over a few more ticks until every reply has landed — or expired and
  // become an engine answer, which the tally then counts as a refusal.
  for (let guard = 0; guard < 8 && inbox.length; guard++) {
    deliverInbox();
    handleReport(step(world));
  }
  // Anything still in flight after the drain was already answered by the
  // engine (the expiry window is shorter than the drain); count those verdicts
  // rather than pretending the late reply landed.
  for (const entry of inbox) {
    if (entry.moment.resolved) tally(entry.moment);
  }
  inbox.length = 0;

  /* ---- the invariant: nothing is refused invisibly ---- */
  /**
   * A proposal is *visible* when the record the world's readers actually saw
   * (the event stream, not the capped log) contains its verdict.
   * resolveGoalApproachMoment writes exactly one proposal event per resolved
   * goal_approach moment — accepted or refused — carrying the verdict, the
   * reason, and whose call it was. The app's Threads view reads exactly
   * these fields.
   */
  const proposalEvents = record.filter(e => e.kind === "proposal");
  let invisible = 0;
  if (proposalEvents.length !== accepted + rejected + expiredBeforeReply) {
    invisible += 1; // a proposal resolved without leaving its verdict in the stream
  }
  for (const event of /** @type {any[]} */ (proposalEvents)) {
    const verdict = event.proposal;
    if (!verdict) { invisible += 1; continue; }
    if (typeof verdict.accepted !== "boolean") invisible += 1;
    if (!verdict.reason || !String(verdict.reason).trim()) invisible += 1;
    if (verdict.source !== "model" && verdict.source !== "engine") invisible += 1;
  }
  for (const agent of world.agents) {
    const book = /** @type {any} */ (agent.proposal);
    if (!book) continue;
    if (book.count !== book.acceptedCount + book.rejectedCount) invisible += 1;
  }

  const total = accepted + rejected;
  return {
    label: `${temperament} model, ${latency === 0 ? "reply same tick" : `reply ${latency} ticks late`}`,
    temperament,
    seed,
    ticks,
    days,
    offered,
    accepted,
    rejected,
    expiredBeforeReply,
    acceptRate: total ? accepted / total : 0,
    rejectRate: total ? rejected / total : 0,
    rejectReasons,
    acceptedMethods,
    rejections,
    invisible,
    /** The proposal events the record actually carried, with their verdicts. */
    proposalEvents,
    perAgent: world.agents
      .filter(a => !a.retired)
      .map(a => {
        const book = /** @type {any} */ (a.proposal);
        return {
          name: a.name,
          count: book ? book.count : 0,
          accepted: book ? book.acceptedCount : 0,
          rejected: book ? book.rejectedCount : 0
        };
      })
  };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/**
 * @param {number} x
 */
function pct(x) {
  return `${(x * 100).toFixed(1).padStart(5)}%`;
}

/**
 * @param {AuditStats} stats
 */
function printReport(stats) {
  const line = "=".repeat(74);
  console.log(line);
  console.log(`Agents World — proposal acceptance audit · seed ${stats.seed} · ${stats.days} world days (${stats.ticks} ticks)`);
  console.log(line);
  console.log(`Scenario: ${stats.label}`);
  console.log("");
  console.log(`  proposals offered to the model .... ${stats.offered}`);
  console.log(`  resolved by the engine ............ ${stats.accepted + stats.rejected + stats.expiredBeforeReply}`);
  console.log(`  accepted (the model's way) ........ ${stats.accepted}  ${pct(stats.acceptRate)}`);
  console.log(`  rejected (engine made the call) ... ${stats.rejected}  ${pct(stats.rejectRate)}`);
  if (stats.expiredBeforeReply) {
    console.log(`  expired before the reply arrived ... ${stats.expiredBeforeReply}`);
  }
  if (stats.rejected) {
    console.log("");
    console.log("  refusals, by reason:");
    const reasons = Object.entries(stats.rejectReasons).sort((a, b) => b[1] - a[1]);
    for (const [reason, n] of reasons) console.log(`    ${String(n).padStart(4)}  ${reason}`);
  }
  if (stats.accepted) {
    console.log("");
    console.log("  accepted approaches, by method:");
    const methods = Object.entries(stats.acceptedMethods).sort((a, b) => b[1] - a[1]);
    for (const [method, n] of methods) {
      console.log(`    ${String(n).padStart(4)}  ${method}  ${pct(n / stats.accepted)}`);
    }
  }
  console.log("");
  console.log(`  invisible rejections .............. ${stats.invisible === 0 ? "none — every refusal is in the record with a reason" : `${stats.invisible}  (this is the bug)`}`);
  const dominated = stats.rejected > stats.accepted;
  const verdict = !dominated ? "no"
    : stats.temperament === "misbehaving"
      ? "yes — expected: it proposes the unresolvable, and every refusal is on the record"
      : "YES — the grammar is not doing its job";
  console.log(`  engine fallback dominates ......... ${verdict}`);
  console.log("");
}

/**
 * @param {AuditStats} stats
 */
function printPerAgent(stats) {
  console.log("  per-mind ledger:");
  for (const a of stats.perAgent) {
    const rate = a.count ? `${(a.accepted / a.count * 100).toFixed(0)}% accepted` : "not asked";
    console.log(`    ${a.name.padEnd(14)} ${String(a.count).padStart(3)} proposals · ${String(a.accepted).padStart(3)} accepted · ${String(a.rejected).padStart(3)} refused · ${rate}`);
  }
  console.log("");
}

/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  /**
   * @param {string} name
   * @param {string} def
   * @returns {string}
   */
  const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? /** @type {string} */ (args[i + 1]) : def;
  };
  const seed = Number(flag("seed", "4711"));
  const days = Number(flag("days", "10"));
  const asJson = args.includes("--json");

  const runs = [
    runAudit({ seed, days, temperament: "compliant", latency: 0 }),
    runAudit({ seed, days, temperament: "compliant", latency: 2 }),
    runAudit({ seed, days, temperament: "sloppy", latency: 2 }),
    runAudit({ seed, days, temperament: "misbehaving", latency: 2 })
  ];

  if (asJson) {
    console.log(JSON.stringify({ seed, days, runs }, null, 2));
    return;
  }

  for (const stats of runs) {
    printReport(stats);
    printPerAgent(stats);
  }
  console.log(line());
  console.log("Reading: the compliant model is the model the approach grammar is for.");
  console.log("If its accept rate is high, the old 'refused — not in the engine's");
  console.log("safe action grammar' wall is gone. The misbehaving model shows the");
  console.log("grammar still guards — and that every guard now leaves a mark.");
  console.log(line());

  function line() {
    return "=".repeat(74);
  }

  // Non-zero exit when the audit fails its own standard, so CI can run it.
  const compliant = runs[0];
  const dominated = compliant.rejected > compliant.accepted;
  process.exit(dominated || compliant.invisible > 0 || compliant.offered === 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedDirectly) main();
