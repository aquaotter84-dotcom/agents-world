/**
 * Phase F, collapse and legacy: defined endings with stated causes, a
 * legacy summary of what the run actually did, and boons that carry
 * into the next camp. The world keeps turning afterwards — an ending,
 * not a crash.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { runTicks, step } from "../engine/simulation.js";
import { collapseSettlement, activateSettlement, performSettlementAct } from "../engine/systems/settlement.js";
import { DEFAULT_CONFIG } from "../engine/config.js";

/** A camp that cannot feed itself: no hands can staff the fields. @param {number} seed @param {any} [extra] */
function doomedWorld(seed = 121, extra = {}) {
  const buildings = structuredClone(DEFAULT_CONFIG.settlement.buildings);
  buildings[0] = { ...buildings[0], maxCrew: 0 };
  return createWorld({ seed, config: /** @type {any} */ ({
    settlement: { enabled: true, buildings, ...extra },
    turnover: { arrivalChance: 0, departureChance: 0 }
  }) });
}

test("starvation ends a camp, with the cause stated and the days counted", () => {
  const world = doomedWorld(121);
  world.settlement.stores.food = 0;
  runTicks(world, 300);
  assert.equal(world.settlement.status, "collapsed");
  assert.match(world.settlement.collapseCause || "", /starvation/);
  assert.ok(world.settlement.legacy);
  assert.equal(world.settlement.legacy.cause, world.settlement.collapseCause);
  assert.ok(world.settlement.legacy.daysSurvived >= world.config.settlement.starveCollapseDays);
  assert.ok(world.events.some(e => e.kind === "collapse" && e.significance === 1));
  // The ending is in the day's chronicle too, through the ordinary path.
  runTicks(world, 60);
  assert.ok(world.chronicle.some(c => /camp|stores|scattered/i.test(c.summary)) || world.events.some(e => e.kind === "chronicle"),
    "the chronicle carries the ending like any other day it closes");
});

test("the Hold hitting zero is survivable for the grace, then it is over", () => {
  const world = createWorld({ seed: 122, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  world.settlement.hold = 0;
  world.settlement.lastDay = world.clock.day;
  // Feed the camp well so only the Hold can end it: each daily ledger
  // still starts at zero will.
  runTicks(world, 30);
  assert.equal(world.settlement.status, "active", "zero Hold is a warning first, not an instant ending");
  // Keep it at zero across the grace (daily gains would otherwise lift it).
  for (let i = 0; i < 160 && world.settlement.status === "active"; i++) {
    world.settlement.hold = 0;
    step(world);
  }
  assert.equal(world.settlement.status, "collapsed");
  assert.match(world.settlement.collapseCause || "", /Hold gave out/);
});

test("collapse is idempotent and the world keeps turning afterwards", () => {
  const world = createWorld({ seed: 123, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  const legacy = collapseSettlement(world, "a test ending");
  assert.ok(legacy);
  assert.equal(collapseSettlement(world, "a second ending")?.cause, "a test ending");
  const food = world.settlement.stores.food;
  const tick = world.clock.tick;
  runTicks(world, 60);
  assert.ok(world.clock.tick > tick, "minds still live after the camp ends");
  assert.equal(world.settlement.stores.food, food, "a scattered camp neither produces nor eats");
  const act = performSettlementAct(world, "relief");
  assert.equal(act.ok, false);
  assert.match(act.reason || "", /scattered/);
});

test("legacy boons are earned by the run and carry into the next camp", () => {
  const world = createWorld({ seed: 124, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  world.settlement.stats.daysSurvived = 20;
  world.settlement.wall.level = 3;
  world.settlement.stats.buildingsBuilt = ["workshop", "memorial"];
  world.settlement.stats.peakLevelIndex = 2;
  world.settlement.stats.peakPopulation = 12;
  const legacy = collapseSettlement(world, "the Hold gave out");
  assert.ok(legacy);
  assert.deepEqual(legacy.boons.sort(), ["remembered_names", "seasoned_stores", "town_charter", "wall_craft"]);
  assert.match(legacy.summary, /wall at level 3/);
  assert.match(legacy.summary, /carries over/i);

  const next = createWorld({ seed: 125 });
  const before = {
    food: next.settlement.stores.food,
    materials: next.settlement.stores.materials,
    hold: next.settlement.hold
  };
  const founded = activateSettlement(next, { boons: legacy.boons });
  assert.equal(founded.ok, true);
  assert.equal(next.config.settlement.enabled, true);
  assert.ok(next.settlement.stores.food > before.food, "seasoned stores arrive");
  assert.ok(next.settlement.stores.materials > before.materials, "the town charter arrives as materials");
  assert.ok(next.settlement.hold > before.hold, "remembered names steady the new Hold");
  assert.ok(next.settlement.appliedBoons.includes("wall_craft"));
  // And a boon that was not earned does not arrive by being named.
  const plain = createWorld({ seed: 126 });
  activateSettlement(plain, { boons: ["not_a_boon"] });
  assert.deepEqual(plain.settlement.appliedBoons, []);
});

test("a short, unbuilt run leaves an honest legacy: the record, not boons", () => {
  const world = createWorld({ seed: 127, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  runTicks(world, 10);
  const legacy = collapseSettlement(world, "a keeper's test");
  assert.ok(legacy);
  assert.deepEqual(legacy.boons, []);
  assert.match(legacy.summary, /left nothing behind but the record/);
  assert.ok(livingAgents(world).length > 0, "the minds outlive the camp, as they should");
});
