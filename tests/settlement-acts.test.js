/**
 * Phase F, keeper acts: emergency sinks priced in the same influence as
 * blessings and omens — the core tradeoff of the base game. Spent on
 * one, it cannot be spent on the other.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import {
  settlementActOptions, canPerformSettlementAct, performSettlementAct
} from "../engine/systems/settlement.js";
import { performIntervention, canIntervene } from "../engine/systems/divine.js";
import { buildingByKind } from "../engine/model/settlement.js";

/** @param {number} seed */
function gameWorld(seed = 111) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
}

test("camp acts are priced, validated with sentences, and spend real influence", () => {
  const world = gameWorld();
  const options = settlementActOptions(world);
  assert.deepEqual(options.map(o => o.kind), ["relief", "repair", "rally"]);
  assert.ok(options.every(o => o.cost > 0));

  // Nothing broken: the repair act refuses in a sentence, spends nothing.
  const influenceBefore = world.charter.influence;
  const noRepair = performSettlementAct(world, "repair");
  assert.equal(noRepair.ok, false);
  assert.match(noRepair.reason || "", /Nothing is broken/);
  assert.equal(world.charter.influence, influenceBefore);

  const foodBefore = world.settlement.stores.food;
  const relief = performSettlementAct(world, "relief");
  assert.equal(relief.ok, true);
  assert.equal(world.settlement.stores.food, foodBefore + world.config.settlement.reliefFood);
  assert.equal(world.charter.influence, influenceBefore - world.config.settlement.reliefCost);
  assert.ok(world.events.some(e => e.kind === "settlement" && /Relief reached/.test(e.text)));

  // Cooldown is a sentence too, and a stranger act is refused by name.
  const again = performSettlementAct(world, "relief");
  assert.equal(again.ok, false);
  assert.match(again.reason || "", /more ticks/);
  assert.equal(canPerformSettlementAct(world, "miracle").ok, false);
});

test("emergency repair turns to the most broken thing, including the wall", () => {
  const world = gameWorld(112);
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  fields.status = "damaged";
  fields.condition = 20;
  world.settlement.wall.condition = 55;
  const repair = performSettlementAct(world, "repair");
  assert.equal(repair.ok, true);
  assert.ok(fields.condition > 20, "the worst breakage gets the hands first");
  assert.equal(fields.status, "damaged", "closer to whole is not whole — the crew still has work");
  fields.condition = 80;
  world.settlement.actLastTick = {};
  const finish = performSettlementAct(world, "repair", { buildingId: fields.id });
  assert.equal(finish.ok, true);
  assert.equal(fields.status, "active");
  assert.equal(fields.condition, 100);
});

test("the tradeoff is real: influence spent on an emergency is not there for a blessing", () => {
  const world = gameWorld(113);
  const reliefCost = world.config.settlement.reliefCost;
  world.charter.influence = reliefCost; // exactly one act in the purse
  assert.equal(canIntervene(world, "blessing", { work: true }).ok, true,
    "the purse holds exactly one of them: either act alone is affordable");
  const relief = performSettlementAct(world, "relief");
  assert.equal(relief.ok, true);
  assert.equal(world.charter.influence, 0);
  const blessing = performIntervention(world, "blessing", { work: true });
  assert.equal(blessing.ok, false, "the blessing the relief replaced cannot also happen");
  assert.match(blessing.reason || "", /influence/);
  const rally = performSettlementAct(world, "rally");
  assert.equal(rally.ok, false);
  assert.match(rally.reason || "", /influence/);
});

test("a rally moves the Hold and the room, and lands in the keeper's ledger", () => {
  const world = gameWorld(114);
  world.settlement.hold = 40;
  const rally = performSettlementAct(world, "rally");
  assert.equal(rally.ok, true);
  assert.equal(world.settlement.hold, 40 + world.config.settlement.rallyHold);
  assert.ok(world.want.log.some(e => /rallied the camp/.test(e.cause)), "the act is in the want ledger with its cause");
});

test("no camp, no acts: a dormant world refuses in a sentence and spends nothing", () => {
  const world = createWorld({ seed: 115 });
  const before = world.charter.influence;
  const result = performSettlementAct(world, "relief");
  assert.equal(result.ok, false);
  assert.equal(world.charter.influence, before);
  assert.equal(settlementActOptions(world).every(o => !o.enabled), true);
});
