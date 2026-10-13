/**
 * The settlement system: the base game running on top of the living world.
 *
 * Stores, the daily ledger, storm season, the Hold and collapse. The
 * design pillar is that the social layer *is* the strategy layer, so
 * almost nothing here reads a raw number when a social fact is available:
 * production is bent by exposed secrets and mourning hands, crews cannot
 * hold two minds in a feud, and a memorial built together writes real
 * affection into the relationship graph.
 *
 * Hard rules this file keeps:
 *   - Dormant unless the game mode enabled it. Every entry point checks,
 *     and a dormant call returns without touching anything (or the RNG).
 *   - No RNG draws, ever. Storm timing and strength are calendar
 *     arithmetic, so an enabled world is as replayable as a dormant one.
 *   - Keeper acts follow the divine pattern: validate first with a
 *     sentence for every refusal, spend influence second, then change
 *     the world, then write it down.
 */

import { clamp } from "../config.js";
import { logEvent } from "../model/events.js";
import { agentById, livingAgents } from "../model/world.js";
import { adjustEdge } from "../model/relationships.js";
import { remember } from "../model/memory.js";
import { moveInfluence } from "../model/charter.js";
import {
  buildingByKind, buildingById, buildingDef, settlementActive, settlementEnabled,
  settlementLevelFor, stormStrengthFor, defenseScore, crewConflict, crewFeudWarning,
  buildingOutputFactor, workFactorFor, isMourning, legacyBoonsOf, LEGACY_BOONS
} from "../model/settlement.js";
import { keeperAct } from "./want.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../model/settlement.js").Building} Building
 */

/* ------------------------------------------------------------------ *
 * Activation: engine defaults keep the camp dormant; the game mode
 * founds it. Founding an already-live camp is a no-op with a sentence.
 * ------------------------------------------------------------------ */

/**
 * Turn the settlement layer on for this world, applying any legacy boons
 * a previous, collapsed run left behind.
 * @param {World} world
 * @param {{boons?: string[]}} [opts]
 * @returns {{ok: boolean, reason?: string, applied?: string[]}}
 */
export function activateSettlement(world, opts = {}) {
  if (!world.settlement) return { ok: false, reason: "This world has no camp to found." };
  const cfg = world.config.settlement;
  const applied = [];
  world.config.settlement = { ...cfg, enabled: true };
  for (const boon of opts.boons || []) {
    if (!(boon in LEGACY_BOONS)) continue;
    if (world.settlement.appliedBoons.includes(boon)) continue;
    world.settlement.appliedBoons.push(boon);
    applied.push(boon);
    if (boon === "seasoned_stores") { world.settlement.stores.food += 20; world.settlement.stores.materials += 6; }
    if (boon === "remembered_names") world.settlement.hold = clamp(world.settlement.hold + 12, 0, 100);
    if (boon === "town_charter") world.settlement.stores.materials += 18;
    // wall_craft needs no number here: the defence reader honours it.
  }
  if (applied.length) {
    logEvent(world, {
      kind: "settlement",
      agentId: null,
      text: `The new camp begins carrying what the last one left: ${applied.map(b => LEGACY_BOONS[b].name.toLowerCase()).join(", ")}.`,
      significance: 0.6
    });
  }
  return { ok: true, applied };
}

/**
 * A one-line reading of the camp for screens, digests and tests.
 * @param {World} world
 */
export function settlementSummary(world) {
  const s = world.settlement;
  const pop = livingAgents(world).length;
  const forecast = world.config.settlement.enabled
    ? {
        nextStormDay: s.storm.nextStormDay,
        daysUntil: Math.max(0, s.storm.nextStormDay - world.clock.day),
        strength: stormStrengthFor(world.config, s.storm.index)
      }
    : null;
  return {
    enabled: settlementEnabled(world),
    active: settlementActive(world),
    status: s.status,
    level: s.level,
    levelIndex: s.levelIndex,
    hold: Math.round(s.hold * 10) / 10,
    food: Math.round(s.stores.food * 10) / 10,
    materials: Math.round(s.stores.materials * 10) / 10,
    foodDays: pop ? Math.round((s.stores.food / (pop * world.config.settlement.foodPerMindPerDay)) * 10) / 10 : 0,
    population: pop,
    wall: { ...s.wall },
    defense: defenseScore(world),
    forecast,
    buildings: s.buildings.map(b => ({
      id: b.id, kind: b.kind, name: b.name, regionId: b.regionId,
      status: b.status, condition: Math.round(b.condition),
      progress: Math.round(b.progress), workNeeded: b.workNeeded,
      crew: [...b.crew]
    })),
    lastDaily: s.lastDaily,
    legacy: s.legacy,
    collapseCause: s.collapseCause
  };
}

/* ------------------------------------------------------------------ *
 * The daily ledger: production, consumption, the Hold.
 * ------------------------------------------------------------------ */

/**
 * Run once per tick. Only the day boundary costs anything: the ledger
 * settles the day that just ended in one deterministic pass.
 * @param {World} world
 */
export function settleSettlement(world) {
  if (!settlementActive(world)) return;
  pruneCrews(world);
  const day = world.clock.day;
  if (day <= world.settlement.lastDay) return;
  // A long catch-up can skip days; settle each one so food, storms and
  // the Hold never silently skip a day the minds lived through.
  while (world.settlement.lastDay < day && world.settlement.status === "active") {
    world.settlement.lastDay += 1;
    settleOneDay(world, world.settlement.lastDay);
  }
}

/**
 * One day of the camp: staffed buildings produce, every mind eats, the
 * Hold is fed by how the day actually went, and storm season arrives
 * on its forecast day whether the keeper is watching or not.
 * @param {World} world
 * @param {number} day  The day that has just begun (the ledger closes the one before).
 */
function settleOneDay(world, day) {
  const cfg = world.config.settlement;
  const s = world.settlement;
  const living = livingAgents(world);
  const pop = living.length;

  /* ---- production from staffed buildings ---- */
  let foodProduced = 0;
  let materialsProduced = 0;
  /** @type {string[]} */
  const exposedKinds = [];
  let mourningHands = 0;
  for (const building of s.buildings) {
    const def = buildingDef(world.config, building.kind);
    if (!def?.produces) continue;
    if (building.status !== "active" && building.status !== "damaged") continue;
    const hands = building.crew.filter(id => {
      const a = agentById(world, id);
      return a && !a.retired;
    }).length;
    if (!hands) continue;
    const { factor, exposed, mourningHands: mourning } = buildingOutputFactor(world, building);
    mourningHands += mourning;
    if (exposed) exposedKinds.push(building.kind);
    const made = Math.round(hands * def.perHandPerDay * factor * 10) / 10;
    if (def.produces === "food") { foodProduced += made; s.stores.food += made; }
    if (def.produces === "materials") { materialsProduced += made; s.stores.materials += made; }
  }

  /* ---- consumption: every mind eats, or nobody pretends they did ---- */
  const foodConsumed = pop * cfg.foodPerMindPerDay;
  const fed = s.stores.food >= foodConsumed;
  if (fed) {
    s.stores.food = Math.round((s.stores.food - foodConsumed) * 10) / 10;
    s.starvingDays = 0;
  } else {
    s.stores.food = 0;
    s.starvingDays += 1;
    for (const agent of living) {
      agent.needs.energy = clamp(agent.needs.energy - cfg.starveEnergyPerDay, 0, 100);
    }
  }

  /* ---- the Hold, fed by the day that actually happened ---- */
  let holdDelta = 0;
  if (fed) holdDelta += cfg.holdFedPerDay; else holdDelta += cfg.holdStarvingPerDay;
  if (fed && pop && s.stores.food / (pop * cfg.foodPerMindPerDay) < 1) holdDelta += cfg.holdLowFoodPerDay;
  const morale = pop ? living.reduce((sum, a) => sum + (a.moodLevel ?? 50), 0) / pop : 50;
  holdDelta += (morale - 50) * cfg.holdMoraleFactor;
  let vendettas = 0;
  const seen = new Set();
  for (const agent of living) {
    for (const [otherId, edge] of Object.entries(agent.relations)) {
      const key = agent.id < otherId ? agent.id + "|" + otherId : otherId + "|" + agent.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const back = agentById(world, otherId)?.relations[agent.id];
      const heat = Math.max(edge.resentment ?? 0, back?.resentment ?? 0);
      if (heat >= world.config.vendetta.vendettaAt) vendettas += 1;
    }
  }
  holdDelta += vendettas * cfg.holdPerVendettaPerDay;
  s.hold = clamp(s.hold + holdDelta, 0, 100);

  s.lastDaily = {
    day: day - 1,
    foodProduced: Math.round(foodProduced * 10) / 10,
    materialsProduced: Math.round(materialsProduced * 10) / 10,
    foodConsumed,
    population: pop,
    fed,
    holdDelta: Math.round(holdDelta * 10) / 10,
    exposedKinds,
    mourningHands
  };
  s.stats.daysSurvived += 1;
  s.stats.peakPopulation = Math.max(s.stats.peakPopulation, pop);

  /* ---- the camp becoming a place: Camp -> Hamlet -> Town ---- */
  const level = settlementLevelFor(world);
  if (level.index > s.levelIndex) {
    s.level = level.name;
    s.levelIndex = level.index;
    s.stats.peakLevelIndex = Math.max(s.stats.peakLevelIndex, level.index);
    logEvent(world, {
      kind: "settlement",
      agentId: null,
      text: `The camp is a camp no longer: with ${s.buildings.filter(b => b.status === "active").length} buildings standing and the wall at level ${s.wall.level}, the world starts calling it a ${level.name.toLowerCase()}.`,
      significance: 0.8
    });
  } else {
    s.level = level.name;
    s.levelIndex = level.index;
  }

  if (!fed || exposedKinds.length) {
    logEvent(world, {
      kind: "settlement",
      agentId: null,
      text: !fed
        ? `The stores ran dry on day ${day - 1}: ${pop} minds went hungry, and the camp felt it.`
        : `What everybody now knows hung over ${exposedKinds.join(" and ")} all day, and the work showed it.`,
      significance: !fed ? 0.72 : 0.55
    });
  }
}

/**
 * Crew lists only ever hold living, present minds. Retired hands come
 * off the roster the tick they leave; feud splits join this in the
 * social wiring.
 * @param {World} world
 */
function pruneCrews(world) {
  for (const building of world.settlement.buildings) {
    if (!building.crew.length) continue;
    building.crew = building.crew.filter(id => {
      const a = agentById(world, id);
      return a && !a.retired;
    });
  }
}
