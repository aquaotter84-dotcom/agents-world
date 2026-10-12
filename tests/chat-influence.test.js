/**
 * Chat influence: Jeremy's words change the simulation.
 *
 * Covers the lexicon scorer (intensifiers, negation), mood shifts and clamps,
 * memory traces, third-mind mention nudges (and the false positives they must
 * avoid), goal seeding + adoption, social-need satisfaction, feed surfacing,
 * keeper-role modulation, mood decay, and determinism.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import {
  applyChatInfluence,
  scoreSentiment,
  sentimentKind,
  detectDirective,
  settleChat,
  GOAL_ADOPT_PER_TICK
} from "../engine/systems/chat-influence.js";
import { edgeToward } from "../engine/model/relationships.js";
import { moodWord } from "../engine/model/agent.js";
import { recall } from "../engine/model/memory.js";
import { step } from "../engine/simulation.js";

/** Two fresh minds from a fresh world. */
function twoMinds(seed = 7) {
  const world = createWorld({ seed });
  const [a, b] = world.agents;
  return { world, a, b };
}

/* ---------- sentiment ---------- */

test("warm and cold messages score with the right sign", () => {
  assert.ok(scoreSentiment("I love you, truly wonderful!") >= 2);
  assert.ok(scoreSentiment("I hate this terrible awful day") <= -2);
  assert.equal(sentimentKind(scoreSentiment("I love you")), "warm");
  assert.equal(sentimentKind(scoreSentiment("this is cruel and vile")), "cold");
  assert.equal(sentimentKind(scoreSentiment("the sky is blue today")), "neutral");
});

test("negation flips the next sentiment word", () => {
  assert.ok(scoreSentiment("that is not good at all") < 0);
  assert.ok(scoreSentiment("never a happy moment") < 0);
});

test("intensifiers scale the next sentiment word", () => {
  assert.ok(scoreSentiment("very happy") > scoreSentiment("happy"));
  assert.ok(scoreSentiment("extremely cruel") < scoreSentiment("cruel"));
  assert.ok(scoreSentiment("not very good") < scoreSentiment("not good"));
});

/* ---------- mood ---------- */

test("warm chat lifts mood, cold chat lowers it, neutral does nothing", () => {
  const { world, a } = twoMinds();
  const warm = applyChatInfluence(world, a, "I love your wonderful kind heart", "r", "spirit");
  assert.ok(warm.moodShift >= 6 && warm.moodShift <= 12);
  assert.equal(a.moodLevel, 50 + warm.moodShift);

  const w2 = createWorld({ seed: 7 });
  const a2 = w2.agents[0];
  const cold = applyChatInfluence(w2, a2, "I hate this cruel vile place", "r", "demon");
  assert.ok(cold.moodShift <= -6 && cold.moodShift >= -12);
  assert.equal(a2.moodLevel, 50 + cold.moodShift);

  const w3 = createWorld({ seed: 7 });
  const a3 = w3.agents[0];
  const neutral = applyChatInfluence(w3, a3, "the sky is blue today", "r");
  assert.equal(neutral.moodShift, 0);
  assert.equal(a3.moodLevel, 50);
});

test("mood clamps at 0 and 100", () => {
  const { world, a } = twoMinds();
  a.moodLevel = 99;
  applyChatInfluence(world, a, "I love this wonderful amazing day", "r");
  assert.equal(a.moodLevel, 100);
  a.moodLevel = 1;
  applyChatInfluence(world, a, "I hate this cruel vile day", "r");
  assert.equal(a.moodLevel, 0);
});

test("same inputs give same shifts (deterministic)", () => {
  const run = () => {
    const { world, a } = twoMinds(21);
    const report = applyChatInfluence(world, a, "I truly love your brave kind heart", "reply!", "trickster");
    const lastTrace = a.memory.traces.at(-1);
    assert.ok(lastTrace);
    return { shift: report.moodShift, mood: a.moodLevel, mem: lastTrace.text };
  };
  assert.deepEqual(run(), run());
});

test("keeper roles modulate the shift a little", () => {
  const plain = twoMinds(5);
  const rPlain = applyChatInfluence(plain.world, plain.a, "you are cruel and vile", "r");
  const demon = twoMinds(5);
  const rDemon = applyChatInfluence(demon.world, demon.a, "you are cruel and vile", "r", "demon");
  assert.ok(rDemon.moodShift < rPlain.moodShift, "a Demon's barbs cut deeper");

  const plain2 = twoMinds(5);
  const rPlain2 = applyChatInfluence(plain2.world, plain2.a, "you are wonderful and kind", "r");
  const spirit = twoMinds(5);
  const rSpirit = applyChatInfluence(spirit.world, spirit.a, "you are wonderful and kind", "r", "spirit");
  assert.ok(rSpirit.moodShift > rPlain2.moodShift, "a Spirit's comfort soothes more");
});

/* ---------- memory ---------- */

test("chat leaves a recallable trace of Jeremy's words", () => {
  const { world, a } = twoMinds();
  applyChatInfluence(world, a, "I love your wonderful stories, keep them coming", "r");
  const traces = recall(a.memory, { tick: world.clock.tick, config: world.config, kinds: ["contact"] });
  const mine = traces.find(t => t.text.includes("keep them coming"));
  assert.ok(mine, "trace exists and is recallable");
  assert.ok(mine.valence > 0, "warm chat has warm valence");
  assert.equal(mine.tick, world.clock.tick);
});

test("long messages are truncated in memory", () => {
  const { world, a } = twoMinds();
  applyChatInfluence(world, a, "x".repeat(300), "r");
  const last = a.memory.traces.at(-1);
  assert.ok(last);
  assert.ok(last.text.length <= 140, `trace is compact, got ${last.text.length}`);
});

/* ---------- mentions ---------- */

test("praising a named mind warms the speaker toward them", () => {
  const { world, a, b } = twoMinds();
  const before = edgeToward(a, b.id);
  const a0 = before.affinity, t0 = before.trust;
  const report = applyChatInfluence(world, a, `${b.name} is wonderful and kind`, "r");
  assert.deepEqual(report.mentionedIds, [b.id]);
  const after = edgeToward(a, b.id);
  assert.equal(after.affinity, a0 + 4);
  assert.equal(after.trust, t0 + 4);
});

test("warning about a named mind chills the speaker toward them", () => {
  const { world, a, b } = twoMinds();
  applyChatInfluence(world, a, `${b.name} is cruel and vile, beware`, "r");
  const after = edgeToward(a, b.id);
  assert.ok(after.affinity < 40 && after.trust < 40);
});

test("no false positives on mentions", () => {
  const { world, a, b } = twoMinds();
  // A name embedded in a longer word must not match; the speaker's own name
  // is never a third-mind mention.
  applyChatInfluence(world, a, `${b.name}x is a thing, and ${a.name} agrees`, "r");
  assert.ok(!(b.id in a.relations), "compound word matched nothing");
  assert.ok(!(a.id in a.relations), "no self edge");
  // Neutral sentiment names nobody's feelings.
  const w2 = createWorld({ seed: 7 });
  const [c, d] = w2.agents;
  applyChatInfluence(w2, c, `${d.name} walked by today`, "r");
  assert.ok(!(d.id in c.relations), "neutral mention nudges nothing");
});

/* ---------- goals ---------- */

test("directives are stored as suggested goals", () => {
  const { world, a } = twoMinds();
  const r = applyChatInfluence(world, a, "you should guard the northern gate tonight", "r");
  assert.ok(r.goalSeeded);
  assert.ok(a.suggestedGoal);
  assert.ok(a.suggestedGoal.text.includes("guard the northern gate"));
  assert.equal(a.suggestedGoal.tick, world.clock.tick);
});

test("plain chat seeds no goal", () => {
  const { world, a } = twoMinds();
  const r = applyChatInfluence(world, a, "nice weather we're having", "r");
  assert.ok(!r.goalSeeded);
  assert.equal(a.suggestedGoal, undefined);
  assert.ok(detectDirective("just thinking out loud") === null);
  const pm = detectDirective("promise me you'll keep them safe");
  assert.ok(pm && pm.includes("keep them safe"));
});

test("a suggested goal can be adopted, announced in the feed", () => {
  const { world, a } = twoMinds(11);
  applyChatInfluence(world, a, "you should guard the northern gate", "r");
  world.rng.float = () => 0; // force the adoption roll
  step(world);
  assert.ok(a.goal.text.includes("guard the northern gate"), "goal adopted");
  assert.equal(a.suggestedGoal, undefined, "suggestion consumed");
  const announced = world.events.find(e => e.text.includes("takes Jeremy's words to heart"));
  assert.ok(announced, "adoption announced in feed");
  assert.equal(announced.kind, "goal");
});

test("without a lucky roll the suggestion waits", () => {
  const { world, a } = twoMinds(11);
  applyChatInfluence(world, a, "you should guard the northern gate", "r");
  world.rng.float = () => 0.999; // far above the 8% adoption chance
  step(world);
  assert.ok(a.suggestedGoal, "still waiting");
  assert.ok(!a.goal.text.includes("guard the northern gate"));
});

/* ---------- needs, feed, decay, mood word ---------- */

test("talking satisfies a little social need", () => {
  const { world, a } = twoMinds();
  a.needs.connection = 40;
  applyChatInfluence(world, a, "hello there", "r");
  assert.ok(a.needs.connection > 40 && a.needs.connection <= 100);
});

test("big swings reach the feed, small ones stay quiet", () => {
  const w1 = createWorld({ seed: 7 });
  applyChatInfluence(w1, w1.agents[0], "I love this wonderful amazing great day", "r");
  assert.ok(w1.events.some(e => e.text.includes("lift") && e.text.includes("spirits")));

  const w2 = createWorld({ seed: 7 });
  applyChatInfluence(w2, w2.agents[0], "I love this", "r"); // score 1 -> +6, under the threshold
  assert.ok(!w2.events.some(e => e.text.includes("spirits") || e.text.includes("leave a mark")));
});

test("mood decays toward baseline each tick", () => {
  const { world, a } = twoMinds();
  a.moodLevel = 60;
  settleChat(world, a);
  assert.equal(a.moodLevel, 58);
  for (let i = 0; i < 10; i++) settleChat(world, a);
  assert.equal(a.moodLevel, 50);
});

test("extreme chat mood tips the mood word", () => {
  const { world, a } = twoMinds();
  a.needs = { energy: 80, connection: 80, esteem: 80, meaning: 80 };
  a.mood = "steady";
  a.moodLevel = 80;
  assert.equal(moodWord(a, world.clock.tick), "bright");
  a.moodLevel = 20;
  assert.equal(moodWord(a, world.clock.tick), "low");
  a.moodLevel = 50;
  assert.ok(!["bright", "low"].includes(moodWord(a, world.clock.tick)));
});

test("a real transient mood still beats chat mood", () => {
  const { world, a } = twoMinds();
  a.needs = { energy: 80, connection: 80, esteem: 80, meaning: 80 };
  a.mood = "triumphant";
  a.moodUntil = world.clock.tick + 100;
  a.moodLevel = 90;
  assert.equal(moodWord(a, world.clock.tick), "triumphant");
});
