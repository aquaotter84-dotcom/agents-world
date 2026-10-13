/**
 * Phase F, the camp view: the World screen's settlement slice, booted
 * through the real app against the real vendored engine — stores, Hold,
 * wall and forecast, buildings and crews, and the keeper's camp acts.
 * Canvas is stubbed; everything else is the shipping code path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { createWorld } from "../engine/model/world.js";
import { serializeWorld } from "../engine/snapshot.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(ROOT, "app/index.html"), "utf8");

/** @returns {any} */
function stubCtx() {
  /** @type {Record<string | symbol, any>} */
  const store = {};
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "data") { const arr = new Uint8ClampedArray(128 * 128 * 4); target[key] = arr; return arr; }
      const fn = () => stubCtx();
      target[key] = fn;
      return fn;
    },
    set(target, key, value) { target[key] = value; return true; }
  });
}

/** @param {{savedState?: any}} [opts] */
async function bootApp({ savedState = null } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  const window = /** @type {any} */ (dom.window);
  window.HTMLCanvasElement.prototype.getContext = () => stubCtx();
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
    const id = realSetInterval(fn, ms); timers.push({ id, kind: "interval" }); return id;
  };
  const fakeSetTimeout = (/** @type {any} */ fn, /** @type {number|undefined} */ ms, /** @type {any[]} */ ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest); timers.push({ id, kind: "timeout" }); return id;
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

/** A fresh game-mode world as the app's own save would hold it. */
function savedGameWorld() {
  const world = createWorld({ seed: 151, config: /** @type {any} */ ({ settlement: { enabled: true } }) });
  return {
    world: serializeWorld(world),
    settings: {}, chats: {}, chatRoles: {}, retold: {},
    ui: { selectedId: null, chatId: null, record: "feed", threadKind: "mind", threadTarget: null },
    keeper: { marks: [], xp: 0 }, lastSeenAt: Date.now(), digest: null, lastSeenTick: 0
  };
}

/** @param {any} doc */
function savedWorld(doc) {
  const raw = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
  return JSON.parse(raw.world);
}

test("the camp view shows stores, Hold, the wall and its forecast, buildings and camp acts", async () => {
  const { document: doc, restore } = await bootApp({ savedState: savedGameWorld() });
  try {
    const camp = doc.getElementById("camp-card");
    assert.ok(camp && camp.textContent.length > 40, "the camp card renders");
    const text = camp.textContent;
    assert.match(text, /The camp · Camp/);
    assert.match(text, /Hold/);
    assert.match(text, /food/);
    assert.match(text, /North Wall level 0/);
    assert.match(text, /Storm in \d+d · strength \d+/);
    for (const name of ["the Fields", "the Workshop", "the Common Hall", "the Memorial"]) {
      assert.ok(text.includes(name), `${name} is on the board`);
    }
    const acts = [...doc.querySelectorAll("#camp-card [data-camp-act]")];
    assert.deepEqual(acts.map(b => b.getAttribute("data-camp-act")), ["relief", "repair", "rally"]);
    // The vitals strip carries the camp's two numbers that cannot wait.
    assert.match(doc.getElementById("vitals").textContent, /Food .*Hold/);
  } finally { restore(); }
});

test("the keeper can start a building, staff a crew and spend on relief from the camp card", async () => {
  const { document: doc, restore } = await bootApp({ savedState: savedGameWorld() });
  try {
    const build = doc.querySelector('[data-build="workshop"]');
    assert.ok(build, "the workshop is raisable at the start");
    build.click();
    assert.equal(savedWorld(doc).settlement.buildings.find((/** @type {any} */ b) => b.kind === "workshop").status, "building");

    const select = doc.querySelector('.camp-staff-select[data-for="b-fields"]');
    assert.ok(select, "the fields offer a staffing choice");
    const agentId = select.value;
    doc.querySelector('[data-assign="b-fields"]').click();
    const after = savedWorld(doc);
    assert.ok(after.settlement.buildings.find((/** @type {any} */ b) => b.kind === "fields").crew.includes(agentId),
      "the chosen mind is on the crew in the saved world");

    const influenceBefore = after.charter.influence;
    const relief = doc.querySelector('[data-camp-act="relief"]');
    assert.ok(relief && !relief.hasAttribute("disabled"), "relief is affordable from the starting purse");
    relief.click();
    const spent = savedWorld(doc);
    assert.equal(spent.charter.influence, influenceBefore - spent.config.settlement.reliefCost);
    assert.ok(spent.settlement.stores.food > after.settlement.stores.food);
  } finally { restore(); }
});

test("a collapsed camp reads as an ending with a way into the next run", async () => {
  const state = savedGameWorld();
  const parsed = JSON.parse(state.world);
  parsed.settlement.status = "collapsed";
  parsed.settlement.collapseCause = "the Hold gave out";
  parsed.settlement.legacy = {
    cause: "the Hold gave out", tick: 10, day: 3, daysSurvived: 2, peakLevel: "Camp",
    peakPopulation: 9, wallLevel: 1, stormsWeathered: 0, buildingsBuilt: [],
    boons: ["seasoned_stores"], summary: "The camp ended on day 3, the Hold gave out. What carries over: seasoned stores."
  };
  state.world = JSON.stringify(parsed);
  const { document: doc, restore } = await bootApp({ savedState: state });
  try {
    const camp = doc.getElementById("camp-card");
    assert.match(camp.textContent, /scattered/);
    assert.match(camp.textContent, /seasoned stores/i);
    assert.ok(doc.querySelector("[data-new-camp]"), "the next founding is one tap away");
  } finally { restore(); }
});
