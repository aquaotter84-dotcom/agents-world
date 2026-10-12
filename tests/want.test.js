/**
 * Phase D, first idea: the keeper's want.
 *
 * Harmony, prosperity and legacy are the keeper's own score, and the claim
 * under test is that they are honest: read off the world's real condition,
 * moved by what the keeper actually does, moved *visibly* (every movement in a
 * ledger with its cause), and — the part that makes them a game — able to decay
 * when the world stops asking the keeper for anything.
 *
 * Nothing here involves a model. These are engine facts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import { livingAgents } from "../engine/model/world.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { adjustEdge } from "../engine/model/relationships.js";
import { ruleOnPetition, resolveDilemma, actOnWhisper } from "../engine/systems/charter.js";
import { wantReading, wantSummary, settleWant, noteAsk, quietState } from "../engine/systems/want.js";
import { describeBoard, keeperRing } from "../app/board.js";

/**
 * One meter out of a summary, with the lookup narrowed for the type-checker.
 * @param {import("../engine/model/world.js").World} world
 * @param {string} key
 * @returns {NonNullable<ReturnType<typeof wantSummary>["meters"][number]>}
 */
function meter(world, key) {
  const found = wantSummary(world).meters.find(m => m.key === key);
  assert.ok(found, `the summary should carry a ${key} meter`);
  return found;
}

/** @param {import("../engine/model/world.js").World} world @param {string} key */
function value(world, key) {
  return meter(world, key).value;
}

/**
 * Run a world forward with nobody answering the model's moments — the engine
 * expires each one and decides it itself, exactly as a keyless world does.
 * @param {import("../engine/model/world.js").World} world
 * @param {number} ticks
 */
function run(world, ticks) {
  for (let i = 0; i < ticks; i++) step(world);
  return world;
}

test("the meters are read off the world, not invented", () => {
  const world = createWorld({ seed: 41 });
  const before = wantReading(world);
  /** @type {["harmony", "prosperity", "legacy"]} */
  const meters = ["harmony", "prosperity", "legacy"];
  for (const key of meters) {
    assert.equal(typeof before[key], "number", `${key} reads as a number`);
    assert.ok(before[key] >= 0 && before[key] <= 100, `${key} stays inside 0..100`);
  }
  // A reading nobody can explain is a reading nobody can act on: every meter
  // comes with the facts it was read from.
  assert.equal(typeof before.terms, "object");
  assert.equal(typeof before.terms.bonds, "number");
  assert.equal(typeof before.terms.wall, "number");

  // A vendetta is a fact about two minds, and harmony must fall for it.
  const [a, b] = livingAgents(world);
  adjustEdge(a, b.id, { resentment: 80 }, world.clock.tick);
  adjustEdge(b, a.id, { resentment: 80 }, world.clock.tick);
  const feuding = wantReading(world);
  assert.ok(feuding.harmony < before.harmony, `a vendetta should cost harmony (${before.harmony} → ${feuding.harmony})`);
  assert.equal(feuding.terms.vendettas, before.terms.vendettas + 1, "the vendetta is counted as a vendetta");

  // Loneliness is harmony's other opposite: make every mind alone and watch it
  // fall further still.
  for (const agent of livingAgents(world)) agent.needs.connection = 0;
  const lonely = wantReading(world);
  assert.ok(
    lonely.harmony < feuding.harmony,
    `a world where nobody is held should be worse than one feud (${feuding.harmony} → ${lonely.harmony})`
  );
  assert.equal(lonely.terms.lonely, livingAgents(world).length);

  // And a bond is worth something: put everyone's connection back and give two
  // minds a mutual affection; the reading comes up by exactly that bond.
  for (const agent of livingAgents(world)) agent.needs.connection = 60;
  const recovered = wantReading(world);
  const [c, d] = livingAgents(world);
  adjustEdge(c, d.id, { affinity: 70 }, world.clock.tick);
  adjustEdge(d, c.id, { affinity: 70 }, world.clock.tick);
  const bonded = wantReading(world);
  assert.ok(bonded.harmony > recovered.harmony, `a bond is harmony the other way (${recovered.harmony} → ${bonded.harmony})`);
  assert.equal(bonded.terms.bonds, recovered.terms.bonds + 1);
});

test("prosperity follows the shared work and legacy follows what endures", () => {
  const world = createWorld({ seed: 42 });
  const before = wantReading(world);

  // Put stone on the wall and hands on the stone: prosperity must notice.
  world.project.progress = 60;
  world.project.lastWorkTick = world.clock.tick;
  for (const agent of livingAgents(world).slice(0, 3)) {
    world.project.contributors[agent.id] = { work: 12, help: 0, interference: 0, lastTick: world.clock.tick };
  }
  const working = wantReading(world);
  assert.ok(working.prosperity > before.prosperity, "the wall going up is prosperity");

  // A law that stands, a role the world uses, a day in the chronicle: legacy.
  world.charter.active.debts_honoured = 1;
  world.charter.roles.push({ id: "role1", name: "Wallwright", holderId: livingAgents(world)[0].id, basis: "test", tick: 0, weight: 12 });
  world.chronicle.push({ day: 1, tick: 48, summary: "A day.", notableCount: 1, stats: {} });
  const enduring = wantReading(world);
  assert.ok(enduring.legacy > before.legacy, "a standing law and a used role are legacy");
});

test("a keeper act moves the meters and writes down why it happened", () => {
  const world = createWorld({ seed: 43 });
  const agent = livingAgents(world)[0];
  const legacyBefore = value(world, "legacy");
  const harmonyBefore = value(world, "harmony");

  world.charter.petitions.push({
    id: "pet-test",
    agentId: agent.id,
    text: "Let the wall come first.",
    ruleKind: "wall_first",
    kind: "law",
    tick: world.clock.tick,
    support: 3,
    oppose: 0,
    basis: "Three minds have worked on the wall.",
    status: "open",
    cost: 0
  });
  noteAsk(world, "a petition");
  const ruled = ruleOnPetition(world, "pet-test", "enact");
  assert.equal(ruled.ok, true);

  const after = wantSummary(world);
  assert.equal(meter(world, "legacy").cause, "you enacted The wall comes first", "the ledger names the act");
  assert.ok(value(world, "legacy") > legacyBefore, "enacting raises legacy");
  assert.ok(value(world, "harmony") > harmonyBefore, "being heard raises harmony");
  assert.ok(after.asks >= 1, "the ask is counted");
});

test("ignoring the world costs harmony, and an unanswered petition is counted", () => {
  const world = createWorld({ seed: 44 });
  world.config.charter.petitionLapseTicks = 1;
  const agent = livingAgents(world)[0];
  world.charter.petitions.push({
    id: "pet-old",
    agentId: agent.id,
    text: "Something nobody answered.",
    ruleKind: "wall_first",
    kind: "law",
    tick: 0,
    support: 1,
    oppose: 0,
    basis: "A wall nobody is lifting.",
    status: "open",
    cost: 0
  });
  const before = value(world, "harmony");
  step(world); // settleCharter lapses the petition
  const after = wantSummary(world);
  assert.equal(after.ignored, 1, "the lapse is counted as ignored");
  assert.ok(value(world, "harmony") < before, "an unanswered ask should cost harmony immediately");
});

test("acting on a whisper and settling a dilemma both move the keeper's own score", () => {
  const world = createWorld({ seed: 45 });
  const [a, b] = livingAgents(world);
  world.charter.whispers.push({ id: "whi-test", agentId: a.id, aboutId: b.id, text: "They are hiding something.", tick: world.clock.tick });
  world.charter.dilemmas.push({ id: "dil-test", text: "They cannot share a place.", partyIds: [a.id, b.id], kind: "feud", tick: world.clock.tick, status: "open" });
  noteAsk(world, "a dilemma");
  const legacyBefore = value(world, "legacy");

  assert.equal(actOnWhisper(world, "whi-test").ok, true);
  assert.equal(resolveDilemma(world, "dil-test", "mediate").ok, true);

  const after = wantSummary(world);
  const causes = after.meters.filter(m => m.cause).map(m => m.cause);
  assert.ok(causes.includes("you acted on something told to you in private"), causes.join(" | "));
  assert.ok(causes.includes("you chose to mediate"), causes.join(" | "));
  assert.ok(value(world, "legacy") > legacyBefore,
    "acting on a whisper stands as legacy even while it costs harmony");
});

test("a world that stops asking drains its harmony, and says so out loud", () => {
  const world = createWorld({ seed: 46 });
  world.config.want.quietAfterTicks = 20;
  world.config.want.quietLogIntervalTicks = 10;
  // The world has asked nothing since it began; let it run past the threshold.
  run(world, 26);
  const quiet = quietState(world);
  assert.equal(quiet.draining, true, "silence past the threshold counts as draining");
  assert.ok(meter(world, "harmony").drift <= 0, "harmony is being pulled down");
  const warnings = world.events.filter(e => e.kind === "want" && /nothing has asked|getting used to deciding/i.test(e.text));
  assert.ok(warnings.length >= 1, "the quiet is written into the world's record, not just felt");

  // An ask breaks the silence at once and the drain stops.
  noteAsk(world, "a whisper");
  assert.equal(quietState(world).draining, false, "an ask ends the quiet");
  assert.equal(world.want.quietTicks, 0);
});

test("a world that never asks again falls quiet, and can be brought back", () => {
  const world = createWorld({ seed: 47 });
  world.config.want.quietAfterTicks = 5;
  world.config.want.quietDecayPerTick = 6;
  world.config.want.quietMaxPenalty = 100;
  world.config.want.fallenGraceTicks = 2;
  world.config.want.driftPerTick = 8;
  run(world, 40);
  assert.equal(world.want.fallen, true, "enough silence spends all the harmony there was");
  assert.equal(world.want.harmony <= 1, true);
  const fall = world.events.find(e => e.kind === "want" && /gone quiet/i.test(e.text));
  assert.ok(fall, "the fall is announced in the record");
  assert.ok(fall.significance >= 0.9, "and it matters when it happens");

  noteAsk(world, "a petition");
  assert.equal(world.want.fallen, false, "a world that is asked again comes back");
  assert.equal(world.want.revivals, 1);
  assert.ok(world.events.some(e => e.kind === "want" && /asks again/i.test(e.text)));
});

test("the meters are part of the world: they survive a save", () => {
  const world = createWorld({ seed: 48 });
  run(world, 30);
  const saved = serializeWorld(world);
  const resumed = deserializeWorld(saved);
  assert.deepEqual(resumed.want, world.want, "the keeper's own score is persisted with the world");
  assert.equal(JSON.stringify(resumed.want).includes("\"log\""), true, "and so is the ledger of what moved it");
});

test("the board shows the keeper's want, not only the panel", () => {
  const world = createWorld({ seed: 49 });
  run(world, 12);
  const ring = keeperRing(world);
  assert.equal(ring.meters.length, 3);
  assert.deepEqual(ring.meters.map(m => m.key), ["harmony", "prosperity", "legacy"]);
  for (const meter of ring.meters) {
    assert.ok(meter.value >= 0 && meter.value <= 100);
    assert.ok(typeof meter.color === "string" && meter.color.startsWith("#"));
    assert.ok(typeof meter.word === "string" && meter.word.length > 0);
  }
  assert.match(describeBoard(world), /the keeper's want: harmony \d+/);
});

test("the same world and the same acts produce the same meters", () => {
  const a = createWorld({ seed: 50 });
  const b = createWorld({ seed: 50 });
  run(a, 60);
  run(b, 60);
  assert.deepEqual(a.want, b.want);
  assert.deepEqual(wantReading(a), wantReading(b));
});

test("a world left to itself keeps a ledger of where its meters went", () => {
  const world = createWorld({ seed: 51 });
  run(world, 200);
  // Nobody was at the screen, and the meters still followed the world: the tick
  // of the last reading is current, the numbers are finite, and the ledger has
  // the drift to explain them.
  assert.equal(world.want.tick, world.clock.tick, "the reading is current as of the last tick run");
  /** @type {["harmony", "prosperity", "legacy"]} */
  const meters = ["harmony", "prosperity", "legacy"];
  for (const key of meters) assert.ok(Number.isFinite(world.want[key]));
  assert.ok(world.want.log.length > 0, "the ledger fills even with no keeper at the screen");
  assert.ok(world.want.log.some(entry => entry.by === "drift"), "and it records the world's own condition");
});
