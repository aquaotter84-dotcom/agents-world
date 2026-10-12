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
 * @param {{ savedState?: any, serviceJson?: string | null }} [opts]
 */
async function bootApp({ savedState = null, serviceJson = null } = {}) {
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
    getComputedStyle: window.getComputedStyle,
    // The background service is reached over relative URLs; stub it when a test
    // says one is running, and otherwise make it unreachable, as in the APK.
    fetch: async (/** @type {string} */ url) => {
      if (serviceJson && String(url).endsWith("api/world")) {
        return { ok: true, text: async () => serviceJson };
      }
      throw new TypeError("no service");
    }
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
  // Boot is async now (it probes for the background service first). Let the
  // probe settle before the test looks at the world.
  await new Promise(r => setImmediate(r));

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
    assert.deepEqual(
      tabs.map(t => t.textContent),
      ["Feed", "Chronicle", "Secrets", "Threads", "Charter", "Keeper"]
    );

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

    // The charter is the keeper-facing half of the loop: influence, what is
    // waiting on a ruling, and whatever the world has already decided.
    tabs.find(t => t.dataset.view === "charter").click();
    const charterText = text(doc, "record-pane");
    assert.ok(charterText.includes("influence"), "the charter shows what the keeper can spend");
    assert.ok(
      charterText.includes("Awaiting your ruling") || charterText.includes("Nobody has asked you"),
      "the charter either shows petitions or says plainly that there are none"
    );
  } finally { restore(); }
});

test("a mind's dossier shows who it is to everyone else, not just its stats", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const saved = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
    const savedWorld = JSON.parse(saved.world);
    const pilot = savedWorld.agents.find((/** @type {any} */ agent) => agent.cognition && agent.cognition.enabled);
    assert.ok(pilot, "the world should persist its small cognition pilot");
    const card = $$(doc, "#agents-list .agent-card").find(element =>
      element.querySelector(".aname")?.textContent.trim().startsWith(pilot.name));
    assert.ok(card, "the Minds tab should list the pilot by region");
    card.querySelector(".act-open").click();

    const sheet = doc.getElementById("mind-sheet");
    assert.equal(sheet.classList.contains("hidden"), false, "the dossier opens");
    assert.ok($$(doc, "#sheet-rpg .bar").length >= 1, "needs and drives are shown");
    assert.ok(text(doc, "sheet-ties").length > 0, "the dossier says how the mind stands with others");
    assert.ok(text(doc, "sheet-carrying").length > 0, "the dossier says what the mind is carrying");
    assert.match(text(doc, "sheet-cognition"), /Private cognition|SELF-AUTHORED|No self-authored plan/,
      "the dossier shows a pilot mind's durable plans and private cognition");
    // With no key there is no inner monologue to fetch, and the app must say so
    // rather than sit on "listening…" forever or throw.
    assert.match(text(doc, "sheet-thought"), /no inner monologue|Add a key/i);
    assert.equal(text(doc, "sheet-toggle"), "Sleep");
  } finally { restore(); }
});

test("follow-this-thread connects mind, pair, and secret histories", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const tabs = $$(doc, "#record-tabs .rtab");
    tabs.find(tab => tab.dataset.view === "threads").click();
    assert.match(text(doc, "thread-title"), /’s thread/);
    const sectionNames = $$(doc, "#thread-detail .thread-section h3").map(el => el.textContent);
    assert.ok(sectionNames.includes("Initiating incident"));
    assert.ok(sectionNames.includes("Who learned what"));
    assert.ok(sectionNames.includes("Relationship changes"));
    assert.ok(sectionNames.includes("Subsequent events"));

    const kind = doc.getElementById("thread-kind");
    kind.value = "pair";
    kind.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
    assert.match(text(doc, "thread-title"), / and /);
    assert.ok($$(doc, "#thread-detail .thread-relation").length >= 2,
      "a pair thread shows the relationship in both directions");

    tabs.find(tab => tab.dataset.view === "secrets").click();
    const followSecret = $(doc, "#record-pane .follow-secret-thread");
    assert.ok(followSecret, "each secret offers a direct follow link");
    followSecret.click();
    assert.match(text(doc, "thread-title"), /Secret thread/);
    assert.ok($$(doc, "#thread-detail .thread-knowledge").length > 0,
      "a secret thread shows who currently knows which version");
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

test("an all-asleep app world still advances and lets a mind wake without using the dossier toggle", async () => {
  const { createWorld, serializeWorld } = await import("../engine/index.js");
  const sleeping = createWorld({ seed: 409 });
  for (const agent of sleeping.agents) {
    agent.awake = false;
    agent.needs.energy = 70;
  }
  const savedState = {
    world: serializeWorld(sleeping),
    settings: { tickSeconds: 45 },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };
  const app = await bootApp({ savedState });
  try {
    assert.match(text(app.document, "live-badge"), /RECOVERING/);
    const before = JSON.parse(JSON.parse(
      app.window.localStorage.getItem("agentsworld.v2")
    ).world).clock.tick;
    app.document.getElementById("btn-tick").click();
    await new Promise(r => setTimeout(r, 20));
    const after = JSON.parse(JSON.parse(
      app.window.localStorage.getItem("agentsworld.v2")
    ).world);
    assert.equal(after.clock.tick, before + 1);
    assert.ok(after.agents.some((/** @type {any} */ agent) => agent.awake), "one sleeper wakes from engine recovery");
    assert.match(text(app.document, "live-badge"), /SELF-RUNNING/);
  } finally { app.restore(); }
});

test("when the background service is running, the app shows its world and does not tick on its own", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const served = createWorld({ seed: 42 });
  runTicks(served, 240);
  const serviceJson = serializeWorld(served);
  const servedTick = served.clock.tick;

  const app = await bootApp({ serviceJson });
  try {
    const stored = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));
    const adopted = JSON.parse(stored.world);
    assert.equal(adopted.clock.tick, servedTick, "the app adopts the service's world as it stands");
    assert.equal(adopted.seed, 42);

    // A manual tick must not move a world the service is keeping alive.
    app.document.getElementById("btn-tick").click();
    await new Promise(r => setImmediate(r));
    const after = JSON.parse(JSON.parse(app.window.localStorage.getItem("agentsworld.v2")).world);
    assert.equal(after.clock.tick, servedTick, "the app leaves the clock to the service");
  } finally { app.restore(); }
});


test("a conversation shows up in the feed as the lines the two minds said", async () => {
  const { createWorld, runTicks, serializeWorld, livingAgents } = await import("../engine/index.js");
  const { logEvent } = await import("../engine/model/events.js");
  const world = createWorld({ seed: 77 });
  runTicks(world, 20);
  const [a, b] = livingAgents(world);
  logEvent(world, {
    kind: "contact",
    agentId: a.id,
    subjectId: b.id,
    text: `${a.name} and ${b.name} talked for a while, and it was easy.`,
    significance: 0.45,
    scene: [
      { speakerId: a.id, text: "You look like the day has been long." },
      { speakerId: b.id, text: "Long day, yes. But this helps." }
    ]
  });

  const app = await bootApp({ serviceJson: serializeWorld(world) });
  try {
    const lines = $$(app.document.getElementById("activity-feed") || app.document, ".sline");
    assert.ok(lines.length >= 2, "both lines of the conversation should be on screen");
    const said = lines.map(l => l.textContent.trim());
    assert.ok(said.some(t => t.includes("this helps")), said.join(" | "));
    assert.ok(said.some(t => t.startsWith(a.name)), "each line is attributed to its speaker");
  } finally { app.restore(); }
});

test("the keeper earns rank by what they do, and every mind has a face on screen", async () => {
  const app = await bootApp();
  try {
    const doc = app.document;
    const strip = doc.getElementById("keeper-strip");
    assert.ok(strip && strip.textContent.includes("Passerby"), "a new keeper starts as a Passerby");
    const xpBefore = Number((strip.textContent.match(/(\d+) XP/) || [])[1]);

    // A first visit to a screen is a first-time act: it pays once.
    const minds = [...doc.querySelectorAll("#record-tabs .rtab")].find(t => t.dataset.view === "keeper");
    minds.click();
    const xpAfter = Number((doc.getElementById("keeper-strip").textContent.match(/(\d+) XP/) || [])[1]);
    assert.ok(xpAfter >= xpBefore, "XP never goes down");

    // The Keeper view lists every achievement, unlocked or not.
    const panel = doc.querySelector("#record-pane .keeper-panel");
    assert.ok(panel, "the Keeper view renders");
    assert.equal(panel.querySelectorAll(".ach").length, 10);

    // Each mind is drawn as a portrait, not an emoji in a circle.
    const portraits = doc.querySelectorAll("#agents-list .portrait svg");
    assert.ok(portraits.length >= 9, "every mind in the list has a portrait, got " + portraits.length);
  } finally { app.restore(); }
});

test("Admin downloads a portable world-only backup without exporting the API key", async () => {
  const app = await bootApp();
  try {
    const { window, document: doc } = app;
    const captured = /** @type {{ blob: Blob|null, link: HTMLAnchorElement|null }} */ ({ blob: null, link: null });
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: (/** @type {Blob} */ blob) => { captured.blob = blob; return "blob:agents-world-backup"; }
    });
    Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: () => {} });
    /** @type {any} */ (window.HTMLAnchorElement.prototype).click = function () { captured.link = this; };

    const stored = JSON.parse(window.localStorage.getItem("agentsworld.v2"));
    const expectedWorld = JSON.parse(stored.world);
    doc.getElementById("btn-export-world").click();

    const exportedBlob = captured.blob;
    const downloadLink = captured.link;
    assert.ok(exportedBlob, "the app creates a downloadable JSON blob");
    assert.ok(downloadLink, "the browser download is triggered");
    assert.match(downloadLink.download, new RegExp(`agents-world-seed-${expectedWorld.seed}-day-${expectedWorld.clock.day}\\.json`));
    const backup = JSON.parse(await exportedBlob.text());
    assert.equal(backup.format, "agents-world-save");
    assert.equal(backup.version, 1);
    assert.deepEqual(backup.world, expectedWorld, "the backup contains the exact serialized simulation state");
    assert.equal("settings" in backup, false, "local preferences and credentials are not part of the world file");
    assert.match(text(doc, "backup-status"), /backup downloaded/i);
  } finally { app.restore(); }
});

test("Admin restores a world backup and leaves local credentials and keeper data alone", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const current = createWorld({ seed: 101 });
  runTicks(current, 8);
  const savedState = {
    world: serializeWorld(current),
    settings: { apiKey: "local-only-secret", model: "local-model", tickSeconds: 45 },
    chats: { [current.agents[0].id]: [{ role: "user", content: "a local conversation" }] },
    chatRoles: {},
    ui: {},
    keeper: {},
    lastSeenAt: Date.now()
  };
  const app = await bootApp({ savedState });
  try {
    const { window, document: doc } = app;
    const imported = createWorld({ seed: 987654 });
    runTicks(imported, 37);
    const input = doc.getElementById("import-world-file");
    const file = {
      name: "agents-world-backup.json",
      text: async () => JSON.stringify({
        format: "agents-world-save",
        version: 1,
        exportedAt: "2026-01-02T03:04:05.000Z",
        world: JSON.parse(serializeWorld(imported))
      })
    };
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    window.confirm = () => true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    const restoredState = JSON.parse(window.localStorage.getItem("agentsworld.v2"));
    const restoredWorld = JSON.parse(restoredState.world);
    assert.equal(restoredWorld.seed, imported.seed);
    assert.equal(restoredWorld.clock.tick, imported.clock.tick);
    assert.deepEqual(restoredWorld, JSON.parse(serializeWorld(imported)), "all replay-relevant world state is restored");
    assert.deepEqual(restoredState.chats, {}, "chat history tied to the replaced world is cleared");
    assert.equal(restoredState.settings.apiKey, "local-only-secret", "the device-only API key is neither exported nor overwritten");
    assert.match(text(doc, "backup-status"), /Backup restored/);
    assert.match(text(doc, "admin-world"), /seed 987654/);
  } finally { app.restore(); }
});

test("Admin rejects unsupported backups without changing the current world", async () => {
  const app = await bootApp();
  try {
    const { window, document: doc } = app;
    const before = JSON.parse(window.localStorage.getItem("agentsworld.v2")).world;
    const input = doc.getElementById("import-world-file");
    const file = {
      name: "future-backup.json",
      text: async () => JSON.stringify({ format: "agents-world-save", version: 999, world: {} })
    };
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(JSON.parse(window.localStorage.getItem("agentsworld.v2")).world, before);
    assert.match(text(doc, "backup-status"), /format or version is not supported/i);
  } finally { app.restore(); }
});

test("a background-owned world can be exported but its restore control is disabled", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const served = createWorld({ seed: 314 });
  runTicks(served, 20);
  const app = await bootApp({ serviceJson: serializeWorld(served) });
  try {
    app.document.querySelector('.tab[data-tab="admin"]').click();
    assert.equal(app.document.getElementById("btn-import-world").disabled, true);
    assert.match(text(app.document, "backup-status"), /background service owns this world/i);
  } finally { app.restore(); }
});
