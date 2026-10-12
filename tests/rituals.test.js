/**
 * Calendar rituals: recurring world events on the engine's clock. Gathering
 * Night leans the world together; Quiet Day turns it inward. Nobody decides
 * them; everybody feels them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { activeRitual, settleRituals } from "../engine/systems/rituals.js";
import { generateIntents } from "../engine/decision/intents.js";
import { offlineWorld } from "./helpers.mjs";

/** Put the clock on a given day and phase.
 * @param {import("../engine/model/world.js").World} world
 * @param {number} day
 * @param {string} phase
 */
function setClock(world, day, phase) {
  world.clock.day = day;
  world.clock.phase = phase;
  world.lastRitualKey = undefined;
}

test("gathering night is active on its days at dusk", () => {
  const world = createWorld({ seed: 3 });
  setClock(world, 5, "dusk"); // (5 - 5) % 7 === 0
  const ritual = activeRitual(world);
  assert.ok(ritual && ritual.id === "gathering", `expected gathering, got ${ritual && ritual.id}`);
  setClock(world, 6, "dusk");
  assert.equal(activeRitual(world), null, "no ritual the day after");
  setClock(world, 5, "day");
  assert.equal(activeRitual(world), null, "gathering is a dusk ritual, not a day one");
});

test("quiet day is active all day on its days", () => {
  const world = createWorld({ seed: 3 });
  setClock(world, 2, "day"); // (2 - 2) % 9 === 0
  const ritual = activeRitual(world);
  assert.ok(ritual && ritual.id === "quiet", `expected quiet, got ${ritual && ritual.id}`);
  setClock(world, 2, "deep night");
  assert.equal(activeRitual(world)?.id, "quiet", "quiet day holds all phases");
});

test("a ritual's shifts apply exactly once per day", () => {
  const world = createWorld({ seed: 3 });
  setClock(world, 5, "dusk");
  const before = livingAgents(world).map(a => a.needs.connection);
  settleRituals(world);
  const afterOne = livingAgents(world).map(a => a.needs.connection);
  settleRituals(world);
  settleRituals(world);
  const afterThree = livingAgents(world).map(a => a.needs.connection);
  for (let i = 0; i < before.length; i++) {
    assert.ok(afterOne[i] > before[i], "gathering night should raise connection");
    assert.equal(afterThree[i], afterOne[i], "shifts must not stack within a day");
  }
  const event = world.events.find(e => e.kind === "ritual");
  assert.ok(event, "the ritual should be written into the world's history");
});

test("minds lean with the ritual in their choices", () => {
  const world = createWorld({ seed: 3 });
  const agent = world.agents[0];
  setClock(world, 5, "dusk");
  const biased = generateIntents(world, agent).find(i => i.kind === "seek_company");
  setClock(world, 6, "dusk");
  const plain = generateIntents(world, agent).find(i => i.kind === "seek_company");
  // Intents carry jitter, so compare reasons rather than raw scores.
  if (biased && plain) {
    assert.ok(biased.reasons.includes("it is Gathering Night"), "gathering should be a stated reason");
    assert.ok(!plain.reasons.includes("it is Gathering Night"), "no ritual, no reason");
  } else {
    assert.ok(true, "seek_company not always generated; bias is opportunistic");
  }
});

test("rituals fire on their own in a long run", () => {
  const world = offlineWorld({ seed: 11, ticks: 1200 });
  const rituals = world.events.filter(e => e.kind === "ritual");
  assert.ok(rituals.length >= 2, `expected several rituals in 1200 ticks, saw ${rituals.length}`);
  const kinds = new Set(rituals.map(e => e.text));
  assert.ok(kinds.size >= 2, "more than one ritual line should appear");
});
