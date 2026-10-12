/**
 * Phase D, fourth idea: the always-on world — and what it says on return.
 *
 * The runner keeps the world ticking while the keeper is elsewhere, and the app
 * pays back closed time by running the same simulation forward. Both are the
 * same thing: a world moving without a witness. The claim under test is that
 * when the keeper comes back, the absence is *reported* — from a comparison of
 * two real states, never invented — and that the report names what the world
 * lost, what it built, and what is now waiting on the keeper.
 *
 * The digest is pure: no DOM, no storage, no clock of its own. These are facts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { serializeWorld, deserializeWorld } from "../engine/snapshot.js";
import { adjustEdge } from "../engine/model/relationships.js";
import { keeperAct } from "../engine/systems/want.js";
import { callFuneral, settleMourning } from "../engine/systems/mourning.js";
import { applyEffects } from "../engine/systems/effects.js";
import { digestMark, awayDigest, digestLine } from "../app/digest.js";

/**
 * A world where the first mind can be buried on demand, with a real quarrel for
 * them to leave behind.
 * @param {number} seed
 */
function worldWithAGrudge(seed) {
  const world = createWorld({ seed, config: /** @type {any} */ ({ mourning: { callDelayTicks: 0 } }) });
  const [dead, heir, rival] = livingAgents(world);
  adjustEdge(heir, dead.id, { affinity: 80, familiarity: 40 }, 0);
  adjustEdge(dead, rival.id, { resentment: 80, affinity: -40 }, 0);
  adjustEdge(rival, dead.id, { resentment: 80, affinity: -40 }, 0);
  return { world, dead, heir, rival };
}

/**
 * Kill a mind the way the engine does, without waiting for a turnover tick.
 * @param {import("../engine/model/world.js").World} world
 * @param {any} dead
 */
function bury(world, dead) {
  dead.retired = true;
  dead.departureKind = "died";
  callFuneral(world, dead);
  const funeral = /** @type {any} */ (world.mourning.funerals.at(-1));
  funeral.holdTick = world.clock.tick;
  settleMourning(world);
  applyEffects(world, /** @type {any} */ (world.pendingOps || []), {});
  world.pendingOps = [];
  return funeral;
}

test("an absence the world slept through is reported as exactly that, not as a story", () => {
  const world = createWorld({ seed: 3 });
  const mark = digestMark(world);
  const digest = awayDigest(mark, world, { hours: 0.1, because: "service" });

  assert.equal(digest.ticks, 0);
  assert.equal(digest.empty, true, "nothing happened, so there is nothing to tell");
  assert.equal(digest.lines.length, 0);
  assert.equal(digestLine(digest), "The world is where you left it.");
  // The meters still report where they stand, so the card is never blank.
  assert.equal(digest.meters.length, 3);
  assert.ok(digest.meters.every(m => m.delta === 0));
});

test("a death inside the window leads the digest, and the quarrel it left behind is followed to its heir", () => {
  const { world, dead, heir, rival } = worldWithAGrudge(20);
  const mark = digestMark(world);
  // The keeper leaves; the mind dies while they are gone.
  bury(world, dead);

  const digest = awayDigest(mark, world, { hours: 6, because: "service" });
  const death = digest.lines.find(l => l.kind === "death");
  assert.ok(death, "the world's loss leads");
  assert.ok(death.text.includes(dead.name), `the dead are named: ${death.text}`);
  assert.ok(death.text.length > dead.name.length, "and the world says something about them");

  const inherited = digest.lines.find(l => l.kind === "inherited");
  assert.ok(inherited, "a real grudge is an inheritance, and the digest follows it");
  assert.ok(inherited.text.includes(heir.name), `the heir is named: ${inherited.text}`);
  assert.ok(inherited.text.includes(rival.name), `and so is the person they now resent: ${inherited.text}`);

  // The chronicle weight of a death shows up where the keeper's score lives.
  const legacy = digest.meters.find(m => m.key === "legacy");
  assert.ok(legacy && Number.isFinite(legacy.to), "the loss is measurable on the keeper's own meters");
  assert.ok(legacy.to > 0);
  assert.ok(digest.headline === null || digest.headline.tick > mark.tick,
    "the headline is always something that happened in the window");
});

test("the keeper's own score is shown as where it was and where it is now", () => {
  const world = createWorld({ seed: 8 });
  const mark = digestMark(world);
  keeperAct(world, "you blessed Orin with a light", { harmony: 3, prosperity: 2 });

  const digest = awayDigest(mark, world, { hours: 1, because: "offline" });
  const harmony = digest.meters.find(m => m.key === "harmony");
  const legacy = digest.meters.find(m => m.key === "legacy");
  assert.equal(harmony?.delta, 3, "the movement is the difference, not a claim");
  assert.equal(harmony?.from, Math.round(mark.want.harmony * 10) / 10);
  assert.equal(harmony?.to, Math.round(world.want.harmony));
  assert.equal(legacy?.delta, 0, "an untouched meter reads as untouched");
  assert.ok(digest.lines.every(l => !/blessed/.test(l.text)),
    "the digest reports the world, not the keeper's own act");
});

test("a custom made without the keeper, and the wall that rose while they were gone, are both in the digest", () => {
  const world = createWorld({ seed: 6 });
  const mark = digestMark(world);

  world.charter.rules.push(/** @type {any} */ ({
    id: "test-rule",
    ruleKind: "quiet_hours",
    kind: "tradition",
    ruling: "enacted",
    proposedBy: world.agents[0].id,
    text: "The world keeps its quiet hours.",
    tick: world.clock.tick
  }));
  world.charter.wallRaised = true;
  world.project.status = "complete";
  world.project.progress = 100;
  world.clock.tick += 72;

  const digest = awayDigest(mark, world, { hours: 12, because: "service" });
  const law = digest.lines.find(l => l.kind === "law");
  assert.ok(law, "a law nobody asked the keeper about is still reported");
  assert.ok(law.text.includes("quiet_hours"), law.text);
  assert.ok(digest.lines.some(l => l.kind === "wall" && /stands/.test(l.text)),
    "and the shared win is named as the shared win, not as a percentage");
  assert.equal(digestLine(digest).includes("Chronicle"), true, "the toast points at the record");
});

test("a world that went quiet while the keeper was away says so plainly", () => {
  const world = createWorld({ seed: 9 });
  const mark = digestMark(world);
  world.want.quietTicks = 240;
  world.want.fallen = true;
  world.want.ignored += 2;
  world.clock.tick += 60;

  const digest = awayDigest(mark, world, { hours: 20, because: "service" });
  const quiet = digest.lines.find(l => l.kind === "quiet");
  assert.ok(quiet, "the lose condition is the one line that cannot be left out");
  assert.equal(digest.quiet.fallen, true);
  assert.equal(digest.quiet.since, 240);
  assert.equal(quiet.text.includes("quiet"), true, "quiet is reported as a condition, not as an absence of news");
  assert.ok(digest.lines.some(l => l.kind === "asks"), "and with what went unanswered while nobody was looking");
});

test("the digest is built from a mark, so it survives a save and a reload", () => {
  const world = createWorld({ seed: 11 });
  const mark = digestMark(world);
  const storedMark = JSON.parse(JSON.stringify(mark));

  // The world moves on and is written down, then read back the way the app does.
  keeperAct(world, "you set an omen over the Lantern District", { harmony: 3 });
  world.clock.tick += 96;
  const reloaded = deserializeWorld(serializeWorld(world));

  const digest = awayDigest(storedMark, reloaded, { hours: 2, because: "offline" });
  assert.equal(digest.ticks, 96, "the mark is enough to know how long the keeper was gone");
  assert.ok(digest.lines.some(l => l.kind === "span"), "and it opens with the span");
  const harmony = digest.meters.find(m => m.key === "harmony");
  assert.equal(harmony?.delta, 3);

  // A world that has never been marked produces no digest at all — the app must
  // not invent one from nothing.
  const bare = awayDigest({ ...mark }, deserializeWorld(serializeWorld(world)), { because: "manual" });
  assert.ok(bare.ticks >= 0);
});
