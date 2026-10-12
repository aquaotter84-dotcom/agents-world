/**
 * Rumour mutation: gossip warps as it spreads. Details sharpen or soften,
 * and sometimes the name at the centre of the story changes. The secret
 * underneath stays what it was — what the room *says* becomes its own
 * creature.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { mutateClaim, tellWithMutation } from "../engine/systems/rumour.js";
import { applyEffects } from "../engine/systems/effects.js";

function worldWithSecret(seed = 5150) {
  const world = createWorld({ seed });
  const [a, b] = world.agents;
  applyEffects(world, [{
    op: "secret_new", holders: [a.id], about: b.id, kind: "knowledge",
    text: `${b.name} hides something in the marsh`
  }]);
  const secret = world.secrets.find(s => s.text.includes("hides something in the marsh"));
  assert.ok(secret);
  return { world, secret, a, b };
}

test("an intact telling passes the claim through unchanged", () => {
  const { world, secret } = worldWithSecret();
  const out = tellWithMutation(
    { ...world, rng: /** @type {any} */ ({ chance: () => false }) },
    secret,
    "a plain claim"
  );
  assert.equal(out.mutated, false);
  assert.equal(out.claim, "a plain claim");
  assert.equal(secret.timesTold, 1, "tellings are counted even when intact");
  assert.equal(secret.mutations ?? 0, 0);
});

test("a mutated telling is counted on the secret", () => {
  const { world, secret } = worldWithSecret();
  const out = tellWithMutation(
    { ...world, rng: /** @type {any} */ ({ chance: () => true, float: () => 0.99, pick: (/** @type {any[]} */ arr) => arr[0] }) },
    secret,
    "a plain claim"
  );
  assert.equal(out.mutated, true);
  assert.equal(secret.timesTold, 1);
  assert.equal(secret.mutations, 1);
});

test("misattribution swaps the subject's name", () => {
  const { world, secret, b } = worldWithSecret();
  const claimed = `${b.name} hides something in the marsh`;
  const out = mutateClaim(
    { ...world, rng: /** @type {any} */ ({ float: () => 0.01, pick: (/** @type {any[]} */ arr) => arr.find((/** @type {any} */ a) => a.id !== b.id) || arr[0] }) },
    secret,
    claimed
  );
  assert.ok(out, "expected a mutation");
  assert.equal(out.kind, "misattributed");
  assert.ok(!out.claim.includes(b.name), `original name should be gone, got: ${out.claim}`);
});

test("exaggeration sharpens the claim", () => {
  const { world, secret } = worldWithSecret();
  const out = mutateClaim(
    { ...world, rng: /** @type {any} */ ({ float: () => 0.5, pick: (/** @type {any[]} */ arr) => arr[0] }) },
    secret,
    "a plain claim"
  );
  assert.ok(out && out.kind === "exaggerated", `expected exaggeration, got ${out && out.kind}`);
  assert.ok(out.claim.length > "a plain claim".length);
});

test("softening hedges the claim", () => {
  const { world, secret } = worldWithSecret();
  const out = mutateClaim(
    { ...world, rng: /** @type {any} */ ({ float: () => 0.99, pick: (/** @type {any[]} */ arr) => arr[0] }) },
    secret,
    "a plain claim"
  );
  assert.ok(out && out.kind === "softened", `expected softening, got ${out && out.kind}`);
});

test("mutation never rewrites the secret record", () => {
  const { world, secret, b } = worldWithSecret();
  const original = secret.text;
  tellWithMutation(
    { ...world, rng: /** @type {any} */ ({ chance: () => true, float: () => 0.01, pick: (/** @type {any[]} */ arr) => arr.find((/** @type {any} */ a) => a.id !== b.id) || arr[0] }) },
    secret,
    secret.text
  );
  assert.equal(secret.text, original, "the secret underneath stays what it was");
  assert.equal(secret.aboutId, b.id, "the secret stays about whom it was about");
});
