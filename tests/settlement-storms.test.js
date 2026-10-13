/**
 * Phase F, storms: a forecast clock the keeper can read, defence scored
 * from the wall and shelter, and the North Wall as level 1 of something
 * the keeper keeps reinforcing instead of a day-one ending.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { runTicks } from "../engine/simulation.js";
import { resolveIntent } from "../engine/systems/act.js";
import { applyEffects } from "../engine/systems/effects.js";
import { resolveStorm } from "../engine/systems/settlement.js";
import { stormForecast, defenseScore, buildingByKind } from "../engine/model/settlement.js";

/** @param {number} seed @param {any} [extra] */
function gameWorld(seed = 91, extra = {}) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true, ...extra } }) });
}

test("the forecast is exact and free: same camp, same storm, no dice", () => {
  const a = gameWorld(91);
  const b = gameWorld(91);
  const fa = stormForecast(a);
  const fb = stormForecast(b);
  assert.deepEqual(fa, fb);
  assert.ok(fa);
  assert.equal(fa.nextStormDay, a.config.settlement.stormFirstDay);
  assert.equal(fa.daysUntil, fa.nextStormDay - 1, "on day 1 the storm is that many days out");
  // Strength is stepped calendar arithmetic, and it grows over the season.
  const later = gameWorld(91);
  later.settlement.storm.index = 3;
  assert.ok((stormForecast(later)?.strength ?? 0) >= (fa.strength ?? 0));
});

test("defence is the wall plus shelter, and the margin decides the outcome", () => {
  const world = gameWorld(92);
  // A bare camp: no wall level, an unwalled answer of condition alone.
  world.settlement.wall.level = 0;
  world.settlement.wall.condition = 100;
  const bare = defenseScore(world);
  assert.equal(bare, Math.round(100 * world.config.settlement.wallDefensePerCondition * 10) / 10);

  const result = resolveStorm(world);
  assert.ok(result);
  assert.equal(result.defense, bare);
  assert.equal(result.margin, Math.round((result.defense - result.strength) * 10) / 10);
  assert.equal(world.settlement.storm.lastOutcome, result.outcome);
  assert.equal(world.settlement.storm.lastMargin, result.margin);
  // The appointment is kept and the next one is already on the calendar.
  assert.equal(world.settlement.storm.nextStormDay,
    world.config.settlement.stormFirstDay + world.config.settlement.stormIntervalDays);
  assert.ok(world.events.some(e => e.kind === "storm"));
});

test("a strong wall holds; a weak one is breached, damaged and spoiled", () => {
  const strong = gameWorld(93);
  strong.settlement.wall.level = 4;
  strong.settlement.wall.condition = 100;
  const hall = buildingByKind(strong.settlement, "hall");
  assert.ok(hall);
  hall.status = "active";
  const held = resolveStorm(strong);
  assert.equal(held?.outcome, "held");
  const fieldsAfterHeld = buildingByKind(strong.settlement, "fields");
  assert.equal(fieldsAfterHeld?.condition, 80, "a held storm does no damage");

  const weak = gameWorld(93);
  weak.settlement.wall.level = 0;
  weak.settlement.wall.condition = 10;
  weak.settlement.stores.food = 40;
  const foodBefore = weak.settlement.stores.food;
  const breached = resolveStorm(weak);
  assert.equal(breached?.outcome, "breached");
  assert.ok(weak.settlement.wall.condition < 10, "the wall itself is worried raw");
  assert.ok(weak.settlement.stores.food < foodBefore, "a breach spoils stores");
  const fields = buildingByKind(weak.settlement, "fields");
  assert.equal(fields?.status, "damaged", "torn buildings need repair, and say so");
  assert.ok(weak.settlement.hold < weak.config.settlement.startingHold, "a breach costs the camp its will");
});

test("storms arrive on schedule while the world runs, keeper or no keeper", () => {
  const world = gameWorld(94);
  runTicks(world, 300); // past the first forecast day at the default clock
  assert.ok(world.settlement.storm.stormsHit >= 1, "the season arrived on its day");
  assert.ok(world.events.some(e => e.kind === "storm"));
});

test("the North Wall no longer ends the game: completion is level 1, and it reopens", () => {
  const world = gameWorld(95);
  const [a, b] = livingAgents(world);
  for (const agent of [a, b]) agent.regionId = "wall";
  const perform = (/** @type {any} */ agent) => {
    const resolution = resolveIntent(world, agent, {
      kind: "project_contribute", targetId: null, utility: 100, requiresProximity: false, reasons: ["test"]
    });
    applyEffects(world, resolution.ops, { actorId: agent.id });
  };
  let acts = 0;
  while (world.settlement.wall.level < 1 && acts++ < 60) perform(acts % 2 ? a : b);
  assert.equal(world.settlement.wall.level, 1, "the first raising is level 1");
  assert.equal(world.settlement.wall.condition, 100);
  assert.equal(world.project.status, "active", "the work reopens for the next level");
  assert.equal(world.project.progress, 0);
  assert.ok(world.charter.wallRaised, "the old shared win is still recorded the first time");

  const firstLevelActs = acts;
  acts = 0;
  while (world.settlement.wall.level < 2 && acts++ < 120) perform(acts % 2 ? a : b);
  assert.equal(world.settlement.wall.level, 2);
  assert.ok(acts > firstLevelActs, `the next level is slower work (${acts} acts after ${firstLevelActs})`);
  assert.equal(world.settlement.wall.reinforcements, 1);
});

test("outside the game mode the wall still completes once, as before", () => {
  const world = createWorld({ seed: 96 });
  const [a] = livingAgents(world);
  a.regionId = "wall";
  let guard = 0;
  while (world.project.status === "active" && guard++ < 40) {
    const resolution = resolveIntent(world, a, {
      kind: "project_contribute", targetId: null, utility: 100, requiresProximity: false, reasons: ["test"]
    });
    applyEffects(world, resolution.ops, { actorId: a.id });
  }
  assert.equal(world.project.status, "complete");
  assert.equal(world.settlement.wall.level, 0, "a dormant camp's wall has no levels");
});
