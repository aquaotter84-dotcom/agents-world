import test from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../engine/model/world.js";
import { applyEffects } from "../engine/systems/effects.js";
import { edgeToward } from "../engine/model/relationships.js";
import { deserializeWorld, serializeWorld } from "../engine/snapshot.js";

test("relationship changes retain direction, cause, and the associated secret thread", () => {
  const world = createWorld({ seed: 7001 });
  const secret = world.secrets[0];
  const [from, to] = world.agents;
  const edge = edgeToward(from, to.id);
  const beforeTrust = edge.trust;
  const beforeResentment = edge.resentment;

  applyEffects(world, [{
    op: "edge",
    from: from.id,
    to: to.id,
    deltas: { trust: 8, resentment: 5 },
    reason: "sharing the secret",
    secretId: secret.id
  }]);

  const change = world.events.find(event => event.kind === "relationship" && event.secretId === secret.id);
  assert.ok(change, "material directed relationship changes are recorded");
  assert.equal(change.agentId, from.id);
  assert.equal(change.subjectId, to.id);
  const relationship = change.relationship;
  assert.ok(relationship);
  assert.equal(relationship.reason, "sharing the secret");
  assert.deepEqual(relationship.changes.map(item => item.axis), ["trust", "resentment"]);
  assert.equal(relationship.changes[0].before, beforeTrust);
  assert.equal(relationship.changes[0].after, edge.trust);
  assert.equal(relationship.changes[1].before, beforeResentment);
  assert.equal(relationship.changes[1].after, edge.resentment);

  const resumed = deserializeWorld(serializeWorld(world));
  const resumedChange = resumed.events.find(event => event.id === change.id);
  assert.ok(resumedChange);
  assert.deepEqual(resumedChange.relationship, relationship);
});

test("a secret thread records the moment a new mind learned it without revealing the claim", () => {
  const world = createWorld({ seed: 7002 });
  const secret = world.secrets[0];
  const from = world.agents.find(agent => secret.holders[agent.id] !== undefined);
  const to = world.agents.find(agent => secret.holders[agent.id] === undefined && !agent.retired);
  assert.ok(from && to);
  const claim = secret.text;

  applyEffects(world, [{
    op: "secret_share",
    secretId: secret.id,
    from: from.id,
    to: to.id,
    fidelity: 0.72,
    memoryText: `${from.name} told me something about someone.`,
    memorySalience: 0.8
  }]);

  assert.equal(secret.holders[to.id], 0.72, "the new holder keeps the version's fidelity");
  const learned = world.events.find(event => event.kind === "secret" && event.secretId === secret.id && event.subjectId === to.id);
  assert.ok(learned, "the knowledge trail names who learned it and links to the secret");
  assert.match(learned.text, new RegExp(`${from.name} trusted ${to.name}`));
  assert.equal(learned.text.includes(claim), false, "a private share event does not leak the secret itself");
  assert.ok(to.memory.traces.some(trace => trace.secretId === secret.id), "the learner also retains a private trace");
});
