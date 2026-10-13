/**
 * The director decides what the world is doing, how fast the clock should run,
 * what story is on the board and what a viewer was not there for. It is pure by
 * design, so it can be tested against real engine worlds without a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { runTicks } from "../engine/simulation.js";
import {
  isBookkeeping, beatTier, worldPulse, paceFor, directorNote, feudBoard,
  storylineBoard, foldAmbient, todaySoFar, replayFrames, STORYLINE_KINDS
} from "../app/director.js";

/** A world that has lived a while, so nothing below is about the seed state. */
function lived(seed = 4711, ticks = 240) {
  const world = createWorld({ seed });
  runTicks(world, ticks);
  return world;
}

test("bookkeeping is the simulation's own arithmetic, not the world's events", () => {
  // The four shapes that made up 39% of the World screen, measured over ten
  // world days — and must never be shown as news.
  assert.equal(isBookkeeping({ kind: "relationship", text: "Elio's view of Orin changed: affection 0 → 6." }), true);
  assert.equal(isBookkeeping({ kind: "charter", text: "Cass wanted to petition the keeper, but had nothing in the world to point at." }), true);
  assert.equal(isBookkeeping({ kind: "charter", text: "Sei started to tell the keeper something and stopped." }), true);
  assert.equal(isBookkeeping({ kind: "proposal", authored: false, text: "Wren proposed a way at guard the one secret." }), true);
  // A proposal the model actually wrote is a mind's own idea, and stays.
  assert.equal(isBookkeeping({ kind: "proposal", authored: true, text: "Wren proposed a way at guard the one secret." }), false);
  // And ordinary events are never mistaken for bookkeeping.
  for (const text of ["The North Wall stands.", "Wren said a little more than they meant to.", "Pim forgave Cass, or at least stopped keeping score."]) {
    assert.equal(isBookkeeping({ kind: "conflict", text }), false, text);
  }
});

test("a line's tier follows the engine's own score, not its kind", () => {
  assert.equal(beatTier({ significance: 1 }), "moment");
  assert.equal(beatTier({ significance: 0.85 }), "moment");
  assert.equal(beatTier({ significance: 0.84 }), "beat");
  assert.equal(beatTier({ significance: 0.6 }), "beat");
  assert.equal(beatTier({ significance: 0.4 }), "notable");
  assert.equal(beatTier({ significance: 0.399 }), "texture");
  assert.equal(beatTier({}), "texture");
});

test("the pulse reads the world it is given, and a world that has gone quiet is quiet", () => {
  const world = lived();
  const pulse = worldPulse(world);
  assert.ok(["hot", "live", "settling", "quiet"].includes(pulse.level));
  assert.ok(pulse.because.length > 0, "a pulse always has a reason, even if the reason is silence");
  assert.equal(typeof pulse.heat, "number");

  // A world with nothing in it at all, nobody awake, no history.
  const empty = createWorld({ seed: 3 });
  empty.events.length = 0;
  /** @type {any} */ (empty).flags = { feudStages: {} };
  for (const a of empty.agents) a.awake = false;
  const quiet = worldPulse(empty);
  assert.equal(quiet.level, "quiet");
  assert.match(quiet.because, /asleep|nothing has moved/);
});

test("the feud board comes from the engine's own record of which pairs are at war", () => {
  const world = lived();
  const [a, b] = world.agents;
  /** @type {any} */ (world).flags = { feudStages: { [a.id + "|" + b.id]: "vendetta" } };
  world.config.relations.rivalryThreshold = 20;
  a.relations[b.id].resentment = 61;
  b.relations[a.id].resentment = 88;
  const board = feudBoard(world);
  assert.equal(board.length, 1);
  assert.equal(board[0].stage, "vendetta");
  assert.equal(board[0].heat, 88);
  assert.equal(board[0].rank, 3);
  assert.equal(board[0].a.id, a.id);

  // A feud whose minds have retired is a record, not a storyline.
  b.retired = true;
  assert.equal(feudBoard(world).length, 0);
});

test("the pace fits the story: hot is fastest, quiet is slowest, all of them sane", () => {
  const secs = /** @type {const} */ (["hot", "live", "settling", "quiet"]).map(l => paceFor(l).secs);
  for (let i = 1; i < secs.length; i++) assert.ok(secs[i] > secs[i - 1], "the director slows down as the world does");
  for (const s of secs) assert.ok(s >= 20 && s <= 180, "a pace nobody would accept: " + s);
  assert.equal(paceFor("hot").secs, 30);
  assert.equal(paceFor("quiet").secs, 180);
});

test("the header says who set the pace and why", () => {
  const pulse = { level: "hot", because: "Pim and Wren are in a vendetta" };
  const directed = directorNote(pulse, paceFor("hot"), { directed: true });
  assert.match(directed, /^Brisk — /);
  assert.match(directed, /vendetta/);
  // With the director off, the app does not claim a pace it is not setting.
  const kept = directorNote(pulse, paceFor("hot"), { directed: false });
  assert.doesNotMatch(kept, /Brisk/);
  assert.match(kept, /vendetta/);
});

test("a dilemma puts the world on the hottest setting there is", () => {
  const world = lived();
  // The engine raises its own dilemmas; this test is about the one on the table.
  world.charter.dilemmas = /** @type {any} */ ([{ id: "d1", status: "open", text: "Pim and Wren will not share the wall.", kind: "feud" }]);
  const pulse = worldPulse(world);
  assert.equal(pulse.level, "hot");
  assert.equal(pulse.dilemma.text, "Pim and Wren will not share the wall.");
  assert.ok(pulse.reasons.some(r => /dilemma/.test(r)));
});

test("the board answers what story is running, once per kind, best first", () => {
  const world = lived();
  const board = storylineBoard(world, { limit: 3 });
  assert.ok(board.length >= 1, "a lived-in world always has something on the board");
  assert.ok(board.length <= 3);
  const kinds = board.map(c => c.kind);
  assert.equal(new Set(kinds).size, kinds.length, "three cards of the same story is a list, not a board");
  for (const kind of kinds) assert.ok(STORYLINE_KINDS.includes(kind), kind);
  for (const card of board) {
    assert.ok(card.eyebrow && card.title && card.line && card.meta, "a card says what it is, what it is called, what happened and how bad");
    assert.ok(card.weight >= 0);
  }
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].weight >= board[i].weight, "cards are ranked");

  // The wall is the one thing the world builds together, so it is on the board
  // while it is being built — and gone once it is finished, because a finished
  // wall is history, not a storyline.
  const fresh = storylineBoard(createWorld({ seed: 4711 }));
  const work = fresh.find(c => c.kind === "work");
  assert.ok(work, "the work is on the board while it is being built");
  assert.match(work.meta, /pairs of hands|pair of hands/);
  const finished = lived();
  finished.project.status = "complete";
  assert.equal(storylineBoard(finished).some(c => c.kind === "work"), false, "a finished wall is not a storyline");
});

test("a feud worth following comes with a way to follow it", () => {
  const world = lived();
  const [a, b] = world.agents;
  /** @type {any} */ (world).flags = { feudStages: { [a.id + "|" + b.id]: "vendetta" } };
  a.relations[b.id].resentment = 70;
  b.relations[a.id].resentment = 65;
  const board = storylineBoard(world);
  const feud = board.find(c => c.kind === "feud");
  assert.ok(feud, "the feud is the first thing on the board");
  assert.equal(feud.tone, "blood");
  assert.deepEqual(feud.action.thread, { kind: "pair", id: [a.id, b.id].sort().join("|") });
  assert.match(feud.meta, /resentment 70 \/ 65/);
});

test("a secret under pressure is a secret with holders, and it can be followed", () => {
  const world = lived();
  const board = storylineBoard(world);
  const secret = board.find(c => c.kind === "secret");
  if (!secret) return; // a world that has kept nothing quiet has nothing to show
  assert.match(secret.title, /mind|minds/);
  assert.match(secret.line, /^…/);
  assert.equal(secret.action.thread.kind, "secret");
});

test("the ambient layer folds: a run of walking is one row, a beat is its own", () => {
  const rows = foldAmbient([
    { id: "e1", kind: "act", significance: 0.2, text: "Elio walked the whole way to the Market." },
    { id: "e2", kind: "act", significance: 0.2, text: "Sei took the long way toward the Market." },
    { id: "e3", kind: "confide", significance: 0.6, text: "Sei told Fable everything." },
    { id: "e4", kind: "act", significance: 0.2, text: "Wren watched the world go by." }
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "ambient");
  assert.deepEqual(rows[0].events.map(e => e.id), ["e1", "e2"]);
  assert.equal(rows[1].kind, "event");
  assert.equal(rows[1].event.id, "e3");
  // A single line of walking is not a run: it is just a quiet line.
  assert.equal(rows[2].kind, "event");
});

test("today, in one sentence, counts what a person would count", () => {
  const world = lived();
  const today = todaySoFar(world);
  assert.ok(today.line.length > 10);
  assert.match(today.line, /^(Today:|Nothing worth telling)/);
  // Bookkeeping is never counted as news.
  assert.equal(today.counts.relationship, undefined);
  assert.equal(today.total, Object.values(today.counts).reduce((a, b) => a + b, 0));

  const empty = createWorld({ seed: 5 });
  empty.events.length = 0;
  assert.match(todaySoFar(empty).line, /^Nothing worth telling/);

  // The sentence leads with what is worth counting, not what happened most.
  const world2 = createWorld({ seed: 9 });
  runTicks(world2, 120);
  const line = todaySoFar(world2).line;
  const first = line.replace(/^Today: /, "").split(",")[0];
  assert.doesNotMatch(first, /^\d* ?meetings?$|^a meeting$/, "a day of meetings does not lead the sentence: " + line);
});

test("a replay is the record read back in order, beats kept and walking dropped", () => {
  // The floor is what makes a film a film: `replayFrames` only frames ticks with
  // something a person would look at in them, and counts the rest.
  const world = lived();
  const film = replayFrames(world, { ticks: 24, fromTick: world.clock.tick - 24 });
  assert.ok(film.frames.length > 0, "a lived-in world has something to replay");
  assert.ok(film.frames.length <= 24);
  assert.equal(film.from, world.clock.tick - 24);
  assert.equal(film.to, world.clock.tick);
  let last = -1;
  for (const frame of film.frames) {
    assert.ok(frame.tick > last, "frames run forwards");
    last = frame.tick;
    assert.ok(frame.tick > film.from && frame.tick <= film.to);
    assert.ok(frame.events.length > 0, "an empty tick is not a frame");
    assert.ok(
      frame.events.some(e => beatTier(e) !== "texture"),
      "a tick of nothing but walking is counted as quiet, not played"
    );
    for (const e of frame.events) assert.equal(isBookkeeping(e), false, "walking and arithmetic are not in the film");
    for (let i = 1; i < frame.events.length; i++) {
      assert.ok((frame.events[i - 1].significance || 0) >= (frame.events[i].significance || 0), "the biggest thing in a tick comes first");
    }
  }
  // Empty ranges are not films.
  assert.equal(replayFrames(world, { ticks: 0, fromTick: world.clock.tick }).frames.length, 0);
});
