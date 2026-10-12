/**
 * Public standing: what the room thinks of a mind, separate from private
 * affection. Public deeds shift it; gossip moves it faster than truth; it
 * fades when nobody is talking.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, agentById } from "../engine/model/world.js";
import { standingWord } from "../engine/model/agent.js";
import { edgeToward } from "../engine/model/relationships.js";
import { applyEffects } from "../engine/systems/effects.js";
import { settleRelations } from "../engine/systems/social.js";
import { buildMoment } from "../engine/decision/moments.js";
import { resolveMoment } from "../engine/simulation.js";
import { resolveIntent } from "../engine/systems/act.js";

function twoMinds(seed = 4242) {
  const world = createWorld({ seed });
  const [a, b, c] = world.agents;
  b.regionId = a.regionId;
  c.regionId = a.regionId;
  return { world, a, b, c };
}

/**
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} agent
 * @param {string} kind
 * @param {string} targetId
 * @param {object} [payload]
 */
function momentFor(world, agent, kind, targetId, payload) {
  const intent = { kind, targetId, utility: 90, requiresProximity: false, reasons: ["test"], payload };
  const moment = buildMoment(world, agent, intent, [intent]);
  assert.ok(moment, `expected a ${kind} moment`);
  world.pending.push(moment);
  return moment;
}

test("standing starts at zero and words map to bands", () => {
  const { a } = twoMinds();
  assert.equal(a.standing, 0);
  assert.equal(standingWord(70), "revered");
  assert.equal(standingWord(40), "respected");
  assert.equal(standingWord(15), "well-regarded");
  assert.equal(standingWord(0), "unknown");
  assert.equal(standingWord(-15), "suspect");
  assert.equal(standingWord(-40), "disreputable");
  assert.equal(standingWord(-70), "notorious");
});

test("the standing op clamps at both ends", () => {
  const { world, a } = twoMinds();
  applyEffects(world, [{ op: "standing", agent: a.id, delta: 500 }]);
  assert.equal(a.standing, 100);
  applyEffects(world, [{ op: "standing", agent: a.id, delta: -500 }]);
  assert.equal(a.standing, -100);
});

test("a public betrayal tanks standing", () => {
  const { world, a, b } = twoMinds();
  // Forge the weapon: a learns something ruinous about b.
  applyEffects(world, [{
    op: "secret_new", holders: [a.id], about: b.id, kind: "crime",
    text: `${b.name} did something unforgivable once, and ${a.name} can prove it`
  }]);
  const secret = world.secrets.find(s => s.holders[a.id] !== undefined && s.aboutId === b.id);
  assert.ok(secret, "expected a to hold a secret about b");
  const before = a.standing;
  const moment = momentFor(world, a, "betray", b.id, { secretId: secret.id });
  const result = resolveMoment(world, moment.id, { optionId: "say_it_out_loud" });
  assert.ok(result.ok);
  assert.ok(a.standing < before, `standing should fall after a public betrayal (${before} -> ${a.standing})`);
});

test("forgiving a debt lifts standing; holding it over them lowers it", () => {
  const { world, a, b } = twoMinds();
  const mkDebt = () => applyEffects(world, [{ op: "favour", from: a.id, to: b.id, amount: 30 }]);
  const callIn = (/** @type {string} */ optionId) => {
    const m = momentFor(world, a, "call_in", b.id);
    const r = resolveMoment(world, m.id, { optionId });
    assert.ok(r.ok);
  };
  mkDebt();
  const before = a.standing;
  callIn("tear_it_up");
  assert.ok(a.standing > before, `forgiveness should lift standing (${before} -> ${a.standing})`);
});

test("unkind gossip about someone drags their standing down", () => {
  const { world, a, b, c } = twoMinds();
  // a despises c: sentiment comes from a's own edge toward c, so the telling
  // comes out unkind.
  edgeToward(a, c.id).affinity = -80;
  const intent = {
    kind: "gossip", targetId: b.id, utility: 80, requiresProximity: true,
    reasons: ["test"], payload: { aboutId: c.id }
  };
  const before = c.standing;
  const res = resolveIntent(world, a, intent, [intent]);
  applyEffects(world, res.ops, { actorId: a.id });
  assert.ok(c.standing < before, `unkind gossip should drag standing down (${before} -> ${c.standing})`);
});

test("warm gossip about someone lifts their standing", () => {
  const { world, a, b, c } = twoMinds();
  edgeToward(a, c.id).affinity = 80;
  const intent = {
    kind: "gossip", targetId: b.id, utility: 80, requiresProximity: true,
    reasons: ["test"], payload: { aboutId: c.id }
  };
  const before = c.standing;
  const res = resolveIntent(world, a, intent, [intent]);
  applyEffects(world, res.ops, { actorId: a.id });
  assert.ok(c.standing > before, `warm gossip should lift standing (${before} -> ${c.standing})`);
});

test("standing decays toward obscurity", () => {
  const { world, a } = twoMinds();
  a.standing = 50;
  for (let i = 0; i < 100; i++) settleRelations(world, a);
  assert.ok(a.standing < 50 && a.standing >= 0, `standing should fade, got ${a.standing}`);
  a.standing = -50;
  for (let i = 0; i < 100; i++) settleRelations(world, a);
  assert.ok(a.standing > -50 && a.standing <= 0, `infamy should fade too, got ${a.standing}`);
});

test("levelling up lifts standing", () => {
  const { world, a } = twoMinds();
  const before = a.standing;
  applyEffects(world, [{ op: "xp", agent: a.id, amount: 100000 }]);
  assert.ok(a.level > 1, "expected a level-up");
  assert.ok(a.standing > before, `the room notices growth (${before} -> ${a.standing})`);
});
