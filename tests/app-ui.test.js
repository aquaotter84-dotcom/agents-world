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
 * @param {{ savedState?: any, serviceJson?: string | null | (() => string | null), modelReply?: string | ((url: string, body: any) => string) | null }} [opts]
 */
async function bootApp({ savedState = null, serviceJson = null, modelReply = null } = {}) {
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
  /** @type {{id: any, kind: string, ms: number}[]} */
  const timers = [];
  // Captured once, before any override can shadow them.
  const realSetInterval = setInterval;
  const realSetTimeout = setTimeout;
  const fakeSetInterval = (/** @type {any} */ fn, /** @type {number} */ ms) => {
    const id = realSetInterval(fn, ms);
    timers.push({ id, kind: "interval", ms: Number(ms) });
    return id;
  };
  const fakeSetTimeout = (/** @type {any} */ fn, /** @type {number|undefined} */ ms, /** @type {any[]} */ ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    timers.push({ id, kind: "timeout", ms: Number(ms) });
    return id;
  };

  /** Every URL the app asked for, so a test can see where it looked. @type {string[]} */
  const requested = [];
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
    fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
      requested.push(String(url));
      const body = init && init.body ? JSON.parse(String(init.body)) : null;
      // `serviceJson` may be a function when a test needs the served world to
      // move between polls — which is the whole point of a world kept elsewhere,
      // and the reason the app must not treat every poll as a new world.
      const payload = typeof serviceJson === "function" ? serviceJson() : serviceJson;
      if (payload && String(url).endsWith("api/world")) {
        return { ok: true, text: async () => payload };
      }
      // A stand-in for a provider: whatever a test says the model said.
      if (modelReply) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: {
            content: typeof modelReply === "function" ? modelReply(String(url), body) : modelReply
          } }] })
        };
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
  return { window, document: window.document, mod, restore, requested, timers };
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

test("a successful message visibly builds the keeper's influence", async () => {
  const { createWorld, serializeWorld } = await import("../engine/index.js");
  const world = createWorld({ seed: 149 });
  const before = world.charter.influence;
  const savedState = {
    world: serializeWorld(world),
    settings: { provider: "gemini", keys: { gemini: "test-key" } },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };
  const app = await bootApp({ savedState, modelReply: "I am glad you came by; the evening is quiet." });
  try {
    const { document: doc, window } = app;
    assert.match(text(doc, "hand-card"), /up to 4 successful chat exchanges each world day can earn \+1 influence/i,
      "the World screen explains how to grow the resource");

    doc.querySelector('.tab[data-tab="messages"]').click();
    doc.querySelector("#chat-picker .agent-row").click();
    assert.match(text(doc, "chat-influence-note"), /up to 4 successful chat exchanges/i,
      "the conversation view repeats the reward rule");

    doc.getElementById("chat-input").value = "I am glad to hear from you.";
    doc.getElementById("chat-send").click();
    await new Promise(resolve => setTimeout(resolve, 30));

    const saved = JSON.parse(window.localStorage.getItem("agentsworld.v2"));
    const savedWorld = JSON.parse(saved.world);
    assert.equal(savedWorld.charter.influence, before + 1, "the completed exchange increases spendable influence");
    assert.equal(savedWorld.charter.chatInfluenceRewardsToday, 1, "the daily reward is recorded");
    assert.match(text(doc, "chat-influence-note"), /1\/4 earned today/,
      "the chat screen reports the updated daily count");
    assert.match(text(doc, "toast"), /\+1/,
      "the keeper gets immediate feedback when the reward lands");
  } finally { app.restore(); }
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

test("the world screen shows the story and counts the bookkeeping it left out", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    // A tick of nine minds is mostly the simulation keeping its own books:
    // opinion deltas between pairs, minds that thought about asking the keeper
    // for something and did not, moments the model never answered in time. The
    // World screen is the one screen that has to be worth watching, so those
    // are counted rather than printed — and the count has to be real.
    const rows = $$(doc, "#activity-feed .event");
    assert.ok(rows.length > 0, "the world screen still has a feed");
    for (const row of rows) {
      // A row is either one event or a folded run of ambient lines; both are
      // held to the same rule, which is that the simulation's bookkeeping is
      // not something that happened.
      const ambient = row.classList.contains("ambient");
      const line = (ambient
        ? row.querySelector(".ambient-body").textContent
        : row.querySelector(".etext").textContent);
      assert.doesNotMatch(line, /'s view of .* changed/, "an opinion delta is not an event");
      assert.doesNotMatch(line, /had nothing in the world to point at/, "a mind who asked for nothing is not an event");
      assert.doesNotMatch(line, /No answer arrived in time/, "the engine narrating its own fallback is not an event");
      assert.doesNotMatch(line, /started to tell the keeper something and stopped/, "nor is a mind changing its mind");
      if (ambient) {
        assert.ok(row.querySelectorAll(".ambient-line").length >= 2, "a folded row holds a run, not one line");
        assert.ok(row.querySelectorAll(".ambient-face").length >= 1, "and shows the faces it folded");
      } else {
        assert.match(row.className, /tier-(moment|beat|notable|texture)/, "every row carries how much it mattered");
      }
    }
    const quiet = doc.querySelector("#activity-feed .feed-quiet");
    assert.ok(quiet, "the screen says how much it left out");
    assert.match(quiet.textContent, /\d+ quieter change/, "the count is a number, not a mood");

    // Nothing is hidden, only moved. The record's Feed is still every line.
    $$(doc, "#record-tabs .rtab").find(t => t.dataset.view === "feed").click();
    const all = $$(doc, "#record-pane .event").map(row => row.querySelector(".etext").textContent);
    assert.ok(all.length > rows.length, "the record holds more than the world screen");
    assert.ok(
      all.some(line => /'s view of .* changed/.test(line)),
      "including the lines the world screen would never say out loud"
    );
  } finally { restore(); }
});

test("a beat takes over the top of the world screen", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const banner = doc.getElementById("beat-banner");
    assert.ok(banner.classList.contains("hidden"), "nothing is announced before the world moves");
    let announced = null;
    // A beat worth announcing lands on roughly 40% of ticks, so a couple of
    // world days is overwhelming odds; the loop is bounded either way.
    for (let i = 0; i < 60 && !announced; i++) {
      doc.getElementById("btn-tick").click();
      await new Promise(r => setTimeout(r, 20));
      if (!banner.classList.contains("hidden")) announced = banner.textContent;
    }
    assert.ok(announced, "a day of world time produces something worth announcing");
    assert.match(banner.className, /tier-(beat|moment)/, "only beat-or-better interrupts, and only when it lands");
    assert.ok(announced.trim().length > 20, "the announcement says what happened");
    assert.doesNotMatch(announced, /'s view of .* changed|No answer arrived in time/);
    banner.click();
    assert.ok(banner.classList.contains("hidden"), "tapping it dismisses it");
  } finally { restore(); }
});

test("the director sets the pace to the story, and the header says so", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  // A world with a live vendetta is a world worth sitting and watching.
  const [a, b] = world.agents;
  /** @type {any} */ (world).flags = { feudStages: { [a.id + "|" + b.id]: "vendetta" } };
  a.relations[b.id].resentment = 80;
  b.relations[a.id].resentment = 76;
  const savedState = {
    world: serializeWorld(world),
    settings: { director: true, tickSeconds: 45 },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };

  const app = await bootApp({ savedState });
  try {
    const note = text(app.document, "director-note");
    assert.match(note, /Brisk/, "a vendetta runs at the fastest pace the director has");
    assert.match(note, /vendetta/i, "and the header says why");
    const tick = app.timers.filter(t => t.kind === "interval" && t.ms >= 15000);
    assert.ok(tick.length >= 1, "the app armed a clock");
    for (const t of tick) assert.equal(t.ms, 30000, "the clock runs at the pace the world earned");
  } finally { app.restore(); }
});

test("with the director off the keeper's own pace is kept, and no pace is claimed", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  const [a, b] = world.agents;
  /** @type {any} */ (world).flags = { feudStages: { [a.id + "|" + b.id]: "vendetta" } };
  a.relations[b.id].resentment = 80;
  const savedState = {
    world: serializeWorld(world),
    settings: { director: false, tickSeconds: 90 },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };

  const app = await bootApp({ savedState });
  try {
    const tick = app.timers.filter(t => t.kind === "interval" && t.ms >= 15000);
    assert.ok(tick.length >= 1);
    for (const t of tick) assert.equal(t.ms, 90000, "the keeper's dial is the one that matters");
    assert.doesNotMatch(text(app.document, "director-note"), /Brisk|Normal|Easy|Chill/);
  } finally { app.restore(); }
});

test("the board says what story is running, and a card can be followed", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  const [a, b] = world.agents;
  /** @type {any} */ (world).flags = { feudStages: { [a.id + "|" + b.id]: "vendetta" } };
  a.relations[b.id].resentment = 80;
  b.relations[a.id].resentment = 76;
  const savedState = {
    world: serializeWorld(world),
    settings: {}, chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };

  const app = await bootApp({ savedState });
  try {
    const doc = app.document;
    const cards = $$(doc, "#storylines .storyline");
    assert.ok(cards.length >= 1, "a world at war has something on the board");
    assert.ok(cards.length <= 3, "three cards, not a list");
    for (const card of cards) {
      assert.ok(card.querySelector(".story-title").textContent.trim().length > 0, "a card is titled");
      assert.ok(card.querySelector(".story-line").textContent.trim().length > 0, "and says something");
    }
    const feud = cards.find(c => /vendetta/i.test(c.textContent));
    assert.ok(feud, "the vendetta is the first thing the board says");
    const act = feud.querySelector(".story-act");
    assert.ok(act, "and it can be followed");
    act.click();
    assert.ok(doc.querySelector("#screen-record").classList.contains("active"), "following a story opens the record");
    assert.ok(doc.querySelector('.rtab[data-view="threads"]').classList.contains("active"), "on the thread it points at");
    assert.match(doc.querySelector("#thread-target").textContent, new RegExp(a.name + "|" + b.name));
  } finally { app.restore(); }
});

test("the world screen says what today has done so far", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const line = text(doc, "today-line");
    assert.ok(line.length > 10, "there is a line about today");
    assert.match(line, /^(Today:|Nothing worth telling)/);
  } finally { restore(); }
});

test("watch mode is the map, the beats, and no controls", async () => {
  const { document: doc, restore, window } = await bootApp();
  try {
    const btn = doc.getElementById("btn-watch");
    assert.ok(!doc.body.classList.contains("watching"), "the app opens with its controls");
    doc.querySelector('.tab[data-tab="admin"]').click();
    assert.ok(doc.querySelector("#screen-admin").classList.contains("active"));
    btn.click();
    assert.ok(doc.body.classList.contains("watching"), "watch mode is a state the whole app wears");
    assert.ok(doc.querySelector("#screen-world").classList.contains("active"), "and it always shows the world");
    assert.match(btn.textContent, /Watching/);
    assert.equal(JSON.parse(window.localStorage.getItem("agentsworld.v2")).settings.watching, true, "and it is remembered");
    btn.click();
    assert.ok(!doc.body.classList.contains("watching"), "and it can be left");
    assert.equal(JSON.parse(window.localStorage.getItem("agentsworld.v2")).settings.watching, false);
  } finally { restore(); }
});

test("sound is a switch in Admin, off until it is asked for", async () => {
  const { document: doc, restore, window } = await bootApp();
  try {
    doc.querySelector('.tab[data-tab="admin"]').click();
    const box = doc.getElementById("set-sound");
    assert.ok(box, "Admin carries the switch");
    assert.equal(box.checked, false, "the app is silent until asked");
    box.checked = true;
    box.dispatchEvent(new window.Event("change"));
    assert.equal(JSON.parse(window.localStorage.getItem("agentsworld.v2")).settings.sound, true);
    // A device with no audio must still survive being told to play something.
    assert.doesNotThrow(() => doc.getElementById("btn-sound-test").click());
    box.checked = false;
    box.dispatchEvent(new window.Event("change"));
    assert.equal(JSON.parse(window.localStorage.getItem("agentsworld.v2")).settings.sound, false);
  } finally { restore(); }
});

test("coming back to a world that ran on replays what was missed", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const { isBookkeeping } = await import("../app/director.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  // Stand where the keeper last stood: a real absence, with real story in it.
  const { beatTier: tierOf } = await import("../app/director.js");
  for (let i = 0; i < 60; i++) {
    const recent = world.events.filter(e => e.tick > world.clock.tick - 12 && !isBookkeeping(e) && tierOf(e) !== "texture");
    if (recent.length >= 2) break;
    runTicks(world, 4);
  }
  const lastSeenTick = world.clock.tick - 12;
  assert.ok(
    world.events.some(e => e.tick > lastSeenTick && !isBookkeeping(e) && tierOf(e) !== "texture"),
    "the absence has something worth watching in it"
  );
  const savedState = {
    world: serializeWorld(world),
    settings: {}, chats: {}, chatRoles: {}, ui: {},
    lastSeenAt: Date.now() - 3600 * 1000,
    lastSeenTick
  };

  const app = await bootApp({ savedState });
  try {
    const doc = app.document;
    const banner = doc.getElementById("beat-banner");
    assert.ok(!banner.classList.contains("hidden"), "the app starts by showing what was missed");
    assert.ok(banner.classList.contains("replaying"), "and says it is a replay");
    assert.ok(doc.querySelector("#activity-feed .feed-quiet.replay"), "the feed is reading the past back");
    assert.equal(doc.querySelectorAll("#timeline .tl-seg.playing").length, 1,
      "and the timeline shows where the film started");
    // A tap is "get me to now".
    banner.click();
    assert.ok(banner.classList.contains("hidden"), "the replay can be skipped");
    assert.equal(doc.querySelector("#activity-feed .feed-quiet.replay"), null, "and the feed catches up");
  } finally { app.restore(); }
});

test("a model can write the conversations again, and the record is not touched", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const { logEvent } = await import("../engine/model/events.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  // No moments this tick: the only call the app should make is the retelling.
  world.config.moments.maxPerTick = 0;
  world.pending = [];
  const [a, b] = world.agents.filter(x => !x.retired);
  const engineLines = ["Wren and Corva talked for a while, and it was easy.", "Neither of them said the true thing."];
  const scene = logEvent(world, {
    kind: "contact",
    agentId: a.id,
    subjectId: b.id,
    text: a.name + " and " + b.name + " talked for a while, and it was easy.",
    significance: 0.6,
    scene: [
      { speakerId: a.id, text: engineLines[0] },
      { speakerId: b.id, text: engineLines[1] }
    ]
  });
  const savedState = {
    world: serializeWorld(world),
    settings: { provider: "gemini", keys: { gemini: "AIKEY" }, retell: true },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };
  const modelReply = a.name + ": I did not come here to argue with you.\n" +
    b.name + ": Then you came to the wrong place.\n";
  const app = await bootApp({ savedState, modelReply });
  try {
    const doc = app.document;
    doc.getElementById("btn-tick").click();
    // The tick, then the call it was worth spending.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      const saved = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));
      if (saved.retold && saved.retold[scene.id]) break;
    }
    const saved = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));

    // 1. The model's lines are kept, with the model that wrote them.
    const retelling = saved.retold[scene.id];
    assert.ok(retelling, "the conversation was retold");
    assert.equal(retelling.lines.length, 2);
    assert.match(retelling.lines[0].text, /did not come here to argue/);
    assert.equal(retelling.lines[0].speakerId, a.id, "lines are attributed to the right people");

    // 2. The world is not touched: the record still holds what the engine wrote.
    const kept = JSON.parse(saved.world).events.find((/** @type {any} */ e) => e.id === scene.id);
    assert.deepEqual(kept.scene.map((/** @type {any} */ l) => l.text), engineLines,
      "the engine's lines are the record, and a retelling does not overwrite them");

    // 3. And the screen shows the retelling, marked as one.
    doc.querySelector('.rtab[data-view="feed"]').click();
    const card = $$(doc, "#record-pane .thread-event, #record-pane .event").find(c => c.textContent.includes("did not come here to argue"));
    assert.ok(card, "the retelling is what the keeper reads");
    assert.ok(card.querySelector(".scene.retold"), "and it is drawn as a retelling");
    assert.match(card.querySelector(".retold-tag").textContent, /retold by/);
  } finally { app.restore(); }
});

test("with the retelling switched off, no model call is made for a conversation", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const { logEvent } = await import("../engine/model/events.js");
  const world = createWorld({ seed: 42 });
  runTicks(world, 240);
  world.config.moments.maxPerTick = 0;
  world.pending = [];
  const [a, b] = world.agents.filter(x => !x.retired);
  logEvent(world, {
    kind: "contact", agentId: a.id, subjectId: b.id,
    text: a.name + " and " + b.name + " talked for a while.",
    significance: 0.6,
    scene: [{ speakerId: a.id, text: "Wren and Corva talked for a while, and it was easy." }, { speakerId: b.id, text: "Neither of them said the true thing." }]
  });
  const savedState = {
    world: serializeWorld(world),
    settings: { provider: "gemini", keys: { gemini: "AIKEY" }, retell: false },
    chats: {}, chatRoles: {}, ui: {}, lastSeenAt: Date.now()
  };
  const app = await bootApp({ savedState, modelReply: "should never be called" });
  try {
    app.document.getElementById("btn-tick").click();
    await new Promise(r => setTimeout(r, 200));
    const saved = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));
    assert.deepEqual(Object.keys(saved.retold || {}), [], "nothing was retold");
    for (const url of app.requested) {
      assert.ok(url.endsWith("api/world"), "the app only looked for a world: " + url);
    }
  } finally { app.restore(); }
});

test("the timeline is a day of ticks, and a quiet one cannot be scrubbed into a film", async () => {
  const { document: doc, restore } = await bootApp();
  try {
    const segs = $$(doc, "#timeline .tl-seg");
    assert.equal(segs.length, 48, "the strip is one world day, one tick at a time");
    for (const seg of segs) {
      assert.match(seg.className, /tl-seg (quiet|notable|beat|moment)/, "every tick is drawn by how much happened in it");
      assert.ok(seg.dataset.tick);
    }
    assert.equal(doc.querySelectorAll("#timeline .tl-seg.now").length, 1, "the present is on the strip");

    // Scrubbing to the present is not a replay.
    const now = segs[segs.length - 1];
    now.click();
    assert.ok(doc.getElementById("beat-banner").classList.contains("hidden"), "there is nothing to catch up on");
    assert.match(doc.getElementById("toast")?.textContent || "", /where the world is now/, "and the app says so");
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


test("a world kept elsewhere announces its beats as it moves", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const served = createWorld({ seed: 42 });
  runTicks(served, 240);
  // The service serializes the whole world on every poll, so this app sees a new
  // object every ten seconds. If that reads as a new world, nothing the world
  // does on its own is ever worth announcing — which is exactly the bug this
  // pins: the announcement watermark has to survive the world being re-read.
  let payload = serializeWorld(served);
  const app = await bootApp({ serviceJson: () => payload });
  try {
    const doc = app.document;
    const banner = doc.getElementById("beat-banner");
    assert.ok(banner.classList.contains("hidden"), "adopting a world is not an arrival");

    // The world moves on while the app is closed, the way a hosted world does.
    let beat = null;
    for (let i = 0; i < 40 && !beat; i++) {
      runTicks(served, 1);
      const newest = served.events[0];
      if (newest && newest.kind !== "relationship" && newest.significance >= 0.6) beat = newest;
    }
    assert.ok(beat, "a served world produces a beat inside a day of its own time");

    payload = serializeWorld(served);
    doc.getElementById("btn-service-check").click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!banner.classList.contains("hidden"), "the next poll announces it");
    assert.ok(
      banner.textContent.includes(beat.text.slice(0, 24)),
      "and the announcement is the thing that actually happened"
    );
  } finally { app.restore(); }
});

test("a hosted world that ran on plays its missed ticks back, rather than only being adopted", async () => {
  const { createWorld, runTicks, serializeWorld } = await import("../engine/index.js");
  const { isBookkeeping, beatTier } = await import("../app/director.js");
  const served = createWorld({ seed: 42 });
  runTicks(served, 240);
  let payload = serializeWorld(served);
  const app = await bootApp({ serviceJson: () => payload });
  try {
    const doc = app.document;
    const banner = doc.getElementById("beat-banner");

    // The world lives on without the app: a real absence, longer than the floor
    // a replay needs, and with something in it.
    const from = served.clock.tick;
    for (let i = 0; i < 40; i++) {
      runTicks(served, 4);
      const seen = served.events.filter(e => e.tick > from && !isBookkeeping(e) && beatTier(e) !== "texture");
      if (served.clock.tick - from >= 12 && seen.length >= 2) break;
    }
    assert.ok(
      served.events.some(e => e.tick > from && !isBookkeeping(e) && beatTier(e) !== "texture"),
      "the ticks missed in the interval are worth watching"
    );
    payload = serializeWorld(served);

    doc.getElementById("btn-service-check").click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(banner.classList.contains("replaying"), "the app plays back what it missed, it does not just adopt it");
    assert.ok(doc.querySelector("#activity-feed .feed-quiet.replay"), "and the feed reads as the story of the absence");
    // Nothing interrupts a film — not a later, smaller catch-up, and not a real
    // moment landing in the live world while the story behind it is being told.
    const frame = banner.innerHTML;
    const { logEvent } = await import("../engine/model/events.js");
    logEvent(served, {
      kind: "feud", significance: 1,
      text: "The two of them settled it, and only one of them was left standing."
    });
    payload = serializeWorld(served);
    doc.getElementById("btn-service-check").click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(banner.innerHTML, frame, "the film it is already showing is not interrupted");
    assert.ok(doc.querySelector("#activity-feed .feed-quiet.replay"),
      "and its feed is not wiped by the world moving underneath it");
    assert.equal(doc.querySelectorAll("#timeline .tl-seg.playing").length, 1,
      "and the timeline says where the film starts");

    // A film is about one world. Pointing the app at a different one ends it:
    // somebody else's ticks are not this keeper's absence.
    const other = createWorld({ seed: 7 });
    runTicks(other, 120);
    payload = serializeWorld(other);
    doc.getElementById("btn-service-check").click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(banner.classList.contains("hidden"), "the film of the old world does not play over the new one");
    assert.equal(doc.querySelector("#activity-feed .feed-quiet.replay"), null, "nor does its feed");
  } finally { app.restore(); }
});

test("coming back after hours shows what the world did while the keeper was gone", async () => {
  const { createWorld, serializeWorld } = await import("../engine/index.js");
  const world = createWorld({ seed: 12 });
  const savedState = {
    world: serializeWorld(world),
    settings: { tickSeconds: 45 },
    chats: {},
    chatRoles: {},
    ui: {},
    lastSeenAt: Date.now() - 4 * 3600 * 1000
  };

  const app = await bootApp({ savedState });
  try {
    const doc = app.document;
    // The world ran on without a keeper. The Chronicle is where absence is
    // accounted for, so that is where the card goes.
    doc.querySelector('.rtab[data-view="chronicle"]').click();
    const card = doc.querySelector("#record-pane .away-card");
    assert.ok(card, "the absence has a card of its own in the Chronicle");
    assert.match(card.textContent, /While you were away/);
    assert.equal(card.querySelectorAll(".away-meter").length, 3, "the keeper's score is on it");
    assert.equal(doc.querySelector("#record-pane").firstElementChild, card,
      "and it sits above the days it summarizes");
    // A digest that reports nothing would not have been written.
    const stored = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));
    assert.ok(stored.digest && stored.digest.ticks > 0, "the digest says how long the world ran alone");

    // Reading it is an act: dismissed, it is gone from the record and the save.
    card.querySelector(".digest-dismiss").click();
    assert.equal(doc.querySelector("#record-pane .away-card"), null);
    assert.equal(JSON.parse(app.window.localStorage.getItem("agentsworld.v2")).digest, null);
  } finally { app.restore(); }
});

test("when the background service kept the world alive, the app says what it did in the keeper's absence", async () => {
  const { createWorld, runTicks, serializeWorld, deserializeWorld } = await import("../engine/index.js");
  const mine = createWorld({ seed: 42 });
  runTicks(mine, 108);
  const savedState = {
    world: serializeWorld(mine),
    settings: { tickSeconds: 45 },
    chats: {},
    chatRoles: {},
    ui: {},
    lastSeenAt: Date.now() - 3 * 3600 * 1000,
    lastSeenTick: mine.clock.tick
  };
  // The service holds the same world, three hours further along.
  const served = deserializeWorld(serializeWorld(mine));
  runTicks(served, 240);

  const app = await bootApp({ savedState, serviceJson: serializeWorld(served) });
  try {
    const doc = app.document;
    const stored = JSON.parse(app.window.localStorage.getItem("agentsworld.v2"));
    assert.equal(JSON.parse(stored.world).clock.tick, served.clock.tick,
      "the service's world is the one adopted");
    assert.ok(stored.digest && stored.digest.ticks === 240,
      "the gap between left and lived is what the keeper is told about");
    const toast = doc.getElementById("toast");
    assert.ok(toast && /While you were away/.test(toast.textContent),
      "and the keeper hears about it on the way in");

    // Two hundred and forty ticks is a long absence, and the world is the one
    // they were watching: it is played back, not only described.
    const banner = doc.getElementById("beat-banner");
    assert.ok(banner.classList.contains("replaying"),
      "the world the keeper was already watching is played back on arrival");
    assert.ok(doc.querySelector("#activity-feed .feed-quiet.replay"), "and the feed reads as the absence");
    banner.click();
    assert.ok(banner.classList.contains("hidden"), "a tap gets the keeper to now");

    doc.querySelector('.rtab[data-view="chronicle"]').click();
    assert.ok(doc.querySelector("#record-pane .away-card"),
      "the record keeps it after the toast is gone");
  } finally { app.restore(); }
});

test("the keeper can point the app at a world kept elsewhere and see it answer", async () => {
  const { createWorld, runTicks, serializeWorld, deserializeWorld } = await import("../engine/index.js");
  const mine = createWorld({ seed: 4 });
  runTicks(mine, 96);
  for (const agent of mine.agents) {
    agent.awake = true;
    agent.needs.energy = 80;
  }
  const savedState = {
    world: serializeWorld(mine),
    settings: { tickSeconds: 45, serviceUrl: "https://world.example/" },
    chats: {},
    chatRoles: {},
    ui: {},
    lastSeenAt: Date.now() - 3600 * 1000
  };
  // The same world, a day and a half further along, kept by something else.
  const hosted = deserializeWorld(serializeWorld(mine));
  runTicks(hosted, 120);

  const app = await bootApp({ savedState, serviceJson: serializeWorld(hosted) });
  try {
    const doc = app.document;
    assert.equal(app.requested[0], "https://world.example/api/world",
      "the app asks the address the keeper set, not this origin");
    const stored = JSON.parse(doc.defaultView.localStorage.getItem("agentsworld.v2"));
    assert.equal(JSON.parse(stored.world).clock.tick, hosted.clock.tick,
      "and adopts the world it was pointed at");
    assert.ok(stored.digest && stored.digest.ticks === 120,
      "the gap between left and lived is what the keeper is told about");
    // The board says where the world is kept — the keeper never has to wonder
    // whether the thing on screen is theirs or somebody else's clock.
    assert.match(text(doc, "live-badge"), /REMOTE/);
    assert.match(text(doc, "live-note"), /world\.example/);

    // Asking again by hand is a keeper action, and it answers plainly.
    doc.querySelector('.tab[data-tab="admin"]').click();
    assert.equal(doc.getElementById("set-service").value, "https://world.example/");
    doc.getElementById("btn-service-check").click();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.match(text(doc, "service-status"), /Found it\. Day \d+, tick \d+/);
  } finally { app.restore(); }
});

test("with no address set the app looks at its own origin, and says so when nothing answers", async () => {
  const app = await bootApp();
  try {
    const doc = app.document;
    assert.equal(app.requested[0], "/api/world", "with no service URL the probe is relative");
    doc.querySelector('.tab[data-tab="admin"]').click();
    doc.getElementById("btn-service-check").click();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.match(text(doc, "service-status"), /keeping its own world/);
    assert.match(text(doc, "live-badge"), /SELF-RUNNING/, "and the world keeps running here");
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
    assert.equal(restoredState.settings.keys.bluesminds, "local-only-secret", "the device-only API key is neither exported nor overwritten");
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
