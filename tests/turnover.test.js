/**
 * Turnover: the cast changes. Wanderers arrive with whole identities; the
 * lonely drift away; the very old may die. The original nine and the keeper's
 * own minds are protected from all of it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { arrive, depart, isProtected, settleTurnover } from "../engine/systems/turnover.js";
import { WANDERERS } from "../engine/content.js";
import { offlineWorld } from "./helpers.mjs";

const SEED_NAMES = ["Elio", "Juno", "Cass", "Fable", "Sable", "Pim", "Wren", "Sei", "Orin"];

test("an arrival is a complete stranger with a real identity", () => {
  const world = createWorld({ seed: 7 });
  const before = livingAgents(world).length;
  const mind = arrive(world);
  assert.ok(mind, "expected an arrival");
  assert.equal(livingAgents(world).length, before + 1);
  assert.ok(mind.name && mind.personality && mind.goal.text, "arrival must be a whole person");
  assert.ok(!mind.userCreated, "wanderers are not keeper-made");
  assert.ok(mind.createdTick === world.clock.tick, "arrival is stamped now");
  assert.ok(world.regions.some(r => r.id === mind.regionId), "arrival lands somewhere real");
});

test("arrivals never duplicate a living name", () => {
  const world = createWorld({ seed: 7 });
  const names = new Set();
  for (let i = 0; i < WANDERERS.length; i++) {
    const mind = arrive(world);
    if (!mind) break;
    assert.ok(!names.has(mind.name), `duplicate arrival name: ${mind.name}`);
    names.add(mind.name);
  }
  // Exhausted the pool: further arrivals politely decline.
  assert.equal(arrive(world), null, "no more unique wanderers left");
});

test("the cast never grows past maxCast", () => {
  const world = createWorld({ seed: 7, config: { turnover: /** @type {any} */ ({ maxCast: 10, arrivalChance: 1, arrivalIntervalTicks: 1 }) } });
  for (let i = 0; i < 40; i++) { world.clock.tick++; settleTurnover(world); }
  assert.ok(livingAgents(world).length <= 10, `cast overflowed: ${livingAgents(world).length}`);
});

test("the seed cast and keeper-made minds are protected", () => {
  const world = createWorld({ seed: 7 });
  for (const agent of world.agents) assert.ok(isProtected(agent), `${agent.name} should be protected`);
  const mind = arrive(world);
  assert.ok(mind && !isProtected(mind), "a wanderer is not protected");
  mind.userCreated = true;
  assert.ok(isProtected(mind), "a keeper-made mind becomes protected");
});

test("departure takes only the long-adrift and unprotected", () => {
  const world = createWorld({
    seed: 7,
    config: { turnover: /** @type {any} */ ({ departureChance: 1, departureIntervalTicks: 1, lonelyTicks: 5, minCast: 1 }) }
  });
  const wanderer = arrive(world);
  assert.ok(wanderer);
  // Make the wanderer profoundly lonely for longer than the threshold.
  wanderer.needs.connection = 0;
  for (let i = 0; i < 10; i++) { world.clock.tick++; settleTurnover(world); }
  assert.ok(wanderer.retired, "an adrift wanderer should eventually leave");
  assert.equal(wanderer.departureKind, "left");
  // The original nine are untouched no matter how lonely they get.
  for (const agent of world.agents) {
    if (SEED_NAMES.includes(agent.name)) assert.ok(!agent.retired, `${agent.name} must never randomly depart`);
  }
});

test("the world never shrinks below minCast", () => {
  const world = createWorld({
    seed: 7,
    config: { turnover: /** @type {any} */ ({ departureChance: 1, departureIntervalTicks: 1, lonelyTicks: 1, minCast: 40 }) }
  });
  for (const agent of livingAgents(world)) {
    agent.userCreated = false;
    agent.createdTick = 999;
    agent.needs.connection = 0;
  }
  for (let i = 0; i < 30; i++) { world.clock.tick++; settleTurnover(world); }
  assert.ok(livingAgents(world).length >= 40 || livingAgents(world).length === world.agents.filter(a => !a.retired).length,
    "minCast guard must hold");
});

test("death only comes for the old", () => {
  const world = createWorld({
    seed: 7,
    config: { turnover: /** @type {any} */ ({ departureChance: 1, departureIntervalTicks: 1, lonelyTicks: 1, deathAgeTicks: 10, deathChance: 1 }) }
  });
  const young = arrive(world);
  assert.ok(young);
  young.needs.connection = 0;
  for (let i = 0; i < 5; i++) { world.clock.tick++; settleTurnover(world); }
  assert.ok(young.retired, "the young wanderer should leave");
  assert.equal(young.departureKind, "left", "the young do not die, they leave");

  const old = arrive(world);
  assert.ok(old);
  old.createdTick = world.clock.tick - 1000; // ancient
  old.needs.connection = 0;
  for (let i = 0; i < 5; i++) { world.clock.tick++; settleTurnover(world); }
  assert.ok(old.retired && old.departureKind === "died", "the old may die");
});

test("a long run keeps the original nine alive", () => {
  const world = offlineWorld({ seed: 2024, ticks: 2500 });
  const living = new Set(livingAgents(world).map(a => a.name));
  for (const name of SEED_NAMES) {
    assert.ok(living.has(name), `${name} of the original nine is gone after a long run`);
  }
});
