/**
 * The settlement: the camp the minds live in, as durable world state.
 *
 * Phase F turns the living world into a base game without touching what
 * the world already is. This module is only the shape of that layer plus
 * readers over it — stores, buildings and their crews, the North Wall as
 * a levelled defence, the storm forecast, the Hold, and the legacy a
 * collapsed camp leaves behind. Nothing here decides anything, draws
 * from the RNG, or writes to the world; the behaviour lives in
 * `systems/settlement.js`.
 *
 * The layer is dormant unless `config.settlement.enabled` is set by the
 * game mode. A dormant settlement is inert state: it produces nothing,
 * consumes nothing and changes no decision, so a pure simulation world
 * replays exactly as it did before the layer existed.
 */

import { clamp } from "../config.js";
import { feudStage } from "./relationships.js";

/**
 * @typedef {object} Building
 * @property {string} id
 * @property {string} kind        fields | workshop | hall | memorial
 * @property {string} name
 * @property {string} regionId
 * @property {"planned"|"building"|"active"|"damaged"} status
 * @property {number} progress    Work put into construction/repair, 0..workNeeded.
 * @property {number} workNeeded
 * @property {number} condition   0..100. Storms take this; repair restores it.
 * @property {string[]} crew      Agent ids currently staffing this building.
 * @property {Record<string, {work: number, lastTick: number}>} contributors
 * @property {number|null} builtTick
 * @property {number|null} completedTick
 * @property {boolean} repairPaid Whether the material cost of the current repair was paid.
 */

/**
 * @typedef {object} SettlementLegacy
 * @property {string} cause
 * @property {number} tick
 * @property {number} day
 * @property {number} daysSurvived
 * @property {string} peakLevel
 * @property {number} peakPopulation
 * @property {number} wallLevel
 * @property {number} stormsWeathered
 * @property {string[]} buildingsBuilt
 * @property {string[]} boons     Legacy boon ids carried into the next run.
 * @property {string} summary     The ending, in one paragraph.
 */

/**
 * @typedef {object} Settlement
 * @property {{food: number, materials: number}} stores
 * @property {Building[]} buildings
 * @property {{level: number, condition: number, reinforcements: number}} wall
 * @property {number} hold        0..100. The camp's will to stay together.
 * @property {string} level       Camp | Hamlet | Town
 * @property {number} levelIndex  0 | 1 | 2
 * @property {"active"|"collapsed"} status
 * @property {string|null} collapseCause
 * @property {number|null} collapsedTick
 * @property {SettlementLegacy|null} legacy
 * @property {{index: number, nextStormDay: number, stormsHit: number, lastStormDay: number, lastMargin: number|null, lastOutcome: string|null}} storm
 * @property {number} lastDay     World day the daily ledger last settled.
 * @property {number} starvingDays
 * @property {number} lowHoldDays
 * @property {Record<string, number>} actLastTick  Keeper settlement acts, for cooldowns.
 * @property {{daysSurvived: number, peakPopulation: number, peakLevelIndex: number, stormsWeathered: number, buildingsBuilt: string[]}} stats
 * @property {{day: number, foodProduced: number, materialsProduced: number, foodConsumed: number, population: number, fed: boolean, holdDelta: number, exposedKinds: string[], mourningHands: number}|null} lastDaily
 * @property {number} crewSplitTick  Tick a feud last split a crew (-1 = never).
 * @property {string[]} appliedBoons  Legacy boons this run started with.
 */

/** Settlement levels, lowest first. */
export const SETTLEMENT_LEVELS = ["Camp", "Hamlet", "Town"];

/** Legacy boons a collapsed camp can leave for the next run. */
export const LEGACY_BOONS = /** @type {Record<string, {name: string, gloss: string}>} */ ({
  seasoned_stores: { name: "Seasoned stores", gloss: "The next camp starts with fuller stores." },
  wall_craft: { name: "Wall-craft", gloss: "The next camp's wall starts a level stronger in craft: it answers storms harder." },
  remembered_names: { name: "Remembered names", gloss: "The next camp starts holding together more surely." },
  town_charter: { name: "A town's charter", gloss: "The next camp starts with the materials to build sooner." }
});

/**
 * @param {import("../config.js").WorldConfig} config
 * @returns {Settlement}
 */
export function createSettlement(config) {
  const cfg = config.settlement;
  return {
    stores: { food: cfg.startingFood, materials: cfg.startingMaterials },
    buildings: cfg.buildings.map(def => ({
      id: `b-${def.kind}`,
      kind: def.kind,
      name: def.name,
      regionId: def.regionId,
      status: def.startBuilt ? "active" : "planned",
      progress: 0,
      workNeeded: def.workNeeded,
      condition: def.startBuilt ? 80 : 100,
      crew: [],
      contributors: {},
      builtTick: def.startBuilt ? 0 : null,
      completedTick: def.startBuilt ? 0 : null,
      repairPaid: true
    })),
    wall: { level: 0, condition: 100, reinforcements: 0 },
    hold: cfg.startingHold,
    level: "Camp",
    levelIndex: 0,
    status: "active",
    collapseCause: null,
    collapsedTick: null,
    legacy: null,
    storm: {
      index: 0,
      nextStormDay: cfg.stormFirstDay,
      stormsHit: 0,
      lastStormDay: 0,
      lastMargin: null,
      lastOutcome: null
    },
    lastDay: 1,
    starvingDays: 0,
    lowHoldDays: 0,
    actLastTick: {},
    stats: { daysSurvived: 0, peakPopulation: 0, peakLevelIndex: 0, stormsWeathered: 0, buildingsBuilt: [] },
    lastDaily: null,
    crewSplitTick: -1,
    appliedBoons: []
  };
}

/**
 * Coerce whatever came out of a save into a usable settlement. A world
 * saved before the camp existed gets a fresh, dormant one — no stores
 * are invented out of a history that never tracked them beyond the
 * configured starting amounts, and no tick is rewound.
 * @param {unknown} raw
 * @param {import("../config.js").WorldConfig} config
 * @returns {Settlement}
 */
export function normalizeSettlement(raw, config) {
  const base = createSettlement(config);
  const s = /** @type {any} */ (raw);
  if (!s || typeof s !== "object") return base;
  const num = (/** @type {unknown} */ v, /** @type {number} */ fallback) =>
    (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const byKind = new Map((Array.isArray(s.buildings) ? s.buildings : [])
    .filter((/** @type {any} */ b) => b && typeof b === "object")
    .map((/** @type {any} */ b) => [b.kind, b]));
  const buildings = base.buildings.map(fresh => {
    const saved = byKind.get(fresh.kind);
    if (!saved) return fresh;
    return {
      ...fresh,
      status: ["planned", "building", "active", "damaged"].includes(saved.status) ? saved.status : fresh.status,
      progress: num(saved.progress, fresh.progress),
      condition: clamp(num(saved.condition, fresh.condition), 0, 100),
      crew: Array.isArray(saved.crew) ? saved.crew.filter((/** @type {unknown} */ id) => typeof id === "string") : [],
      contributors: saved.contributors && typeof saved.contributors === "object" ? saved.contributors : {},
      builtTick: num(saved.builtTick, fresh.builtTick ?? 0) || null,
      completedTick: num(saved.completedTick, fresh.completedTick ?? 0) || null,
      repairPaid: saved.repairPaid !== false
    };
  });
  return {
    stores: {
      food: Math.max(0, num(s.stores?.food, base.stores.food)),
      materials: Math.max(0, num(s.stores?.materials, base.stores.materials))
    },
    buildings,
    wall: {
      level: Math.max(0, Math.floor(num(s.wall?.level, 0))),
      condition: clamp(num(s.wall?.condition, 100), 0, 100),
      reinforcements: Math.max(0, Math.floor(num(s.wall?.reinforcements, 0)))
    },
    hold: clamp(num(s.hold, base.hold), 0, 100),
    level: SETTLEMENT_LEVELS.includes(s.level) ? s.level : "Camp",
    levelIndex: Math.max(0, Math.min(2, Math.floor(num(s.levelIndex, 0)))),
    status: s.status === "collapsed" ? "collapsed" : "active",
    collapseCause: typeof s.collapseCause === "string" ? s.collapseCause : null,
    collapsedTick: num(s.collapsedTick, 0) || null,
    legacy: s.legacy && typeof s.legacy === "object" ? s.legacy : null,
    storm: {
      index: Math.max(0, Math.floor(num(s.storm?.index, 0))),
      nextStormDay: Math.max(1, Math.floor(num(s.storm?.nextStormDay, base.storm.nextStormDay))),
      stormsHit: Math.max(0, Math.floor(num(s.storm?.stormsHit, 0))),
      lastStormDay: Math.max(0, Math.floor(num(s.storm?.lastStormDay, 0))),
      lastMargin: typeof s.storm?.lastMargin === "number" && Number.isFinite(s.storm.lastMargin) ? s.storm.lastMargin : null,
      lastOutcome: typeof s.storm?.lastOutcome === "string" ? s.storm.lastOutcome : null
    },
    lastDay: Math.max(1, Math.floor(num(s.lastDay, 1))),
    starvingDays: Math.max(0, Math.floor(num(s.starvingDays, 0))),
    lowHoldDays: Math.max(0, Math.floor(num(s.lowHoldDays, 0))),
    actLastTick: s.actLastTick && typeof s.actLastTick === "object" ? { ...s.actLastTick } : {},
    stats: {
      daysSurvived: Math.max(0, Math.floor(num(s.stats?.daysSurvived, 0))),
      peakPopulation: Math.max(0, Math.floor(num(s.stats?.peakPopulation, 0))),
      peakLevelIndex: Math.max(0, Math.min(2, Math.floor(num(s.stats?.peakLevelIndex, 0)))),
      stormsWeathered: Math.max(0, Math.floor(num(s.stats?.stormsWeathered, 0))),
      buildingsBuilt: Array.isArray(s.stats?.buildingsBuilt)
        ? s.stats.buildingsBuilt.filter((/** @type {unknown} */ k) => typeof k === "string")
        : []
    },
    lastDaily: s.lastDaily && typeof s.lastDaily === "object" ? s.lastDaily : null,
    crewSplitTick: num(s.crewSplitTick, -1),
    appliedBoons: Array.isArray(s.appliedBoons) ? s.appliedBoons.filter((/** @type {unknown} */ b) => typeof b === "string" && b in LEGACY_BOONS) : []
  };
}

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

/** @param {Settlement} settlement @param {string} kind */
export function buildingByKind(settlement, kind) {
  return settlement?.buildings.find(b => b.kind === kind) || null;
}

/** @param {Settlement} settlement @param {string} id */
export function buildingById(settlement, id) {
  return settlement?.buildings.find(b => b.id === id) || null;
}

/** The building definition for a kind, from config. @param {import("../config.js").WorldConfig} config @param {string} kind */
export function buildingDef(config, kind) {
  return config.settlement.buildings.find(d => d.kind === kind) || null;
}

/**
 * Whether the settlement layer is live in this world. Every settlement
 * behaviour gates on this, which is what keeps the base engine a pure
 * simulation when the game mode has not asked for the camp.
 * @param {import("./world.js").World} world
 */
export function settlementEnabled(world) {
  return Boolean(world?.config?.settlement?.enabled && world?.settlement);
}

/**
 * Whether the camp is in play right now: live, founded and not collapsed.
 * @param {import("./world.js").World} world
 */
export function settlementActive(world) {
  return settlementEnabled(world) && world.settlement.status === "active";
}

/** Living minds, read straight off the world. @param {import("./world.js").World} world */
function living(world) {
  return world.agents.filter(a => !a.retired);
}

/**
 * Days of food in store at the current population.
 * @param {import("./world.js").World} world
 */
export function foodDays(world) {
  const pop = living(world).length;
  if (!pop) return 0;
  const perDay = Math.max(0.01, world.config.settlement.foodPerMindPerDay * pop);
  return world.settlement.stores.food / perDay;
}

/**
 * What the camp has become, read off facts: staffed ground it has built,
 * the wall it keeps, the people it holds.
 * @param {import("./world.js").World} world
 * @returns {{name: string, index: number}}
 */
export function settlementLevelFor(world) {
  const cfg = world.config.settlement;
  const s = world.settlement;
  const active = s.buildings.filter(b => b.status === "active" || b.status === "damaged").length;
  const pop = living(world).length;
  if (active >= cfg.townActiveBuildings && s.wall.level >= cfg.townWallLevel && pop >= cfg.townPopulation) {
    return { name: "Town", index: 2 };
  }
  if (active >= cfg.hamletActiveBuildings && s.wall.level >= cfg.hamletWallLevel) {
    return { name: "Hamlet", index: 1 };
  }
  return { name: "Camp", index: 0 };
}

/**
 * The deterministic strength of storm number `index` (0-based).
 * @param {import("../config.js").WorldConfig} config
 * @param {number} index
 */
export function stormStrengthFor(config, index) {
  const cfg = config.settlement;
  return cfg.stormBaseStrength + ((Math.max(0, index) * cfg.stormStrengthStep) % Math.max(1, cfg.stormStrengthCycle));
}

/**
 * The forecast the keeper can see coming: when the next storm lands and
 * how hard, known exactly, because storm season runs on the camp's
 * calendar and never on a dice roll.
 * @param {import("./world.js").World} world
 */
export function stormForecast(world) {
  if (!world?.settlement) return null;
  const s = world.settlement;
  const strength = stormStrengthFor(world.config, s.storm.index);
  const daysUntil = Math.max(0, s.storm.nextStormDay - world.clock.day);
  return {
    index: s.storm.index,
    nextStormDay: s.storm.nextStormDay,
    daysUntil,
    /** Rough tick distance: a world day is 48 ticks at the default clock. */
    ticksUntil: daysUntil * 48,
    strength,
    lastOutcome: s.storm.lastOutcome,
    lastMargin: s.storm.lastMargin
  };
}

/**
 * What the wall itself answers a storm with.
 * @param {import("./world.js").World} world
 */
export function wallDefense(world) {
  const cfg = world.config.settlement;
  const wall = world.settlement.wall;
  const craft = world.settlement.appliedBoons?.includes("wall_craft") ? 10 : 0;
  return wall.level * cfg.wallDefensePerLevel + wall.condition * cfg.wallDefensePerCondition + craft;
}

/**
 * Shelter: the built, roofed part of the defence, plus the camp's own
 * standing. A staffed hall shelters more than an empty one.
 * @param {import("./world.js").World} world
 */
export function shelterScore(world) {
  const cfg = world.config.settlement;
  const hall = buildingByKind(world.settlement, "hall");
  let score = world.settlement.levelIndex * cfg.settlementLevelDefense;
  if (hall && (hall.status === "active" || hall.status === "damaged")) {
    score += cfg.hallShelter * (hall.condition / 100);
    if (hall.crew.length) score += cfg.hallStaffedShelterBonus;
  }
  return Math.round(score * 10) / 10;
}

/**
 * The camp's whole answer to a storm: the wall that holds, plus shelter.
 * @param {import("./world.js").World} world
 */
export function defenseScore(world) {
  return Math.round((wallDefense(world) + shelterScore(world)) * 10) / 10;
}

/**
 * Whether a mind is in mourning right now. Grief is a mood the mourning
 * system already stamps; the camp only reads it.
 * @param {import("./agent.js").Agent} agent
 * @param {number} tick
 */
export function isMourning(agent, tick) {
  return agent.mood === "grieving" && tick < (agent.moodUntil ?? 0);
}

/**
 * The crew conflict between a candidate and a building's current crew:
 * the first crew member whose feud with them has reached rivalry or
 * worse. Two minds in a feud cannot staff the same workshop — that is
 * the camp's central social rule, so it is a reader everything uses.
 * @param {import("./world.js").World} world
 * @param {Building} building
 * @param {string} agentId
 * @returns {{otherId: string, stage: string}|null}
 */
export function crewConflict(world, building, agentId) {
  const candidate = world.agents.find(a => a.id === agentId);
  if (!candidate) return null;
  for (const otherId of building.crew) {
    if (otherId === agentId) continue;
    const other = world.agents.find(a => a.id === otherId);
    if (!other || other.retired) continue;
    const stage = feudStage(candidate.relations[otherId], other.relations[agentId], world.config);
    if (stage === "rivalry" || stage === "vendetta") return { otherId, stage };
  }
  return null;
}

/**
 * A crew pair whose feud is live but has not yet reached the blocking
 * stage — the "about to split this crew" warning. Returns the hottest
 * such pair across the camp, or null.
 * @param {import("./world.js").World} world
 * @returns {{building: Building, aId: string, bId: string, stage: string, heat: number}|null}
 */
export function crewFeudWarning(world) {
  if (!world?.settlement) return null;
  const cfg = world.config;
  let best = null;
  for (const building of world.settlement.buildings) {
    for (let i = 0; i < building.crew.length; i++) {
      for (let j = i + 1; j < building.crew.length; j++) {
        const a = world.agents.find(x => x.id === building.crew[i]);
        const b = world.agents.find(x => x.id === building.crew[j]);
        if (!a || !b) continue;
        const heat = Math.max(a.relations[b.id]?.resentment ?? 0, b.relations[a.id]?.resentment ?? 0);
        const stage = feudStage(a.relations[b.id], b.relations[a.id], cfg);
        if (stage && stage !== "grudge") continue; // already blocking; handled as a split
        if (heat < cfg.vendetta.grudgeAt) continue;
        if (heat < cfg.vendetta.rivalryAt - cfg.settlement.crewFeudWarningMargin) continue;
        if (!best || heat > best.heat) best = { building, aId: a.id, bId: b.id, stage: stage || "grudge", heat };
      }
    }
  }
  return best;
}

/**
 * Whether a crew member is the subject of a secret that has recently
 * gone public — the exposure that tanks a whole building's output.
 * @param {import("./world.js").World} world
 * @param {Building} building
 */
export function buildingExposed(world, building) {
  const tick = world.clock.tick;
  const window = world.config.settlement.secretExposureTicks;
  return world.secrets.some(s =>
    s.isPublic &&
    s.aboutId &&
    building.crew.includes(s.aboutId) &&
    tick - (s.publicTick ?? -99999) < window
  );
}

/**
 * The social multiplier on a staffed building's daily output: an exposed
 * secret about somebody on the crew, and mourning hands among them.
 * @param {import("./world.js").World} world
 * @param {Building} building
 * @returns {{factor: number, exposed: boolean, mourningHands: number}}
 */
export function buildingOutputFactor(world, building) {
  const cfg = world.config.settlement;
  const tick = world.clock.tick;
  let factor = 1;
  const exposed = buildingExposed(world, building);
  if (exposed) factor *= cfg.secretExposureFactor;
  let mourningHands = 0;
  for (const id of building.crew) {
    const agent = world.agents.find(a => a.id === id);
    if (agent && isMourning(agent, tick)) mourningHands += 1;
  }
  if (building.crew.length && mourningHands) {
    const share = mourningHands / building.crew.length;
    factor *= 1 - share * (1 - cfg.mourningProductionFactor);
  }
  // A building the storm has half-wrecked produces like it looks.
  factor *= 0.4 + 0.6 * (building.condition / 100);
  return { factor, exposed, mourningHands };
}

/**
 * The social multiplier on one mind's construction or repair work.
 * @param {import("./world.js").World} world
 * @param {import("./agent.js").Agent} agent
 */
export function workFactorFor(world, agent) {
  return isMourning(agent, world.clock.tick) ? world.config.settlement.mourningWorkFactor : 1;
}

/**
 * The boons a legacy carries, filtered to ones that exist.
 * @param {Settlement} settlement
 * @returns {string[]}
 */
export function legacyBoonsOf(settlement) {
  return (settlement?.legacy?.boons || []).filter(b => b in LEGACY_BOONS);
}
