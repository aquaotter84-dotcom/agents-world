/**
 * Behavioural tests: does the simulation actually behave like a world?
 *
 * These are the tests that stop the balance regressing. Every one of them
 * corresponds to something that went wrong during development — a world that
 * emptied out into a single region, needs that saturated and killed all
 * motivation, confessions that crowded out every other action.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, worldStats, livingAgents, privateSecretsHeld } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import { socialTemperature } from "../engine/systems/social.js";
import { NEED_KEYS } from "../engine/model/agent.js";
import { advanceWithModel, offlineWorld } from "./helpers.mjs";

test("needs stay inside their bounds for a long run", () => {
  const world = offlineWorld({ seed: 3, ticks: 600 });
  for (const agent of world.agents) {
    for (const key of NEED_KEYS) {
      const value = agent.needs[key];
      assert.ok(Number.isFinite(value), `${agent.name}.${key} is not a number`);
      assert.ok(value >= 0 && value <= 100, `${agent.name}.${key} = ${value} out of range`);
    }
    assert.ok(Number.isFinite(agent.xp) && agent.xp >= 0, `${agent.name} has bad xp`);
    assert.ok(agent.level >= 1, `${agent.name} has level ${agent.level}`);
  }
});

test("need pressure is never permanently dead", () => {
  // If every need saturates at 100 the world stops having reasons to act, and
  // the simulation goes quiet without anything reporting an error.
  const world = advanceAndSample();
  let total = 0;
  let count = 0;
  for (const agent of world.agents) {
    for (const key of NEED_KEYS) {
      total += agent.needs[key];
      count += 1;
    }
  }
  const mean = total / count;
  assert.ok(mean < 92, `mean need level ${mean.toFixed(1)} — the world has saturated`);
  assert.ok(mean > 20, `mean need level ${mean.toFixed(1)} — the world is in permanent crisis`);
});

test("the map stays populated", () => {
  // A world where everyone drifts into one region and never leaves has lost
  // five sixths of its settings for no visible reason.
  const world = offlineWorld({ seed: 11, ticks: 900 });
  const occupied = new Set(world.agents.map(a => a.regionId));
  assert.ok(
    occupied.size >= 3,
    `only ${occupied.size} region(s) occupied: ${[...occupied].join(", ")}`
  );
  const stats = worldStats(world);
  assert.ok(stats.busiest, "the world should report a busiest region");
});

test("a mind that collapses comes back", () => {
  const world = createWorld({ seed: 4 });
  const agent = world.agents[0];
  agent.needs.energy = 1;
  agent.awake = true;
  for (let i = 0; i < 40; i++) step(world);
  assert.ok(
    world.agents[0].awake,
    "a mind that ran out of energy should recover rather than being gone forever"
  );
});

test("moments expire when nobody answers them", () => {
  // The engine must never be blocked on a model that is slow, absent, or dead.
  const world = createWorld({ seed: 8 });
  for (let i = 0; i < 200; i++) step(world);
  const limit = world.config.moments.maxPendingTicks;
  for (const moment of world.pending) {
    assert.ok(
      world.clock.tick - moment.tick < limit,
      `moment ${moment.id} has been pending for ${world.clock.tick - moment.tick} ticks`
    );
  }
  assert.ok(world.resolved.length > 0, "expired moments should be recorded as engine-resolved");
});

test("at most the configured number of moments are offered per tick", () => {
  const world = createWorld({ seed: 21 });
  const cap = world.config.moments.maxPerTick;
  for (let i = 0; i < 120; i++) {
    const report = step(world);
    assert.ok(report.moments.length <= cap, `offered ${report.moments.length}, cap is ${cap}`);
  }
});

test("memory stays bounded while the world runs", () => {
  const world = offlineWorld({ seed: 6, ticks: 1200 });
  const cap = world.config.limits.agentMemories;
  for (const agent of world.agents) {
    assert.ok(
      agent.memory.traces.length <= cap,
      `${agent.name} holds ${agent.memory.traces.length} traces, cap is ${cap}`
    );
  }
});

test("long histories are consolidated rather than truncated", () => {
  const world = offlineWorld({ seed: 6, ticks: 1200 });
  const summaries = world.agents.reduce(
    (n, a) => n + a.memory.traces.filter(t => t.consolidated).length,
    0
  );
  assert.ok(summaries > 0, "an old world should hold consolidated memories of its past");
});

test("the world develops relationships in both directions", () => {
  const world = offlineWorld({ seed: 5, ticks: 800 });
  const stats = socialTemperature(world);
  assert.ok(stats.affection > 0, "some minds should end up liking each other");
  assert.ok(stats.friction > 0, "some minds should end up resenting each other");
});

test("conflict does not consume the world", () => {
  // A world where every other event is an argument is not dramatic, it is stuck.
  const world = offlineWorld({ seed: 13, ticks: 960 });
  const tallies = world.tallies;
  const conflict = tallies.conflict || 0;
  const contact = tallies.contact || 0;
  assert.ok(contact > 0, "minds should spend time together");
  assert.ok(
    conflict < contact,
    `${conflict} conflicts against ${contact} contacts — the world has tipped into perpetual argument`
  );
});

test("drama actually happens over a long run", () => {
  const world = offlineWorld({ seed: 2, ticks: 1800 });
  const tallies = world.tallies;
  assert.ok((tallies.confide || 0) > 0, "nobody ever confided in anyone");
  assert.ok((tallies.gossip || 0) > 0, "no gossip ever circulated");
  assert.ok((tallies.betrayal || 0) > 0, "no secret was ever used against anyone");
  assert.ok((tallies.level || 0) > 0, "nobody ever grew");
});

test("secrets are held and eventually get out", () => {
  const world = offlineWorld({ seed: 17, ticks: 1400 });
  assert.ok(world.secrets.length > 0, "the world should have secrets");
  const revealed = world.secrets.filter(s => s.isPublic).length;
  assert.ok(revealed > 0, "words should get out eventually");
  for (const secret of world.secrets) {
    assert.ok(Object.keys(secret.holders).length > 0, `${secret.id} is held by nobody`);
  }
});

test("no mind is allowed to hoard every secret", () => {
  const world = createWorld({ seed: 42 });
  advanceWithModel(world, 1500);
  const cap = world.config.limits.secretsPerAgent;
  for (const agent of world.agents) {
    assert.ok(
      privateSecretsHeld(world, agent.id).length <= cap,
      `${agent.name} carries ${privateSecretsHeld(world, agent.id).length} private secrets, cap is ${cap}`
    );
  }
  assert.ok(
    world.secrets.length <= world.config.limits.secretsInWorld,
    "the world should not accumulate secrets without limit"
  );
});

test("chronicles are written and read like days", () => {
  const world = offlineWorld({ seed: 23, ticks: 500 });
  assert.ok(world.chronicle.length >= 8, `only ${world.chronicle.length} day summaries written`);
  for (const day of /** @type {any[]} */ (world.chronicle)) {
    assert.equal(typeof day.summary, "string");
    assert.ok(day.summary.length > 10, `day ${day.day} has an empty summary`);
    assert.ok(day.day >= 1);
  }
});

test("an event log never grows without bound", () => {
  const world = offlineWorld({ seed: 24, ticks: 900 });
  assert.ok(world.events.length <= world.config.limits.events);
  assert.ok(world.seq > world.events.length, "the log should be a window onto a longer history");
  const counted = Object.values(world.tallies).reduce((a, b) => a + b, 0);
  assert.ok(counted >= world.seq - 1, "lifetime tallies should account for every event");
});

test("every mind has somewhere to be and something to want", () => {
  const world = createWorld({ seed: 3 });
  for (const agent of world.agents) {
    assert.ok(agent.regionId, `${agent.name} has no region`);
    assert.ok(agent.homeRegionId, `${agent.name} has no home`);
    assert.ok(agent.goal && agent.goal.text.length > 3, `${agent.name} has no goal`);
    assert.ok(world.regions.some(r => r.id === agent.regionId));
  }
  assert.equal(livingAgents(world).length, world.agents.length);
});

/** @returns {import("../engine/model/world.js").World} */
function advanceAndSample() {
  const world = createWorld({ seed: 15 });
  advanceWithModel(world, 700);
  return world;
}
