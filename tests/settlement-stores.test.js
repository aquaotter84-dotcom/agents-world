/**
 * Phase F, stores: the camp carries food and materials, minds eat daily,
 * and a settlement that the game mode has not activated does nothing at
 * all — the base engine stays a pure simulation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { step, runTicks } from "../engine/simulation.js";
import { fingerprint } from "./helpers.mjs";
import { settlementEnabled } from "../engine/model/settlement.js";

/** @param {number} seed */
function gameWorld(seed = 71) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
}

test("settlement defaults off in the base engine, and a dormant world replays identically", () => {
  const plain = createWorld({ seed: 99 });
  assert.equal(settlementEnabled(plain), false);
  assert.equal(plain.config.settlement.enabled, false);
  assert.ok(plain.settlement, "dormant state exists so activation never invents shape");
  const foodBefore = plain.settlement.stores.food;
  runTicks(plain, 120);
  assert.equal(plain.settlement.stores.food, foodBefore, "a dormant camp neither produces nor eats");
  assert.equal(plain.settlement.hold, plain.config.settlement.startingHold);
  // Determinism against a second identical run: the layer cost no RNG.
  const again = createWorld({ seed: 99 });
  runTicks(again, 120);
  assert.equal(fingerprint(plain), fingerprint(again));
});

test("the camp survives a save: stores, wall and Hold resume where they were", () => {
  const world = gameWorld(72);
  world.settlement.stores.food = 17;
  world.settlement.wall.level = 2;
  world.settlement.hold = 41;
  const resumed = deserializeWorld(serializeWorld(world));
  assert.equal(resumed.settlement.stores.food, 17);
  assert.equal(resumed.settlement.wall.level, 2);
  assert.equal(resumed.settlement.hold, 41);
  assert.equal(settlementEnabled(resumed), true, "the game mode survives the save too");
});

test("an old save with no settlement at all loads with a dormant camp", () => {
  const world = createWorld({ seed: 73 });
  const data = JSON.parse(serializeWorld(world));
  delete data.settlement;
  const resumed = deserializeWorld(JSON.stringify(data));
  assert.ok(resumed.settlement);
  assert.equal(resumed.settlement.stores.food, resumed.config.settlement.startingFood);
  assert.equal(resumed.settlement.buildings.length, resumed.config.settlement.buildings.length);
});

test("activating the game mode makes minds eat: food falls by population each day", () => {
  const world = gameWorld(74);
  // Pin the crew empty so this measures consumption alone, not farming.
  const pop = livingAgents(world).length;
  const before = world.settlement.stores.food;
  runTicks(world, 49); // just over one world day of daily ledgers
  const after = world.settlement.stores.food;
  assert.ok(after <= before - pop + 0.001 + 12, `food should fall by roughly a day's eating (${before} -> ${after})`);
  assert.ok(world.settlement.lastDaily, "a daily ledger was written");
  assert.equal(world.settlement.lastDaily.foodConsumed, pop * world.config.settlement.foodPerMindPerDay);
});
