/**
 * Phase D, second idea: death matters.
 *
 * The claims under test are the ones the world is not allowed to get wrong: a
 * death calls a gathering the world actually attends, a real quarrel outlives
 * the person holding it, everything lost is written down in a mourning
 * chronicle the legacy meter reads — and none of it depends on a model.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents, agentById } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import { arrive } from "../engine/systems/turnover.js";
import { callFuneral, settleMourning, deedsOf } from "../engine/systems/mourning.js";
import { applyEffects } from "../engine/systems/effects.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { adjustEdge } from "../engine/model/relationships.js";
import { wantReading } from "../engine/systems/want.js";
import { recentMemorials, pendingFunerals } from "../engine/model/mourning.js";
import { mourningMarks, describeBoard } from "../app/board.js";

/**
 * A world where a wanderer can actually die: departures happen every tick, only
 * an ancient adrift mind is eligible, and arrivals are switched off so nobody
 * else wanders in behind them.
 * @param {number} seed
 */
function deathWorld(seed) {
  return createWorld({
    seed,
    config: /** @type {any} */ ({
      turnover: {
        departureChance: 1,
        departureIntervalTicks: 1,
        lonelyTicks: 1,
        deathAgeTicks: 1,
        deathChance: 1,
        arrivalIntervalTicks: 100000,
        minCast: 1
      },
      mourning: { callDelayTicks: 6 }
    })
  });
}

/** @param {number} seed */
function departureWorld(seed) {
  return createWorld({
    seed,
    config: /** @type {any} */ ({
      turnover: {
        departureChance: 1,
        departureIntervalTicks: 1,
        lonelyTicks: 1,
        deathAgeTicks: 100000,
        deathChance: 0,
        arrivalIntervalTicks: 100000,
        minCast: 1
      }
    })
  });
}

/**
 * The newest funeral of a world, asserted to exist.
 * @param {import("../engine/model/world.js").World} world
 */
function latestFuneral(world) {
  const funeral = world.mourning.funerals.at(-1);
  assert.ok(funeral, "a funeral should exist");
  return funeral;
}

/**
 * An old, lonely wanderer arrives and is allowed to die of it. Returns them.
 * @param {import("../engine/model/world.js").World} world
 */
function burySomeone(world) {
  const wanderer = arrive(world);
  assert.ok(wanderer, "a wanderer should arrive");
  wanderer.createdTick = world.clock.tick - 5000;
  wanderer.needs.connection = 0;
  for (let i = 0; i < 600 && !wanderer.retired; i++) step(world);
  assert.equal(wanderer.retired, true, "the old, adrift wanderer should die");
  assert.equal(wanderer.departureKind, "died");
  return wanderer;
}

test("a death calls a gathering, and the world really turns up for it", () => {
  const world = deathWorld(11);
  const wanderer = burySomeone(world);

  const funeral = world.mourning.funerals.at(-1);
  assert.ok(funeral, "a funeral should have been called");
  assert.equal(funeral.agentId, wanderer.id);
  assert.equal(funeral.held, false, "the world is given a little time to hear");
  assert.ok(funeral.holdTick > funeral.calledTick, "and the gathering is set for later");
  assert.ok(world.events.some(e => e.kind === "mourning" && /is dead/.test(e.text)),
    "the death is announced in the world's record");

  // Play on until the gathering comes due.
  for (let i = 0; i < 40 && !funeral.held; i++) step(world);

  assert.equal(funeral.held, true, "the gathering happens");
  assert.ok(funeral.mourners.length >= 1, "somebody stands at the grave");
  for (const id of funeral.mourners) {
    const mourner = agentById(world, id);
    assert.ok(mourner && !mourner.retired, "the mourners are living minds");
    assert.equal(mourner.regionId, funeral.regionId, "and they went to where the grave is");
    assert.equal(mourner.mood, "grieving", "standing at a grave is its own weather");
  }

  const event = world.events.find(e => e.kind === "mourning" && /gathered at/.test(e.text));
  assert.ok(event, "the gathering is in the world's record");
  assert.ok(event.significance >= 0.8, "and it is significant enough for the chronicle");
  assert.match(event.text, new RegExp(wanderer.name));
});

test("the funeral reaches the day's chronicle, not just the feed", () => {
  const world = deathWorld(12);
  const wanderer = burySomeone(world);
  latestFuneral(world).holdTick = world.clock.tick;
  step(world);
  for (let i = 0; i < 80 && !world.chronicle.length; i++) step(world);
  assert.ok(world.chronicle.length >= 1, "the day should close");
  assert.match(/** @type {any} */ (world.chronicle[0]).summary, new RegExp(`${wanderer.name}|gathered`),
    "the day that buried them says so");
});

test("a real quarrel does not die with the person holding it", () => {
  const world = createWorld({ seed: 13, config: /** @type {any} */ ({ mourning: { callDelayTicks: 0 } }) });
  const [dead, heir, rival] = livingAgents(world);

  // The dead and the rival are in a vendetta; the heir is the one who loved
  // them. This is the shape that leaves a grudge walking around.
  adjustEdge(heir, dead.id, { affinity: 70, familiarity: 40 }, 0);
  adjustEdge(dead, rival.id, { resentment: 80, affinity: -40 }, 0);
  adjustEdge(rival, dead.id, { resentment: 80, affinity: -40 }, 0);
  const heirBefore = heir.relations[rival.id]?.resentment ?? 0;

  dead.retired = true; // the death, without playing out the whole turnover
  callFuneral(world, dead);
  const funeral = /** @type {any} */ (world.mourning.funerals.at(-1));
  funeral.holdTick = world.clock.tick;
  settleMourning(world);
  applyEffects(world, /** @type {any} */ (world.pendingOps || []), {});
  world.pendingOps = [];

  const inherited = Math.round(80 * world.config.mourning.inheritFactor);
  const heirAfter = heir.relations[rival.id]?.resentment ?? 0;
  assert.ok(heirAfter >= heirBefore + inherited - 1,
    `the heir should carry the grudge (${heirBefore} → ${heirAfter})`);
  assert.deepEqual(funeral.inherited, [{ heirId: heir.id, aboutId: rival.id }]);
  assert.ok(world.events.some(e => e.kind === "feud" && e.text.includes(heir.name) && e.text.includes(rival.name)),
    "and the world says so where it says things that matter");

  // Standing at the grave is remembered by the people who stood there.
  assert.ok(world.events.some(e => e.kind === "mourning" && e.text.includes(heir.name)),
    "the heir is named at the grave");
});

test("a mind carrying more quarrels than one person should passes on the worst of them", () => {
  const world = createWorld({ seed: 20, config: /** @type {any} */ ({ mourning: { callDelayTicks: 0 } }) });
  const living = livingAgents(world);
  const dead = living[0];
  const heir = living[1];
  adjustEdge(heir, dead.id, { affinity: 80, familiarity: 40 }, 0);
  // Six vendettas, each of a different weight.
  for (const rival of living.slice(2, 8)) {
    adjustEdge(dead, rival.id, { resentment: 90 - 5 * living.indexOf(rival), affinity: -40 }, 0);
    adjustEdge(rival, dead.id, { resentment: 80, affinity: -40 }, 0);
  }
  dead.retired = true;
  callFuneral(world, dead);
  latestFuneral(world).holdTick = world.clock.tick;
  settleMourning(world);

  const funeral = latestFuneral(world);
  assert.equal(funeral.inherited.length, world.config.mourning.maxInherit,
    "only the worst quarrels find a new pair of hands");
  const event = world.events.find(e => e.kind === "mourning" && /gathered at\b/.test(e.text));
  assert.ok(event);
  assert.ok((event.text.match(/took up/g) || []).length <= world.config.mourning.maxInherit,
    "and the funeral line stays a sentence, not a list");
});

test("a mind nobody loved takes their quarrels with them", () => {
  const world = createWorld({ seed: 14, config: /** @type {any} */ ({ mourning: { callDelayTicks: 0, heirAffinityMin: 95 } }) });
  const [dead, rival] = livingAgents(world);
  adjustEdge(dead, rival.id, { resentment: 90, affinity: -50 }, 0);
  adjustEdge(rival, dead.id, { resentment: 90, affinity: -50 }, 0);
  const rivalBefore = rival.relations[dead.id].resentment;

  dead.retired = true;
  callFuneral(world, dead);
  latestFuneral(world).holdTick = world.clock.tick;
  settleMourning(world);

  assert.equal(rival.relations[dead.id].resentment, rivalBefore, "nothing passed to anyone");
  assert.ok(!world.events.some(e => e.kind === "feud" && e.tick === world.clock.tick),
    "and no feud was invented to keep the story going");
  const event = world.events.find(e => e.kind === "mourning" && /ended at the grave/.test(e.text));
  assert.ok(event, "the record says the quarrel ended there");
});

test("what the world buries is written down, and it counts as legacy", () => {
  const world = deathWorld(15);
  const legacyBefore = wantReading(world).legacy;
  const wanderer = burySomeone(world);
  latestFuneral(world).holdTick = world.clock.tick;
  step(world);

  const memorial = recentMemorials(world.mourning, 1)[0];
  assert.equal(memorial.kind, "death");
  assert.equal(memorial.agentId, wanderer.id);
  assert.match(memorial.text, /was buried at/);
  assert.ok(memorial.mourners.length >= 1, "the memorial knows who stood there");
  assert.match(memorial.text, new RegExp(wanderer.name));

  // The reading counts the grave, and the ledger names the funeral: a death is
  // never invisible in the keeper's own score.
  const after = wantReading(world);
  assert.equal(after.terms.graves, 1);
  assert.ok(after.legacy > legacyBefore, `a grave is legacy (${legacyBefore} → ${after.legacy})`);
  const entry = world.want.log.find(e => /buried/.test(e.cause));
  assert.ok(entry, "the funeral is in the keeper's ledger");
  assert.equal(entry?.by, "world");
});

test("a mind that leaves is recorded too — nobody is quietly dropped", () => {
  const world = departureWorld(16);
  const wanderer = arrive(world);
  assert.ok(wanderer);
  wanderer.needs.connection = 0;
  for (let i = 0; i < 20 && !wanderer.retired; i++) step(world);

  assert.equal(wanderer.retired, true);
  assert.equal(wanderer.departureKind, "left");
  const memorial = recentMemorials(world.mourning, 1)[0];
  assert.equal(memorial.agentId, wanderer.id);
  assert.equal(memorial.kind, "departure");
  assert.match(memorial.text, /left/);
  assert.ok(world.events.some(e => e.kind === "mourning" && e.text.includes(wanderer.name)));
});

test("the memorial says what they did here, read off the world", () => {
  const world = createWorld({ seed: 17 });
  const [agent] = livingAgents(world);
  world.project.contributors[agent.id] = { work: 40, help: 2, interference: 0, lastTick: world.clock.tick };
  world.charter.roles.push({
    id: "role-x", name: "Wallwright", holderId: agent.id, basis: "more of the wall is theirs", tick: 0, weight: 30
  });
  const deeds = deedsOf(world, agent);
  assert.match(deeds, /Wallwright/);
  assert.match(deeds, /North Wall/);
});

test("the board shows the world burying, and then the grave", () => {
  const world = deathWorld(18);
  const wanderer = burySomeone(world);
  const marks = mourningMarks(world);
  assert.equal(marks.length, 1, "a funeral that has been called is on the board");
  assert.equal(marks[0].kind, "funeral");
  assert.equal(marks[0].agentId, wanderer.id);
  assert.match(describeBoard(world), /a funeral called for/);

  latestFuneral(world).holdTick = world.clock.tick;
  step(world);
  const graves = mourningMarks(world);
  assert.equal(graves[0].kind, "grave", "once filled, it is a cairn");
  assert.ok(graves[0].mourners >= 1);
  assert.match(describeBoard(world), /the world has buried 1/);
  assert.equal(pendingFunerals(world.mourning).length, 0, "nothing is still coming");
});

test("mourning is part of the world: saved, restored, reproducible", () => {
  const bury = (/** @type {import("../engine/model/world.js").World} */ world) => {
    const wanderer = burySomeone(world);
    latestFuneral(world).holdTick = world.clock.tick;
    step(world);
    return wanderer;
  };
  const a = deathWorld(19);
  const b = deathWorld(19);
  bury(a);
  bury(b);
  assert.deepEqual(a.mourning, b.mourning, "the same world buries the same way");
  assert.deepEqual(a.want.log, b.want.log, "and the keeper's ledger agrees");

  const resumed = deserializeWorld(serializeWorld(a));
  assert.deepEqual(resumed.mourning, a.mourning, "graves survive a save");
});
