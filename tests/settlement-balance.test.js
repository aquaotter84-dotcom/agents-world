/**
 * Phase F, balance: deterministic seeded sims, no model, no keeper —
 * and then a scripted keeper — proving the measured complaints are gone.
 * The wall used to finish inside day 1; influence used to pin at its cap
 * with nothing to buy; food used to be a number nobody watched. These
 * runs are the calibration evidence, and they replay identically.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import {
  activateSettlement, canPerformSettlementAct, performSettlementAct
} from "../engine/systems/settlement.js";
import { foodDays } from "../engine/model/settlement.js";
import { DEFAULT_CONFIG } from "../engine/config.js";

const DAY = 48;

/** @param {number} seed */
function campWorld(seed) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
}

/**
 * Step a world, optionally letting a scripted keeper act on a rule.
 * @param {any} world @param {number} ticks @param {(world: any) => void} [keeper]
 */
function run(world, ticks, keeper) {
  for (let i = 0; i < ticks; i++) {
    step(world);
    if (keeper) keeper(world);
  }
}

test("the North Wall is a season's work now, not a day's: level 1 lands after day 1 and within the month", () => {
  for (const seed of [1, 42]) {
    const world = campWorld(seed);
    let wallTick = -1;
    for (let i = 0; i < 30 * DAY && wallTick < 0; i++) {
      step(world);
      if (world.settlement.wall.level >= 1) wallTick = world.clock.tick;
    }
    assert.ok(wallTick > DAY, `seed ${seed}: wall level 1 at tick ${wallTick} is still inside day 1`);
    assert.ok(wallTick > 0 && wallTick <= 20 * DAY, `seed ${seed}: wall level 1 by day 20 (tick ${wallTick})`);
    // And it keeps being raised: the project re-opens for the next level.
    assert.equal(world.project.status, "active");
  }
});

test("an unattended camp survives its first storms, builds, and stays hungry enough to matter", () => {
  for (const seed of [1, 7, 42]) {
    const world = campWorld(seed);
    let minFoodDays = Infinity;
    for (let i = 0; i < 20 * DAY; i++) {
      step(world);
      minFoodDays = Math.min(minFoodDays, foodDays(world));
    }
    const s = world.settlement;
    assert.equal(s.status, "active", `seed ${seed}: the camp should still stand on day 20 (${s.collapseCause})`);
    assert.ok(s.storm.stormsHit >= 3, `seed ${seed}: storms arrived on schedule (${s.storm.stormsHit})`);
    assert.ok(s.buildings.filter(b => b.status === "active").length >= 3,
      `seed ${seed}: the camp builds without a keeper (${s.buildings.map(b => b.kind + ":" + b.status).join(", ")})`);
    assert.ok(livingAgents(world).length >= 8, `seed ${seed}: the camp holds its people`);
    // Food pressure is real: at some point in the first twenty days the
    // stores held under three days of food — but the camp worked its way
    // back rather than spiralling. (Seeds 1 and 7 both dip under two.)
    assert.ok(minFoodDays < 3, `seed ${seed}: food never got tight (min ${minFoodDays.toFixed(1)} days)`);
    assert.ok(s.starvingDays <= 2, `seed ${seed}: hunger stayed a scare, not a spiral (${s.starvingDays} starving days)`);
  }
});

test("a keeper who works the camp acts drains the purse that used to pin at its cap", () => {
  const world = campWorld(7);
  let acts = 0;
  let spent = 0;
  const cfg = world.config.settlement;
  run(world, 20 * DAY, w => {
    const spend = (/** @type {"relief"|"rally"} */ kind, /** @type {number} */ cost) => {
      if (canPerformSettlementAct(w, kind).ok && performSettlementAct(w, kind).ok) { acts += 1; spent += cost; }
    };
    if (foodDays(w) < 2.2) spend("relief", cfg.reliefCost);
    if (w.settlement.hold < 75) spend("rally", cfg.rallyCost);
  });
  assert.ok(acts >= 4, `the camp gives a keeper real decisions (${acts} acts in 20 days)`);
  assert.ok(spent >= 40, `influence has somewhere to go (${spent} spent)`);
  assert.ok(world.charter.influence < world.charter.influenceMax,
    `the purse ends drained, not pinned (${world.charter.influence.toFixed(0)}/${world.charter.influenceMax})`);
  assert.equal(world.settlement.status, "active");
  assert.ok(world.settlement.hold >= 50, "and the spending buys a camp that holds together");
});

test("the full cycle completes: a doomed camp collapses, and its legacy founds the next one", () => {
  const buildings = structuredClone(DEFAULT_CONFIG.settlement.buildings);
  buildings[0] = { ...buildings[0], maxCrew: 0 }; // fields nobody can work
  const doomed = createWorld({
    seed: 77,
    config: /** @type {any} */ ({ settlement: { enabled: true, buildings }, turnover: { arrivalChance: 0, departureChance: 0 } })
  });
  run(doomed, 30 * DAY);
  assert.equal(doomed.settlement.status, "collapsed", "a camp that cannot eat, ends");
  const legacy = doomed.settlement.legacy;
  assert.ok(legacy && typeof legacy.summary === "string" && legacy.summary.length > 20,
    "the ending is written down");

  const next = campWorld(78);
  // campWorld starts founded; refound it from the legacy to prove the carry.
  next.config.settlement.enabled = false;
  activateSettlement(next, { boons: legacy.boons });
  assert.equal(next.settlement.appliedBoons.length, legacy.boons.length);
  run(next, 2 * DAY);
  assert.equal(next.settlement.status, "active", "and the next camp lives its first days");
});
