import test from "node:test";
import assert from "node:assert/strict";
import { createWorld } from "../engine/index.js";
import {
  TRIAL_DEFS, TRIAL_COMPLETION_BONUS, emptyTrials, normalizeTrials,
  trialDeck, trialSummary, recordTrialAction
} from "../app/trials.js";

function worldAt(day = 3) {
  const world = createWorld({ seed: 4711, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  world.clock.day = day;
  return world;
}

test("the first thread teaches three real keeper acts in order", () => {
  const world = worldAt();
  const state = emptyTrials(world, true);
  assert.deepEqual(trialDeck(world, state), ["dossier", "bless-mind", "omen"]);
  assert.equal(trialSummary(world, state).active?.id, "dossier");
  recordTrialAction(state, world, "dossier");
  assert.equal(trialSummary(world, state).active?.id, "bless-mind");
  recordTrialAction(state, world, "bless-mind");
  assert.equal(trialSummary(world, state).active?.id, "omen");
});

test("each trial and the chain bonus complete exactly once", () => {
  const world = worldAt();
  const state = emptyTrials(world, true);
  assert.deepEqual(recordTrialAction(state, world, "dossier").completed.map(t => t.id), ["dossier"]);
  assert.deepEqual(recordTrialAction(state, world, "dossier").completed, []);
  recordTrialAction(state, world, "bless-mind");
  const final = recordTrialAction(state, world, "omen");
  assert.equal(final.bonus, true);
  assert.equal(state.bonus, true);
  assert.equal(trialSummary(world, state).active, null);
  assert.equal(trialSummary(world, state).completed, 3);
  assert.equal(recordTrialAction(state, world, "omen").bonus, false);
  assert.ok(TRIAL_COMPLETION_BONUS.xp > 0 && TRIAL_COMPLETION_BONUS.influence > 0);
});

test("an unrelated or unsuccessful act does not advance the thread", () => {
  const world = worldAt();
  const state = emptyTrials(world, true);
  assert.deepEqual(recordTrialAction(state, world, "camp").completed, []);
  assert.equal(trialSummary(world, state).completed, 0);
});

test("a new world day deals a fresh non-tutorial thread", () => {
  const world = worldAt(3);
  const old = emptyTrials(world, true);
  old.done.push("dossier");
  old.bonus = true;
  world.clock.day = 4;
  const fresh = normalizeTrials(old, world);
  assert.equal(fresh.day, 4);
  assert.equal(fresh.tutorial, false);
  assert.deepEqual(fresh.done, []);
  assert.equal(fresh.bonus, false);
  assert.equal(trialDeck(world, fresh).length, 3);
});

test("later decks contain three distinct, currently eligible acts", () => {
  for (let day = 4; day < 20; day++) {
    const world = worldAt(day);
    const state = emptyTrials(world);
    const deck = trialDeck(world, state);
    assert.equal(deck.length, 3);
    assert.equal(new Set(deck).size, 3);
    for (const id of deck) assert.ok(Object.values(TRIAL_DEFS).some(trial => trial.id === id), id);
    if (!(world.chronicle || []).length) assert.equal(deck.includes("chronicle"), false);
  }
});

test("completing an act cannot change the rest of that day's deck", () => {
  const world = worldAt(4);
  world.charter.petitions.push(/** @type {any} */ ({ id: "p-test", status: "open" }));
  let state = emptyTrials(world);
  for (let day = 4; day < 30 && !trialDeck(world, state).includes("ruling"); day++) {
    world.clock.day = day;
    state = emptyTrials(world);
  }
  const dealt = trialDeck(world, state);
  assert.equal(dealt[2], "ruling");
  recordTrialAction(state, world, "ruling");
  world.charter.petitions[0].status = "resolved";
  assert.deepEqual(trialDeck(world, state), dealt);
  assert.equal(trialSummary(world, state).completed, 1);
  assert.equal(trialSummary(world, state).trials[2].done, true);
});

test("corrupt trial saves cannot invent progress or crash a launch", () => {
  const world = worldAt();
  const state = normalizeTrials({ seed: 4711, day: 3, done: ["dossier", "dossier", "bogus", 4], bonus: "yes" }, world);
  assert.deepEqual(state.done, ["dossier"]);
  assert.equal(state.bonus, true);
  assert.deepEqual(normalizeTrials(null, world).done, []);
  assert.deepEqual(normalizeTrials({ seed: "other", day: 3, done: ["omen"] }, world).done, []);
});
