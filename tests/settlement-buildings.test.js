/**
 * Phase F, buildings: construction is paid work over time, crews are
 * tracked with validation the keeper can read, and the labor intents
 * that staff the camp exist only while the game mode is live.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { generateIntents } from "../engine/decision/intents.js";
import { resolveIntent } from "../engine/systems/act.js";
import { applyEffects } from "../engine/systems/effects.js";
import {
  startConstruction, canConstruct, assignCrew, unassignCrew, staffingBlock
} from "../engine/systems/settlement.js";
import { buildingByKind } from "../engine/model/settlement.js";
import { runTicks } from "../engine/simulation.js";
import { DEFAULT_CONFIG } from "../engine/config.js";

/** @param {number} seed */
function gameWorld(seed = 81) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
}

/**
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} agent
 * @param {string} kind
 * @param {string} buildingId
 */
function perform(world, agent, kind, buildingId) {
  const resolution = resolveIntent(world, agent, {
    kind, targetId: null, utility: 100, requiresProximity: false, reasons: ["test"],
    payload: { buildingId }
  });
  applyEffects(world, resolution.ops, { actorId: agent.id });
  return resolution;
}

test("construction is validated, paid for up front, and never instant", () => {
  const world = gameWorld();
  const workshop = buildingByKind(world.settlement, "workshop");
  assert.ok(workshop);
  assert.equal(workshop.status, "planned");
  const materialsBefore = world.settlement.stores.materials;

  // Not enough stored wealth is a sentence, not a silent no.
  world.settlement.stores.materials = 2;
  const broke = startConstruction(world, "workshop");
  assert.equal(broke.ok, false);
  assert.match(broke.reason || "", /materials/);
  assert.equal(workshop.status, "planned");

  world.settlement.stores.materials = materialsBefore;
  const started = startConstruction(world, "workshop");
  assert.equal(started.ok, true);
  assert.equal(workshop.status, "building");
  assert.equal(workshop.progress, 0, "paying for a building does not raise it");
  assert.equal(world.settlement.stores.materials, materialsBefore - 6);
  assert.equal(startConstruction(world, "workshop").ok, false, "no double-starting the same walls");
  assert.equal(startConstruction(world, "fields").ok, false, "what already stands cannot be built again");
  assert.equal(canConstruct(world, "observatory").ok, false);
});

test("hands raise a building over repeated work, and completion is recorded", () => {
  const world = gameWorld(82);
  const [a, b] = livingAgents(world);
  startConstruction(world, "workshop");
  const workshop = buildingByKind(world.settlement, "workshop");
  assert.ok(workshop);
  for (const agent of [a, b]) agent.regionId = workshop.regionId;

  perform(world, a, "settlement_build", workshop.id);
  assert.equal(workshop.status, "building", "one act of work is progress, not a building");
  assert.ok(workshop.progress > 0);

  let guard = 0;
  while (workshop.status === "building" && guard++ < 20) {
    perform(world, guard % 2 ? a : b, "settlement_build", workshop.id);
  }
  assert.equal(workshop.status, "active");
  assert.equal(workshop.condition, 100);
  assert.ok(workshop.completedTick !== null);
  assert.ok(world.settlement.stats.buildingsBuilt.includes("workshop"));
  assert.ok(world.events.some(e => e.kind === "building" && /Workshop stands finished/.test(e.text)));
});

test("crew staffing is tracked, capped, exclusive, and removable", () => {
  const world = gameWorld(83);
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  const minds = livingAgents(world);
  for (const m of minds.slice(0, 3)) assert.equal(assignCrew(world, fields.id, m.id).ok, true);
  assert.deepEqual(fields.crew, minds.slice(0, 3).map(m => m.id));
  const fourth = assignCrew(world, fields.id, minds[3].id);
  assert.equal(fourth.ok, false, "a full building refuses a fourth hand");
  assert.match(fourth.reason || "", /hands/);

  // One mind, one post: staffing the hall moves them off the fields.
  const hall = buildingByKind(world.settlement, "hall");
  assert.ok(hall);
  hall.status = "active";
  assert.equal(assignCrew(world, hall.id, minds[0].id).ok, true);
  assert.ok(!fields.crew.includes(minds[0].id));
  assert.equal(unassignCrew(world, hall.id, minds[0].id).ok, true);
  assert.equal(hall.crew.length, 0);
  assert.equal(assignCrew(world, "b-nope", minds[0].id).ok, false);
  assert.ok(staffingBlock(world, fields, "m-gone") !== null);
});

test("production follows the crew: an unstaffed field feeds nobody, a staffed one feeds the camp", () => {
  const staffed = gameWorld(84);
  const fieldsA = buildingByKind(staffed.settlement, "fields");
  assert.ok(fieldsA);
  for (const m of livingAgents(staffed).slice(0, 3)) assignCrew(staffed, fieldsA.id, m.id);
  staffed.settlement.stores.food = 5;
  runTicks(staffed, 49);
  assert.ok(staffed.settlement.lastDaily && staffed.settlement.lastDaily.foodProduced > 9,
    `staffed fields should out-produce a day's eating, made ${staffed.settlement.lastDaily?.foodProduced}`);
  assert.equal(staffed.settlement.lastDaily.fed, true);

  // A world whose fields can hold no hands at all: production must be zero
  // however long it runs, because output is crew times rate, not weather.
  const noHands = structuredClone(DEFAULT_CONFIG.settlement.buildings);
  noHands[0] = { ...noHands[0], maxCrew: 0 };
  const empty = createWorld({ seed: 84, config: /** @type {any} */ ({ settlement: { enabled: true, buildings: noHands } }) });
  empty.settlement.stores.food = 5;
  runTicks(empty, 49);
  assert.equal(empty.settlement.lastDaily?.foodProduced, 0);
  assert.equal(empty.settlement.lastDaily?.fed, false, "with no hands the camp goes hungry on empty stores");
});

test("labor intents exist in the game mode and not outside it", () => {
  const on = gameWorld(85);
  const agent = livingAgents(on)[0];
  agent.regionId = "lowlands";
  const kinds = generateIntents(on, agent).map(i => i.kind);
  assert.ok(kinds.includes("settlement_work"), "a live camp offers camp work");

  const off = createWorld({ seed: 85 });
  const dormantKinds = generateIntents(off, livingAgents(off)[0]).map(i => i.kind);
  assert.ok(!dormantKinds.some(k => k.startsWith("settlement_")), "a dormant camp offers nothing");
});

test("a damaged building is repaired by work over time, at a material cost", () => {
  const world = gameWorld(86);
  const [a] = livingAgents(world);
  const fields = buildingByKind(world.settlement, "workshop");
  assert.ok(fields);
  fields.status = "damaged";
  fields.condition = 40;
  fields.progress = 0;
  fields.repairPaid = false;
  a.regionId = fields.regionId;
  const materialsBefore = world.settlement.stores.materials;
  let guard = 0;
  while (fields.status === "damaged" && guard++ < 20) perform(world, a, "settlement_repair", fields.id);
  assert.equal(fields.status, "active");
  assert.equal(fields.condition, 100);
  assert.ok(world.settlement.stores.materials < materialsBefore, "repair is paid for in materials");
  assert.ok(world.events.some(e => e.kind === "building" && /stands whole again/.test(e.text)));
});
