/**
 * Keeper roles: the mask Jeremy wears when he chats with a mind. Six roles,
 * each with a distinct voice instruction that colours the model's reply.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KEEPER_ROLES, roleById } from "../engine/chat.js";
import * as engine from "../engine/index.js";

test("the role set is full and well-formed", () => {
  assert.ok(KEEPER_ROLES.length >= 5, `expected a fuller set, got ${KEEPER_ROLES.length}`);
  const ids = KEEPER_ROLES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "role ids must be unique");
  for (const role of KEEPER_ROLES) {
    assert.ok(role.id && role.name, "role needs id and name");
    assert.ok(role.blurb && role.blurb.length > 5, `${role.id} needs a real blurb`);
    assert.ok(role.voice && role.voice.length > 20, `${role.id} needs a voice instruction`);
  }
});

test("the set goes beyond the original three seeds", () => {
  const ids = KEEPER_ROLES.map(r => r.id);
  for (const seed of ["spirit", "demon", "divine"]) {
    assert.ok(ids.includes(seed), `expected the seed role ${seed}`);
  }
  assert.ok(KEEPER_ROLES.length > 3, "roles are not limited to the three seeds");
});

test("roleById finds roles and falls back to the first for unknown ids", () => {
  assert.equal(roleById("judge").name, "Judge");
  assert.equal(roleById("trickster").blurb.length > 0, true);
  assert.equal(roleById("no-such-role").id, KEEPER_ROLES[0].id, "unknown id falls back");
  assert.equal(roleById(undefined).id, KEEPER_ROLES[0].id, "missing id falls back");
});

test("roles are exported from the engine surface", () => {
  assert.equal(engine.KEEPER_ROLES, KEEPER_ROLES);
  assert.equal(engine.roleById, roleById);
});

test("voices address the keeper, not a generic user", () => {
  for (const role of KEEPER_ROLES) {
    assert.ok(
      /keeper/i.test(role.voice),
      `${role.id}: the voice should name who the keeper is in the scene`
    );
  }
});
