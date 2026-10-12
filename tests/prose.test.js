/**
 * The world's voice.
 *
 * These tests guard the thing a reader notices before they notice any mechanic:
 * whether the record sounds like a world or like a form letter. The failure they
 * exist to catch is not a crash — it is a long run in which the same sentence
 * arrives forty times and a third of the lines still read like menu entries.
 *
 * Every one of them failed before the prose pass: the menu-text leak was in the
 * feed at 4.4% of events, and the busiest kinds held a distinct-text ratio of
 * 0.06 — sixty sentences recycled across a thousand events.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, serializeWorld, deserializeWorld, forkWorld } from "../engine/index.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { pickFresh } from "../engine/decision/prose.js";
import { advanceWithModel, offlineWorld } from "./helpers.mjs";

const MENU_LEAK = /chose the option that read/;
const PLACEHOLDER = /\{[a-z]+\}/;

/**
 * Three ways a world gets narrated: the engine answering its own moments (an
 * offline world, or one whose model was slow), a model answering them, and a
 * mind that keeps changing its mind.
 *
 * That third one is not a flourish. A goal change is the only option whose id
 * cannot be listed in the narration tables — it is generated from the goal
 * tables — so it is the one path that falls through to the option's own prose.
 * When that prose went missing the feed filled up with "chose the option that
 * read: Take up something new…" instead. Nothing else drove that path hard
 * enough to notice, so this policy does.
 * @param {number} ticks
 */
function runs(ticks) {
  return {
    expiry: offlineWorld({ seed: 5, ticks }),
    answered: (() => {
      const world = createWorld({ seed: 5 });
      advanceWithModel(world, ticks);
      return world;
    })(),
    restless: (() => {
      const world = createWorld({ seed: 5 });
      for (let i = 0; i < ticks; i++) {
        step(world);
        for (const moment of [...world.pending]) {
          if (moment.kind === "cognition") {
            resolveMoment(world, moment.id, { action: "observe", target: "NONE", plan: "I will look around carefully." });
            continue;
          }
          // A proposal has no menu: the model names an approach instead. Cycling
          // through the ones on offer keeps the lines distinct across a long run.
          if (moment.kind === "goal_approach") {
            const offered = /** @type {any} */ (moment.context).availableMethods || ["focus"];
            const method = offered[i % offered.length];
            resolveMoment(world, moment.id, {
              method,
              approach: `Working at it their own way — ${method.replace(/_/g, " ")} for now.`
            });
            continue;
          }
          const generated = moment.options.find(o => String(o.id).startsWith("new_goal"));
          const chosen = generated || moment.options[moment.options.length - 1];
          resolveMoment(world, moment.id, { optionId: chosen.id });
        }
      }
      return world;
    })()
  };
}

test("no line of narration ever leaks a menu label", () => {
  for (const [how, world] of Object.entries(runs(700))) {
    for (const event of world.events) {
      assert.ok(
        !MENU_LEAK.test(event.text),
        `${how}: a moment fell through to its menu entry — "${event.text}"`
      );
    }
  }
});

test("no line of narration is left with an unfilled placeholder", () => {
  // A hole like {newgoal} reaches the reader as a typo in the middle of a story.
  // It happens when an option carries its own prose and the values it needs do
  // not travel with it, which is the other half of this bug class.
  for (const [how, world] of Object.entries(runs(700))) {
    for (const event of world.events) {
      assert.ok(!PLACEHOLDER.test(event.text), `${how}: unfilled placeholder in "${event.text}"`);
    }
    for (const day of /** @type {any[]} */ (world.chronicle)) {
      assert.ok(!PLACEHOLDER.test(day.summary), `${how}: unfilled placeholder in a chronicle`);
    }
  }
});

test("the record keeps finding new things to say", () => {
  const { expiry } = runs(1200);
  const counts = new Map();
  for (const event of expiry.events) {
    counts.set(event.text, (counts.get(event.text) || 0) + 1);
  }
  const total = expiry.events.length;
  const distinct = counts.size / total;
  assert.ok(
    distinct >= 0.4,
    `only ${(distinct * 100).toFixed(0)}% of ${total} events were distinct lines — the templates have run dry`
  );
  const worst = Math.max(...counts.values());
  assert.ok(
    worst <= total * 0.02,
    `one line appeared ${worst} times in ${total} events (${((worst / total) * 100).toFixed(1)}%)`
  );
});

test("one kind of talk does not swallow the record", () => {
  // Gossip used to be the single largest kind in the feed — 35 to 51% of it,
  // depending on the cast — because having an opinion about somebody was the
  // cheapest act in the world. News should travel; it should not be the weather.
  for (const [how, world] of Object.entries(runs(900))) {
    const total = world.events.length;
    const gossip = world.events.filter(e => e.kind === "gossip").length;
    assert.ok(
      gossip <= total * 0.2,
      `${how}: ${((gossip / total) * 100).toFixed(0)}% of the record is gossip`
    );
    const talk = world.events.filter(e => e.kind === "gossip" || e.kind === "contact").length;
    assert.ok(
      talk <= total * 0.5,
      `${how}: ${((talk / total) * 100).toFixed(0)}% of the record is minds talking to each other`
    );
  }
});

test("a pool of lines is cycled before any of them repeats", () => {
  const world = createWorld({ seed: 9 });
  const pool = ["one", "two", "three", "four", "five", "six"];
  const picked = [];
  for (let i = 0; i < pool.length; i++) picked.push(pickFresh(world, "test:cycle", pool));
  assert.equal(new Set(picked).size, pool.length, `cycled with a repeat: ${picked.join(", ")}`);
  // …and once it has, it starts again rather than getting stuck.
  const second = new Set();
  for (let i = 0; i < pool.length; i++) second.add(pickFresh(world, "test:cycle", pool));
  assert.equal(second.size, pool.length, "the second cycle should also be complete");
});

test("what has been said lately is part of the world, not the module", () => {
  const world = offlineWorld({ seed: 21, ticks: 150 });
  const keys = Object.keys(world.proseMemory || {});
  assert.ok(keys.length > 0, "a world that has been running should remember its own narration");

  // A resumed world must not immediately start repeating lines the original had
  // already spent, and a fork must not share the original's memory.
  const resumed = deserializeWorld(serializeWorld(world));
  assert.deepEqual(resumed.proseMemory, world.proseMemory, "narration memory did not survive a save");

  const fork = forkWorld(world);
  /** @type {Record<string, string[]>} */
  const forked = fork.proseMemory || {};
  /** @type {Record<string, string[]>} */
  const source = world.proseMemory || {};
  forked["phrase:gossip"] = ["a line the fork invented"];
  assert.notDeepEqual(
    forked["phrase:gossip"],
    source["phrase:gossip"],
    "the fork and its source should not share narration memory"
  );
});

test("a chronicle is a summary, not a stutter", () => {
  const { expiry } = runs(600);
  assert.ok(expiry.chronicle.length > 3, "expected some days to have closed");
  for (const day of /** @type {any[]} */ (expiry.chronicle)) {
    const stutter = /(\b[A-Z][a-z]+): \1\b/.exec(day.summary);
    assert.equal(stutter, null, `day ${day.day} reads "${day.summary.slice(0, 90)}…"`);
  }
});
