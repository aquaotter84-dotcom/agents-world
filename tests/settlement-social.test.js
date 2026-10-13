/**
 * Phase F, the social layer as the strategy layer: feuds block and split
 * crews, an exposed secret tanks a building, mourning hands build
 * slower, and a memorial raised together binds its builders.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents, createSecret, publishSecret } from "../engine/model/world.js";
import { runTicks, step } from "../engine/simulation.js";
import { resolveIntent } from "../engine/systems/act.js";
import { applyEffects } from "../engine/systems/effects.js";
import { assignCrew, startConstruction } from "../engine/systems/settlement.js";
import { buildingByKind, crewFeudWarning } from "../engine/model/settlement.js";
import { edgeToward, adjustEdge } from "../engine/model/relationships.js";

/** @param {number} seed */
function gameWorld(seed = 131) {
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

test("two minds in a feud cannot staff the same workshop; a grudge still can", () => {
  const world = gameWorld();
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  const [a, b] = livingAgents(world);
  adjustEdge(a, b.id, { resentment: 45 }, 0);
  adjustEdge(b, a.id, { resentment: 45 }, 0);
  assert.equal(assignCrew(world, fields.id, a.id).ok, true);
  const blocked = assignCrew(world, fields.id, b.id);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason || "", /rivalry|vendetta/);
  assert.match(blocked.reason || "", /Rearrange/);
  assert.deepEqual(fields.crew, [a.id]);

  // Cool it to a grudge and the same two hands are allowed back together.
  // (Set outright: the seed may already have them hot with each other.)
  edgeToward(a, b.id).resentment = 20;
  edgeToward(b, a.id).resentment = 20;
  assert.equal(assignCrew(world, fields.id, b.id).ok, true);
});

test("a feud that escalates inside a crew splits it, and the camp is told", () => {
  const world = gameWorld(132);
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  const [a, b] = livingAgents(world);
  assignCrew(world, fields.id, a.id);
  assignCrew(world, fields.id, b.id);
  adjustEdge(a, b.id, { resentment: 70 }, 0);
  adjustEdge(b, a.id, { resentment: 70 }, 0);
  step(world);
  assert.equal(fields.crew.length, 1, "one of the feuding hands comes off the roster");
  assert.ok(world.settlement.crewSplitTick >= 0);
  assert.ok(world.events.some(e => e.kind === "settlement" && /can no longer staff/.test(e.text)));
});

test("a crew feud on the way up is visible before it splits", () => {
  const world = gameWorld(133);
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  const [a, b] = livingAgents(world);
  assignCrew(world, fields.id, a.id);
  assignCrew(world, fields.id, b.id);
  assert.equal(crewFeudWarning(world), null);
  adjustEdge(a, b.id, { resentment: 28 }, 0); // a grudge, close to rivalry
  const warning = crewFeudWarning(world);
  assert.ok(warning);
  assert.equal(warning.building.id, fields.id);
  assert.equal(warning.heat, 28);
});

test("a secret getting out tanks the output of the whole building it touches", () => {
  /** @param {boolean} expose */
  function campWithExposed(expose) {
    const world = gameWorld(134);
    const fields = buildingByKind(world.settlement, "fields");
    assert.ok(fields);
    const crew = livingAgents(world).slice(0, 3);
    for (const m of crew) assignCrew(world, fields.id, m.id);
    world.settlement.stores.food = 60;
    if (expose) {
      const secret = createSecret(world, {
        kind: "theft", text: `${crew[0].name} has been skimming from the stores`,
        aboutId: crew[0].id, holderId: crew[1].id
      });
      assert.ok(secret);
      publishSecret(world, secret);
    }
    runTicks(world, 49);
    return world.settlement.lastDaily?.foodProduced ?? 0;
  }
  const clean = campWithExposed(false);
  const exposed = campWithExposed(true);
  assert.ok(clean > 5, `a clean crew produces (${clean})`);
  assert.ok(exposed < clean * 0.65, `an exposed crew produces ${exposed} against ${clean}`);
});

test("a mourning crew builds slower: grief is in the hands, not just the mood", () => {
  /** @param {boolean} grieving */
  function buildOnce(grieving) {
    const world = gameWorld(135);
    const [a] = livingAgents(world);
    startConstruction(world, "workshop");
    const workshop = buildingByKind(world.settlement, "workshop");
    assert.ok(workshop);
    a.regionId = workshop.regionId;
    if (grieving) { a.mood = "grieving"; a.moodUntil = world.clock.tick + 999; }
    perform(world, a, "settlement_build", workshop.id);
    return workshop.progress;
  }
  const steady = buildOnce(false);
  const mourning = buildOnce(true);
  assert.ok(steady > 0);
  assert.ok(mourning < steady * 0.7, `mourning hands put in ${mourning} against ${steady}`);
  assert.ok(Math.abs(mourning / steady - world0Factor()) < 0.15, "and by the configured factor");
  function world0Factor() {
    return createWorld({ seed: 1 }).config.settlement.mourningWorkFactor;
  }
});

test("a memorial built together binds its builders closer, in both directions", () => {
  const world = gameWorld(136);
  const [a, b] = livingAgents(world);
  // The camp has lost somebody; that is what a memorial is for.
  world.mourning.memorials.push(/** @type {any} */ ({
    id: "mem-test", agentId: "m-gone", name: "The Gone", epithet: "", kind: "death",
    regionId: "crossroads", tick: 0, day: 1, mourners: [], heirs: [], inherited: [],
    text: "The Gone was buried.", deeds: "was here"
  }));
  assert.equal(startConstruction(world, "memorial").ok, true);
  const memorial = buildingByKind(world.settlement, "memorial");
  assert.ok(memorial);
  for (const agent of [a, b]) agent.regionId = memorial.regionId;
  const aBefore = { ...edgeToward(a, b.id) };
  const bBefore = { ...edgeToward(b, a.id) };
  let guard = 0;
  while (memorial.status === "building" && guard++ < 20) {
    perform(world, guard % 2 ? a : b, "settlement_build", memorial.id);
  }
  assert.equal(memorial.status, "active");
  assert.ok(edgeToward(a, b.id).affinity > aBefore.affinity + 5, "affection grew from shared work");
  assert.ok(edgeToward(b, a.id).trust > bBefore.trust + 5, "and so did trust, from the other side too");
  assert.ok(a.memory.traces.some(t => /raised the Memorial together/.test(t.text)));
  assert.ok(world.events.some(e => e.kind === "building" && /Memorial stands/.test(e.text)));
});
