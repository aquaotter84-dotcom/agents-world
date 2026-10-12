import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld, step, serializeWorld, deserializeWorld, socialEncounter, agentById, livingAgents } from "../engine/index.js";
import { composeScene } from "../engine/systems/scene.js";
import { remember } from "../engine/model/memory.js";
import { edgeToward } from "../engine/model/relationships.js";

function twoMinds(seed = 3) {
  const world = createWorld({ seed });
  const [a, b] = livingAgents(world);
  return { world, a, b };
}

test("a scene is four to six lines, spoken only by the two minds in it", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { world, a, b } = twoMinds(seed);
    for (const quality of [0.8, -0.8]) {
      const scene = composeScene(world, a, b, quality, "the Market");
      assert.ok(scene.length >= 4 && scene.length <= 6, `seed ${seed}: got ${scene.length} lines`);
      for (const line of scene) {
        assert.ok([a.id, b.id].includes(line.speakerId));
        assert.ok(line.text.length > 0);
      }
    }
  }
});

test("no line leaks template syntax, empty slots, or doubled punctuation", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { world, a, b } = twoMinds(seed);
    for (const quality of [0.9, -0.9]) {
      for (const line of composeScene(world, a, b, quality, "the Crossroads")) {
        assert.doesNotMatch(line.text, /[{}]|undefined|null/, line.text);
        assert.doesNotMatch(line.text, /\.\./, line.text);
      }
    }
  }
});

test("the same world composes the same conversation", () => {
  const first = twoMinds(9);
  const second = twoMinds(9);
  const s1 = composeScene(first.world, first.a, first.b, 0.7, "the Market");
  const s2 = composeScene(second.world, second.a, second.b, 0.7, "the Market");
  assert.deepEqual(s1, s2);
});

test("a remembered wrong is brought up by the one still holding it", () => {
  let brought = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { world, a, b } = twoMinds(seed);
    // b still resents a, and remembers a specific incident.
    edgeToward(b, a.id).resentment = 60;
    remember(b.memory, {
      kind: "conflict",
      text: "You left me to face the north wall alone.",
      subjectId: a.id,
      valence: -0.8,
      salience: 0.9,
      tick: world.clock.tick
    }, () => "m-test");
    const scene = composeScene(world, a, b, -0.5, "the Market");
    if (scene.some(l => l.speakerId === b.id && l.text.includes("north wall"))) brought++;
  }
  assert.ok(brought > 0, "the grievance should surface in at least some scenes");
});

test("a loud encounter carries a transcript; a quiet one does not compose one", () => {
  let loudSeen = 0;
  let quietSeen = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const world = createWorld({ seed });
    const [a, b] = livingAgents(world);
    b.regionId = a.regionId;
    const res = /** @type {any} */ (socialEncounter(world, a, b, "meet"));
    if (res.quiet) {
      quietSeen++;
      assert.equal(res.scene, undefined);
    } else {
      loudSeen++;
      assert.ok(res.scene && res.scene.length >= 4, `seed ${seed} should carry a scene`);
    }
  }
  assert.ok(loudSeen > 0 && quietSeen > 0, "the sample should cover both loud and quiet meetings");
});

test("scenes survive a save and reload", () => {
  const world = createWorld({ seed: 5 });
  for (let i = 0; i < 300; i++) step(world);
  const withScene = /** @type {any} */ (world.events.find(e => e.scene));
  if (!withScene) return; // nothing loud happened in this window; nothing to check
  const restored = deserializeWorld(serializeWorld(world));
  const again = /** @type {any} */ (restored.events.find(e => e.id === withScene.id));
  assert.ok(again, "the event should still be in the restored log");
  assert.deepEqual(again.scene, withScene.scene);
  assert.ok(agentById(restored, withScene.scene[0].speakerId));
});
