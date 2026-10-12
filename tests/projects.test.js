import test from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../engine/model/world.js";
import { applyEffects } from "../engine/systems/effects.js";
import { resolveIntent } from "../engine/systems/act.js";
import { generateIntents } from "../engine/decision/intents.js";
import { edgeToward } from "../engine/model/relationships.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { regionDistance } from "../engine/model/regions.js";

/**
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} agent
 * @param {string} kind
 * @param {string|null} [targetId]
 */
function perform(world, agent, kind, targetId = null) {
  const resolution = resolveIntent(world, agent, {
    kind,
    targetId,
    utility: 100,
    requiresProximity: false,
    reasons: ["test action"]
  });
  applyEffects(world, resolution.ops, { actorId: agent.id });
  return resolution;
}

test("the North Wall is a durable shared project with explicit milestones", () => {
  const world = createWorld({ seed: 611 });
  assert.equal(world.project.id, "north-wall");
  assert.equal(world.project.status, "active");
  assert.equal(world.project.progress, 0);
  assert.deepEqual(world.project.milestones.map(m => m.threshold), [20, 45, 75, 100]);
  const resumed = deserializeWorld(serializeWorld(world));
  assert.deepEqual(resumed.project, world.project);
});

test("multiple minds can contribute, help, interfere, and leave lasting social effects", () => {
  const world = createWorld({ seed: 612 });
  const [builder, helper, saboteur] = world.agents;
  for (const agent of [builder, helper, saboteur]) agent.regionId = "wall";
  edgeToward(saboteur, builder.id).resentment = 48;
  edgeToward(builder, saboteur.id).resentment = 30;

  perform(world, builder, "project_contribute");
  const helpChoices = generateIntents(world, helper).map(intent => intent.kind);
  assert.ok(helpChoices.includes("project_help"), "a mind can choose to join and help a builder");
  perform(world, helper, "project_help", builder.id);
  assert.ok(world.project.contributors[helper.id].help > 0, "help counts as project participation");

  const interfereChoices = generateIntents(world, saboteur).map(intent => intent.kind);
  assert.ok(interfereChoices.includes("project_interfere"), "a resentful mind can choose to interfere");
  const progressBeforeInterference = world.project.progress;
  const resentmentBefore = edgeToward(builder, saboteur.id).resentment;
  perform(world, saboteur, "project_interfere", builder.id);
  assert.ok(world.project.progress < progressBeforeInterference, "interference visibly sets the work back");
  assert.ok(edgeToward(builder, saboteur.id).resentment > resentmentBefore, "the sabotage damages a real relationship");
  assert.ok(world.events.some(event => /interfered with the North Wall/.test(event.text)));

  const warmthBeforeCompletion = edgeToward(builder, helper.id).affinity;
  let turn = 0;
  while (world.project.status === "active" && turn++ < 12) {
    perform(world, turn % 2 ? builder : helper, "project_contribute");
  }
  assert.equal(world.project.status, "complete", "enough work completes the project");
  assert.equal(world.project.progress, 100);
  assert.ok(world.project.milestones.every(m => m.reached), "all milestones are recorded permanently");
  assert.ok(world.project.completionContributors.includes(builder.id));
  assert.ok(world.project.completionContributors.includes(helper.id));
  assert.ok(world.project.completedTick !== null);
  assert.ok(edgeToward(builder, helper.id).affinity > warmthBeforeCompletion,
    "working together leaves a lasting bond");
  assert.ok(builder.standing > 0 && helper.standing > 0,
    "the people who built the wall gain public standing");

  const saved = deserializeWorld(serializeWorld(world));
  assert.equal(saved.project.status, "complete", "the repaired wall survives save/load");
  assert.deepEqual(saved.project.completionContributors, world.project.completionContributors);
});

test("project actions travel to the worksite before changing construction", () => {
  const world = createWorld({ seed: 613 });
  const agent = world.agents[0];
  agent.regionId = "market";
  const distanceBefore = regionDistance(world, agent.regionId, world.project.regionId);
  const resolution = resolveIntent(world, agent, {
    kind: "project_contribute", targetId: null, utility: 100,
    requiresProximity: false, reasons: []
  });
  assert.equal(world.project.progress, 0, "planning the trip does not teleport project progress");
  applyEffects(world, resolution.ops, { actorId: agent.id });
  assert.notEqual(agent.regionId, "market", "the first action advances toward the worksite");
  assert.ok(regionDistance(world, agent.regionId, world.project.regionId) < distanceBefore);
  assert.equal(world.project.progress, 0);
});
