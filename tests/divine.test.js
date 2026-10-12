/**
 * Phase D, third idea: gods don't chat.
 *
 * The keeper's interventions are apparitions, omens and blessings — never a
 * message, never a voice in a bubble. The claims under test:
 *
 *   1. each one is priced in influence, and the engine charges exactly what the
 *      panel quotes;
 *   2. nothing lands that the world cannot honour, and every refusal is a
 *      sentence the keeper can read;
 *   3. each one does something real and bounded — a blessed mind's hands go
 *      further, an omen cools a feud and makes a fight harder to choose, an
 *      apparition puts down more resentment than any ruling has;
 *   4. each one moves the keeper's own meters through the same ledger every
 *      other keeper act uses;
 *   5. each one is a mark on the board and a line in the record.
 *
 * Nothing here involves a model. These are engine facts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents, regionName } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { adjustEdge } from "../engine/model/relationships.js";
import { applyEffects } from "../engine/systems/effects.js";
import { generateIntents } from "../engine/decision/intents.js";
import {
  canIntervene,
  interventionOptions,
  performIntervention,
  recentInterventions,
  settleDivine
} from "../engine/systems/divine.js";
import { liveInterventions, markedInterventions } from "../engine/model/divine.js";
import { wantLog } from "../engine/model/want.js";
import { describeBoard, divineMarks } from "../app/board.js";

/**
 * @param {number} ticks
 * @param {number} [seed]
 */
function freshWorld(seed = 21, ticks = 0) {
  const world = createWorld({ seed });
  for (let i = 0; i < ticks; i++) step(world);
  return world;
}

/** The price the panel shows, for one kind. @param {import("../engine/model/world.js").World} world @param {string} kind */
function quote(world, kind) {
  const option = interventionOptions(world).find(o => o.kind === kind);
  assert.ok(option, `the hand should quote a ${kind}`);
  return option;
}

/** Two minds in one place, with real resentment between them. */
function feudWorld(seed = 33) {
  const world = freshWorld(seed);
  const [a, b] = livingAgents(world);
  b.regionId = a.regionId;
  const tick = world.clock.tick;
  adjustEdge(a, b.id, { resentment: 60, familiarity: 20 }, tick);
  adjustEdge(b, a.id, { resentment: 60, familiarity: 20 }, tick);
  return { world, a, b };
}

test("the hand quotes three prices, and the engine charges exactly those", () => {
  const world = freshWorld(21, 40);
  const options = interventionOptions(world);
  assert.deepEqual(options.map(o => o.kind), ["blessing", "omen", "apparition"]);
  assert.deepEqual(options.map(o => o.cost), [5, 7, 12]);
  // A god does not speak. Every one of these is aimed at something the world
  // already has, and none of them is a message.
  assert.ok(options.every(o => /mind|work|region|dilemma/i.test(o.aim)), "each act names its target");

  const target = livingAgents(world)[0];
  const before = world.charter.influence;
  const result = performIntervention(world, "blessing", { agentId: target.id });
  assert.equal(result.ok, true);
  assert.equal(world.charter.influence, before - quote(world, "blessing").cost, "the quote is the charge");

  // And the price is real: an empty purse refuses with the arithmetic in it.
  world.charter.influence = 3;
  const broke = performIntervention(world, "omen", { regionId: target.regionId });
  assert.equal(broke.ok, false);
  assert.match(broke.reason || "", /costs 7 influence and you have 3/);
});

test("nothing lands that the world cannot honour, and every refusal says why", () => {
  const world = freshWorld(22, 40);
  const [a, b] = livingAgents(world);

  assert.match((canIntervene(world, "omen", { regionId: "nowhere" }).reason || ""), /no such place/);
  assert.match((canIntervene(world, "blessing", { agentId: "nobody" }).reason || ""), /point it at a mind/i);
  assert.match((canIntervene(world, "apparition", {}).reason || ""), /nothing is waiting on you to appear/i);

  // One live sign per target, and one act at a time: both refusals are readable.
  assert.equal(performIntervention(world, "omen", { regionId: a.regionId }).ok, true);
  assert.match((canIntervene(world, "omen", { regionId: a.regionId }).reason || ""), /already hangs over/);
  assert.equal(performIntervention(world, "blessing", { agentId: b.id }).ok, true);
  assert.match((canIntervene(world, "blessing", { agentId: b.id }).reason || ""), /already carrying your light/);
  // The cooldown is per act, not per place: a second omen cannot be set
  // anywhere this soon, even over somewhere no sign is hanging.
  const elsewhere = world.regions.find(r => r.id !== a.regionId);
  assert.ok(elsewhere);
  assert.match((canIntervene(world, "omen", { regionId: elsewhere.id }).reason || ""), /more ticks? before you can/i);

  // A mind that is gone cannot be blessed, and an old dilemma cannot be stood in.
  a.retired = true;
  assert.match((canIntervene(world, "blessing", { agentId: a.id }).reason || ""), /nobody there to bless/);
});

test("a blessing lifts a mind, and while it holds their hands go further", () => {
  const blessed = freshWorld(24);
  const plain = freshWorld(24);
  const worker = livingAgents(blessed)[0];
  const same = livingAgents(plain)[0];
  assert.equal(worker.id, same.id, "both worlds are the same world");

  const energy = worker.needs.energy;
  const meaning = worker.needs.meaning;
  const standing = worker.standing;
  assert.equal(performIntervention(blessed, "blessing", { agentId: worker.id }).ok, true);
  assert.ok(worker.needs.energy > energy, "the light lifts what they are running on");
  assert.ok(worker.needs.meaning > meaning, "and what they think it is for");
  assert.ok(worker.standing > standing, "and how the room reads them");
  assert.ok(worker.memory.traces.some(t => /something looked at me/i.test(t.text)), "they remember it");

  // The same day's work on the wall, twice: once under the light, once without.
  const amount = 10;
  const before = blessed.project.progress;
  applyEffects(blessed, [{ op: "project_work", agent: worker.id, amount }], { actorId: worker.id });
  const blessedGain = blessed.project.progress - before;
  const plainBefore = plain.project.progress;
  applyEffects(plain, [{ op: "project_work", agent: same.id, amount }], { actorId: same.id });
  const plainGain = plain.project.progress - plainBefore;
  assert.ok(blessedGain > plainGain, `a blessed mind should get more wall out of the same day (${blessedGain} vs ${plainGain})`);

  // And when the window closes, the hand is ordinary again.
  const intervention = recentInterventions(blessed, 1)[0];
  blessed.clock.tick = intervention.expireTick;
  const afterBefore = blessed.project.progress;
  applyEffects(blessed, [{ op: "project_work", agent: worker.id, amount }], { actorId: worker.id });
  assert.equal(blessed.project.progress - afterBefore, plainGain, "the light does not outlive its window");
});

test("a blessing on the wall lights every hand that is already on it", () => {
  const world = freshWorld(26);
  const [a, b] = livingAgents(world);
  world.project.contributors[a.id] = { work: 12, help: 0, interference: 0, lastTick: world.clock.tick };
  world.project.contributors[b.id] = { work: 2, help: 3, interference: 0, lastTick: world.clock.tick };
  const standingA = a.standing ?? 0;

  assert.equal(performIntervention(world, "blessing", { work: true }).ok, true);
  assert.ok((a.standing ?? 0) > standingA, "the builders are read differently for it");
  assert.ok(a.memory.traces.some(t => /light lay across the wall/i.test(t.text)));

  // Any hand on the wall goes further while the work is lit, not only the
  // minds who were standing there when it was set.
  const c = livingAgents(world)[2];
  const before = world.project.progress;
  applyEffects(world, [{ op: "project_work", agent: c.id, amount: 10 }], { actorId: c.id });
  assert.equal(world.project.progress - before, 14, "10 of work under the light is 14 of wall");
  assert.match((canIntervene(world, "blessing", { work: true }).reason || ""), /already lit/i);
});

test("an omen cools the quarrel it hangs over and makes a fight harder to choose", () => {
  const { world, a, b } = feudWorld(33);
  const plain = feastCopy(33);
  const before = a.relations[b.id].resentment;

  assert.equal(performIntervention(world, "omen", { regionId: a.regionId }).ok, true);
  assert.ok(a.relations[b.id].fear > 0, "standing under a sign frightens people out of a fight");
  settleDivine(world);
  assert.ok(a.relations[b.id].resentment < before, "and the quarrel cools while it hangs");

  // The mind weighing it up says so in its own reasons, and wants it less. Two
  // things are doing the work — the deterrence itself and the fright the sign
  // puts into the quarrel — so the claim is the honest one: standing under a
  // sign costs a confrontation at least its deterrence, and the mind can say why.
  const withSign = confrontUtility(world, a, b.id);
  const without = confrontUtility(plain, plain.agents[0], plain.agents[1].id);
  assert.ok(withSign, "a mind with a grudge still considers confrontation");
  assert.ok(without, "the same mind in the same world does too");
  assert.ok(without.utility - withSign.utility >= world.config.divine.omenDeterrence,
    `the sign should cost the confrontation at least its deterrence (${without.utility - withSign.utility})`);
  assert.ok(withSign.reasons.some(r => /sign hanging over/.test(r)), "and the mind can say why");

  // A sign is not a cage: a mind that wants it badly enough still goes. Make the
  // grievance a vendetta and the deterrence stops being decisive.
  adjustEdge(a, b.id, { resentment: 60 }, world.clock.tick);
  adjustEdge(b, a.id, { resentment: 60 }, world.clock.tick);
  assert.ok(confrontUtility(world, a, b.id), "the world can still have it out under a sign");
});

test("an omen stops cooling the moment its window closes", () => {
  const { world, a, b } = feudWorld(34);
  performIntervention(world, "omen", { regionId: a.regionId });
  const sign = recentInterventions(world, 1)[0];
  world.clock.tick = sign.expireTick;
  const before = a.relations[b.id].resentment;
  settleDivine(world);
  assert.equal(a.relations[b.id].resentment, before, "a sign that has passed changes nothing");
  assert.equal(liveInterventions(world.divine, world.clock.tick).length, 0);
  assert.equal(markedInterventions(world.divine, world.clock.tick).length, 1, "but the board still remembers it");
});

test("the apparition is the most expensive act, and the only one that writes no law", () => {
  const { world, a, b } = feudWorld(35);
  world.charter.dilemmas.push({
    id: "dil-test", text: "Two builders, one vendetta.", partyIds: [a.id, b.id],
    kind: "feud", tick: world.clock.tick, status: "open"
  });
  const influence = world.charter.influence;
  const precedents = world.charter.precedents.length;
  const before = a.relations[b.id].resentment;

  const result = performIntervention(world, "apparition", {});
  assert.equal(result.ok, true);
  assert.equal(world.charter.influence, influence - 12, "it costs the most");
  assert.equal(a.relations[b.id].resentment, before + world.config.divine.apparitionResentment,
    "and it puts down thirty of what they were carrying");
  assert.equal(b.relations[a.id].resentment, before + world.config.divine.apparitionResentment);
  assert.equal(world.charter.dilemmas[0].status, "resolved");
  assert.equal(world.charter.dilemmas[0].resolution, "apparition");
  assert.equal(world.charter.precedents.length, precedents, "nothing was said, so no law is written");
  assert.ok(!world.charter.dilemmas.some(d => d.status === "open"), "and it is not waiting to be settled twice");
  assert.ok(a.memory.traces.some(t => /stood where we were standing/i.test(t.text)), "neither of them forgets it");
  // Nothing is left to appear at — and the next refusal says whichever of the
  // two reasons comes first, which is honest either way.
  assert.match((canIntervene(world, "apparition", {}).reason || ""), /more ticks? before you can|nothing is waiting/i);
});

test("every intervention moves the keeper's own meters, through the same ledger", () => {
  const { world, a, b } = feudWorld(36);
  world.charter.dilemmas.push({
    id: "dil-meter", text: "A feud with no room left.", partyIds: [a.id, b.id],
    kind: "feud", tick: world.clock.tick, status: "open"
  });
  const acts = world.config.want.acts;
  const before = wantLog(world.want, 1).length;

  const omen = performIntervention(world, "omen", { regionId: a.regionId });
  const blessing = performIntervention(world, "blessing", { agentId: a.id });
  const apparition = performIntervention(world, "apparition", {});
  assert.ok(omen.ok && blessing.ok && apparition.ok);

  const entries = wantLog(world.want, 8).slice(0, 8);
  assert.equal(entries.length >= 3, true, "each act is written down");
  /** @type {[RegExp, "omen"|"blessing"|"apparition"][]} */
  const expected = [[/omen over/, "omen"], [/blessed/, "blessing"], [/appeared where/, "apparition"]];
  for (const [pattern, kind] of expected) {
    const entry = entries.find(e => pattern.test(e.cause));
    assert.ok(entry, `the ledger names the ${kind}`);
    assert.equal(entry.by, "keeper");
    assert.deepEqual(entry.deltas, acts[kind], `the ${kind} moves the meters it says it does`);
  }
  // Every act also carries the meters it landed in, so the record can show them
  // without re-deriving anything.
  assert.ok(apparition.intervention && apparition.intervention.values);
  assert.equal(/** @type {number[]} */ (apparition.intervention.values).length, 3);
  assert.ok(before === 0 || wantLog(world.want, 1).length > before);
});

test("the board marks where the keeper has been, and the mark outlives the effect", () => {
  const { world, a } = feudWorld(37);
  assert.equal(divineMarks(world).length, 0, "a world nobody has touched carries no sign");
  assert.match(describeBoard(world), /no sign on the world yet/);

  performIntervention(world, "omen", { regionId: a.regionId });
  const blessing = performIntervention(world, "blessing", { agentId: a.id });
  const marks = divineMarks(world);
  assert.equal(marks.length, 2);
  const omen = marks.find(m => m.kind === "omen");
  assert.ok(omen, "the sign is on the board, over the region it was set over");
  assert.equal(omen.regionId, a.regionId);
  assert.equal(omen.live, true);
  assert.match(omen.label, /a sign over/);
  assert.match(describeBoard(world), /signs of the keeper's still standing \(omen, blessing\)/);

  // Once the window closes the mark stops being live, and once the fade is over
  // it is gone from the board entirely — but the record keeps it.
  const iv = recentInterventions(world, 2).find(i => i.kind === "omen");
  assert.ok(iv);
  world.clock.tick = iv.expireTick;
  assert.equal(divineMarks(world).find(m => m.id === iv.id)?.live, false);
  world.clock.tick = iv.markUntil;
  assert.equal(divineMarks(world).some(m => m.id === iv.id), false);
  assert.ok(recentInterventions(world, 4).some(i => i.id === iv.id), "the record keeps what the board drops");
  assert.equal(blessing.ok, true);
});

test("a sign survives the save, the reload and the app being closed", () => {
  const { world, a } = feudWorld(38);
  performIntervention(world, "blessing", { agentId: a.id });
  const back = deserializeWorld(serializeWorld(world));
  assert.deepEqual(back.divine, world.divine, "the keeper's signs come back exactly as they were");
  assert.deepEqual(divineMarks(back).map(m => m.kind), divineMarks(world).map(m => m.kind));
  // And a world saved before any of this existed simply has never been visited.
  const old = JSON.parse(serializeWorld(world));
  delete old.divine;
  assert.deepEqual(deserializeWorld(JSON.stringify(old)).divine, { interventions: [], lastTick: {}, counts: {} });
});

test("the same keeper act in the same world always lands in the same world", () => {
  const one = feudWorld(39);
  const two = feudWorld(39);
  for (const { world, a } of [one, two]) {
    performIntervention(world, "omen", { regionId: a.regionId });
    performIntervention(world, "blessing", { agentId: a.id });
    for (let i = 0; i < 30; i++) step(world);
  }
  assert.equal(serializeWorld(one.world), serializeWorld(two.world), "interventions draw nothing from the RNG");
  assert.equal(one.a.relations[one.b.id].resentment, two.a.relations[two.b.id].resentment);
});

test("an intervention is never a message: it is an event the world saw", () => {
  const { world, a, b } = feudWorld(40);
  world.charter.dilemmas.push({
    id: "dil-quiet", text: "A feud with no room left.", partyIds: [a.id, b.id],
    kind: "feud", tick: world.clock.tick, status: "open"
  });
  const seqBefore = world.events.length ? world.events[0].seq : 0;
  performIntervention(world, "blessing", { agentId: a.id });
  performIntervention(world, "apparition", {});
  const fresh = world.events.filter(e => e.seq > seqBefore);
  assert.ok(fresh.length >= 2, "each act reaches the record");
  assert.ok(fresh.every(e => e.kind === "divine"), "and reaches it as an intervention, not as talk");
  assert.ok(fresh.some(e => /light that came from nowhere/.test(e.text)));
  assert.equal(world.charter.rulingsMade, 0, "nothing was said, so nothing was ruled");
  assert.equal(regionName(world, a.regionId).length > 0, true);
});

/**
 * The same world as `feudWorld`, untouched: the control half of a comparison.
 * @param {number} seed
 */
function feastCopy(seed) {
  const world = freshWorld(seed);
  const [a, b] = livingAgents(world);
  b.regionId = a.regionId;
  adjustEdge(a, b.id, { resentment: 60, familiarity: 20 }, world.clock.tick);
  adjustEdge(b, a.id, { resentment: 60, familiarity: 20 }, world.clock.tick);
  return world;
}

/**
 * What a mind thinks of confronting somebody, if it thinks of it at all.
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/agent.js").Agent} agent
 * @param {string} rivalId
 */
function confrontUtility(world, agent, rivalId) {
  const intent = generateIntents(world, agent).find(i => i.kind === "confront" && i.targetId === rivalId);
  return intent ? { utility: intent.utility, reasons: intent.reasons } : null;
}
