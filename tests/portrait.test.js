import test from "node:test";
import assert from "node:assert/strict";
import { portraitSvg, expressionFor } from "../app/portrait.js";

const mind = (/** @type {string} */ id, /** @type {object} */ extra = {}) => ({ id, color: "#c084fc", class: "Scholar", ...extra });

test("a mind's portrait is the same every time it is drawn", () => {
  assert.equal(portraitSvg(mind("m1")), portraitSvg(mind("m1")));
});

test("different minds look different", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(portraitSvg(mind("m" + i)));
  assert.ok(seen.size >= 30, "portraits should vary across minds, got " + seen.size);
});

test("the expression follows the mood", () => {
  assert.equal(expressionFor("warm and at ease"), "smile");
  assert.equal(expressionFor("tired"), "tired");
  assert.equal(expressionFor("restless"), "stern");
  assert.equal(expressionFor("steady"), "flat");
  assert.notEqual(portraitSvg(mind("m1"), "warm"), portraitSvg(mind("m1"), "tired"));
});

test("hostile colours and class names cannot break out of the markup", () => {
  const svg = portraitSvg(/** @type {any} */ ({ id: "x", color: '"><script>alert(1)</script>', class: "<b>" }));
  assert.doesNotMatch(svg, /<script|<b>/);
  assert.doesNotMatch(svg, /"><script/);
  assert.match(svg, /<svg/);
});

test("no portrait leaks undefined or NaN", () => {
  for (let i = 0; i < 20; i++) {
    const svg = portraitSvg(/** @type {any} */ (mind("id-" + i, { class: undefined })));
    assert.doesNotMatch(svg, /undefined|NaN|null/);
  }
});
