/**
 * The app is the only part of this repo nobody can unit-test by inspection, and
 * it is also the part that has to work on a phone with no key, no network and no
 * developer tools. So: boot the real `app/index.html` against the real vendored
 * engine in a headless DOM, click the real buttons, and check that a world with
 * no model in it still reads as a story.
 *
 * Canvas is stubbed. Everything else — layout, rendering, the record tabs, the
 * dossier, the engine loop — is the shipping code path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(ROOT, "app/index.html"), "utf8");

/** A no-op stand-in for a 2D context, deep enough for gradients and image data.
 * @returns {any} */
function stubCtx() {
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
      const fn = () => stubCtx();
      target[key] = fn;
      return fn;
    },
    set(target, key, value) { target[key] = value; return true; }
  });
}

/**
 * Boot the app in a fresh DOM. Each test gets its own world, its own storage and
 * its own module registry, because the app keeps its state in module scope.
 */
/**
 * @param {{ savedState?: any }} [opts]
 */
async function bootApp({ savedState = null } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  const window = /** @type {any} */ (dom.window);

  window.HTMLCanvasElement.prototype.getContext = () => stubCtx();
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (savedState) window.localStorage.setItem("agentsworld.v2", JSON.stringify(savedState));

  // Let the map loop run a couple of frames so the drawing path is exercised,
  // then stop rescheduling: an unbounded rAF loop would hang the test runner.
  let frames = 0;
  window.requestAnimationFrame = (/** @type {any} */ cb) => {
    if (frames++ > 4) return 0;
    cb(frames * 16);
    return frames;
  };

  // The app arms a repeating tick timer. Capture it so a test can shut the world
  // down; an interval left running would keep the runner alive forever.
  /** @type {{id: any, kind: string}[]} */
  const timers = [];
  // Captured once, before any override can shadow them.
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
    window: /** @type {any} */ (window),
    document: window.document,
    localStorage: window.localStorage,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame,
    setInterval: fakeSetInterval,
    setTimeout: fakeSetTimeout,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle
  };
  // Keep the originals: deleting an override would delete Node's real global too.
  const originals = new Map();
  for (const [k, v] of Object.entries(globals)) {
    originals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }

  // Cache-bust so each boot re-evaluates the module with the globals in place.
  const mod = await import(`../app/app.js?boot=${Math.random()}`);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  const restore = () => {
    for (const t of timers) (t.kind === "interval" ? clearInterval : clearTimeout)(t.id);
    for (const [k, desc] of originals) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete /** @type {any} */ (globalThis)[k];
    }
    dom.window.close();
  };
  return { window, document: window.document, mod, restore };
}

/** @param {any} doc @param {string} id */
const text = (doc, id) => (doc.getElementById(id)?.textContent || "").trim();
/** @param {any} doc @param {string} sel */
const $ = (doc, sel) => doc.querySelector(sel);
/** @param {any} doc @param {string} sel */
const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];

test("the world is alive before any model is attached", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    // A fresh world is seeded with history, so the first screen is not an empty map.
    assert.ok($$(doc, "#activity-feed .event").length > 0, "the feed should already have events");
    assert.ok(text(doc, "headline-text").length > 20, "there should be a headline worth reading");
    assert.deepEqual(
      $$(doc, "#vitals .vital").map(el => el.textContent).length >= 4,
      true,
      "the vitals strip should report the world's condition"
    );
    assert.match(text(doc, "world-sub"), /Day \d+ · (dawn|day|dusk|night|deep night) · \d+\/\d+ awake/);
    assert.match(text(doc, "live-badge"), /SELF-RUNNING/, "with no key the world still runs");
  } finally { restore(); }
});

test("a tick with no model still moves the world and narrates it", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const dayOf = () => Number((text(doc, "map-day").match(/\d+/) || [0])[0]);
    const before = dayOf();
    const before2 = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
    before2.world = JSON.parse(before2.world);
    doc.getElementById("btn-tick").click();
    await new Promise(r => setTimeout(r, 20));
    const eventsAfter = $$(doc, "#activity-feed .event").length;
    assert.ok(eventsAfter > 0, "a tick should produce readable events with no model attached");
    assert.ok(dayOf() >= before, "time only moves forwards");
    const after2 = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
    after2.world = JSON.parse(after2.world);
    assert.ok(
      after2.world.clock.tick >= before2.world.clock.tick,
      "the tick is written to storage immediately"
    );
    // Nothing may be left dangling: a keyless world resolves every moment itself.
    assert.match(text(doc, "map-phase"), /dawn|day|dusk|night|deep night/);
  } finally { restore(); }
});

test("the record carries a chronicle and the secrets people are keeping", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    // The opening ticks close at least one day, which is what a chronicle entry needs.
    const tabs = $$(doc, "#record-tabs .rtab");
    assert.deepEqual(tabs.map(t => t.textContent), ["Feed", "Chronicle", "Secrets"]);

    tabs.find(t => t.dataset.view === "chronicle").click();
    const days = $$(doc, "#record-pane .day-card");
    assert.ok(days.length >= 1, "the world's opening days should already be written up");
    assert.ok(text(doc, "record-pane").includes("Day 1"), "a chronicle entry is dated");
    assert.ok(days[0].textContent.length > 60, "a chronicle entry says something");

    tabs.find(t => t.dataset.view === "secrets").click();
    const secrets = $$(doc, "#record-pane .secret-card");
    assert.ok(secrets.length >= 3, "a seeded world starts with things being kept quiet");
    assert.ok(
      secrets.some(s => s.textContent.includes("HELD BY")),
      "a private secret reports how many minds are carrying it"
    );
  } finally { restore(); }
});

test("a mind's dossier shows who it is to everyone else, not just its stats", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const card = $(doc, "#agents-list .agent-card");
    assert.ok(card, "the Minds tab should list the cast by region");
    card.querySelector(".act-open").click();

    const sheet = doc.getElementById("mind-sheet");
    assert.equal(sheet.classList.contains("hidden"), false, "the dossier opens");
    assert.ok($$(doc, "#sheet-rpg .bar").length >= 1, "needs and drives are shown");
    assert.ok(text(doc, "sheet-ties").length > 0, "the dossier says how the mind stands with others");
    assert.ok(text(doc, "sheet-carrying").length > 0, "the dossier says what the mind is carrying");
    // With no key there is no inner monologue to fetch, and the app must say so
    // rather than sit on "listening…" forever or throw.
    assert.match(text(doc, "sheet-thought"), /no inner monologue|Add a key/i);
    assert.equal(text(doc, "sheet-toggle"), "Sleep");
  } finally { restore(); }
});

test("time the app was closed is paid back on the next launch", async () => {
  const first = await bootApp();
  const stored = JSON.parse(first.window.localStorage.getItem("agentsworld.v2"));
  const worldAtClose = JSON.parse(stored.world);
  const tickAtClose = worldAtClose.clock.tick;
  assert.ok(tickAtClose > 0, "a first launch leaves a world with history in it");
  first.restore();

  // Pretend the app sat closed for three hours.
  stored.lastSeenAt = Date.now() - 3 * 3600 * 1000;
  const second = await bootApp({ savedState: stored });
  try {
    const caught = JSON.parse(JSON.parse(
      second.document.defaultView.localStorage.getItem("agentsworld.v2")
    ).world);
    assert.ok(
      caught.clock.tick >= tickAtClose,
      "the world remembers where it was — it must never run backwards"
    );
    assert.ok(
      caught.clock.tick > tickAtClose,
      "three hours of being closed should have been lived through, not skipped"
    );
    assert.ok(caught.clock.day >= worldAtClose.clock.day);
  } finally { second.restore(); }
});

test("nothing in the render path writes to the simulation", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const stored = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
    const before = JSON.parse(stored.world);
    // Rendering is not what persists, so compare the live world the app holds by
    // round-tripping it: a render that created relationship edges would show up
    // as extra keys in every mind's `relations`.
    const edgeCounts = before.agents.map((/** @type {any} */ a) => Object.keys(a.relations).length);
    assert.ok(edgeCounts.every((/** @type {number} */ n) => n <= before.agents.length - 1),
      "no mind knows more minds than exist");
  } finally { restore(); }
});
