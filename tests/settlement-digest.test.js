/**
 * Phase F, the 3pm reason: the "while you were away" digest surfaces the
 * camp decisions that go stale — an approaching storm, low food, a feud
 * about to split a crew — and says plainly that the world decides
 * without the keeper if they do not come back.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, livingAgents } from "../engine/model/world.js";
import { digestMark, awayDigest } from "../app/digest.js";
import { assignCrew, resolveStorm, collapseSettlement } from "../engine/systems/settlement.js";
import { buildingByKind } from "../engine/model/settlement.js";
import { edgeToward } from "../engine/model/relationships.js";

/** @param {number} seed */
function gameWorld(seed = 141) {
  return createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
}

test("an approaching storm leads the stale decisions, with the defence it will meet", () => {
  const world = gameWorld();
  // Move the season far away for the mark, then bring it to the door.
  world.settlement.storm.nextStormDay = world.clock.day + 6;
  const mark = digestMark(world);
  world.settlement.storm.nextStormDay = world.clock.day + 1;
  const digest = awayDigest(mark, world, { hours: 3, because: "offline" });
  const storm = digest.lines.find(l => l.kind === "storm");
  assert.ok(storm, "the approaching storm is surfaced");
  assert.match(storm.text, /strength \d+/);
  assert.match(storm.text, /meets the storm exactly as it stands/, "and it says what happens if nobody acts");
  assert.ok(digest.settlement && digest.settlement.stormDaysUntil <= 1);
});

test("low food and a crew about to split are surfaced by name", () => {
  const world = gameWorld(142);
  const mark = digestMark(world);
  const fields = buildingByKind(world.settlement, "fields");
  assert.ok(fields);
  const [a, b] = livingAgents(world);
  assignCrew(world, fields.id, a.id);
  assignCrew(world, fields.id, b.id);
  edgeToward(a, b.id).resentment = 29;
  edgeToward(b, a.id).resentment = 12;
  world.settlement.stores.food = 4; // hours of food for nine minds, not days

  const digest = awayDigest(mark, world, { hours: 5, because: "offline" });
  const food = digest.lines.find(l => l.kind === "food");
  assert.ok(food);
  assert.match(food.text, /go hungry/);
  const feud = digest.lines.find(l => l.kind === "feud");
  assert.ok(feud, "the near-split crew is named before it splits");
  assert.ok(feud.text.includes(a.name) && feud.text.includes(b.name));
  assert.ok(feud.text.includes(fields.name));
});

test("a storm that already hit, damage unrepaired, and a collapse each read as themselves", () => {
  const hit = gameWorld(143);
  hit.settlement.wall.condition = 20;
  const hitMark = digestMark(hit);
  resolveStorm(hit);
  const hitDigest = awayDigest(hitMark, hit, { hours: 8, because: "service" });
  assert.ok(hitDigest.lines.some(l => l.kind === "storm" && /hit the camp/.test(l.text)));
  assert.ok(hitDigest.lines.some(l => l.kind === "building" && /damaged/.test(l.text)),
    "storm damage left unrepaired is a stale decision too");

  const fallen = gameWorld(144);
  const fallenMark = digestMark(fallen);
  collapseSettlement(fallen, "the Hold gave out");
  const fallenDigest = awayDigest(fallenMark, fallen, { hours: 8, because: "service" });
  const collapse = fallenDigest.lines.find(l => l.kind === "collapse");
  assert.ok(collapse);
  assert.match(collapse.text, /scattered/);
});

test("a quiet camp adds no settlement noise to the digest", () => {
  const world = gameWorld(145);
  world.settlement.storm.nextStormDay = world.clock.day + 6;
  world.settlement.stores.food = 90;
  const mark = digestMark(world);
  const digest = awayDigest(mark, world, { hours: 1, because: "offline" });
  assert.ok(!digest.lines.some(l => ["storm", "food", "building", "collapse"].includes(l.kind)),
    `a fed camp with the storm a week out stays quiet: ${JSON.stringify(digest.lines)}`);
});

test("a dormant world has no camp decisions to surface, before or after", () => {
  const world = createWorld({ seed: 146 });
  const mark = digestMark(world);
  assert.equal(mark.settlement?.enabled, false);
  const digest = awayDigest(mark, world, { hours: 2, because: "offline" });
  assert.ok(!digest.lines.some(l => ["storm", "food", "collapse"].includes(l.kind)));
});
