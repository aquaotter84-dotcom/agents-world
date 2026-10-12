import test from "node:test";
import assert from "node:assert/strict";
import { award, summarize, normalizeKeeper, emptyKeeper, tallies, RANKS, ACHIEVEMENTS, XP } from "../app/keeper.js";

test("a first-time act pays once, and repeats pay nothing", () => {
  const k = emptyKeeper();
  assert.equal(award(k, "dossier", "m1"), true);
  assert.equal(award(k, "dossier", "m1"), false, "the same dossier twice must not pay again");
  assert.equal(award(k, "dossier", "m2"), true);
  assert.equal(k.xp, XP.dossier * 2);
});

test("unknown kinds are ignored rather than paid", () => {
  const k = emptyKeeper();
  assert.equal(award(k, "bogus", "x"), false);
  assert.equal(k.xp, 0);
});

test("rank follows XP, and progress reports the way to the next rank", () => {
  const k = { marks: [], xp: 0 };
  assert.equal(summarize(k, 9).rank, RANKS[0].title);
  k.xp = RANKS[1].xp;
  const s = summarize(k, 9);
  assert.equal(s.rank, RANKS[1].title);
  assert.equal(s.progress, 0);
  assert.equal(s.next && s.next.title, RANKS[2].title);
  k.xp = RANKS[RANKS.length - 1].xp + 999;
  const top = summarize(k, 9);
  assert.equal(top.rank, RANKS[RANKS.length - 1].title);
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
});

test("achievements are derived from what was done, not stored", () => {
  const k = emptyKeeper();
  for (const m of ["a", "b", "c"]) award(k, "dossier", m);
  const unlocked = (/** @type {string} */ id) => summarize(k, 9).achievements.find(a => a.id === id)?.unlocked;
  assert.equal(unlocked("first-look"), true);
  assert.equal(unlocked("met-them-all"), false);
  for (const m of ["d", "e", "f", "g", "h", "i"]) award(k, "dossier", m);
  assert.equal(unlocked("met-them-all"), true);
});

test("days kept counts the highest day seen, not how many times it was seen", () => {
  const k = emptyKeeper();
  award(k, "day", 3); award(k, "day", 4); award(k, "day", 4);
  assert.equal(tallies(k, 9).days, 4);
  const week = () => summarize(k, 9).achievements.find(a => a.id === "week-kept")?.unlocked;
  assert.equal(week(), false);
  for (let d = 5; d <= 7; d++) award(k, "day", d);
  assert.equal(week(), true);
});

test("a corrupt save cannot inflate XP or crash the launch", () => {
  assert.deepEqual(normalizeKeeper(null), emptyKeeper());
  assert.deepEqual(normalizeKeeper({ marks: "nope", xp: 99999 }), emptyKeeper());
  const k = normalizeKeeper({ marks: ["dossier:a", "dossier:a", "tab:world", 7], xp: 99999 });
  assert.deepEqual(k.marks, ["dossier:a", "tab:world"], "duplicates and non-strings are dropped");
  assert.equal(k.xp, XP.dossier + XP.tab, "XP is recomputed from the marks");
});

test("every achievement has a title and a description, and ids are unique", () => {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.title && a.desc, a.id);
    assert.ok(!ids.has(a.id), "duplicate id " + a.id);
    ids.add(a.id);
  }
});
