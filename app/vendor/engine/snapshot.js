/**
 * Snapshots: turning a living world into something that can be written to disk
 * and back without it noticing.
 *
 * The only awkward part is the generator, whose state is a single integer, and
 * the id factory, which is a closure over a counter object. Both are restored
 * exactly, so a reloaded world continues the same sequence it would have
 * continued had it never been saved. That is what makes it possible to rewind
 * to a save and watch an interesting week play out differently.
 */

import { createRng } from "./rng.js";
import { makeConfig } from "./config.js";
import { makeIdFactory } from "./model/world.js";
import { createNorthWallProject } from "./model/projects.js";
import { normalizeCharter } from "./model/charter.js";
import { normalizeWant } from "./model/want.js";
import { normalizeMourning } from "./model/mourning.js";
import { normalizeDivine } from "./model/divine.js";
import { createCognitionState, createProposalState } from "./model/agent.js";

/**
 * The parts of a world worth persisting. Derived data (factions, stats) is
 * deliberately left out — recomputing is cheaper and it can't fall out of sync.
 */
const PERSISTED = [
  "id",
  "seed",
  "clock",
  "agents",
  "regions",
  "events",
  "tallies",
  "secrets",
  "project",
  "charter",
  // The keeper's own score and the ledger of what moved it. Persisted because
  // a keeper who comes back after a night away should find the meters where
  // the world left them, not reset to a fresh 50.
  "want",
  // Funerals still coming and the memorials of everyone the world has lost.
  "mourning",
  // Signs the keeper has already set: which targets are lit, which regions are
  // under an omen, and how long each has left to bite.
  "divine",
  "pending",
  "resolved",
  "chronicle",
  "chronicleMark",
  "seq",
  "flags",
  // Slow-interval markers. These decide *when* a system next fires, and they
  // draw from the seeded RNG when they do — so they are part of the world's
  // state. A resumed world that forgot them would fire everything at once and
  // fork the RNG stream.
  "lastArrivalTick",
  "lastDepartureTick",
  "lastRitualKey",
  // Which narration lines have been used lately. Part of the world's state
  // rather than the module's, so a resumed or forked world does not immediately
  // start repeating lines the original had already spent.
  "proseMemory"
];

/**
 * @param {import("./model/world.js").World} world
 * @returns {string}
 */
export function serializeWorld(world) {
  /** @type {Record<string, any>} */
  const out = {};
  const source = /** @type {Record<string, any>} */ (/** @type {unknown} */ (world));
  for (const key of PERSISTED) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  out.idCounters = world.idCounters;
  out.rngState = world.rng.state();
  out.config = world.config;
  return JSON.stringify(out);
}

/**
 * @param {string|object} input
 * @returns {import("./model/world.js").World}
 */
export function deserializeWorld(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const rng = createRng(data.seed);
  rng.restore(data.rngState);

  const counters = data.idCounters || {};
  /** @type {any} */
  const world = {};
  for (const key of PERSISTED) {
    if (data[key] !== undefined) world[key] = data[key];
  }
  world.config = makeConfig(data.config);
  // Older v2 worlds predate the shared project; give them the same deterministic
  // initial project state without drawing from or perturbing the RNG stream.
  world.project = data.project || createNorthWallProject();
  if (!Number.isFinite(world.project.lastWorkTick)) world.project.lastWorkTick = 0;
  // A world saved before the charter existed simply has no customs yet.
  world.charter = normalizeCharter(data.charter);
  // A world saved before the keeper's want existed starts with a level reading
  // and an empty ledger, which is the honest thing to show.
  world.want = normalizeWant(data.want);
  // A world saved before anyone had died has an empty mourning chronicle.
  world.mourning = normalizeMourning(data.mourning);
  // A world saved before the keeper had any way to be felt has never been
  // visited — no signs, no cooldowns, nothing to expire.
  world.divine = normalizeDivine(data.divine);
  const pilotCount = Math.max(0, Math.floor(world.config.cognition.pilotCount));
  const interval = Math.max(1, world.config.cognition.planIntervalTicks);
  for (let index = 0; index < world.agents.length; index += 1) {
    /** @type {import("./model/agent.js").Agent} */
    const agent = world.agents[index];
    const saved = agent.cognition;
    const enabled = saved && typeof saved.enabled === "boolean" ? saved.enabled : index < pilotCount;
    const offset = 1 + Math.floor(index * interval / Math.max(1, pilotCount));
    agent.cognition = {
      ...createCognitionState(enabled, enabled ? offset : -1),
      ...(saved || {})
    };
    if (!Array.isArray(agent.cognition.priorities)) agent.cognition.priorities = [];
    if (!Array.isArray(agent.cognition.beliefs)) agent.cognition.beliefs = [];
    if (typeof agent.cognition.memorySummary !== "string") agent.cognition.memorySummary = "";
    if (!Number.isFinite(agent.cognition.nextPlanTick)) agent.cognition.nextPlanTick = enabled ? offset : -1;
    if (!Number.isFinite(agent.cognition.lastPlanTick)) agent.cognition.lastPlanTick = -1;
    if (!Number.isFinite(agent.cognition.planCount)) agent.cognition.planCount = 0;

    // A world saved before proposal-based minds existed has no proposal record.
    // Stagger the first approach the same way cognition staggers its first plan,
    // so a resumed world does not ask all nine minds at once.
    const savedProposal = agent.proposal;
    const proposalInterval = Math.max(1, world.config.proposals.intervalTicks);
    const proposalOffset = 1 + Math.floor(index * proposalInterval / Math.max(1, world.agents.length));
    agent.proposal = {
      ...createProposalState(proposalOffset),
      ...(savedProposal || {})
    };
    if (!Number.isFinite(agent.proposal.nextTick)) agent.proposal.nextTick = proposalOffset;
    if (!Number.isFinite(agent.proposal.count)) agent.proposal.count = 0;
    if (!Number.isFinite(agent.proposal.acceptedCount)) agent.proposal.acceptedCount = 0;
    if (!Number.isFinite(agent.proposal.rejectedCount)) agent.proposal.rejectedCount = 0;

    if (!agent.petition || typeof agent.petition !== "object") agent.petition = { nextTick: 0, count: 0 };
    if (!Number.isFinite(agent.petition.nextTick)) agent.petition.nextTick = 0;
    if (!Number.isFinite(agent.petition.count)) agent.petition.count = 0;
    if (!agent.whisper || typeof agent.whisper !== "object") agent.whisper = { nextTick: 0, count: 0 };
    if (!Number.isFinite(agent.whisper.nextTick)) agent.whisper.nextTick = 0;
    if (!Number.isFinite(agent.whisper.count)) agent.whisper.count = 0;
  }
  world.rng = rng;
  world.idCounters = counters;
  world.nextId = makeIdFactory(counters);
  return world;
}

/**
 * Deep-copy a world by round-tripping it through a snapshot. Useful for tests
 * that want to explore two futures from the same moment.
 * @param {import("./model/world.js").World} world
 * @returns {import("./model/world.js").World}
 */
export function forkWorld(world) {
  return deserializeWorld(serializeWorld(world));
}
