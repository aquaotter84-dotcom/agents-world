/**
 * Phase C: the atlas as a board.
 *
 * The claim under test is that the map answers questions without the keeper
 * having to open anything — a builder and a saboteur read differently at a
 * glance, what is waiting on the keeper is marked where it belongs, and the four
 * keeper moves are one gesture away. Canvas is stubbed; the drawing path, the
 * gesture handling and the menu itself are the shipping code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(ROOT, "app/index.html"), "utf8");

/** A recording stand-in for a 2D context: every call is logged, nothing draws. */
function stubCtx(/** @type {any[]|null} */ log) {
  /** @type {Record<string | symbol, any>} */
  const store = {};
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "data") {
        const arr = new Uint8ClampedArray(128 * 128 * 4);
        target[key] = arr;
        return arr;
      }
      const fn = (/** @type {any[]} */ ...args) => {
        if (log && typeof key === "string") log.push([key, args]);
        return stubCtx(log);
      };
      target[key] = fn;
      return fn;
    },
    set(target, key, value) { target[key] = value; return true; }
  });
}

/**
 * Boot the app in a fresh DOM.
 * @param {{ savedState?: any, log?: any[]|null }} [opts]
 */
async function bootApp({ savedState = null, log = null } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  const window = /** @type {any} */ (dom.window);
  window.HTMLCanvasElement.prototype.getContext = () => stubCtx(log);
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (savedState) window.localStorage.setItem("agentsworld.v2", JSON.stringify(savedState));

  let frames = 0;
  window.requestAnimationFrame = (/** @type {any} */ cb) => {
    if (frames++ > 4) return 0;
    cb(frames * 16);
    return frames;
  };

  /** @type {{id: any, kind: string}[]} */
  const timers = [];
  const realSetInterval = setInterval;
  const realSetTimeout = setTimeout;
  const fakeSetInterval = (/** @type {any} */ fn, /** @type {number} */ ms) => {
    const id = realSetInterval(fn, ms);
    timers.push({ id, kind: "interval" });
    return id;
  };
  const fakeSetTimeout = (/** @type {any} */ fn, /** @type {number|undefined} */ ms, /** @type {any[]} */ ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    timers.push({ id, kind: "timeout" });
    return id;
  };

  const globals = {
    window, document: window.document, localStorage: window.localStorage,
    ResizeObserver: window.ResizeObserver, requestAnimationFrame: window.requestAnimationFrame,
    setInterval: fakeSetInterval, setTimeout: fakeSetTimeout, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLCanvasElement: window.HTMLCanvasElement,
    Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle,
    fetch: async () => { throw new TypeError("no service"); }
  };
  const originals = new Map();
  for (const [k, v] of Object.entries(globals)) {
    originals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }

  await import(`../app/app.js?boot=${Math.random()}`);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise(r => setImmediate(r));

  const restore = () => {
    for (const t of timers) (t.kind === "interval" ? clearInterval : clearTimeout)(t.id);
    for (const [k, desc] of originals) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete /** @type {any} */ (globalThis)[k];
    }
    dom.window.close();
  };
  return { window, document: window.document, restore };
}

/** @param {any} doc @param {string} id */
const text = (doc, id) => (doc.getElementById(id)?.textContent || "").trim();
/** @param {any} doc @param {string} sel */
const $ = (doc, sel) => doc.querySelector(sel);
/** @param {any} doc @param {string} sel */
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];

/**
 * A stored state whose charter already has something on it, so the board has
 * sigils to draw. Built from a real serialised world rather than a mock.
 */
async function storedWorldWithCharter() {
  const { createWorld } = await import("../engine/model/world.js");
  const { serializeWorld } = await import("../engine/snapshot.js");
  const world = createWorld({ seed: 4242 });
  const worldJson = JSON.parse(serializeWorld(world));
  const a = worldJson.agents[0];
  const b = worldJson.agents[1];
  worldJson.charter.petitions.push({
    id: "pet1", agentId: a.id, text: "Make it a law that nobody touches another's work.",
    ruleKind: "no_undermining", kind: "law", tick: 12, support: 3, oppose: 0,
    basis: "Wall work has been damaged twice.", status: "open", cost: 16
  });
  worldJson.charter.whispers.push({
    id: "whi1", agentId: b.id, aboutId: a.id, text: "Something about the gate.", tick: 20
  });
  worldJson.charter.dilemmas.push({
    id: "dil1", text: "Two builders, one vendetta.", partyIds: [a.id, b.id], kind: "feud", tick: 30, status: "open"
  });
  worldJson.charter.roles.push({
    id: "role1", name: "Wallwright", holderId: a.id, basis: "more of the wall is theirs", tick: 10, weight: 30
  });
  worldJson.charter.influence = 55;
  worldJson.project.contributors = {
    [a.id]: { work: 20, help: 0, interference: 0, lastTick: 5 },
    [b.id]: { work: 4, help: 0, interference: 3, lastTick: 6 }
  };
  worldJson.project.progress = 42;
  return { world: JSON.stringify(worldJson), settings: {}, chats: {}, chatRoles: {}, ui: {}, keeper: { marks: [], xp: 0 }, lastSeenAt: Date.now() };
}

/**
 * A stored world that has lost someone: one funeral still coming, one grave
 * already filled, with a living mourner and a living heir so the record's
 * chips have somewhere to go.
 */
async function storedWorldWithMourning() {
  const { createWorld } = await import("../engine/model/world.js");
  const { serializeWorld } = await import("../engine/snapshot.js");
  const world = createWorld({ seed: 4243 });
  const worldJson = JSON.parse(serializeWorld(world));
  const a = worldJson.agents[0];
  const b = worldJson.agents[1];
  const c = worldJson.agents[2];
  worldJson.mourning = {
    funerals: [
      {
        id: "fun1", agentId: "gone1", name: "Adah", epithet: "the patient", className: "mystic", level: 3,
        regionId: a.regionId, calledTick: 10, holdTick: 22, held: false, mourners: [], heirs: [], inherited: [],
        deeds: "the world's Wallwright, laid 24 into the North Wall"
      }
    ],
    memorials: [
      {
        id: "mem1", agentId: "gone2", name: "Ren", epithet: "the quiet", kind: "death", regionId: a.regionId,
        tick: 30, day: 2, mourners: [b.id], heirs: [c.id], inherited: [{ heirId: c.id, aboutId: b.id }],
        text: "Ren was buried at the Crossroads on day 2, with " + b.name + " standing by. They laid 30 into the North Wall.",
        deeds: "laid 30 into the North Wall"
      }
    ]
  };
  return {
    world: JSON.stringify(worldJson), settings: {}, chats: {}, chatRoles: {}, ui: {},
    keeper: { marks: [], xp: 0 }, lastSeenAt: Date.now(), mourner: b.name
  };
}

/* ------------------------------------------------------------------ */

test("the board tells the keeper what a tap-and-hold will get them", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    assert.match(text(doc, "map-hint"), /hold/i, "the hint should teach the gesture");
    const menu = $(doc, "#radial-menu");
    assert.ok(menu, "the radial menu exists in the board's markup");
    assert.ok(menu.classList.contains("hidden"), "and it starts closed");
  } finally { restore(); }
});

test("a tap-and-hold opens the four keeper moves", async () => {
  const { window, document: doc, restore } = await bootApp();
  try {
    const cv = $(doc, "#world-canvas");
    const Mouse = window.MouseEvent;
    // Everything sits inside the stubbed 50x50 canvas, so the origin is on the board.
    cv.dispatchEvent(new Mouse("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
    await new Promise(r => setTimeout(r, 520));

    const menu = $(doc, "#radial-menu");
    assert.ok(!menu.classList.contains("hidden"), "holding the board should open the menu");
    const labels = $$(doc, "#radial-menu .radial-item").map(b => b.textContent.trim());
    assert.deepEqual(labels.sort(), ["Answer petition", "Dossier", "Follow thread", "Whisper"]);
  } finally { restore(); }
});

test("the menu disables what the world cannot currently honour, and enables what it can", async () => {
  const saved = await storedWorldWithCharter();
  const { window, document: doc, restore } = await bootApp({ savedState: saved });
  try {
    const cv = $(doc, "#world-canvas");
    cv.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
    await new Promise(r => setTimeout(r, 520));

    const items = $$(doc, "#radial-menu .radial-item");
    assert.equal(items.length, 4);
    const byAct = new Map(items.map(b => [b.dataset.act, b]));
    for (const act of ["whisper", "petition", "thread", "dossier"]) {
      assert.ok(byAct.has(act), `the menu offers ${act}`);
    }
    // A tap on empty board hits nobody, so the mind-scoped moves are honest
    // about having nothing to act on; the petition is world-wide and stays live.
    const petitionItem = /** @type {any} */ (byAct.get("petition"));
    assert.ok(!petitionItem.classList.contains("disabled"),
      "an open petition is answerable from anywhere on the board");
    assert.match(petitionItem.title, /influence to enact/, "and it says what it costs");

    // Choosing it takes the keeper to the charter, where the ruling happens.
    petitionItem.click();
    assert.equal(text(doc, "record-tabs").includes("Charter"), true);
    const pane = text(doc, "record-pane");
    assert.ok(pane.includes("Awaiting your ruling"), "the charter shows what is waiting");
    assert.ok(pane.includes("nobody touches another"), "with the petition's own words");
  } finally { restore(); }
});

test("a tap still opens a dossier, and the radial closes when anything else takes over", async () => {
  const { window, document: doc, restore } = await bootApp();
  try {
    const cv = $(doc, "#world-canvas");
    const Mouse = window.MouseEvent;
    cv.dispatchEvent(new Mouse("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
    await new Promise(r => setTimeout(r, 520));
    const menu = $(doc, "#radial-menu");
    assert.ok(!menu.classList.contains("hidden"));

    // A plain tap elsewhere dismisses it rather than stacking menus.
    cv.dispatchEvent(new Mouse("mousedown", { clientX: 40, clientY: 40, bubbles: true }));
    cv.dispatchEvent(new Mouse("mouseup", { clientX: 40, clientY: 40, bubbles: true }));
    assert.ok(menu.classList.contains("hidden"), "the menu should not linger");
  } finally { restore(); }
});

test("the keeper's want is on the board, not buried in a tab", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const card = $(doc, "#want-card");
    assert.ok(card, "the world screen carries the keeper's own score");
    const meters = $$(doc, "#want-card .want-meter");
    assert.deepEqual(meters.map(m => /** @type {any} */ (m).dataset.meter), ["harmony", "prosperity", "legacy"]);
    for (const meter of meters) {
      assert.match(/** @type {HTMLElement} */ (meter).textContent || "", /\d/, "each meter shows its number");
      assert.ok(meter.querySelector(".wm-bar"), "and its bar");
    }
    assert.match(text(doc, "want-card"), /ask/, "and it says whether the world is asking for anything");

    // The board answers the same question: the ring is the card in another
    // language, and describeBoard is the same reading as a sentence.
    /** @type {HTMLElement} */ (card).click();
    assert.match(text(doc, "record-pane"), /What has moved them/, "the ledger is one tap from the board");
    assert.equal($$(doc, "#record-pane .want-panel .want-meter").length, 3);
  } finally { restore(); }
});

test("tapping the keeper's crown opens their standing, wherever else the board is busy", async () => {
  const { window, document: doc, restore } = await bootApp();
  try {
    const cv = $(doc, "#world-canvas");
    const Mouse = window.MouseEvent;
    // In the stubbed 50x50 board the crown sits at (6, 42) — the map's top-right
    // corner — and it reads before any orb, sigil or thread does.
    cv.dispatchEvent(new Mouse("mousedown", { clientX: 6, clientY: 42, bubbles: true }));
    cv.dispatchEvent(new Mouse("mouseup", { clientX: 6, clientY: 42, bubbles: true }));
    assert.match(text(doc, "record-pane"), /The keeper/, "the crown opens the keeper's record");
  } finally { restore(); }
});

test("a ruling moves the keeper's meters visibly, with the delta shown", async () => {
  const saved = await storedWorldWithCharter();
  const { document: doc, restore } = await bootApp({ savedState: saved });
  try {
    // Nothing has moved the meters yet, so no badge and no cause are shown.
    assert.equal($$(doc, "#want-card .wm-delta").length, 0, "a fresh ledger shows no deltas");

    const tabs = $$(doc, "#record-tabs .rtab");
    tabs.find(t => t.dataset.view === "charter").click();
    /** @type {HTMLElement} */ ($(doc, "#record-pane .enact-petition")).click();

    // The world-screen card now shows the movement on the meters it moved, and
    // names the act that moved them.
    const badges = $$(doc, "#want-card .wm-delta.up");
    assert.ok(badges.length >= 2, "enacting moves both legacy and harmony, and both show it");
    assert.match(text(doc, "want-card"), /you enacted/, "the card names the act that moved it");

    // The keeper's record holds the same movement in its ledger.
    tabs.find(t => t.dataset.view === "keeper").click();
    const pane = text(doc, "record-pane");
    assert.match(pane, /you enacted/, "the ledger keeps the act");
    assert.match(pane, /Day 1/, "with the day it happened");
  } finally { restore(); }
});

test("the board reports what the atlas shows, from the world alone", async () => {
  // The canvas only positions and paints; everything the map *decides* to show
  // is pure, and that is the part worth testing.
  const { createWorld } = await import("../engine/model/world.js");
  const { boardSigils, mindGlyph, feudArcs, constellations, projectPalette, describeBoard } =
    await import("../app/board.js");

  const world = /** @type {any} */ (createWorld({ seed: 4242 }));
  const a = world.agents[0], b = world.agents[1];

  // Nothing on it yet: an empty board is a real state, not an error.
  assert.deepEqual(boardSigils(world), []);
  assert.equal(mindGlyph(world, a), null, "a mind with no wall work reads as neither");

  // A builder and a saboteur read differently.
  world.project.status = "active";
  world.project.contributors[a.id] = { work: 20, help: 0, interference: 0, lastTick: 5 };
  world.project.contributors[b.id] = { work: 4, help: 0, interference: 3, lastTick: 6 };
  assert.equal(mindGlyph(world, a), "builder");
  assert.equal(mindGlyph(world, b), "saboteur", "sabotage is the part that matters when a mind has done both");

  // What is waiting on the keeper, with the region it belongs over.
  world.charter.petitions.push({
    id: "pet1", agentId: a.id, text: "Make it a law.", ruleKind: "no_undermining", kind: "law",
    tick: 12, support: 3, oppose: 0, basis: "Damaged twice.", status: "open", cost: 16
  });
  world.charter.whispers.push({ id: "whi1", agentId: b.id, aboutId: a.id, text: "About the gate.", tick: 20 });
  world.charter.dilemmas.push({ id: "dil1", text: "Two builders, one vendetta.", partyIds: [a.id, b.id], kind: "feud", tick: 30, status: "open" });
  const sigils = boardSigils(world);
  assert.deepEqual(sigils.map(s => s.kind).sort(), ["dilemma", "petition", "whisper"]);
  const petitionSigil = /** @type {any} */ (sigils.find(s => s.kind === "petition"));
  assert.equal(petitionSigil.shape, "seal", "a law is a seal, a tradition is a scroll");
  assert.equal(petitionSigil.regionId, a.regionId, "the sigil knows where to be drawn");

  // A ruled petition and an acted-on whisper leave the board.
  world.charter.petitions[0].status = "enacted";
  world.charter.whispers[0].actedOn = true;
  const after = boardSigils(world);
  assert.ok(!after.some(s => s.kind === "petition"), "an enacted petition is no longer waiting");
  assert.ok(!after.some(s => s.kind === "whisper"), "a used whisper is no longer unheard");

  // Feud arcs carry their stage, so a grudge and a vendetta do not look alike.
  a.relations[b.id] = { affinity: -30, trust: 0, familiarity: 30, resentment: 70, fear: 0, debts: 0, contacts: 4, lastContactTick: 0, lastCallInTick: -1 };
  b.relations[a.id] = { affinity: -30, trust: 0, familiarity: 30, resentment: 66, fear: 0, debts: 0, contacts: 4, lastContactTick: 0, lastCallInTick: -1 };
  const arcs = feudArcs(world);
  assert.ok(arcs.length >= 1, "a vendetta is drawn");
  assert.equal(arcs[0].stage, "vendetta");

  // Threads as constellations: a secret two minds still hold is a shape.
  world.secrets.push({
    id: world.nextId("sec"), kind: "betrayal", text: "The gate was opened.", aboutId: a.id,
    holders: { [a.id]: 1, [b.id]: 0.8 }, isPublic: false, originTick: 0, lastSpreadTick: 0,
    weaponisedTick: 0, originatorId: a.id
  });
  const threads = constellations(world);
  assert.ok(threads.some(th => th.holders.length >= 2), "a shared secret is a constellation");
  const oncePublic = threads[0];
  /** @type {any} */ (world.secrets.find((/** @type {any} */ s) => s.id === oncePublic.secretId)).isPublic = true;
  assert.ok(!constellations(world).some(th => th.secretId === oncePublic.secretId),
    "and it leaves the board once it is out");

  // The wall's palette is the shared win condition, readable as one number.
  world.project.progress = 42;
  assert.equal(Math.round(projectPalette(world).k * 100), 42);
  world.project.status = "complete";
  assert.equal(projectPalette(world).k, 1);
  assert.equal(projectPalette(world).complete, true);

  assert.match(describeBoard(world), /the wall at/);
});

test("the mourning chronicle is a page in the record, not a line in the feed", async () => {
  const saved = await storedWorldWithMourning();
  const { document: doc, restore } = await bootApp({ savedState: saved });
  try {
    const tabs = $$(doc, "#record-tabs .rtab");
    tabs.find(t => t.dataset.view === "chronicle").click();
    const pane = text(doc, "record-pane");
    assert.match(pane, /In memoriam/, "the record keeps the dead");
    assert.match(pane, /A funeral called/, "a gathering still coming is announced");
    assert.match(pane, /Adah/, "with the mind it is for");
    assert.match(pane, /GATHERING|gathering/i);
    assert.match(pane, /Ren/, "and the grave already filled is kept");
    assert.match(pane, /carries what Ren had against/, "including the quarrel that outlived them");

    // A mourner who is still alive is touchable: the chip opens their dossier.
    const chip = $(doc, "#record-pane .mem-mind");
    assert.ok(chip, "the living mourner is a chip");
    /** @type {HTMLElement} */ (chip).click();
    assert.ok(!$(doc, "#mind-sheet").classList.contains("hidden"), "tapping the mourner opens them");
  } finally { restore(); }
});

test("the keeper's own retire button does not make a quiet despawn", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    // jsdom will not run a modal, so the confirmation is simply granted.
    const realConfirm = /** @type {any} */ (globalThis).confirm;
    /** @type {any} */ (globalThis).confirm = () => true;
    try {
      const tabs = $$(doc, "#tabbar .tab");
      tabs.find(t => t.dataset.tab === "minds").click();
      const card = $(doc, "screen-minds .agent-card") || $(doc, ".agent-card");
      assert.ok(card, "the cast is listed");
      const name = /** @type {HTMLElement} */ (card.querySelector(".aname")).textContent.trim().split(/\s+/)[0];
      /** @type {HTMLElement} */ (card.querySelector(".act-retire")).click();

      // The world keeps a memorial, and the record says so.
      const record = $$(doc, "#record-tabs .rtab").find(t => t.dataset.view === "chronicle");
      record?.click();
      const pane = text(doc, "record-pane");
      assert.match(pane, /In memoriam/, "the mourning chronicle has them");
      assert.match(pane, new RegExp(name), "under their own name");
    } finally {
      /** @type {any} */ (globalThis).confirm = realConfirm;
    }
  } finally { restore(); }
});

test("the charter tab is the board's counterpart, and a ruling moves the world", async () => {
  const saved = await storedWorldWithCharter();
  const { document: doc, restore } = await bootApp({ savedState: saved });
  try {
    const tabs = $$(doc, "#record-tabs .rtab");
    tabs.find(t => t.dataset.view === "charter").click();
    assert.ok(text(doc, "record-pane").includes("55 influence"), "the keeper's influence is on the board's tab");
    assert.ok($$(doc, "#record-pane .role-row").length >= 1, "roles the world uses are listed");
    assert.ok($$(doc, "#record-pane .dilemma-card").length >= 1, "an open dilemma is put to the keeper");
    assert.ok($$(doc, "#record-pane .whispers-card .whisper-row").length >= 1, "a whisper is shown as unheard");

    // Refusing is a real ruling: it closes the question and writes precedent.
    const refuse = $(doc, "#record-pane .refuse-petition");
    assert.ok(refuse, "the keeper can refuse from here");
    refuse.click();
    const after = JSON.parse(JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2")).world);
    assert.equal(after.charter.petitions[0].status, "refused", "the ruling was applied and saved");
    assert.ok(after.charter.precedents.length >= 1, "and it became precedent");
  } finally { restore(); }
});
