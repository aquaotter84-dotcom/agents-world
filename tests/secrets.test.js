import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, createSecret } from "../engine/model/world.js";
import { applyEffects } from "../engine/systems/effects.js";

test("the world-wide secret cap is enforced by every creation path", () => {
  const world = createWorld({ seed: 301, config: /** @type {any} */ ({ limits: { secretsInWorld: 7 } }) });
  const holder = world.agents[0];
  const about = world.agents[1];
  assert.equal(world.secrets.length, 6, "the opening secrets fit below the configured cap");

  applyEffects(world, [
    { op: "secret_new", holder: holder.id, about: about.id, kind: "knowledge", text: "A new claim from a moment." },
    { op: "secret_new", holder: holder.id, about: about.id, kind: "crime", text: "A second claim queued in the same tick." },
    { op: "secret_new", holder: holder.id, about: about.id, kind: "debt", text: "A third claim must be refused." }
  ]);
  assert.equal(world.secrets.length, 7, "only one op can consume the final slot");

  const direct = createSecret(world, {
    kind: "knowledge",
    text: "A caller must not bypass the cap.",
    aboutId: about.id,
    holderId: holder.id
  });
  assert.equal(direct, null, "the public constructor refuses a secret after the cap");

  applyEffects(world, [
    { op: "secret_new", holder: holder.id, about: about.id, kind: "crime", text: "A betrayal path must obey the same cap." }
  ]);
  assert.equal(world.secrets.length, world.config.limits.secretsInWorld);
});

test("initial seeding also respects a deliberately small cap", () => {
  const world = createWorld({ seed: 302, config: /** @type {any} */ ({ limits: { secretsInWorld: 2 } }) });
  assert.equal(world.secrets.length, 2);
});
