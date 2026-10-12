import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, SEED_CAST } from "../engine/model/world.js";
import { buildCognitionMoment, resolveMoment, step } from "../engine/simulation.js";
import { deserializeWorld, serializeWorld } from "../engine/snapshot.js";
import { buildPrompt, parseCognitionReply, parseReply } from "../server/prompt.js";
import { generateIntents } from "../engine/decision/intents.js";
import { edgeToward } from "../engine/model/relationships.js";

/** @param {Record<string, any>} [overrides] */
function smallWorld(overrides = {}) {
  return createWorld({
    seed: 2301,
    cast: SEED_CAST.slice(0, 2),
    config: /** @type {any} */ ({ cognition: { pilotCount: 1 }, ...overrides })
  });
}

test("only a small pilot pair gets durable open-plan cognition", () => {
  const world = createWorld({ seed: 2302 });
  const pilots = world.agents.filter(agent => agent.cognition.enabled);
  assert.equal(pilots.length, 2);
  assert.deepEqual(pilots.map(agent => agent.cognition.nextPlanTick), [1, 13]);
  assert.ok(world.agents.slice(2).every(agent => !agent.cognition.enabled));
});

test("cognition prompts start without a selected intent or menu and use private durable context", () => {
  const world = smallWorld();
  const agent = world.agents[0];
  agent.cognition.memorySummary = "I promised to help raise the wall.";
  agent.cognition.priorities = [{ text: "Protect the North Wall", tick: 0 }];
  agent.cognition.beliefs = [{
    id: "belief-test", text: "Juno is hiding a fear", confidence: 0.7, aboutId: world.agents[1].id, tick: 0
  }];
  const moment = buildCognitionMoment(world, agent);
  const prompt = buildPrompt(world, moment);
  const system = prompt.messages[0].content;

  assert.equal(moment.kind, "cognition");
  assert.deepEqual(moment.options, []);
  assert.match(system, /No engine intent has been selected/);
  assert.doesNotMatch(system, /Your options:/);
  assert.match(system, /I promised to help raise the wall/);
  assert.match(system, /Protect the North Wall/);
  assert.match(system, /Juno is hiding a fear/);
  assert.match(system, /North Wall/);
});

test("structured cognition replies parse a plan, priorities, beliefs, and action without option IDs", () => {
  const answer = parseCognitionReply([
    "PLAN: I will help Juno strengthen the wall because it protects everyone.",
    "ACTION: project_help",
    "TARGET: Juno",
    "ABOUT: NONE",
    "PRIORITY: Protect the people who live here",
    "BELIEF: Juno trusts me more than she admits",
    "BELIEF_CONFIDENCE: 0.73",
    "BELIEF_ABOUT: Juno",
    "SUMMARY: I chose to help with the wall and felt useful.",
    "THOUGHT: I should be braver about offering help."
  ].join("\n"));
  assert.equal(answer.action, "project_help");
  assert.equal(answer.target, "Juno");
  assert.equal(answer.plan, "I will help Juno strengthen the wall because it protects everyone.");
  assert.equal(answer.priority, "Protect the people who live here");
  assert.equal(answer.beliefConfidence, 0.73);
  assert.equal(answer.beliefAbout, "Juno");
  assert.equal(answer.summary, "I chose to help with the wall and felt useful.");
  const world = smallWorld();
  const moment = buildCognitionMoment(world, world.agents[0]);
  assert.equal(parseReply("ACTION: observe\nTARGET: NONE", moment).action, "observe");
});

test("the engine validates a self-authored project action and ignores invented effects", () => {
  const world = smallWorld();
  const agent = world.agents[0];
  agent.regionId = world.project.regionId;
  world.agents[1].awake = false;
  world.agents[1].needs.energy = 0;
  const report = step(world);
  const moment = report.moments.find(candidate => candidate.kind === "cognition");
  assert.ok(moment, "the pilot receives an open-plan request on its due tick");
  assert.deepEqual(moment.options, [], "there is no menu from which an engine intent was chosen");

  const energyBefore = agent.needs.energy;
  const answer = {
    action: "project_contribute",
    target: "NONE",
    plan: "I will help build the wall that keeps the settlement safe.",
    priority: "Protect and reinforce the North Wall",
    belief: "The wall gives the scattered people a reason to work together.",
    beliefConfidence: 0.84,
    beliefAbout: "Juno",
    summary: "I chose to strengthen the shared wall and felt useful.",
    thought: "This is worth doing together.",
    // These fields are deliberately outside the reply schema. They must not be
    // interpreted as engine effects, even when the model tries to supply them.
    ops: [{ op: "need", agent: agent.id, deltas: { energy: 1000, esteem: 1000 } }]
  };
  const result = resolveMoment(world, moment.id, answer);
  assert.equal(result.ok, true);
  const recorded = agent.cognition.lastPlan;
  assert.ok(recorded);
  assert.equal(recorded.source, "model");
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.action, "project_contribute");
  assert.ok(world.project.progress > 0, "the existing project resolver applies visible consequences");
  assert.ok(agent.needs.energy < energyBefore, "the action pays its engine-defined energy cost");
  assert.ok(agent.needs.esteem <= 100, "arbitrary model-provided effects are ignored");
  assert.equal(agent.cognition.priorities[0].text, answer.priority);
  const storedBelief = agent.cognition.beliefs[0];
  assert.ok(storedBelief);
  assert.equal(storedBelief.aboutId, world.agents[1].id);
  assert.equal(agent.cognition.memorySummary, answer.summary);
  assert.equal(agent.thought, answer.thought);
  assert.equal(agent.cognition.planCount, 1);
  assert.equal(world.pending.some(candidate => candidate.id === moment.id), false);
  const resolved = world.resolved.at(-1);
  assert.ok(resolved);
  assert.equal(resolved.id, moment.id);
});

test("invalid targets and unsafe actions fall back to engine policy, not model effects", () => {
  const world = smallWorld();
  const agent = world.agents[0];
  agent.regionId = world.project.regionId;
  world.project.progress = 25;
  world.project.contributors[world.agents[1].id] = {
    work: 30, help: 0, interference: 0, lastTick: 0, lastInterferenceTick: -9999
  };
  edgeToward(agent, world.agents[1].id).resentment = 0;
  const moment = buildCognitionMoment(world, agent);
  world.pending.push(moment);
  const progress = world.project.progress;
  const result = resolveMoment(world, moment.id, /** @type {any} */ ({
    action: "project_interfere",
    target: world.agents[1].name,
    plan: "I will damage their work even though I have no grievance.",
    ops: [{ op: "project_interfere", agent: agent.id, targetId: world.agents[1].id, amount: 999 }]
  }));

  assert.equal(result.ok, true, "an invalid proposal still lets the simulation continue");
  const recorded = agent.cognition.lastPlan;
  assert.ok(recorded);
  assert.equal(recorded.accepted, false);
  assert.equal(recorded.source, "engine");
  assert.match(recorded.reason, /grievance/);
  assert.equal(world.project.progress, progress, "the model cannot inject sabotage consequences");
});

test("beliefs, priorities, plans, and summaries stay bounded and survive snapshots", () => {
  const world = smallWorld({ cognition: { maxBeliefs: 2, maxPriorities: 2, summaryMaxChars: 32, planMaxChars: 24 } });
  const agent = world.agents[0];
  agent.regionId = world.project.regionId;
  for (let index = 0; index < 4; index += 1) {
    const moment = buildCognitionMoment(world, agent);
    world.pending.push(moment);
    const result = resolveMoment(world, moment.id, {
      action: "observe",
      target: "NONE",
      plan: "p".repeat(80),
      priority: `priority ${index}`,
      belief: `belief ${index}`,
      beliefConfidence: index / 3,
      summary: "s".repeat(80)
    });
    assert.equal(result.ok, true);
  }

  assert.equal(agent.cognition.beliefs.length, 2);
  assert.equal(agent.cognition.priorities.length, 2);
  assert.equal(agent.cognition.memorySummary.length, 32);
  const lastPlan = agent.cognition.lastPlan;
  assert.ok(lastPlan);
  assert.equal(lastPlan.text.length, 24);
  assert.equal(agent.cognition.planCount, 4);
  const resumed = deserializeWorld(serializeWorld(world));
  assert.deepEqual(resumed.agents[0].cognition, agent.cognition);
});

test("self-authored priorities gently affect later engine policy", () => {
  const baseline = smallWorld();
  const priorityWorld = deserializeWorld(serializeWorld(baseline));
  const agentA = baseline.agents[0];
  const agentB = priorityWorld.agents[0];
  agentA.regionId = priorityWorld.project.regionId;
  agentB.regionId = priorityWorld.project.regionId;
  agentB.cognition.priorities = [{ text: "Build and reinforce the North Wall", tick: 0 }];

  const ordinary = generateIntents(baseline, agentA).find(intent => intent.kind === "project_contribute");
  const biased = generateIntents(priorityWorld, agentB).find(intent => intent.kind === "project_contribute");
  assert.ok(ordinary && biased, "both worlds can consider the shared project");
  assert.equal(biased.utility - ordinary.utility, 12, "a retained priority only nudges policy by a bounded amount");
});

test("replaying the same bounded plan from the same snapshot yields the same world", () => {
  const world = smallWorld();
  world.agents[0].regionId = world.project.regionId;
  world.agents[1].awake = false;
  world.agents[1].needs.energy = 0;
  const moment = step(world).moments.find(candidate => candidate.kind === "cognition");
  assert.ok(moment);
  const resumed = deserializeWorld(serializeWorld(world));
  const answer = {
    plan: "I will put my hands to the wall.",
    action: "project_contribute",
    target: "NONE",
    belief: "Shared work builds trust.",
    beliefConfidence: 0.6,
    priority: "Build together"
  };
  assert.equal(resolveMoment(world, moment.id, answer).ok, true);
  assert.equal(resolveMoment(resumed, moment.id, answer).ok, true);
  assert.equal(serializeWorld(world), serializeWorld(resumed));
});

test("a cognition request that expires gets one engine action and cannot be answered twice", () => {
  const world = smallWorld({ moments: { maxPendingTicks: 1 } });
  world.agents[1].awake = false;
  world.agents[1].needs.energy = 0;
  const firstReport = step(world);
  const moment = firstReport.moments.find(candidate => candidate.kind === "cognition");
  assert.ok(moment);
  step(world);
  assert.equal(world.pending.some(candidate => candidate.id === moment.id), false);
  const resolved = world.resolved.find(candidate => candidate.id === moment.id);
  assert.ok(resolved && resolved.engineResolved);
  const lastPlan = world.agents[0].cognition.lastPlan;
  assert.ok(lastPlan);
  assert.equal(lastPlan.source, "engine");
  assert.equal(resolveMoment(world, moment.id, { action: "project_contribute" }).ok, false);
});
