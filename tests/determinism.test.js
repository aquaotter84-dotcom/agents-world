/**
 * The determinism guarantee.
 *
 * A world you cannot reproduce is a world you cannot debug, balance or trust.
 * These tests are the reason every stochastic decision in the engine draws from
 * the seeded generator and nothing reads the wall clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { serializeWorld, deserializeWorld, forkWorld } from "../engine/snapshot.js";
import { describeWorld } from "../engine/simulation.js";
import { advanceWithModel, offlineWorld, fingerprint } from "./helpers.mjs";

test("the same seed produces the same world", () => {
  const a = createWorld({ seed: "identical" });
  const b = createWorld({ seed: "identical" });

  assert.equal(a.agents.length, b.agents.length);
  assert.equal(
    a.agents.map(x => `${x.name}:${JSON.stringify(x.drives)}:${JSON.stringify(x.needs)}`).join("\n"),
    b.agents.map(x => `${x.name}:${JSON.stringify(x.drives)}:${JSON.stringify(x.needs)}`).join("\n"),
    "the cast should be identical for the same seed"
  );
  assert.equal(
    a.secrets.map(s => s.text).join("\n"),
    b.secrets.map(s => s.text).join("\n"),
    "the opening secrets should be identical"
  );
});

test("different seeds produce different worlds", () => {
  const a = createWorld({ seed: 1 });
  const b = createWorld({ seed: 2 });
  assert.notEqual(
    a.secrets.map(s => s.text).join("\n"),
    b.secrets.map(s => s.text).join("\n"),
    "two seeds should not open with the same secrets"
  );
});

test("two runs from the same seed diverge nowhere", () => {
  const a = createWorld({ seed: 99 });
  const b = createWorld({ seed: 99 });
  advanceWithModel(a, 250);
  advanceWithModel(b, 250);

  assert.equal(fingerprint(a), fingerprint(b));
});

test("a snapshot resumes the world exactly", () => {
  const original = createWorld({ seed: 7 });
  advanceWithModel(original, 120);

  const saved = serializeWorld(original);
  const resumed = deserializeWorld(saved);

  // The resumed world must be indistinguishable at the point of resumption...
  assert.equal(fingerprint(original), fingerprint(resumed));

  // ...and must continue down the same path, which requires the generator's
  // state to have been restored rather than merely the seed.
  advanceWithModel(original, 150);
  advanceWithModel(resumed, 150);
  assert.equal(fingerprint(original), fingerprint(resumed));
});

test("a forked world is independent of its source", () => {
  const original = createWorld({ seed: 12 });
  advanceWithModel(original, 60);
  const fork = forkWorld(original);

  advanceWithModel(original, 80);
  assert.notEqual(fingerprint(original), fingerprint(fork), "the two futures should differ");

  advanceWithModel(fork, 80);
  assert.equal(fingerprint(original), fingerprint(fork), "but they should agree once both catch up");
});

test("an offline world is also reproducible", () => {
  const a = offlineWorld({ seed: 31, ticks: 300 });
  const b = offlineWorld({ seed: 31, ticks: 300 });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(describeWorld(a).split("\n").length, describeWorld(b).split("\n").length);
});
