/**
 * Phase A: proposal-based minds.
 *
 * The claim under test is a division of labour, not a feature list. A mind
 * acting on its own goal gets to say how it means to go about it. The engine
 * decides whether that is possible, what it costs, and what follows. Nothing a
 * model writes ever becomes a number in the world.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import {
  APPROACH_METHODS,
  availableMethods,
  proposalEligible,
  validateApproach,
  resolveApproach
} from "../engine/decision/proposals.js";
import { agentById } from "../engine/model/world.js";
import { buildPrompt, parseReply, parseApproachReply } from "../server/prompt.js";
import { deserializeWorld } from "../engine/snapshot.js";

/**
 * A world with one eligible, well-rested mind standing still.
 * @param {{seed?: number, index?: number, energy?: number, goalKind?: string}} [opts]
 */
function lab(opts = {}) {
  const world = createWorld({ seed: opts.seed ?? 99 });
  const agent = /** @type {import("../engine/model/agent.js").Agent} */ (world.agents[opts.index ?? 0]);
  agent.awake = true;
  agent.retired = false;
  agent.needs.energy = opts.energy ?? 90;
  agent.needs.meaning = 40;
  agent.goal = { text: "Keep the north wall standing.", kind: opts.goalKind ?? "protect", progress: 0.2, since: 0, priority: 1 };
  // A pilot mind self-plans instead, so keep it out of the pilot.
  agent.cognition.enabled = false;
  return { world, agent };
}

/**
 * Everyone except one mind, pushed somewhere else.
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} agent
 */
function isolate(world, agent) {
  for (const other of world.agents) {
    if (other.id !== agent.id) {
      other.regionId = /** @type {any} */ (world.regions.find(r => r.id !== agent.regionId)).id;
      other.awake = false;
    }
  }
}

/* ------------------------------------------------------------------ */

test("a proposal moment asks for an approach, not a menu choice", () => {
  const { world, agent } = lab();
  assert.ok(proposalEligible(world, agent, world.clock.tick), "an eligible mind should be asked");
  let moment = null;
  for (let i = 0; i < 80 && !moment; i++) {
    step(world);
    moment = world.pending.find(m => m.kind === "goal_approach" && m.agentId === agent.id) || null;
  }
  assert.ok(moment, "a mind working toward its goal was never offered a proposal");
  assert.deepEqual(moment.options, [], "a proposal has no pre-built options");
  assert.ok(moment.question.includes(agent.goal.text), "the question should name the mind's own goal");
  const offered = /** @type {any} */ (moment.context).availableMethods;
  assert.ok(Array.isArray(offered) && offered.length > 0, "the prompt should list what is possible from here");
  for (const method of offered) {
    assert.ok(APPROACH_METHODS.includes(method), `${method} is outside the engine's grammar`);
  }
});

test("a valid proposal moves the goal forward and is logged with the mind's own words", () => {
  const { world, agent } = lab();
  const before = agent.goal.progress;
  const { ops } = resolveApproach(world, agent, "focus", null, "Set the lantern low and worked until the stone sat true.");
  const progressOp = /** @type {any[]} */ (ops).find(o => o.op === "goal_progress");
  assert.ok(progressOp && progressOp.amount > 0, "focus should advance the goal");

  // Apply it through the real moment path so the logging is exercised too.
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"),
    tick: world.clock.tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question: "How do they approach it today?",
    context: /** @type {any} */ ({}),
    options: [],
    resolved: false
  });
  world.pending.push(moment);
  const result = resolveMoment(world, moment.id, {
    method: "focus",
    approach: "Set the lantern low and worked until the stone sat true."
  });
  assert.ok(result.ok, "the moment should resolve");
  assert.ok(agent.goal.progress > before, "the goal should have advanced");
  assert.equal(moment.approachAccepted, true);
  assert.equal(agent.proposal.acceptedCount, 1);

  const logged = world.events.find(e => e.kind === "proposal");
  assert.ok(logged, "the proposal should reach the world's record");
  assert.ok(logged.text.includes("Set the lantern low"), "the record should carry the mind's own words");
  assert.ok(logged.proposal, "the proposal record should travel with the event");
  assert.equal(logged.proposal.accepted, true);
  assert.equal(logged.proposal.source, "model");
});

test("an invented approach outside the grammar is refused, and the refusal is logged", () => {
  const { world, agent } = lab();
  const check = validateApproach(world, agent, { method: "summon_a_storm", approach: "Call down weather." });
  assert.equal(check.ok, false);
  assert.match(check.reason, /not one of the approaches/);

  const moment = /** @type {any} */ ({
    id: world.nextId("mo"),
    tick: world.clock.tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question: "How do they approach it today?",
    context: /** @type {any} */ ({}),
    options: [],
    resolved: false
  });
  world.pending.push(moment);
  const result = resolveMoment(world, moment.id, { method: "summon_a_storm", approach: "Call down weather." });
  assert.ok(result.ok, "an invalid proposal still resolves — it does not stall the mind");
  assert.equal(moment.approachAccepted, false);
  assert.equal(moment.engineResolved, true);
  assert.equal(agent.proposal.rejectedCount, 1);
  assert.ok(moment.approachValidation.includes("not one of the approaches"));

  const logged = world.events.find(e => e.kind === "proposal");
  assert.ok(logged && logged.proposal && logged.proposal.accepted === false, "the refusal should be in the record");
  assert.equal(logged.proposal.source, "engine");
});

test("a model cannot buy effects with numbers in its prose", () => {
  const { world, agent } = lab();
  // Same method, wildly different claimed outcomes: the engine's numbers must
  // come out identical, because the prose never reaches them.
  const quiet = resolveApproach(world, agent, "focus", null, "A careful hour.");
  const loud = resolveApproach(world, agent, "focus", null, "Worked for nine hours and gained 400 progress and 100 esteem.");
  /** @param {ReturnType<typeof resolveApproach>} r */
  const amount = (r) => /** @type {any[]} */ (r.ops).find(o => o.op === "goal_progress")?.amount;
  assert.equal(amount(quiet), amount(loud), "prose must not change what the engine computes");
});

test("approaches that need company are refused when nobody is here", () => {
  const { world, agent } = lab();
  isolate(world, agent);
  assert.ok(!availableMethods(world, agent).includes("recruit"), "recruit needs somebody");
  assert.ok(!availableMethods(world, agent).includes("consult"), "consult needs somebody");
  const check = validateApproach(world, agent, { method: "recruit", approach: "Ask for hands." });
  assert.equal(check.ok, false);
  assert.match(check.reason, /no one here/i);
});

test("sabotage needs the wall, a real grievance, and a grudge deep enough", () => {
  const { world, agent } = lab();
  // Off the site entirely.
  agent.regionId = /** @type {any} */ (world.regions.find(r => r.id !== world.project.regionId)).id;
  assert.ok(!availableMethods(world, agent).includes("undermine"), "undermine needs the project site");

  // On the site, with progress, but no grievance against anybody.
  agent.regionId = world.project.regionId;
  world.project.status = "active";
  world.project.progress = 40;
  const rival = /** @type {any} */ (world.agents.find(a => a.id !== agent.id));
  world.project.contributors[rival.id] = { work: 10, help: 0, interference: 0, lastTick: 0 };
  assert.ok(!availableMethods(world, agent).includes("undermine"), "no grievance, no sabotage");
  assert.equal(validateApproach(world, agent, { method: "undermine" }).ok, false);

  // Now give it a real grudge.
  agent.relations[rival.id] = /** @type {any} */ ({
    affinity: -40, trust: 0, familiarity: 40, resentment: 70, fear: 0, debts: 0,
    contacts: 3, lastContactTick: 0, lastCallInTick: -1
  });
  assert.ok(availableMethods(world, agent).includes("undermine"), "a real grievance makes sabotage possible");
  const check = validateApproach(world, agent, { method: "undermine", approach: "Loosen the timbers they set." });
  assert.equal(check.ok, true);
  assert.equal(check.targetId, rival.id, "the engine picks the target, not the model");

  const before = world.project.progress;
  const { ops } = resolveApproach(world, agent, "undermine", rival.id, "Loosen the timbers they set.");
  assert.ok(/** @type {any[]} */ (ops).some(o => o.op === "project_interfere"), "sabotage should hit the shared work");
  assert.ok(/** @type {any[]} */ (ops).every(o => o.op !== "goal_progress"), "sabotage advances nothing of their own");
  assert.ok(world.project.progress <= before);
});

test("an exhausted mind's ambitious approach is refused", () => {
  const { world, agent } = lab({ energy: 8 });
  const check = validateApproach(world, agent, { method: "push_through", approach: "Go at it until it breaks or I do." });
  assert.equal(check.ok, false);
  assert.match(check.reason, /energy/i);
});

test("explore is a real move on the map, and travel costs what it costs", () => {
  const { world, agent } = lab();
  const from = agent.regionId;
  const { ops } = resolveApproach(world, agent, "explore", null, "Walked out to look at it from the other side.");
  const move = /** @type {any} */ (/** @type {any[]} */ (ops).find(o => o.op === "move"));
  assert.ok(move, "explore should move the mind");
  assert.notEqual(move.regionId, from, "explore should move somewhere else");
  assert.ok(world.regions.some(r => r.id === move.regionId), "and somewhere that exists");
});

test("a proposal that is never answered expires into one engine move", () => {
  const { world, agent } = lab();
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"),
    tick: world.clock.tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question: "How do they approach it today?",
    context: /** @type {any} */ ({}),
    options: [],
    resolved: false
  });
  world.pending.push(moment);
  const limit = world.config.moments.maxPendingTicks;
  for (let i = 0; i < limit + 1; i++) step(world);
  assert.equal(world.pending.includes(moment), false, "an unanswered proposal should not sit forever");
  assert.equal(moment.resolved, true);
  assert.equal(moment.engineResolved, true);
  assert.equal(agent.proposal.count, 1);
  // …and a late reply for it is discarded, not applied twice.
  const late = resolveMoment(world, moment.id, { method: "focus", approach: "Better late than never." });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "unknown-or-already-resolved");
  assert.equal(agent.proposal.count, 1, "a discarded late reply must not resolve the beat again");
});

test("proposals are budgeted: one mind at a time, and never more than the tick allows", () => {
  const world = createWorld({ seed: 21 });
  let offered = 0;
  let maxPerTick = 0;
  for (let i = 0; i < 400; i++) {
    const report = step(world);
    const proposals = report.moments.filter(m => m.kind === "goal_approach");
    offered += proposals.length;
    maxPerTick = Math.max(maxPerTick, proposals.length);
    assert.ok(
      report.moments.length <= world.config.moments.maxPerTick,
      "a tick may never offer more moments than the budget allows"
    );
    for (const moment of [...world.pending]) resolveMoment(world, moment.id, {});
  }
  assert.ok(offered > 0, "proposals should actually happen over a long run");
  assert.ok(maxPerTick <= world.config.moments.maxPerTick);
  for (const agent of world.agents) {
    assert.ok(agent.proposal, "every mind carries proposal bookkeeping");
    assert.equal(
      agent.proposal.count,
      agent.proposal.acceptedCount + agent.proposal.rejectedCount,
      `${agent.name}'s proposal tallies do not add up`
    );
  }
});

test("cognition-pilot minds are not asked twice for the same beat", () => {
  const { world, agent } = lab();
  agent.cognition.enabled = true;
  assert.equal(proposalEligible(world, agent, world.clock.tick), false,
    "a pilot mind already self-plans; a second open-ended request would be redundant");
});

test("the prompt offers only what the engine can resolve, and parses the reply back", () => {
  const { world, agent } = lab();
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"),
    tick: world.clock.tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question: `How does ${agent.name} approach it today?`,
    context: /** @type {any} */ ({ ...{}, agentName: agent.name, stateLine: "steady", mood: "steady",
      region: "the Lantern District", regionBlurb: "", phase: "day", night: false,
      goal: agent.goal.text, goalProgress: 0.2, memories: [], availableMethods: availableMethods(world, agent),
      atProjectSite: false }),
    options: [],
    resolved: false
  });
  const prompt = buildPrompt(world, moment);
  const system = prompt.messages[0].content;
  for (const method of /** @type {any} */ (moment.context).availableMethods) {
    assert.ok(system.includes(method), `the prompt should offer ${method}`);
  }
  assert.ok(!system.includes("\n  - teleport"), "the prompt should not offer anything outside the grammar");

  const parsed = parseReply("APPROACH: Went at the frost-bitten course alone.\nMETHOD: focus\nTHOUGHT: Nobody owes me this.", moment);
  assert.equal(parsed.method, "focus");
  assert.equal(parsed.approach, "Went at the frost-bitten course alone.");
  assert.equal(parsed.thought, "Nobody owes me this.");

  // A reworded reply with no METHOD line still lands.
  const loose = parseReply("She decided to consult whoever was standing nearby.\nAPPROACH: Asked around.", moment);
  assert.equal(loose.method, "consult");
  assert.equal(loose.approach, "Asked around.");

  // And a reply with nothing usable is discarded rather than guessed at.
  assert.deepEqual(parseApproachReply("I'm just a language model, I can't do that.", []), {});
});

test("an agent restored from an old save gets proposal bookkeeping", () => {
  const world = createWorld({ seed: 7 });
  const data = JSON.parse(JSON.stringify(world));
  for (const agent of data.agents) delete agent.proposal;
  const restored = deserializeWorld(JSON.stringify(data));
  for (const agent of restored.agents) {
    assert.ok(agent.proposal, "a restored mind needs a proposal record");
    assert.equal(agent.proposal.count, 0);
    assert.ok(Number.isFinite(agent.proposal.nextTick));
  }
  const staggered = new Set(restored.agents.map(a => a.proposal.nextTick));
  assert.ok(staggered.size > 1, "restored minds should not all be asked on the same tick");
});
