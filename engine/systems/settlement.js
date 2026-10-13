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
import { arrive } from "./turnover.js";
import { mournDeparture } from "./mourning.js";

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
  const hall = buildingByKind(s, "hall");
  if (hall && hall.status === "active" && hall.crew.length) holdDelta += cfg.holdHallStaffedPerDay;
  const memorial = buildingByKind(s, "memorial");
  if (memorial && (memorial.status === "active" || memorial.status === "damaged")) holdDelta += cfg.holdMemorialPerDay;
  const holdBefore = s.hold;
  s.hold = clamp(s.hold + holdDelta, 0, 100);
  if (s.hold <= 0) s.lowHoldDays += 1; else s.lowHoldDays = 0;
  if (holdBefore > 25 && s.hold <= 25) {
    logEvent(world, {
      kind: "settlement",
      agentId: null,
      text: `The Hold is failing: at ${Math.round(s.hold)} the camp is a few bad days from scattering. Food, shelter, or the keeper's hand — something has to give.`,
      significance: 0.78
    });
  }
  settlePopulation(world, pop);

  // Storm season keeps its forecast appointment at the close of the day:
  // the ledger above is the day the camp had, this is the night it gets.
  if (day - 1 >= s.storm.nextStormDay) resolveStorm(world);

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

/* ------------------------------------------------------------------ *
 * Buildings: construction and repair are work over time, never instant,
 * and staffing is a decision with rules the keeper can read.
 * ------------------------------------------------------------------ */

/**
 * What could be built next, and why not — the construction menu.
 * @param {World} world
 */
export function constructionOptions(world) {
  if (!settlementEnabled(world)) return [];
  return world.settlement.buildings.map(building => {
    const def = buildingDef(world.config, building.kind);
    const check = canConstruct(world, building.kind);
    return {
      kind: building.kind, name: building.name, regionId: building.regionId,
      cost: def?.cost ?? 0, workNeeded: def?.workNeeded ?? 0,
      status: building.status, can: check.ok, reason: check.ok ? "" : check.reason
    };
  });
}

/**
 * Validate starting (or restarting) construction of a kind.
 * @param {World} world
 * @param {string} kind
 * @returns {{ok: boolean, reason?: string, building?: Building}}
 */
export function canConstruct(world, kind) {
  if (!settlementActive(world)) return { ok: false, reason: "There is no live camp to build in." };
  const def = buildingDef(world.config, kind);
  const building = buildingByKind(world.settlement, kind);
  if (!def || !building) return { ok: false, reason: "There is no such building to raise." };
  if (building.status === "building") return { ok: false, reason: `${building.name} is already rising.` };
  if (building.status === "active") return { ok: false, reason: `${building.name} already stands.` };
  if (building.status === "damaged") return { ok: false, reason: `${building.name} needs repair, not rebuilding.` };
  if (kind === "memorial" && !(world.mourning?.memorials?.length || world.mourning?.funerals?.length)) {
    return { ok: false, reason: "A memorial needs somebody to remember. The camp has lost no one yet." };
  }
  if (world.settlement.stores.materials < def.cost) {
    return { ok: false, reason: `That takes ${def.cost} materials and the camp has ${Math.floor(world.settlement.stores.materials)}.` };
  }
  return { ok: true, building };
}

/**
 * Begin construction: materials leave the store now, the building rises
 * only as fast as hands work on it.
 * @param {World} world
 * @param {string} kind
 */
export function startConstruction(world, kind) {
  const check = canConstruct(world, kind);
  if (!check.ok || !check.building) return { ok: false, reason: check.reason };
  const def = buildingDef(world.config, kind);
  const building = check.building;
  world.settlement.stores.materials -= def?.cost ?? 0;
  building.status = "building";
  building.progress = 0;
  building.builtTick = world.clock.tick;
  logEvent(world, {
    kind: "building",
    agentId: null,
    text: `Work begins on ${building.name}. The materials are counted out; the rest is hands and days.`,
    significance: 0.58,
    regionId: building.regionId
  });
  return { ok: true, building };
}

/**
 * Why this mind cannot staff this building, in one sentence — or null
 * when they can. The feud rule is read from the pair's real stage.
 * @param {World} world
 * @param {Building} building
 * @param {string} agentId
 * @returns {string|null}
 */
export function staffingBlock(world, building, agentId) {
  const agent = agentById(world, agentId);
  if (!agent || agent.retired) return "That mind is gone.";
  if (building.status !== "active" && building.status !== "damaged") return `${building.name} is not standing yet.`;
  if (building.crew.includes(agentId)) return null;
  const def = buildingDef(world.config, building.kind);
  if (def && building.crew.length >= def.maxCrew) return `${building.name} has all the hands it can hold.`;
  const conflict = crewConflict(world, building, agentId);
  if (conflict) {
    const other = agentById(world, conflict.otherId);
    return `${agent.name} and ${other?.name || "a hand already there"} are in a ${conflict.stage} — they cannot staff the same building. Rearrange the crew first.`;
  }
  return null;
}

/**
 * Put a mind on a building's crew (the keeper rearranging who works
 * where). A mind staffs one building at a time: assignment moves them.
 * @param {World} world
 * @param {string} buildingId
 * @param {string} agentId
 */
export function assignCrew(world, buildingId, agentId) {
  if (!settlementActive(world)) return { ok: false, reason: "There is no live camp to staff." };
  const building = buildingId === "wall" ? null : buildingById(world.settlement, buildingId);
  if (!building) return { ok: false, reason: "There is no such building." };
  const block = staffingBlock(world, building, agentId);
  if (block) return { ok: false, reason: block };
  for (const other of world.settlement.buildings) {
    other.crew = other.crew.filter(id => id !== agentId);
  }
  building.crew.push(agentId);
  return { ok: true, building };
}

/**
 * Take a mind off a building's crew.
 * @param {World} world
 * @param {string} buildingId
 * @param {string} agentId
 */
export function unassignCrew(world, buildingId, agentId) {
  const building = buildingById(world.settlement, buildingId);
  if (!building) return { ok: false, reason: "There is no such building." };
  building.crew = building.crew.filter(id => id !== agentId);
  return { ok: true, building };
}

/**
 * Apply one settlement work act (called by the effects interpreter).
 * Modes: `work` staffs and works a standing building, `build` raises
 * one under construction, `repair` restores a damaged one (or, with
 * buildingId "wall", the North Wall's condition). Social factors —
 * above all a mourning pair of hands — bend how far the work goes.
 * @param {World} world
 * @param {{agent: string, buildingId: string, mode: string, amount?: number}} op
 * @returns {import("../model/events.js").WorldEvent|null}
 */
export function applySettlementWork(world, op) {
  if (!settlementActive(world)) return null;
  const agent = agentById(world, op.agent);
  if (!agent || agent.retired) return null;
  const tick = world.clock.tick;
  const amount = Math.max(1, (Number(op.amount) || world.config.settlement.buildWorkBase) * workFactorFor(world, agent));

  if (op.buildingId === "wall") {
    if (op.mode !== "repair") return null;
    const wall = world.settlement.wall;
    wall.condition = clamp(wall.condition + amount, 0, 100);
    return null;
  }

  const building = buildingById(world.settlement, op.buildingId);
  if (!building) return null;
  const record = building.contributors[agent.id] || (building.contributors[agent.id] = { work: 0, lastTick: tick });
  record.work += Math.round(amount * 10) / 10;
  record.lastTick = tick;

  if (op.mode === "work") {
    if (!building.crew.includes(agent.id) && !staffingBlock(world, building, agent.id)) {
      for (const other of world.settlement.buildings) other.crew = other.crew.filter(id => id !== agent.id);
      building.crew.push(agent.id);
    }
    return null;
  }

  if (op.mode === "build") {
    if (building.status !== "building") return null;
    building.progress += amount;
    if (building.progress >= building.workNeeded) return completeBuilding(world, building);
    return null;
  }

  if (op.mode === "repair") {
    if (building.status !== "damaged") return null;
    const def = buildingDef(world.config, building.kind);
    if (!building.repairPaid) {
      const cost = Math.ceil((def?.cost ?? 0) / 2);
      if (world.settlement.stores.materials < cost) return null;
      world.settlement.stores.materials -= cost;
      building.repairPaid = true;
      building.progress = 0;
    }
    building.progress += amount;
    if (building.progress >= Math.ceil(building.workNeeded / 2)) {
      building.status = "active";
      building.condition = 100;
      building.progress = 0;
      building.repairPaid = true;
      return logEvent(world, {
        kind: "building",
        agentId: agent.id,
        text: `${building.name} stands whole again — the repair crews saw to it.`,
        significance: 0.62,
        regionId: building.regionId
      });
    }
    return null;
  }
  return null;
}

/**
 * A building finishes rising. If it is the Memorial, the hands that
 * raised it together are bound closer — real edges, real memories.
 * @param {World} world
 * @param {Building} building
 */
function completeBuilding(world, building) {
  const tick = world.clock.tick;
  building.status = "active";
  building.condition = 100;
  building.progress = 0;
  building.completedTick = tick;
  if (!world.settlement.stats.buildingsBuilt.includes(building.kind)) {
    world.settlement.stats.buildingsBuilt.push(building.kind);
  }
  const builders = /** @type {Agent[]} */ (Object.entries(building.contributors)
    .filter(([, r]) => r.work > 0)
    .map(([id]) => agentById(world, id))
    .filter(a => a !== null && !a.retired));

  if (building.kind === "memorial" && builders.length > 1) {
    const cfg = world.config.settlement;
    for (let i = 0; i < builders.length; i++) {
      for (let j = i + 1; j < builders.length; j++) {
        const a = builders[i], b = builders[j];
        adjustEdge(a, b.id, { affinity: cfg.memorialBondAffinity, trust: cfg.memorialBondTrust, familiarity: 6 }, tick);
        adjustEdge(b, a.id, { affinity: cfg.memorialBondAffinity, trust: cfg.memorialBondTrust, familiarity: 6 }, tick);
        remember(a.memory, {
          tick, kind: "goal", subjectId: b.id, valence: 0.7, salience: 0.85,
          text: `We raised the Memorial together, ${b.name} and I. Some work you do side by side stays in the hands.`
        }, world.nextId);
        remember(b.memory, {
          tick, kind: "goal", subjectId: a.id, valence: 0.7, salience: 0.85,
          text: `We raised the Memorial together, ${a.name} and I. Some work you do side by side stays in the hands.`
        }, world.nextId);
      }
    }
  }

  return logEvent(world, {
    kind: "building",
    agentId: builders[0]?.id ?? null,
    text: building.kind === "memorial"
      ? `The Memorial stands${builders.length > 1 ? `, raised together by ${builders.map(a => a.name).join(", ")}` : ""}. What the camp has lost has a place now.`
      : `${building.name} stands finished${builders.length ? ` — ${builders.map(a => a.name).join(", ")} raised it` : ""}.`,
    significance: 0.8,
    regionId: building.regionId
  });
}

/* ------------------------------------------------------------------ *
 * Storm season: on a forecast clock, answered by the wall and shelter.
 * ------------------------------------------------------------------ */

/**
 * Resolve the storm that is due, right now. Deterministic: strength is
 * calendar arithmetic (see stormStrengthFor), defence is the wall's
 * level and condition plus shelter, and the margin between them is the
 * whole outcome — damage and shelter margin are the same number read
 * two ways. Exported so tests and the keeper's forecast can meet the
 * exact storm the camp will meet.
 * @param {World} world
 * @returns {{strength: number, defense: number, margin: number, outcome: string}|null}
 */
export function resolveStorm(world) {
  if (!settlementActive(world)) return null;
  const cfg = world.config.settlement;
  const s = world.settlement;
  const strength = stormStrengthFor(world.config, s.storm.index);
  const defense = defenseScore(world);
  const margin = Math.round((defense - strength) * 10) / 10;
  const outcome = margin >= cfg.stormHeldMargin ? "held" : margin >= -cfg.stormHeldMargin ? "weathered" : "breached";

  if (outcome !== "held") {
    const shortfall = Math.max(0, -margin);
    const buildingDamage = outcome === "weathered" && margin >= 0 ? 3 : shortfall * cfg.stormDamagePerShortfall;
    const wallDamage = (outcome === "weathered" && margin >= 0 ? 2 : shortfall * cfg.stormWallDamagePerShortfall)
      + (outcome === "breached" ? 5 : 0);
    s.wall.condition = clamp(s.wall.condition - wallDamage, 0, 100);
    for (const building of s.buildings) {
      if (building.status === "building" && outcome === "breached") {
        building.progress = Math.round(building.progress * 0.7);
        continue;
      }
      if (building.status !== "active" && building.status !== "damaged") continue;
      building.condition = clamp(building.condition - buildingDamage, 0, 100);
      if (building.condition < 60 && building.status === "active") {
        building.status = "damaged";
        building.progress = 0;
        building.repairPaid = false;
      }
    }
    if (outcome === "breached") {
      s.stores.food = Math.round(s.stores.food * (1 - cfg.stormFoodLossShare) * 10) / 10;
    }
  }

  const holdDelta = outcome === "held" ? cfg.holdStormHeld : outcome === "weathered" ? cfg.holdStormWeathered : cfg.holdStormBreached;
  s.hold = clamp(s.hold + holdDelta, 0, 100);
  s.storm.lastStormDay = world.clock.day;
  s.storm.lastMargin = margin;
  s.storm.lastOutcome = outcome;
  s.storm.stormsHit += 1;
  s.storm.index += 1;
  s.storm.nextStormDay += cfg.stormIntervalDays;
  if (outcome !== "breached") s.stats.stormsWeathered += 1;

  logEvent(world, {
    kind: "storm",
    agentId: null,
    text: outcome === "held"
      ? `The storm came on day ${world.clock.day} at strength ${strength}, and the camp answered it with ${Math.round(defense)} — the wall held, and everybody heard it hold.`
      : outcome === "weathered"
        ? `The storm came on day ${world.clock.day} at strength ${strength} against the camp's ${Math.round(defense)}. It weathered the night, and woke to repairs.`
        : `The storm came on day ${world.clock.day} at strength ${strength}, and the camp's ${Math.round(defense)} was not enough. It breached — stores spoiled, roofs torn, the wall worried raw.`,
    significance: outcome === "breached" ? 0.92 : 0.82
  });
  return { strength, defense, margin, outcome };
}

/**
 * Population bounds for the base game, settled daily and without drama:
 * a fed, holding camp under its cap may gain a wanderer (through the
 * turnover system's own arrival, protected cast untouched), and a
 * starving or broken camp loses its most adrift unprotected mind —
 * who is written into the mourning record like any departure.
 * @param {World} world
 * @param {number} pop  Population at the start of the ledger.
 */
function settlePopulation(world, pop) {
  const cfg = world.config.settlement;
  const s = world.settlement;
  if (pop < cfg.maxPopulation && s.starvingDays === 0 && s.hold >= 55
      && s.lastDay % cfg.arrivalIntervalDays === 0
      && pop < world.config.turnover.maxCast) {
    arrive(world);
    return;
  }
  if (pop > cfg.minPopulation && (s.starvingDays >= 2 || s.hold < cfg.departureHoldBelow)) {
    const candidates = livingAgents(world)
      .filter(a => !a.seedCast && !a.userCreated)
      .sort((a, b) => (b.adriftTicks ?? 0) - (a.adriftTicks ?? 0) || (a.id < b.id ? -1 : 1));
    const leaving = candidates[0];
    if (leaving) {
      leaving.retired = true;
      leaving.departureKind = "left";
      logEvent(world, {
        kind: "departure",
        agentId: leaving.id,
        text: `${leaving.name} left the camp in the night. A place that cannot feed or hold its people does not get to keep them.`,
        significance: 0.66,
        regionId: leaving.regionId
      });
      mournDeparture(world, leaving);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Keeper acts for the camp: the influence sinks. They follow the
 * divine pattern exactly — validate with a sentence, spend, apply,
 * record — and they spend from the same purse as blessings and omens,
 * which is the tradeoff at the heart of the base game: an emergency
 * answered is a blessing not given.
 * ------------------------------------------------------------------ */

/** What each camp act is, in the keeper's own words. */
export const SETTLEMENT_ACT_INFO = /** @type {Record<string, {name: string, verb: string, blurb: string, color: string}>} */ ({
  relief: {
    name: "Emergency relief", verb: "send relief",
    blurb: "Stores appear where the camp needs them: food for the stores, and a little of the camp's will back with it.",
    color: "#a7c796"
  },
  repair: {
    name: "Emergency repair", verb: "raise emergency hands",
    blurb: "Every sound pair of hands turns to the most broken thing — a building, or the wall itself — until it is whole or nearly.",
    color: "#f3d9a4"
  },
  rally: {
    name: "Rally the camp", verb: "rally the camp",
    blurb: "You are seen to stand with them, and the Hold answers: the camp remembers it is one camp.",
    color: "#c4aaf0"
  }
});

/** @param {import("../config.js").WorldConfig["settlement"]} cfg @param {string} kind */
function actCost(cfg, kind) {
  if (kind === "relief") return cfg.reliefCost;
  if (kind === "repair") return cfg.repairCost;
  return cfg.rallyCost;
}
/** @param {import("../config.js").WorldConfig["settlement"]} cfg @param {string} kind */
function actCooldown(cfg, kind) {
  if (kind === "relief") return cfg.reliefCooldownTicks;
  if (kind === "repair") return cfg.repairCooldownTicks;
  return cfg.rallyCooldownTicks;
}

/**
 * The most broken repairable thing: a damaged building, or the wall.
 * @param {World} world
 * @param {{buildingId?: string|null}|null|undefined} target
 * @returns {{buildingId: string, name: string, condition: number}|null}
 */
function repairTarget(world, target) {
  const s = world.settlement;
  if (target?.buildingId) {
    if (target.buildingId === "wall") {
      return s.wall.condition < 100 ? { buildingId: "wall", name: "the North Wall", condition: s.wall.condition } : null;
    }
    const b = buildingById(s, target.buildingId);
    return b && b.status === "damaged" ? { buildingId: b.id, name: b.name, condition: b.condition } : null;
  }
  /** @type {{buildingId: string, name: string, condition: number}[]} */
  const candidates = s.buildings
    .filter(b => b.status === "damaged")
    .map(b => ({ buildingId: b.id, name: b.name, condition: b.condition }));
  if (s.wall.condition < 100) candidates.push({ buildingId: "wall", name: "the North Wall", condition: s.wall.condition });
  candidates.sort((a, b) => a.condition - b.condition);
  return candidates[0] || null;
}

/**
 * The camp acts with live prices, for the keeper's hand panel.
 * @param {World} world
 */
export function settlementActOptions(world) {
  const cfg = world.config.settlement;
  return Object.keys(SETTLEMENT_ACT_INFO).map(kind => {
    const info = SETTLEMENT_ACT_INFO[kind];
    const check = canPerformSettlementAct(world, kind);
    return {
      kind, name: info.name, verb: info.verb, blurb: info.blurb, color: info.color,
      cost: actCost(cfg, kind), enabled: check.ok, reason: check.ok ? "" : (check.reason || "")
    };
  });
}

/**
 * Could the keeper do this, right now? Every refusal is a sentence.
 * @param {World} world
 * @param {string} kind
 * @param {{buildingId?: string|null}|null} [target]
 */
export function canPerformSettlementAct(world, kind, target) {
  const cfg = world.config.settlement;
  if (!SETTLEMENT_ACT_INFO[kind]) return { ok: false, reason: "There is no such camp act.", cost: 0 };
  const cost = actCost(cfg, kind);
  if (!settlementEnabled(world)) return { ok: false, reason: "This world has no camp to act for.", cost };
  if (world.settlement.status === "collapsed") return { ok: false, reason: "The camp has scattered. There is nothing left to spend on.", cost };
  const tick = world.clock.tick;
  const last = world.settlement.actLastTick[kind];
  const cooldown = actCooldown(cfg, kind);
  if (last !== undefined && tick - last < cooldown) {
    const wait = cooldown - (tick - last);
    return { ok: false, reason: `${wait} more tick${wait === 1 ? "" : "s"} before you can do that again.`, cost };
  }
  if (kind === "repair" && !repairTarget(world, target)) {
    return { ok: false, reason: "Nothing is broken enough to need emergency hands.", cost };
  }
  if ((world.charter?.influence ?? 0) < cost) {
    return { ok: false, reason: `That costs ${cost} influence and you have ${Math.round(world.charter?.influence ?? 0)}.`, cost };
  }
  return { ok: true, cost };
}

/**
 * Do it: influence spent, camp changed, meters moved, record written.
 * @param {World} world
 * @param {string} kind
 * @param {{buildingId?: string|null}|null} [target]
 * @returns {{ok: boolean, reason?: string, kind?: string, cost?: number, effect?: string}}
 */
export function performSettlementAct(world, kind, target) {
  const check = canPerformSettlementAct(world, kind, target);
  if (!check.ok) return { ok: false, reason: check.reason };
  const cfg = world.config.settlement;
  const s = world.settlement;
  const tick = world.clock.tick;
  moveInfluence(world.charter, -check.cost);
  s.actLastTick[kind] = tick;

  let cause = "";
  let effect = "";
  let text = "";
  if (kind === "relief") {
    s.stores.food += cfg.reliefFood;
    s.hold = clamp(s.hold + cfg.reliefHold, 0, 100);
    cause = "you sent relief to the camp's stores";
    effect = `the stores gain ${cfg.reliefFood} food and the Hold steadies.`;
    text = `Relief reached the camp's stores from nowhere anybody could name, and dinner stopped being an argument.`;
  } else if (kind === "repair") {
    const resolved = repairTarget(world, target);
    const name = resolved?.name || "the broken work";
    if (resolved?.buildingId === "wall") {
      s.wall.condition = clamp(s.wall.condition + cfg.repairCondition, 0, 100);
    } else if (resolved) {
      const building = buildingById(s, resolved.buildingId);
      if (building) {
        building.condition = clamp(building.condition + cfg.repairCondition, 0, 100);
        if (building.condition >= 100) { building.status = "active"; building.progress = 0; building.repairPaid = true; }
      }
    }
    cause = `you raised emergency hands for ${name}`;
    effect = `${name} is ${cfg.repairCondition} condition closer to whole.`;
    text = `Every sound pair of hands in the camp turned to ${name} at once, as if somebody had finally said the obvious thing out loud.`;
  } else {
    s.hold = clamp(s.hold + cfg.rallyHold, 0, 100);
    for (const agent of livingAgents(world)) {
      agent.moodLevel = clamp((agent.moodLevel ?? 50) + 4, 0, 100);
    }
    cause = "you rallied the camp";
    effect = `the Hold rises by ${cfg.rallyHold}.`;
    text = `The keeper stood with the camp, and the camp stood a little straighter for being stood with.`;
  }

  keeperAct(world, cause, cfg.actWant[/** @type {"relief"|"repair"|"rally"} */ (kind)] || {});
  logEvent(world, {
    kind: "settlement",
    agentId: null,
    text,
    significance: 0.7
  });
  return { ok: true, kind, cost: check.cost, effect };
}
