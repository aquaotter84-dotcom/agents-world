/**
 * Favours & call-ins: the debt ledger and the moments it produces.
 *
 * Every one of these tests corresponds to a real bug found while building the
 * system — a ledger read backwards, a creation cooldown missing, call-ins that
 * minted instant friendships and broke the map's dispersal, prose that
 * lower-cased proper nouns.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, agentById } from "../engine/model/world.js";
import { edgeToward, decayRelations, relationsSummary } from "../engine/model/relationships.js";
import { applyEffects } from "../engine/systems/effects.js";
import { buildMoment } from "../engine/decision/moments.js";
import { generateIntents } from "../engine/decision/intents.js";
import { resolveMoment } from "../engine/simulation.js";
import { phrase, momentLine } from "../engine/decision/prose.js";

/**
 * Two agents standing in the same region, ready to owe each other things.
 * @param {number} [seed]
 */
function twoMinds(seed = 99) {
  const world = createWorld({ seed });
  const [a, b] = world.agents;
  b.regionId = a.regionId;
  return { world, a, b };
}

/** @param {any} world @param {any} agent @param {any} target */
function callInMomentFor(world, agent, target) {
  const intent = {
    kind: "call_in",
    targetId: target.id,
    utility: 80,
    requiresProximity: true,
    reasons: ["owed a favour"],
    payload: undefined
  };
  const moment = buildMoment(world, agent, intent, [intent]);
  assert.ok(moment, "expected a call_in moment to be built");
  world.pending.push(moment);
  return moment;
}

test("a favour writes a symmetric debt on both sides of the ledger", () => {
  const { world, a, b } = twoMinds();
  const { applied } = applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  assert.equal(applied, 1);

  const giverEdge = edgeToward(a, b.id);
  const receiverEdge = edgeToward(b, a.id);
  // Sign convention: debts > 0 means "they owe me".
  assert.equal(giverEdge.debts, 18, "giver's edge should read +18 (they owe me)");
  assert.equal(receiverEdge.debts, -18, "receiver's edge should read -18 (I owe them)");
  assert.equal(giverEdge.lastFavourTick, world.clock.tick);
  assert.equal(receiverEdge.lastFavourTick, world.clock.tick);
});

test("the ledger is never read backwards in summaries", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 30 }]);
  // The summary only surfaces relationships the mind would actually think
  // about; make this one salient enough to appear.
  edgeToward(a, b.id).familiarity = 30;
  edgeToward(b, a.id).familiarity = 30;
  const lines = relationsSummary(a, new Map(world.agents.map(x => [x.id, x])));
  const line = lines.find(l => l.startsWith(b.name));
  assert.ok(line && line.includes("is owed a favour by them"),
    `creditor's summary should say they are owed, got: ${line}`);
  const debtorLines = relationsSummary(b, new Map(world.agents.map(x => [x.id, x])));
  const debtorLine = debtorLines.find(l => l.startsWith(a.name));
  assert.ok(debtorLine && debtorLine.includes("owes them a favour"),
    `debtor's summary should say they owe, got: ${debtorLine}`);
});

test("the creation cooldown blocks a second favour in the same window", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  const before = edgeToward(a, b.id).debts;
  const beforeBack = edgeToward(b, a.id).debts;
  const { events } = applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  assert.equal(events.length, 0, "the refused favour should produce no event");
  assert.equal(edgeToward(a, b.id).debts, before, "debt must not grow during cooldown");
  assert.equal(edgeToward(b, a.id).debts, beforeBack, "mirror side must not move either");
});

test("debts decay toward zero over time", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 40 }]);
  for (let i = 0; i < 200; i++) decayRelations(a, i, world.config);
  const giverEdge = edgeToward(a, b.id);
  assert.ok(giverEdge.debts >= 0, "debt must not cross zero while decaying");
  assert.ok(giverEdge.debts < 40, `debt should have faded, still ${giverEdge.debts}`);
});

test("ask plainly settles the debt in full", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  const moment = callInMomentFor(world, a, b);
  const result = resolveMoment(world, moment.id, { optionId: "ask_plainly" });
  assert.ok(result.ok);
  assert.equal(edgeToward(a, b.id).debts, 0, "creditor's ledger should be clear");
  assert.equal(edgeToward(b, a.id).debts, 0, "debtor's ledger should be clear");
  assert.ok(edgeToward(a, b.id).trust > 40, "a clean settlement builds trust");
});

test("holding it over them keeps the debt and costs trust", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  const trustBefore = edgeToward(a, b.id).trust;
  const moment = callInMomentFor(world, a, b);
  const result = resolveMoment(world, moment.id, { optionId: "hold_it_over" });
  assert.ok(result.ok);
  assert.equal(edgeToward(a, b.id).debts, 18, "leverage means the debt stays on the books");
  assert.ok(edgeToward(a, b.id).trust < trustBefore, "holding it over them costs trust");
  assert.ok(edgeToward(b, a.id).fear > 0, "the debtor should feel the pressure");
});

test("tearing it up clears the debt without minting an instant ally", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  const moment = callInMomentFor(world, a, b);
  const result = resolveMoment(world, moment.id, { optionId: "tear_it_up" });
  assert.ok(result.ok);
  assert.equal(edgeToward(a, b.id).debts, 0);
  assert.equal(edgeToward(b, a.id).debts, 0);
  // Grace pays in trust and relief. Affinity must stay well short of the
  // alliance threshold, or call-ins become a friendship machine.
  const allianceAt = world.config.relations.allianceThreshold;
  assert.ok(edgeToward(a, b.id).affinity < allianceAt,
    `creditor affinity ${edgeToward(a, b.id).affinity} must stay below alliance threshold ${allianceAt}`);
  assert.ok(edgeToward(b, a.id).affinity < allianceAt,
    `debtor affinity ${edgeToward(b, a.id).affinity} must stay below alliance threshold ${allianceAt}`);
  assert.ok(edgeToward(b, a.id).trust > 40, "forgiveness builds trust");
});

test("a call-in can never flip who owes whom", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  // Ask for more than is owed: the ledger settles, it does not invert.
  applyEffects(world, [{ op: "call_in", from: a.id, to: b.id, amount: 500 }]);
  assert.equal(edgeToward(a, b.id).debts, 0);
  assert.equal(edgeToward(b, a.id).debts, 0);
});

test("no call_in intent fires during the grace period", () => {
  const { world, a, b } = twoMinds();
  b.regionId = a.regionId;
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 30 }]);
  const intents = generateIntents(world, a);
  const callIns = intents.filter(i => i.kind === "call_in" && i.targetId === b.id);
  assert.equal(callIns.length, 0, "calling in during grace would read as a transaction, not a relationship");
});

test("a call_in intent fires once grace has passed", () => {
  const { world, a, b } = twoMinds();
  b.regionId = a.regionId;
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 30 }]);
  // Age the favour past grace without decaying the debt away.
  edgeToward(a, b.id).lastFavourTick = world.clock.tick - world.config.favours.graceTicks - 1;
  edgeToward(a, b.id).debts = 30;
  edgeToward(b, a.id).debts = -30;
  const intents = generateIntents(world, a);
  const callIns = intents.filter(i => i.kind === "call_in" && i.targetId === b.id);
  assert.equal(callIns.length, 1, "an old, substantial debt should want calling in");
});

test("a generous mind generates grant_favour intents for people it likes", () => {
  const { world, a, b } = twoMinds();
  b.regionId = a.regionId;
  edgeToward(a, b.id).affinity = 40;
  a.needs.energy = 85;
  const intents = generateIntents(world, a);
  const favours = intents.filter(i => i.kind === "grant_favour" && i.targetId === b.id);
  assert.equal(favours.length, 1, "should want to do a favour for someone liked");
});

test("prose keeps proper nouns at their own case", () => {
  const { world, a } = twoMinds();
  const line = phrase(world, a, "favour_given", { other: "Juno the Quiet", region: "Somewhere" });
  assert.ok(line.includes("Juno the Quiet"), `proper noun must survive prose, got: ${line}`);
  assert.ok(!line.includes("juno the quiet"), `proper noun must not be lower-cased, got: ${line}`);
});

test("call_in narration names both minds correctly", () => {
  const { world, a, b } = twoMinds();
  applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 18 }]);
  const moment = callInMomentFor(world, a, b);
  const option = moment.options.find(o => o.id === "tear_it_up");
  assert.ok(option, "expected a tear_it_up option");
  const line = momentLine(world, a, moment, option, id => agentById(world, id));
  assert.ok(line.includes(a.name), `line should name the creditor, got: ${line}`);
  assert.ok(line.includes(b.name), `line should name the debtor, got: ${line}`);
});
