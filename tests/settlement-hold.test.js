/**
 * Phase F, the Hold: one cohesion meter, fed daily by food, morale and
 * the camp's own quarrels — and population that grows when the camp can
 * hold people and shrinks when it cannot.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { runTicks } from "../engine/simulation.js";
import { assignCrew } from "../engine/systems/settlement.js";
import { buildingByKind } from "../engine/model/settlement.js";
import { DEFAULT_CONFIG } from "../engine/config.js";

/** @param {number} seed @param {any} [extra] */
function gameWorld(seed = 101, extra = {}) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true, ...extra }, turnover: { arrivalChance: 0, departureChance: 0 } }) });
}

/** A world whose fields can never be staffed, so food only ever falls. @param {number} seed */
function unstaffable(seed) {
  const buildings = structuredClone(DEFAULT_CONFIG.settlement.buildings);
  buildings[0] = { ...buildings[0], maxCrew: 0 };
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true, buildings }, turnover: { arrivalChance: 0, departureChance: 0 } }) });
}

test("a fed camp's Hold rises; a starving camp's Hold falls and keeps falling", () => {
  const fed = gameWorld(101);
  const fields = buildingByKind(fed.settlement, "fields");
  assert.ok(fields);
  for (const m of livingAgents(fed).slice(0, 3)) assignCrew(fed, fields.id, m.id);
  fed.settlement.stores.food = 120;
  const fedStart = fed.settlement.hold;
  runTicks(fed, 49);
  assert.ok(fed.settlement.hold > fedStart, `fed: ${fedStart} -> ${fed.settlement.hold}`);
  assert.equal(fed.settlement.lastDaily?.fed, true);

  const hungry = unstaffable(101);
  hungry.settlement.stores.food = 0;
  const hungryStart = hungry.settlement.hold;
  runTicks(hungry, 49);
  assert.equal(hungry.settlement.lastDaily?.fed, false);
  assert.ok(hungry.settlement.starvingDays >= 1);
  assert.ok(hungry.settlement.hold <= hungryStart - 8, `starving: ${hungryStart} -> ${hungry.settlement.hold}`);
  // And a mind that went hungry is tired in a way the needs system can see.
  assert.ok(livingAgents(hungry).every(a => a.needs.energy <= 100));
});

test("morale feeds the Hold: a bright camp holds better than a grim one on the same food", () => {
  /** @param {number} mood */
  function campAtMood(mood) {
    const world = gameWorld(102);
    world.settlement.stores.food = 200;
    runTicks(world, 30);
    for (const a of livingAgents(world)) a.moodLevel = mood;
    runTicks(world, 12); // across the day boundary, moods still high/low
    return world.settlement.lastDaily?.holdDelta ?? 0;
  }
  const bright = campAtMood(100);
  const grim = campAtMood(0);
  assert.ok(bright > grim + 2, `bright day ${bright} should beat grim day ${grim} on the Hold`);
});

test("the Hold warns before it breaks: crossing low ground is an event", () => {
  const world = unstaffable(103);
  world.settlement.stores.food = 0;
  world.settlement.hold = 30;
  runTicks(world, 49);
  assert.ok(world.settlement.hold <= 25);
  assert.ok(world.events.some(e => e.kind === "settlement" && /Hold is failing/.test(e.text)));
});

test("a fed, holding camp under its cap gains people; a broken one loses its wanderers", () => {
  const growing = gameWorld(104);
  growing.settlement.stores.food = 300;
  growing.settlement.hold = 85;
  // Growth needs the fields able to feed a tenth mouth, not just stores:
  // the test staffs the full crew the growth rule reads.
  const gFields = buildingByKind(growing.settlement, "fields");
  assert.ok(gFields);
  for (const m of livingAgents(growing).slice(0, 4)) assignCrew(growing, gFields.id, m.id);
  const before = livingAgents(growing).length;
  runTicks(growing, 200);
  assert.ok(livingAgents(growing).length > before,
    `settlement growth should add a wanderer (${before} -> ${livingAgents(growing).length})`);
  assert.ok(livingAgents(growing).length <= growing.config.settlement.maxPopulation);

  const broken = unstaffable(105);
  const wanderer = livingAgents(broken)[8];
  wanderer.seedCast = false; // a mind the world may lose, as arrivals are
  broken.settlement.stores.food = 0;
  broken.settlement.hold = 10;
  const brokenBefore = livingAgents(broken).length;
  runTicks(broken, 60);
  assert.ok(livingAgents(broken).length < brokenBefore, "a camp that cannot hold people loses them");
  assert.ok(broken.mourning.memorials.some(m => m.agentId === wanderer.id),
    "the departure is written down, not a quiet despawn");
});
