/**
 * Vendettas: feuds that escalate through stages — grudge → rivalry →
 * vendetta. Each stage changes what the pair will do to each other, and the
 * world is told when a feud changes kind.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { edgeToward, feudStage, FEUD_STAGES } from "../engine/model/relationships.js";
import { trackFeuds } from "../engine/systems/vendetta.js";
import { buildMoment } from "../engine/decision/moments.js";
import { generateIntents } from "../engine/decision/intents.js";
import { resolveMoment } from "../engine/simulation.js";
import { offlineWorld } from "./helpers.mjs";

function twoMinds(seed = 6060) {
  const world = createWorld({ seed });
  const [a, b] = world.agents;
  b.regionId = a.regionId;
  return { world, a, b };
}

/**
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} a
 * @param {import("../engine/model/agent.js").Agent} b
 * @param {number} resentment
 */
function setHeat(world, a, b, resentment) {
  edgeToward(a, b.id).resentment = resentment;
  edgeToward(b, a.id).resentment = resentment;
}

test("feud stages follow the hotter side of the pair", () => {
  const { world, a, b } = twoMinds();
  assert.equal(feudStage(edgeToward(a, b.id), edgeToward(b, a.id), world.config), null);
  setHeat(world, a, b, 20);
  assert.equal(feudStage(edgeToward(a, b.id), edgeToward(b, a.id), world.config), "grudge");
  setHeat(world, a, b, 40);
  assert.equal(feudStage(edgeToward(a, b.id), edgeToward(b, a.id), world.config), "rivalry");
  setHeat(world, a, b, 80);
  assert.equal(feudStage(edgeToward(a, b.id), edgeToward(b, a.id), world.config), "vendetta");
  // One-sided hatred is enough: it takes the maximum.
  edgeToward(a, b.id).resentment = 80;
  edgeToward(b, a.id).resentment = 0;
  assert.equal(feudStage(edgeToward(a, b.id), edgeToward(b, a.id), world.config), "vendetta");
  assert.deepEqual(FEUD_STAGES, ["grudge", "rivalry", "vendetta"]);
});

test("escalations to rivalry and vendetta are announced once", () => {
  const { world, a, b } = twoMinds();
  trackFeuds(world); // settle the seed world's pre-existing feuds
  const baseline = world.events.filter(e => e.kind === "feud").length;

  setHeat(world, a, b, 40);
  trackFeuds(world);
  let feuds = world.events.filter(e => e.kind === "feud");
  assert.equal(feuds.length, baseline + 1, "rivalry should be announced");
  assert.ok(feuds[0].text.includes(a.name) && feuds[0].text.includes(b.name));
  trackFeuds(world);
  assert.equal(world.events.filter(e => e.kind === "feud").length, baseline + 1, "no repeat announcements");

  setHeat(world, a, b, 80);
  trackFeuds(world);
  feuds = world.events.filter(e => e.kind === "feud");
  assert.equal(feuds.length, baseline + 2, "vendetta escalation should be announced");
  assert.ok(feuds[0].text.toLowerCase().includes("vendetta"));
});

test("grudges form quietly", () => {
  const { world, a, b } = twoMinds();
  trackFeuds(world); // settle the baseline
  const baseline = world.events.filter(e => e.kind === "feud").length;
  setHeat(world, a, b, 20);
  trackFeuds(world);
  assert.equal(world.events.filter(e => e.kind === "feud").length, baseline, "grudges are not announced");
});

test("a vendetta-stage confrontation gets the end-it option", () => {
  const { world, a, b } = twoMinds();
  setHeat(world, a, b, 80);
  const intent = { kind: "confront", targetId: b.id, utility: 95, requiresProximity: false, reasons: ["test"] };
  const moment = buildMoment(world, a, intent, [intent]);
  assert.ok(moment, "expected a confrontation moment");
  const endIt = moment.options.find(o => o.id === "end_it");
  assert.ok(endIt, "vendetta should offer ending it, whatever it costs");

  world.pending.push(moment);
  const before = edgeToward(a, b.id).resentment;
  const result = resolveMoment(world, moment.id, { optionId: "end_it" });
  assert.ok(result.ok);
  assert.ok(edgeToward(a, b.id).resentment < before, "ending it drains the feud's heat");
});

test("no end-it option below vendetta", () => {
  const { world, a, b } = twoMinds();
  setHeat(world, a, b, 40);
  const intent = { kind: "confront", targetId: b.id, utility: 95, requiresProximity: false, reasons: ["test"] };
  const moment = buildMoment(world, a, intent, [intent]);
  assert.ok(moment);
  assert.ok(!moment.options.some(o => o.id === "end_it"), "rivalry does not earn the final option");
});

test("vendetta sharpens betrayal and confrontation intents", () => {
  const { world, a, b } = twoMinds();
  setHeat(world, a, b, 80);
  // Low raw grievance for confront gating, but vendetta overrides the gate.
  edgeToward(a, b.id).resentment = 60; // vendetta stage, above the 25 gate anyway
  const intents = generateIntents(world, a);
  const confronts = intents.filter(i => i.kind === "confront" && i.targetId === b.id);
  assert.ok(confronts.length >= 1, "vendetta should want settling");
  assert.ok(confronts[0].reasons.some(r => r.includes("vendetta")), "the reason should name the vendetta");
});

test("feuds do not consume the world in a long run", () => {
  const world = offlineWorld({ seed: 31, ticks: 1200 });
  const feuds = world.events.filter(e => e.kind === "feud");
  const living = livingAgents(world).length;
  assert.ok(living >= 6, `cast collapsed to ${living}`);
  assert.ok(feuds.length < 30, `feud announcements spamming: ${feuds.length}`);
});
