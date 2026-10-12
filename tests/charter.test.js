/**
 * Phase B: gameplay that evolves through play.
 *
 * The claim under test is that the world accumulates rules nobody wrote at the
 * start — because a mind proposed them, the keeper ruled, and the ruling became
 * precedent — and that roles are a fact about observed behaviour rather than an
 * assignment. Also that influence is a real, spendable, bounded resource.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import {
  RULE_KIND_LIST,
  createCharter,
  normalizeCharter,
  moveInfluence,
  ruleStrength,
  precedentFor,
  influenceWord
} from "../engine/model/charter.js";
import {
  petitionableRules,
  validatePetition,
  whisperable,
  openDilemma,
  dilemmaChoices
} from "../engine/decision/petitions.js";
import {
  settleCharter,
  ruleOnPetition,
  resolveDilemma,
  actOnWhisper,
  recordPetition,
  recordWallRaised
} from "../engine/systems/charter.js";
import { buildPrompt, parseCharterReply } from "../server/prompt.js";
import { applyEffects } from "../engine/systems/effects.js";

/** A world with a charter and a mind standing somewhere sensible. */
function lab(seed = 31) {
  const world = createWorld({ seed });
  const agent = /** @type {any} */ (world.agents[0]);
  agent.needs.energy = 80;
  return { world, agent };
}

/**
 * Give the world the fact that justifies a given rule kind.
 * @param {import("../engine/model/world.js").World} world
 * @param {string} ruleKind
 */
function seedBasis(world, ruleKind) {
  const a = /** @type {any} */ (world.agents[0]);
  const b = /** @type {any} */ (world.agents[1]);
  b.regionId = a.regionId;
  switch (ruleKind) {
    case "no_undermining":
      world.project.status = "active";
      world.project.interferenceCount = 2;
      break;
    case "wall_first":
      world.project.status = "active";
      world.project.progress = 30;
      world.project.contributors[a.id] = { work: 5, help: 0, interference: 0, lastTick: 0 };
      world.project.contributors[b.id] = { work: 4, help: 0, interference: 0, lastTick: 0 };
      break;
    case "quiet_hours":
      a.relations[b.id] = { affinity: -30, trust: 0, familiarity: 30, resentment: 70, fear: 0, debts: 0, contacts: 4, lastContactTick: 0, lastCallInTick: -1 };
      b.relations[a.id] = { affinity: -30, trust: 0, familiarity: 30, resentment: 66, fear: 0, debts: 0, contacts: 4, lastContactTick: 0, lastCallInTick: -1 };
      break;
    case "debts_honoured":
      a.relations[b.id] = { affinity: 0, trust: 40, familiarity: 30, resentment: 0, fear: 0, debts: 3, contacts: 2, lastContactTick: 0, lastCallInTick: -1 };
      break;
    case "share_the_fire":
      /** @type {any} */ (world.agents[2]).regionId = a.regionId;
      break;
  }
  return { a, b };
}

/* ------------------------------------------------------------------ */

test("a mind cannot legislate about a problem that has not happened", () => {
  const { world, agent } = lab();
  // A fresh world has done no wall work and broken no law yet, so the rules that
  // answer those problems are simply not on offer — whatever the model wants.
  const offered = petitionableRules(world, agent).map(r => r.ruleKind);
  assert.ok(!offered.includes("no_undermining"), "nothing has been sabotaged yet");
  assert.ok(!offered.includes("wall_first"), "nobody has worked on the wall yet");
  // Whatever *is* on offer, the engine can name the fact that justifies it. A
  // rule offered on mood alone is the thing this whole gate exists to prevent.
  const entries = petitionableRules(world, agent);
  assert.ok(entries.length > 0, "a world with feuds and favours owed has something to legislate about");
  for (const entry of entries) {
    assert.ok(entry.basis && entry.basis.length > 0, `${entry.ruleKind} is offered with no justification`);
    assert.ok(RULE_KIND_LIST.includes(entry.ruleKind), `${entry.ruleKind} is outside the grammar`);
  }

  const check = validatePetition(world, agent, { ruleKind: "no_undermining", petition: "Ban sabotage." });
  assert.equal(check.ok, false);
  assert.match(check.reason, /nothing in the world that justifies/);
});

test("a rule becomes petitionable once the world has produced the fact", () => {
  const { world, agent } = lab();
  seedBasis(world, "no_undermining");
  const offered = petitionableRules(world, agent);
  const entry = offered.find(r => r.ruleKind === "no_undermining");
  assert.ok(entry, "wall damage should make the rule askable");
  assert.match(entry.basis, /damaged 2 times/);

  const check = validatePetition(world, agent, { ruleKind: "no_undermining", petition: "Ban sabotage." });
  assert.equal(check.ok, true);
  assert.equal(check.kind, "law");
  assert.ok(check.cost > 0, "enacting a law costs the keeper something");
});

test("a petition reaches the keeper, and the ruling becomes law and precedent", () => {
  const { world, agent } = lab();
  seedBasis(world, "no_undermining");
  // Two minds have real work on the wall, so there is someone to stand behind it.
  const other = /** @type {any} */ (world.agents[1]);
  world.project.contributors[agent.id] = { work: 6, help: 0, interference: 0, lastTick: 0 };
  world.project.contributors[other.id] = { work: 4, help: 0, interference: 0, lastTick: 0 };
  const before = world.charter.influence;

  const moment = /** @type {any} */ ({
    id: world.nextId("mo"), tick: world.clock.tick, kind: "petition", agentId: agent.id,
    participants: [agent.id], significance: 0.7, question: "What do they ask for?",
    context: {}, options: [], resolved: false
  });
  world.pending.push(moment);
  const result = resolveMoment(world, moment.id, {
    ruleKind: "no_undermining",
    petition: "They have loosened the wall twice. Make it a law that nobody touches another's work."
  });
  assert.ok(result.ok);
  assert.ok(moment.petitionId, "the petition should exist");

  const petition = /** @type {any} */ (world.charter.petitions.find(p => p.id === moment.petitionId));
  assert.equal(petition.status, "open");
  assert.ok(petition.support > 0, "the engine counts who is actually behind it");
  assert.ok(petition.basis.includes("damaged"), "the petition carries the fact that justified it");

  // Nothing has changed in the world yet — the keeper has not ruled.
  assert.equal(ruleStrength(world.charter, "no_undermining"), 0);

  const ruling = ruleOnPetition(world, petition.id, "enact", "The wall is everyone's.");
  assert.ok(ruling.ok, ruling.reason);
  assert.equal(petition.status, "enacted");
  assert.equal(ruleStrength(world.charter, "no_undermining"), 1);
  assert.equal(world.charter.rules.length, 1);
  assert.equal(world.charter.rules[0].rulingNote, "The wall is everyone's.");
  assert.ok(world.charter.influence < before, "enacting a law costs influence");

  const precedent = precedentFor(world.charter, "no_undermining");
  assert.ok(precedent, "a ruling becomes precedent");
  assert.equal(precedent.ruling, "enacted");

  const logged = world.events.find(e => e.kind === "charter");
  assert.ok(logged && logged.text.includes("enacted"), "the ruling should reach the record");
});

test("a law actually changes what the engine will do", () => {
  const { world, agent } = lab();
  const { b } = seedBasis(world, "no_undermining");
  // Give the agent a grievance so interference is on offer at all.
  agent.relations[b.id] = { affinity: -30, trust: 0, familiarity: 30, resentment: 70, fear: 0, debts: 0, contacts: 4, lastContactTick: 0, lastCallInTick: -1 };
  world.project.contributors[b.id] = { work: 10, help: 0, interference: 0, lastTick: 0 };
  world.project.progress = 50;
  agent.regionId = world.project.regionId;
  b.regionId = world.project.regionId;

  const before = world.project.progress;
  applyEffects(world, [{ op: "project_interfere", agent: agent.id, targetId: b.id, amount: 10 }]);
  const lossWithoutLaw = before - world.project.progress;
  assert.ok(lossWithoutLaw > 0);

  // Now legislate, and the same act does less damage.
  world.project.progress = before;
  world.charter.active.no_undermining = 1;
  applyEffects(world, [{ op: "project_interfere", agent: agent.id, targetId: b.id, amount: 10 }]);
  const lossWithLaw = before - world.project.progress;
  assert.ok(lossWithLaw < lossWithoutLaw, `a legislated world should deter sabotage (${lossWithLaw} vs ${lossWithoutLaw})`);
});

test("roles emerge from what a mind is seen doing, and retire when they stop", () => {
  const { world } = lab();
  const wallwright = /** @type {any} */ (world.agents[3]);
  world.project.status = "active";
  world.project.contributors[wallwright.id] = { work: 40, help: 0, interference: 0, lastTick: 0 };
  settleCharter(world);
  const role = world.charter.roles.find(r => r.name === "Wallwright");
  assert.ok(role, "far ahead of the field should earn the name");
  assert.equal(role.holderId, wallwright.id);
  assert.match(role.basis, /more of the wall is theirs/);
  assert.ok(world.events.some(e => e.kind === "role" && e.text.includes("Wallwright")));

  // When the field closes up, nobody is far enough ahead to earn the name.
  const second = /** @type {any} */ (world.agents[4]);
  world.project.contributors[second.id] = { work: 41, help: 0, interference: 0, lastTick: 0 };
  settleCharter(world);
  assert.ok(!world.charter.roles.some(r => r.name === "Wallwright"),
    "the role follows the behaviour, not the person");

  // …and when one mind pulls clearly ahead again, the name goes to them.
  world.project.contributors[second.id] = { work: 60, help: 0, interference: 0, lastTick: 0 };
  settleCharter(world);
  const moved = world.charter.roles.find(r => r.name === "Wallwright");
  assert.ok(moved, "a clear leader earns the name back");
  assert.equal(moved.holderId, second.id, "and it is theirs, not the original holder's");
});

test("a mind cannot hoard every role, and the count stays bounded", () => {
  const { world } = lab();
  world.project.status = "active";
  for (const [i, agent] of world.agents.entries()) {
    /** @type {any} */ (world.project.contributors[agent.id]) = { work: 40 - i, help: 30 - i, interference: i === 5 ? 12 : 0, lastTick: 0 };
  }
  for (let i = 0; i < 4; i++) settleCharter(world);
  assert.ok(world.charter.roles.length <= world.config.charter.maxRoles,
    `${world.charter.roles.length} roles exceeds the cap`);
  const holders = world.charter.roles.map(r => r.holderId);
  assert.equal(new Set(holders).size, holders.length, "one role per mind");
});

test("influence is bounded, spendable, and refuses to go negative", () => {
  const charter = createCharter();
  const start = charter.influence;
  assert.equal(moveInfluence(charter, -9999), -start, "spending more than you have only spends what you have");
  assert.equal(charter.influence, 0);
  assert.equal(moveInfluence(charter, -5), 0, "influence never goes negative");
  assert.equal(moveInfluence(charter, 99999), charter.influenceMax - 0);
  assert.equal(charter.influence, charter.influenceMax);
  assert.equal(moveInfluence(charter, 5), 0, "and never past the cap");
  assert.ok(influenceWord(charter).length > 0);
});

test("the keeper cannot enact what they cannot afford", () => {
  const { world, agent } = lab();
  seedBasis(world, "wall_first");
  world.charter.influence = 0;
  const petition = recordPetition(world, agent, validatePetition(world, agent, { ruleKind: "wall_first" }), "Finish the wall.");
  const ruling = ruleOnPetition(world, petition.id, "enact");
  assert.equal(ruling.ok, false);
  assert.match(/** @type {string} */ (ruling.reason), /influence/);
  assert.equal(petition.status, "open", "a refused-for-cost petition stays open");
});

test("refusing sets precedent too, and pays the keeper for judging", () => {
  const { world, agent } = lab();
  seedBasis(world, "quiet_hours");
  const petition = recordPetition(world, agent, validatePetition(world, agent, { ruleKind: "quiet_hours" }), "No scores after dark.");
  const before = world.charter.influence;
  const ruling = ruleOnPetition(world, petition.id, "refuse", "Not my call to make.");
  assert.ok(ruling.ok, ruling.reason);
  assert.equal(petition.status, "refused");
  assert.equal(ruleStrength(world.charter, "quiet_hours"), 0, "a refused rule changes nothing mechanically");
  assert.ok(world.charter.influence > before, "judging is worth something");
  const precedent = precedentFor(world.charter, "quiet_hours");
  assert.equal(precedent?.ruling, "refused");

  // A second petition on the same subject now leans on that precedent.
  const second = recordPetition(world, /** @type {any} */ (world.agents[1]), validatePetition(world, /** @type {any} */ (world.agents[1]), { ruleKind: "quiet_hours" }), "Ask again.");
  assert.equal(second.precedentId, precedent?.id, "the world remembers it has ruled on this before");
});

test("an unanswered petition lapses rather than waiting forever", () => {
  const { world, agent } = lab();
  seedBasis(world, "say_it_plainly");
  const petition = recordPetition(world, agent, validatePetition(world, agent, { ruleKind: "say_it_plainly" }), "Say what was actually said.");
  const limit = world.config.charter.petitionLapseTicks;
  for (let i = 0; i < limit + 1; i++) step(world);
  assert.equal(petition.status, "lapsed");
});

test("a whisper is recorded privately and changes nothing until the keeper uses it", () => {
  const { world, agent } = lab();
  const other = /** @type {any} */ (world.agents[1]);
  world.secrets.push({
    id: world.nextId("sec"), kind: "betrayal", text: `${other.name} opened the gate.`, aboutId: other.id,
    holders: { [agent.id]: 1 }, isPublic: false, originTick: 0, lastSpreadTick: 0,
    weaponisedTick: 0, originatorId: agent.id
  });
  const subject = whisperable(world, agent);
  assert.ok(subject, "a mind holding something unsaid has something to whisper");

  const standingBefore = other.standing;
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"), tick: world.clock.tick, kind: "whisper", agentId: agent.id,
    participants: [agent.id, other.id], significance: 0.66, question: "What do they whisper?",
    context: {}, options: [], resolved: false
  });
  world.pending.push(moment);
  resolveMoment(world, moment.id, { whisper: "They opened the gate and nobody has said it out loud." });
  assert.ok(moment.whisperId);
  assert.equal(other.standing, standingBefore, "a whisper heard is not a whisper used");

  const used = actOnWhisper(world, moment.whisperId);
  assert.ok(used.ok, used.reason);
  assert.ok(other.standing < standingBefore, "acting on it moves the world");
  assert.equal(actOnWhisper(world, moment.whisperId).ok, false, "a whisper is used once");
});

test("a vendetta between two people who built the wall becomes the keeper's problem", () => {
  const { world } = lab();
  const { a, b } = seedBasis(world, "quiet_hours");
  world.project.contributors[a.id] = { work: 8, help: 0, interference: 0, lastTick: 0 };
  world.project.contributors[b.id] = { work: 6, help: 0, interference: 0, lastTick: 0 };
  world.project.progress = 40;
  const raised = openDilemma(world, world.clock.tick);
  assert.ok(raised, "a vendetta between two builders is a dilemma");
  assert.equal(raised.kind, "feud");
  assert.deepEqual(raised.partyIds.sort(), [a.id, b.id].sort());

  // And the keeper's choices are real, bounded interventions.
  const charter = world.charter;
  /** @type {any} */ (charter.dilemmas).push({
    id: world.nextId("dil"), text: raised.text, partyIds: raised.partyIds, kind: "feud", tick: world.clock.tick, status: "open"
  });
  const dilemma = /** @type {any} */ (charter.dilemmas[charter.dilemmas.length - 1]);
  const choices = dilemmaChoices(world, dilemma);
  assert.ok(choices.some(c => c.id === "mediate"));
  assert.ok(choices.some(c => c.id === "let_it_ride" && c.cost === 0));

  charter.influence = charter.influenceMax;
  const resentmentBefore = a.relations[b.id].resentment;
  const result = resolveDilemma(world, dilemma.id, "mediate");
  assert.ok(result.ok, result.reason);
  assert.equal(dilemma.status, "resolved");
  assert.ok(a.relations[b.id].resentment < resentmentBefore, "mediation should cool it");
  assert.ok(charter.influence < charter.influenceMax, "settling a dilemma costs influence");
  assert.equal(resolveDilemma(world, dilemma.id, "mediate").ok, false, "a dilemma is settled once");
});

test("the North Wall standing is the world's shared win, and it becomes precedent", () => {
  const { world } = lab();
  const builders = world.agents.slice(0, 3).map(a => a.id);
  recordWallRaised(world, builders);
  assert.equal(world.charter.wallRaised, true);
  assert.ok(world.charter.precedents.some(p => p.text.includes("North Wall was raised")));
  assert.equal(ruleStrength(world.charter, "wall_first") > 0, true, "the victory legislates itself");
  for (const id of builders) {
    assert.ok(world.charter.roles.some(r => r.holderId === id), "every builder is marked by it");
  }
  recordWallRaised(world, builders);
  assert.equal(world.charter.roles.filter(r => r.name === "Of the Wall").length, builders.length,
    "the win is paid once");
});

test("petitions, whispers and dilemmas are budgeted over a long run", () => {
  const world = createWorld({ seed: 77 });
  let petitions = 0;
  let whispers = 0;
  for (let i = 0; i < 600; i++) {
    const report = step(world);
    petitions += report.moments.filter(m => m.kind === "petition").length;
    whispers += report.moments.filter(m => m.kind === "whisper").length;
    assert.ok(report.moments.length <= world.config.moments.maxPerTick);
    for (const moment of [...world.pending]) resolveMoment(world, moment.id, {});
  }
  assert.ok(petitions > 0, "petitions should actually happen");
  assert.ok(whispers > 0, "whispers should actually happen");
  assert.ok(world.charter.petitions.length <= world.config.charter.maxOpenPetitions + world.charter.petitions.filter(p => p.status !== "open").length + 1);
  for (const agent of world.agents) {
    assert.ok(agent.petition && agent.whisper, "every mind carries charter bookkeeping");
  }
});

test("the prompt offers only admissible rules, and the parser drops scaffolding", () => {
  const { world, agent } = lab();
  seedBasis(world, "no_undermining");
  const offered = petitionableRules(world, agent);
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"), tick: world.clock.tick, kind: "petition", agentId: agent.id,
    participants: [agent.id], significance: 0.7, question: "What do they ask the keeper for?",
    context: /** @type {any} */ ({
      agentName: agent.name, stateLine: "steady", mood: "steady", region: "the Lantern District",
      regionBlurb: "", phase: "day", night: false, goal: agent.goal.text, goalProgress: 0.3,
      memories: [], petitionable: offered.map(o => ({
        ruleKind: o.ruleKind, name: "No undermining", kind: "law", gloss: "Sabotage needs a deeper grievance.", basis: o.basis
      }))
    }),
    options: [], resolved: false
  });
  const system = buildPrompt(world, moment).messages[0].content;
  assert.ok(system.includes("no_undermining"));
  for (const ruleKind of RULE_KIND_LIST) {
    if (!offered.some(o => o.ruleKind === ruleKind)) {
      assert.ok(!system.includes(`- ${ruleKind} `), `${ruleKind} should not be offered`);
    }
  }

  const parsed = parseCharterReply("PETITION: Make it a law.\nRULE_KIND: no_undermining\nTHOUGHT: About time.", "petition", "ruleKind");
  assert.equal(parsed.ruleKind, "no_undermining");
  assert.equal(parsed.petition, "Make it a law.");
  assert.deepEqual(parseCharterReply("As an AI, I can't write laws.", "petition", "ruleKind"), {},
    "a refusal must not become a petition");
});

test("the charter survives a save and reload, and an old save simply has no customs", () => {
  const { world, agent } = lab();
  seedBasis(world, "no_undermining");
  recordPetition(world, agent, validatePetition(world, agent, { ruleKind: "no_undermining" }), "Ban sabotage.");
  world.charter.influence = 42;
  const restored = deserializeWorld(serializeWorld(world));
  assert.equal(restored.charter.petitions.length, 1);
  assert.equal(restored.charter.influence, 42);

  const legacy = JSON.parse(serializeWorld(world));
  delete legacy.charter;
  const old = deserializeWorld(JSON.stringify(legacy));
  assert.deepEqual(old.charter, normalizeCharter(undefined));
  assert.equal(old.charter.petitions.length, 0);
  assert.ok(Number.isFinite(old.charter.influence));
});

