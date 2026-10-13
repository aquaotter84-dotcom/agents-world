/* Agents World — the engine is the brain, the app is its face.
 * Vanilla JS ES module, no build step. The deterministic simulation engine
 * (vendored from engine/) owns the world; this file renders it and spends the
 * model budget on the engine's moments. State persists in localStorage.
 *
 * Two rules shape everything here:
 *
 *   1. The world never waits for a model. With an API key the biggest beats of
 *      each tick are written by the keeper's chosen provider (Google AI Studio,
 *      BluesMinds, or any OpenAI-compatible endpoint); without one the engine
 *      narrates them itself. Either way the map moves, the feed fills, and days
 *      close into chronicle entries. A key changes the voice, not the world.
 *   2. The engine already knows more than the screen was showing — grudges,
 *      bonds, factions, secrets, what each mind is chewing on — so the UI's job
 *      is to put that on the surface rather than to invent a layer on top.
 *
 * The API key lives ONLY in localStorage, is never logged, and is sent only to
 * the active provider's endpoint (see app/providers.js). No background service: ticks run while the app is
 * open, and any time the app was closed is paid back on load as a catch-up.
 */
import {
  createWorld, step, resolveMoment, runTicks, worldStats,
  serializeWorld, deserializeWorld,
  agentById, livingAgents, regionName, regionOccupancy,
  moodWord, stateLine, describeClock, phaseOf,
  REGIONS, GOAL_IDEAS, BACKSTORIES,
  describeRelation, standingWord,
  KEEPER_ROLES, roleById,
  applyChatInfluence,
  socialTemperature, currentFactions,
  secretTextFor, privateSecretsHeld, secretsAbout, preoccupations,
  levelProgress, pressingNeed,
  ruleOnPetition, resolveDilemma, actOnWhisper, describeRule, influenceWord,
  RULE_KINDS, precedentFor, feudStage,
  wantSummary, wantLog, WANT_LABELS, wantVerdict,
  pendingFunerals, recentMemorials, mournDeparture,
  interventionOptions, canIntervene, performIntervention, recentInterventions,
  interventionFor, INTERVENTION_INFO
} from "./vendor/engine/index.js";
import { createAgent } from "./vendor/engine/model/agent.js";
import { createMemory } from "./vendor/engine/model/memory.js";
import { logEvent } from "./vendor/engine/model/events.js";
import { buildPrompt, parseReply } from "./vendor/server/prompt.js";
import { migrateV1Save } from "./migrate.js";
import { portraitSvg } from "./portrait.js";
import { award, summarize, normalizeKeeper, emptyKeeper, RANKS } from "./keeper.js";
import { cleanReply, stripScaffolding } from "./reply-sanitize.js";
import { PROVIDERS, providerById, providerCallOf, normalizeSettings, hostOf } from "./providers.js";
import {
  isBookkeeping, beatTier, BEAT_FLOOR,
  worldPulse, paceFor, directorNote, storylineBoard, foldAmbient, todaySoFar, replayFrames
} from "./director.js";
import { arm as armSound, isSoundOn, setSoundOn, sting } from "./sound.js";
import { boardSigils, mindGlyph, feudArcs, constellations, projectPalette, keeperRing, mourningMarks, divineMarks } from "./board.js";
import { digestMark, awayDigest, digestLine } from "./digest.js";

const STORE_KEY = "agentsworld.v2";
/**
 * Every world gets a name, derived from its seed so it never changes under the
 * keeper's feet. A world you have watched for a week should not still be called
 * "The World".
 */
const WORLD_FIRST = ["Amber", "Quiet", "Hollow", "Long", "Grey", "Little", "Salt", "Bright", "Slow", "Old", "Deep", "Pale"];
const WORLD_LAST = ["Reach", "Meridian", "Ward", "Threshold", "Crossing", "Holding", "Verdict", "Interval", "Refuge", "Ledger", "Compass", "Anchor"];
function worldNameFor(seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  // `>>>` not `>>`: a signed shift on a 32-bit hash goes negative and indexes
  // the name table from the wrong end.
  return "The " + WORLD_FIRST[h % WORLD_FIRST.length] + " " + WORLD_LAST[(h >>> 7) % WORLD_LAST.length];
}
const OLD_KEY = "agentsworld.v1";
/* Model providers (endpoints, keys, models) live in ./providers.js — the
 * only place in the app that names a URL. */
const THOUGHT_TTL_MS = 5 * 60 * 1000;
/** A brand-new world is given this much history so it opens mid-story. */
const OPENING_TICKS = 108;          // just over two world days
/** Ceiling on how much missed time is paid back in one load. */
const CATCHUP_CAP_TICKS = 480;      // ten world days
const CATCHUP_MAX_HOURS = 8;        // beyond this, the world just picks up fresh

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- create-form constants (engine owns the real tables) ---------- */
const CLASSES = ["Scholar", "Warden", "Diplomat", "Maker"];
const PERSONAS = ["The Curious", "The Stoic", "The Dreamer", "The Bold"];
const HUES = ["#34d399", "#f472b6", "#a78bfa", "#8b5cf6", "#22d3ee", "#fbbf24", "#f87171", "#60a5fa"];
const ICONS = ["✦", "✧", "❖", "◉", "◎", "⛨", "⛉", "⚒", "☾", "❂"];

/* ---------- state ---------- */
let world = null;
let settings = normalizeSettings({});
let chats = {};
let chatRoles = {};
/** Conversations a model has written again, by event id. Never part of the world. */
let retold = {};
let ui = { selectedId: null, chatId: null, record: "feed", threadKind: "mind", threadTarget: null };
let lastSeenAt = Date.now();
/** The tick the world had reached the last time it was saved, for the replay. */
let lastSeenTick = null;
let keeper = emptyKeeper();
/** The last "while you were away" digest, kept until the keeper has read it. */
let lastDigest = null;

/* ---------- the background service ----------
 * When the runner (server/index.js) is alive it owns the clock: the world keeps
 * ticking whether or not this app is open. In that case the app is a window
 * onto the service's world — it adopts the saved world, stops ticking locally
 * and polls for new ticks. Without a service it runs its own world as before. */
let serviceMode = false;
let servicePollTimer = null;
let serviceLost = false;
const SERVICE_POLL_MS = 10000;

/**
 * Where the world is kept, if the keeper has pointed this app at a service:
 * an empty setting means "whatever origin is serving this app".
 */
function serviceBase() {
  return String(settings.serviceUrl || "").trim().replace(/\/+$/, "");
}
function serviceHost() {
  const base = serviceBase();
  if (!base) return "this server";
  try { return new URL(base).host; } catch (e) { return base; }
}
async function probeService() {
  try {
    const r = await fetch(serviceBase() + "/api/world", { cache: "no-store" });
    if (!r.ok) return null;
    return deserializeWorld(await r.text());
  } catch (e) {
    return null; // no service, or not served over http at all (the APK)
  }
}

async function pollServiceOnce() {
  const next = await probeService();
  if (!next) {
    if (!serviceLost) toast("The world you were watching has gone quiet — this app will keep its own until it is back.");
    serviceLost = true;
    renderStats();
    return false;
  }
  const wasLost = serviceLost;
  serviceLost = false;
  if (next.clock.tick === world.clock.tick) return true;
  const sameWorld = next.seed === world.seed;
  // The world moved between two polls. That is the same absence as coming back
  // to an app that was closed, so it gets the same treatment: the ticks play
  // back, and only then does the screen settle into live. A film already playing
  // is not cut off here — maybeReplayMissed decides whether this one is bigger.
  const missedFrom = lastSeenTick;
  if (wasLost) {
    // The service was down and is back: whatever happened to the world while
    // it was away is an absence like any other.
    const mark = digestMark(world);
    world = next;
    const digest = awayDigest(mark, world, { hours: null, because: "service" });
    if (!digest.empty && digest.ticks > 0) {
      lastDigest = digest;
      toast(esc(digestLine(digest)));
    }
    save();
    renderAll();
    if (sameWorld) maybeReplayMissed(missedFrom);
    else stopReplay();
    return true;
  }
  world = next;
  save();
  renderAll();
  if (sameWorld) maybeReplayMissed(missedFrom);
  else stopReplay();
  return true;
}

function startServicePolling() {
  if (servicePollTimer) clearInterval(servicePollTimer);
  servicePollTimer = setInterval(() => { void pollServiceOnce(); }, SERVICE_POLL_MS);
}

/**
 * The keeper's own check: look for a world at the configured address right now,
 * and adopt it if it answers. This is a button, not a background hope — pointing
 * the app at a hosted world should tell you whether it worked.
 */
async function checkServiceNow() {
  const status = $("service-status");
  if (status) status.textContent = "Looking for " + (serviceBase() || "a world on this server") + "…";
  const next = await probeService();
  if (!next) {
    serviceLost = true;
    renderStats();
    if (status) {
      status.textContent = serviceBase()
        ? "Nothing answered at " + serviceBase() + ". This app is keeping its own world."
        : "No world is being kept on this server. This app is keeping its own world.";
    }
    return;
  }
  const previouslySeen = digestMark(world);
  // Is this the world the keeper was watching, or a different one? A keeper who
  // points the app at another host has missed nothing there.
  const sameWorld = world.seed === next.seed;
  world = next;
  serviceMode = true;
  serviceLost = false;
  mapFx.fxInit = false;
  const digest = awayDigest(previouslySeen, world, { hours: Math.round((Date.now() - lastSeenAt) / 3.6e5) / 10, because: "service" });
  if (!digest.empty && digest.ticks > 0) lastDigest = digest;
  if (servicePollTimer == null) startServicePolling();
  // Where the keeper last stood, before this adoption moves the mark.
  const missedFrom = lastSeenTick;
  save();
  renderAll();
  if (sameWorld) maybeReplayMissed(missedFrom);
  else stopReplay();
  loadAdmin();
  if (status) {
    status.textContent = "Found it. Day " + world.clock.day + ", tick " + world.clock.tick +
      ", kept by " + serviceHost() + ". This app is a window onto that world now.";
  }
  toast(esc(digest.empty ? "Connected to the world at " + serviceHost() + "." : digestLine(digest)));
}

function save() {
  // The world has now been seen up to here: this is the mark every replay is
  // measured from, so it is kept in step with what is written down.
  lastSeenTick = world.clock.tick;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      world: serializeWorld(world),
      settings, chats, chatRoles, retold, ui, keeper, lastSeenAt: Date.now(), digest: lastDigest,
      // Where the world had got to the last time anybody looked. The replay is
      // measured from here, so a keeper coming back to a world that ran on gets
      // to see the ticks they missed rather than being told about them.
      lastSeenTick: world.clock.tick
    }));
  } catch (e) { /* storage full/blocked */ }
}
function freshWorld(seed) {
  return createWorld({ seed: seed ?? (1 + Math.floor(Math.random() * 1e9)) });
}
/**
 * Read the save. The returned `seen` is where the keeper last stood *as it was
 * written down* — captured before anything in here saves, because a brand-new
 * world is saved at tick 0 on the way out of this function and that must not
 * look like an absence the keeper missed.
 * @returns {{ fresh: boolean, seen: number|null }}
 */
function load() {
  const seenBefore = lastSeenTick;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      world = deserializeWorld(s.world);
      settings = Object.assign(settings, s.settings);
      settings = normalizeSettings(settings);
      chats = s.chats || {};
      chatRoles = s.chatRoles || {};
      retold = s.retold && typeof s.retold === "object" ? s.retold : {};
      ui = Object.assign(ui, s.ui);
      keeper = normalizeKeeper(s.keeper);
      lastSeenAt = s.lastSeenAt || Date.now();
      lastDigest = s.digest || null;
      lastSeenTick = Number.isFinite(s.lastSeenTick) ? s.lastSeenTick : null;
      return { fresh: false, seen: lastSeenTick };
    }
    // Migrate Jeremy's live v1 world — never start him over.
    const oldRaw = localStorage.getItem(OLD_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      if (old && Array.isArray(old.minds)) {
        const mig = migrateV1Save(old, 1 + Math.floor(Math.random() * 1e9));
        world = mig.world;
        chats = mig.chats;
        if (old.settings) {
          // Legacy flat keys were always BluesMinds keys — they stay BluesMinds keys.
          if (old.settings.apiKey) { settings.provider = "bluesminds"; settings.keys.bluesminds = old.settings.apiKey; }
          if (old.settings.model) settings.models.bluesminds = old.settings.model;
          if (old.settings.tickSeconds) settings.tickSeconds = old.settings.tickSeconds;
        }
        lastSeenAt = Date.now();
        save();
        return { fresh: true, seen: seenBefore };
      }
    }
  } catch (e) { /* corrupt: fall through to fresh */ }
  world = freshWorld();
  lastSeenAt = Date.now();
  save();
  return { fresh: true, seen: seenBefore };
}

/* ---------- tiny DOM helpers ---------- */
const $ = id => document.getElementById(id);
let toastTimer = null;
function toast(msg, ms) {
  // A delayed toast can outlive the document it was queued against (a page
  // teardown, or a test harness) — say nothing rather than throw.
  if (typeof document === "undefined" || !document.body) return;
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.innerHTML = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms || 4600);
}
const tickNow = () => world.clock.tick;
/** The resolved provider call, or null when there is no usable key/endpoint. */
const activeCall = () => { try { return providerCallOf(settings); } catch (e) { return null; } };
const hasKey = () => !!activeCall();
const agentName = a => a.name + (a.epithet ? " " + a.epithet : "");
const modelLabel = () => { const c = activeCall(); return c ? (c.model || "a model") : "the engine"; };

/* Stable per-agent jitter so minds sharing a region don't stack on one dot. */
function jitterFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { dx: (h % 13) - 6, dy: ((h >> 4) % 13) - 6 };
}
function mapPos(a) {
  const r = REGIONS.find(r => r.id === a.regionId) || REGIONS[0];
  const j = jitterFor(a.id);
  return {
    x: Math.min(94, Math.max(6, r.x + j.dx)),
    y: Math.min(94, Math.max(6, r.y + j.dy))
  };
}

/* ---------- world reading: the few derived things the UI needs ---------- */

/** The world's emotional weather, in one word, from its own social graph. */
function worldMood() {
  const t = socialTemperature(world);
  if (t.ratio >= 2.2) return { word: "warm", cls: "warm", line: "people are glad of each other" };
  if (t.ratio >= 1.35) return { word: "settled", cls: "calm", line: "mostly getting along" };
  if (t.ratio >= 1.02) return { word: "even", cls: "", line: "affection and friction in balance" };
  if (t.ratio >= 0.75) return { word: "strained", cls: "tense", line: "more friction than warmth" };
  return { word: "bitter", cls: "tense", line: "the world is mostly grievance" };
}

/** The single line worth leading with: the biggest thing said lately. */
function headline(lookbackTicks = 14) {
  const floor = world.clock.tick - lookbackTicks;
  let best = null;
  for (const e of world.events) {
    if (e.tick < floor) break;
    if (e.kind === "chronicle") continue;
    if (!best || (e.significance || 0) > (best.significance || 0)) best = e;
  }
  return best || world.events[0] || null;
}

function tiesOf(a, limit = 5) {
  const out = [];
  for (const [id, edge] of Object.entries(a.relations)) {
    const other = agentById(world, id);
    if (!other || other.retired) continue;
    const word = describeRelation(edge);
    const weight = Math.abs(edge.affinity) + edge.resentment * 1.1 + edge.fear * 0.6 +
      (edge.trust >= 65 || edge.trust <= 20 ? 14 : 0);
    // "Neutral" is the absence of a tie. Only real familiarity earns a row.
    if (word === "neutral" && weight < 26) continue;
    if (weight < 12) continue;
    out.push({ other, edge, weight, word });
  }
  out.sort((x, y) => y.weight - x.weight);
  return out.slice(0, limit);
}

/** What a mind is doing with its days right now, in its own voice. */
function doingLine(a) {
  if (!a.awake) return "Asleep.";
  const last = world.events.find(e => e.agentId === a.id);
  if (last && world.clock.tick - last.tick <= 3) return last.text;
  const need = pressingNeed(a);
  if (need.value <= 25) {
    const want = {
      energy: "Running on empty — looking for somewhere to put their head down.",
      connection: "Has gone too long without anyone. Looking for company.",
      esteem: "Something has got under their skin. Needs to be seen to be worth something.",
      meaning: "Has lost the thread of why any of it matters."
    };
    return want[need.key] || "Unsettled.";
  }
  return "At " + regionName(world, a.regionId) + ", working on: " + a.goal.text;
}

/* ---------- model calls: one at a time, spaced, with 429 backoff ---------- */
let modelQueue = Promise.resolve();
let modelNextAt = 0;
let modelBackoffUntil = 0;
const MODEL_GAP_MS = 4000;

async function modelChat(messages, maxTokens) {
  const task = modelQueue.then(async () => {
    const now = Date.now();
    if (now < modelBackoffUntil) await sleep(modelBackoffUntil - now);
    const gap = modelNextAt - Date.now();
    if (gap > 0) await sleep(gap);
    try {
      return await modelChatOnce(messages, maxTokens);
    } finally {
      modelNextAt = Date.now() + MODEL_GAP_MS;
    }
  });
  modelQueue = task.catch(() => {}); // a failed call must not break the chain
  return task;
}

async function modelChatOnce(messages, maxTokens) {
  const call = providerCallOf(settings); // throws "no-key", "no-url" or "bad-url"
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(call.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + call.key },
      body: JSON.stringify({
        model: call.model,
        messages,
        max_tokens: maxTokens || 120,
        temperature: 0.9
      }),
      signal: ctrl.signal
    });
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("retry-after") || "0", 10);
      modelBackoffUntil = Date.now() + Math.max(isNaN(ra) ? 0 : ra * 1000, 30000);
      throw new Error("rate-limited — resting a bit");
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 160); } catch (e) {}
      throw new Error("HTTP " + res.status + (detail ? " — " + detail : ""));
    }
    const body = await res.json();
    const msg = body && body.choices && body.choices[0] && body.choices[0].message;
    const text = msg ? String(msg.content || msg.reasoning_content || "").trim() : "";
    if (!text) throw new Error("empty reply");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* Model replies are sanitized by app/reply-sanitize.js: planning leaks,
 * cross-talk, and full prompt echoes become a soft misfire instead of
 * reaching the keeper. */

/* ---------- the engine loop ---------- */
let tickTimer = null;
let ticking = false;

/**
 * Resolve every moment the engine offered this tick, with no model involved.
 * This is what makes the world work with no API key — and it is also the exact
 * path a model-backed world falls back to whenever a call is slow or fails.
 */
function settleMoments(moments) {
  for (const moment of moments) {
    if (!world.pending.some(m => m.id === moment.id)) continue;
    resolveMoment(world, moment.id, {});
  }
}

/** Run the world forward n ticks offline, engine narrating everything. */
function advanceOffline(n) {
  for (let i = 0; i < n; i++) {
    const report = step(world);
    settleMoments(report.moments);
  }
}

async function tick(manual) {
  if (serviceMode) {
    if (manual) toast("The world is running in the background, on its own clock.");
    return;
  }
  // A replay is a deliberate look back; a live tick underneath it would move the
  // world out from under the film.
  if (replay) {
    if (manual) toast("Catching you up first — tap the card to skip to live.");
    return;
  }
  if (ticking) return;
  ticking = true;
  try {
    // Sleeping is a state, not a pause button. The engine still advances the
    // clock and restores energy, so a collapsed world can wake itself without
    // the keeper opening a dossier or pressing a button.
    const report = step(world);
    save();
    renderAll();
    if (!hasKey()) {
      // No model: the engine answers its own biggest beats, immediately.
      settleMoments(report.moments);
      save();
      renderAll();
      return;
    }
    // Spend the model budget on the engine's moments, one at a time. The world
    // never waits: unanswered moments are decided by the engine itself.
    for (const moment of report.moments) {
      resolveMomentWithModel(moment, manual);
    }
  } finally {
    ticking = false;
  }
  // The conversations this tick are the ones worth rewriting, and the ones a
  // viewer is about to read. One call at most, and only if the keeper asked.
  void retellNewestScene();
}

async function resolveMomentWithModel(moment, manual) {
  const { messages, maxTokens } = buildPrompt(world, moment);
  if (!messages.length) return;
  try {
    const raw = await modelChat(messages, maxTokens);
    const answer = parseReply(raw, moment);
    const res = resolveMoment(world, moment.id, answer);
    if (res.ok) {
      save();
      renderAll();
    }
    // else: the engine already decided this beat (expiry) — nothing to do.
  } catch (err) {
    // Leave the moment pending; expireMoments in a later step decides it.
    if (manual && String(err && err.message) !== "rate-limited — resting a bit") {
      toast("A mind's moment went unanswered — the world decided it alone.");
    }
  }
}

/* Tap-to-think: a one-off reflection from the engine agent's live state. */
async function fetchThought(a) {
  const sys = "You are " + agentName(a) + ", " + a.personality +
    ".\nLive state: " + stateLine(a, tickNow()) +
    ".\n\nReply with ONLY your current private thought: one short sentence, first person. No preamble, no planning, no quotes.";
  const raw = await modelChat([
    { role: "system", content: sys },
    { role: "user", content: "Your private thought?" }
  ], 80);
  const clean = cleanReply(raw, a, livingAgents(world));
  if (!clean) throw new Error("misfire");
  a.thought = clean;
  a.thoughtAt = Date.now();
  save();
  return clean;
}

async function mindReplies(a, history, roleId) {
  const role = roleById(roleId);
  const sys = "You are " + agentName(a) + ", " + a.personality +
    " — one mind in a shared living world, chatting one-on-one with the world's keeper (Jeremy). " +
    role.voice + " " +
    "Live state: " + stateLine(a, tickNow()) +
    ".\nWhere you are: " + regionName(world, a.regionId) + ". What you are working on: " + a.goal.text +
    ".\nStay in character, be vivid but concise (a few sentences max). Never mention you are AI. Never narrate your reasoning or describe what you are about to say — output only the reply itself.";
  const msgs = [{ role: "system", content: sys }]
    .concat(history.slice(-14).map(h => ({ role: h.role, content: h.content })));
  let clean = cleanReply(await modelChat(msgs, 220), a, livingAgents(world));
  if (!clean) {
    // One retry with a firmer nudge before giving up on this reply.
    const retry = msgs.concat([{ role: "user", content: "Reply now, in character — no planning, no preamble, only the reply itself." }]);
    clean = cleanReply(await modelChat(retry, 220), a, livingAgents(world));
  }
  if (!clean) throw new Error("misfire");
  return clean;
}

/** @param {number} [secs] the pace to arm at — the director's, or the keeper's */
function armTick(secs) {
  if (tickTimer) clearInterval(tickTimer);
  const rate = Math.max(15, secs || parseInt(settings.tickSeconds, 10) || 45);
  armedSecs = rate;
  tickTimer = setInterval(() => { tick(false); }, rate * 1000);
}

/* ---------- rendering ---------- */
/* Rarity tones for the feed, by engine event kind. */
const KIND_TONE = {
  triumph: "gold", level: "gold", goal: "gold",
  betrayal: "blood", conflict: "blood", death: "blood",
  feud: "blood",
  secret: "violet", confide: "violet",
  world: "ember", chronicle: "ember",
  favour: "ember", project: "gold",
  arrival: "gold", departure: "mist", mourning: "violet",
  ritual: "violet",
  // The keeper's own acts, and the world telling them it has gone quiet.
  divine: "violet",
  want: "ember",
  gossip: "mist", contact: "mist"
};
/* ---------- watching ----------
 *
 * Which lines are events and which are the simulation keeping its books, and how
 * much room each has earned, live in `./director.js` — this file renders what
 * that decides. The World screen is the one place that has to be worth watching,
 * so it shows what a person would call an event and counts what it left out;
 * nothing is deleted, and the Record's Feed is still every line.
 */
const BEAT_HOLD_MS = 9000;
/** In watch mode a beat is worth holding longer: there is nowhere else to look. */
const BEAT_HOLD_WATCH_MS = 16000;
/** Rows the World screen's feed will show before it stops. */
const FEED_ROWS = 6;
/** Ticks the timeline strip covers: one world day, the unit the world thinks in. */
const TIMELINE_TICKS = 48;
/** How much of the log the feed reads to fill those rows (before folding). */
const FEED_SCAN = 40;
/** The shortest absence worth replaying: below this, live is the same thing. */
const REPLAY_MIN_TICKS = 6;
/** Ticks one replay frame covers per second of real time. */
const REPLAY_FRAME_MS = 1400;
/** Most frames a replay will play before it settles into live. */
const REPLAY_MAX_FRAMES = 24;
/** Rows the feed holds while a replay plays: the story so far, not one tick. */
const REPLAY_FEED_ROWS = 8;

/* Stamp events "Day 3 · dusk" from the engine's own clock math. */
function eventStamp(e) {
  try {
    const mpt = (world.config && world.config.clock && world.config.clock.minutesPerTick) ||
      (world.config && world.config.minutesPerTick) || 30;
    const mins = world.clock.minutes - (world.clock.tick - e.tick) * mpt;
    const day = Math.floor(mins / 1440) + 1;
    const hour = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
    return "Day " + day + " · " + phaseOf(hour);
  } catch (err) {
    return "tick " + e.tick;
  }
}
/* A conversation, shown as the lines the two minds actually said. */
/* A mind's face: its portrait, read in its current mood. */
function portraitHtml(a) {
  return '<span class="portrait">' + portraitSvg(a, moodWord(a, tickNow())) + "</span>";
}

/* Pay the keeper for a first-time act, and save only if something was new. */
function credit(kind, key) {
  if (award(keeper, kind, key)) save();
}

/**
 * The lines of a conversation, as they are shown.
 *
 * The engine writes every scene from templates, and measured over ten days the
 * whole world speaks in about 462 distinct sentences — which is the ceiling a
 * long watch runs into. So when a keeper has a key and has left it on, a model
 * retells the notable conversations in the two minds' own voices. The engine's
 * lines are never replaced: they stay in the world, which is the record, and the
 * retelling is drawn over them and marked as what it is.
 * @param {any} e the event
 */
function sceneHtml(e) {
  const scene = e && e.scene;
  if (!scene || !scene.length) return "";
  const retold = retoldFor(e.id);
  const lines = retold ? retold.lines : scene;
  const body = lines.map(line => {
    const sp = agentById(world, line.speakerId);
    const who = sp ? sp.name : "?";
    const color = sp ? sp.color : "#9a9aa8";
    return '<div class="sline"><span class="swho" style="color:' + esc(color) + '">' + esc(who) +
      '</span> ' + esc(line.text) + "</div>";
  }).join("");
  if (!retold) return '<div class="scene">' + body + "</div>";
  return '<div class="scene retold">' + body +
    '<div class="retold-tag">✦ retold by ' + esc(retold.model || "a model") + "</div></div>";
}
function eventCard(e) {
  if (e.scene && e.scene.length) credit("scene", e.id);
  if (e.kind === "betrayal") credit("betrayal", e.id);
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const icon = a ? a.icon : "⚡";
  const color = a ? a.color : "#9a9aa8";
  const name = a ? agentName(a) : "World";
  const tone = KIND_TONE[e.kind] || "";
  const tier = beatTier(e);
  const div = document.createElement("div");
  div.className = "card event" + (tone ? " tone-" + tone : "") + " tier-" + tier;
  div.innerHTML =
    '<div class="eicon' + (a ? " tappable" : "") + '" style="color:' + esc(color) + '">' + (a ? portraitHtml(a) : esc(icon)) + "</div>" +
    '<div><div class="etext">' + esc(e.text) + "</div>" + sceneHtml(e) +
    '<div class="emeta">' + (tier === "moment" ? '<span class="beat-tag">a moment</span> ' : "") +
    '<span class="ewho">' + esc(name) + "</span> · " + esc(eventStamp(e)) + "</div></div>";
  if (a) {
    const open = () => openSheet(a.id);
    div.querySelector(".eicon").addEventListener("click", open);
    div.querySelector(".ewho").addEventListener("click", open);
  }
  return div;
}

/* ---- the world, in one panel ---- */
function renderNow() {
  const stats = worldStats(world);
  const mood = worldMood();
  const head = headline();
  const card = $("headline-card");
  const tone = head ? (KIND_TONE[head.kind] || "") : "";
  card.className = "card" + (tone ? " tone-" + tone : "");
  $("headline-eyebrow").textContent = head
    ? (head.tick >= world.clock.tick - 1 ? "Just now" : eventStamp(head))
    : "So far";
  $("headline-text").textContent = head ? "\u201C" + head.text + "\u201D" : "The world is holding its breath.";

  const factions = currentFactions(world).sort((a, b) => b.length - a.length);
  const camps = factions.length;
  const vitals = [
    '<span class="vital ' + mood.cls + '" title="' + esc(mood.line) + '"><i class="vdot"></i>' + esc(mood.word) + "</span>",
    "<span class=\"vital\">Day <b>" + stats.day + "</b></span>",
    '<span class="vital">' + esc(stats.phase) + " <b>" + stats.awakened + "</b> awake</span>",
    '<span class="vital">Secrets <b>' + (stats.secrets - stats.publicSecrets) + "</b> held, <b>" + stats.publicSecrets + "</b> out</span>",
    '<span class="vital" title="minds carrying a grudge against someone"><i class="vdot" style="background:var(--danger)"></i>Feuding <b>' +
      stats.conflicts + "</b></span>",
    camps > 0
      ? '<span class="vital">Camps <b>' + camps + "</b></span>"
      : '<span class="vital">No camps yet</span>'
  ];
  $("vitals").innerHTML = vitals.join("");
}

function renderStats() {
  const living = livingAgents(world);
  const awake = living.filter(a => a.awake).length;
  $("world-title").textContent = worldNameFor(world.seed);
  $("world-sub").textContent = "Day " + world.clock.day + " · " + world.clock.phase + " · " +
    awake + "/" + living.length + " awake";
  $("map-day").textContent = "Day " + world.clock.day;
  $("map-phase").textContent = world.clock.phase;
  const badge = $("live-badge");
  const live = awake > 0;
  badge.classList.toggle("paused", !live);
  badge.classList.toggle("remote", serviceMode);
  badge.innerHTML = '<span class="dot"></span>' +
    (!live ? "RECOVERING" : serviceMode ? "REMOTE" : hasKey() ? "LIVE" : "SELF-RUNNING");
  const call = activeCall();
  $("live-note").textContent = !live
    ? "sleeping minds recover and wake on their own"
    : serviceMode ? "kept by " + serviceHost()
    : call ? (call.model || "model") : "the engine writes it";
}
function renderProject() {
  const el = $("project-card");
  if (!el || !world.project) return;
  const project = world.project;
  const completed = project.status === "complete";
  const pct = Math.round(project.progress);
  const next = project.milestones.find(m => !m.reached);
  const builders = Object.entries(project.contributors)
    .map(([id, record]) => ({ agent: agentById(world, id), record }))
    .filter(row => row.agent && (row.record.work > 0 || row.record.help > 0 || row.record.interference > 0))
    .sort((a, b) => (b.record.work + b.record.help) - (a.record.work + a.record.help));
  const milestoneHtml = project.milestones.map(m =>
    '<span class="' + (m.reached ? "reached" : "") + '">' + (m.reached ? "✓ " : "") + esc(m.title) + "</span>"
  ).join("");
  const builderText = builders.length
    ? builders.slice(0, 6).map(({ agent, record }) => esc(agent.name) +
      (record.work ? " · " + Math.round(record.work) + " work" : "") +
      (record.help ? " · " + Math.round(record.help) + " help" : "") +
      (record.interference ? " · " + record.interference + " interference" : "")
    ).join(" · ")
    : "No builders yet. The work begins at the North Wall.";
  const status = completed ? "Reinforced" : "In progress";
  const detail = completed
    ? "Completed on Day " + dayOfTick(project.completedTick) + " · the repaired wall is a lasting landmark."
    : (next ? "Next milestone: " + next.title + " · " + next.threshold + "%" : "The wall is nearly whole.");
  el.innerHTML =
    '<div class="project-head"><span class="project-title">' + esc(project.title) +
    '</span><span class="project-state">' + status + " · " + pct + "%</span></div>" +
    '<div class="project-progress"><span style="width:' + pct + '%"></span></div>' +
    '<div class="project-detail">' + esc(detail) + "</div>" +
    '<div class="project-milestones">' + milestoneHtml + "</div>" +
    '<div class="project-builders">' + (completed ? "Raised by " : "At work: ") + builderText + "</div>";
}
/**
 * One row of the feed for a run of ambient lines — somebody crossing a region,
 * somebody watching the world go by. About half of everything the world logs is
 * this, and it is a map rather than a story: folded into a single row with the
 * faces on it, six rows of feed hold six pieces of news instead of six walks.
 * @param {any[]} events
 */
function ambientRow(events) {
  const div = document.createElement("div");
  div.className = "card event ambient";
  const faces = [];
  const seen = new Set();
  for (const e of events) {
    if (!e.agentId || seen.has(e.agentId)) continue;
    seen.add(e.agentId);
    const a = agentById(world, e.agentId);
    if (a) faces.push('<span style="color:' + esc(a.color) + '" class="ambient-face" title="' + esc(agentName(a)) + '">' + portraitHtml(a) + "</span>");
    if (faces.length >= 4) break;
  }
  const lines = events.slice(0, 3).map(e => {
    const a = e.agentId ? agentById(world, e.agentId) : null;
    return '<div class="ambient-line"><b style="color:' + esc(a ? a.color : "#9a9aa8") + '">' +
      esc(a ? a.name : "World") + "</b> " + esc(brief(e.text, a ? a.name : "")) + "</div>";
  }).join("");
  const rest = events.length - Math.min(3, events.length);
  div.innerHTML =
    '<div class="ambient-faces">' + faces.join("") + "</div>" +
    '<div class="ambient-body">' + lines +
    (rest > 0 ? '<div class="ambient-line more">and ' + rest + " more like it</div>" : "") + "</div>";
  return div;
}

/** An engine line without the name we are about to draw next to it. */
function brief(text, name) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  if (name && s.startsWith(name + " ")) s = s.slice(name.length + 1);
  return s.length > 90 ? s.slice(0, 87).trimEnd() + "…" : s;
}

/**
 * The World screen's feed: the last few things a person would call events, with
 * the bookkeeping counted rather than printed and the ambient run folded into
 * one row. The count is real — it is the number of bookkeeping lines the world
 * wrote since the oldest line shown, so it can never claim more quiet than
 * actually happened.
 */
function renderFeed() {
  // During a replay the feed is the film: it accumulates the ticks the keeper
  // missed, and a live re-render (a poll, a tick) must not wipe the story
  // halfway through it. When the film ends, renderAll draws the live feed again.
  if (replay) return;
  const feed = $("activity-feed");
  feed.innerHTML = "";
  if (!world.events.length) {
    feed.innerHTML = '<p class="note" style="text-align:center">The world is quiet. Give it a tick.</p>';
    return;
  }
  const candidates = [];
  let legacy = false;
  for (const e of world.events) {
    if (isBookkeeping(e)) { legacy = true; continue; }
    if (candidates.length >= FEED_SCAN) break;
    candidates.push(e);
  }
  if (!candidates.length) {
    // A tick of nothing but bookkeeping is still a tick: say so plainly rather
    // than showing an empty screen.
    feed.innerHTML = '<p class="note" style="text-align:center">Nothing worth telling happened. ' +
      "The world is getting on with itself.</p>";
    return;
  }
  const rows = foldAmbient(candidates).slice(0, FEED_ROWS);
  for (const row of rows) {
    if (row.kind === "ambient") feed.appendChild(ambientRow(row.events));
    else feed.appendChild(eventCard(row.event));
  }
  // How much quieter the world was than this reads, since the oldest line here.
  const lastRow = rows[rows.length - 1];
  const oldest = lastRow.kind === "ambient" ? lastRow.events[lastRow.events.length - 1] : lastRow.event;
  const quiet = world.events.filter(e => e.tick >= oldest.tick && isBookkeeping(e)).length;
  if (!quiet && !legacy) return;
  const p = document.createElement("p");
  p.className = "feed-quiet";
  p.textContent = quiet
    ? quiet + " quieter change" + (quiet === 1 ? "" : "s") + " since then — the record has every line."
    : "The record has every line, including the ones nobody would say out loud.";
  feed.appendChild(p);
}

/**
 * One tick of the timeline: the best thing it had in it, or nothing.
 * @param {number} long how many ticks the strip covers
 */
function timelineBuckets(long) {
  const now = world.clock.tick;
  const from = Math.max(0, now - long + 1);
  /** @type {Map<number, any>} */
  const byTick = new Map();
  for (const e of world.events) {
    if (e.tick < from) break; // newest first
    if (isBookkeeping(e)) continue;
    const prev = byTick.get(e.tick);
    if (!prev || (e.significance || 0) > (prev.significance || 0)) byTick.set(e.tick, e);
  }
  const out = [];
  for (let t = from; t <= now; t++) out.push({ tick: t, best: byTick.get(t) || null });
  return out;
}

/**
 * The last world day, one tick at a time. A band of gold and blood is a busy
 * stretch of world; long flat runs are the quiet parts. Tapping a tick plays
 * forward from there, which is the same machinery as the arrival replay.
 */
function renderTimeline() {
  const el = $("timeline");
  if (!el) return;
  const buckets = timelineBuckets(TIMELINE_TICKS);
  const playingFrom = replay ? replay.from : null;
  // A film can start before the window this strip covers — an absence is often
  // longer than a day. Then the leftmost tick is where it starts, for the strip's
  // purposes: everything the keeper can see on it is part of the replay.
  const earliest = buckets.length ? buckets[0].tick : null;
  const playingMark = playingFrom === null ? null
    : (playingFrom < /** @type {number} */ (earliest) ? earliest : playingFrom);
  el.innerHTML = buckets.map(b => {
    const tier = b.best ? beatTier(b.best) : "quiet";
    const label = b.best
      ? "Day " + dayOfTick(b.tick) + ": " + brief(b.best.text, "")
      : "Day " + dayOfTick(b.tick) + ": nothing worth telling";
    return '<span class="tl-seg ' + (tier === "texture" ? "quiet" : tier) +
      (b.tick === world.clock.tick ? " now" : "") +
      (playingMark !== null && b.tick === playingMark ? " playing" : "") +
      '" data-tick="' + b.tick + '" title="' + esc(label) + '"></span>';
  }).join("");
}

/** Watch the world from a tick on the timeline. */
function replayFromTick(tick) {
  const from = Number(tick);
  if (!Number.isFinite(from) || from >= world.clock.tick) { toast("That is where the world is now — nothing to catch up on."); return; }
  const film = replayFrames(world, { fromTick: from, ticks: world.clock.tick - from, maxFrames: REPLAY_MAX_FRAMES });
  if (!film.frames.length) { toast("Nothing worth watching happened between then and now."); return; }
  startReplay(film);
}

/** What the world has done since dawn, in one sentence, for a keeper in a hurry. */
function renderToday() {
  const el = $("today-line");
  if (!el) return;
  const today = todaySoFar(world);
  el.textContent = today.line;
  el.className = today.total ? "today-line" : "today-line quiet";
}

/**
 * The arrival: one line taking over the top of the World screen when something
 * actually happened.
 *
 * A tick lands every 45 seconds and mostly changes numbers nobody can see. When
 * one of them is a real beat — a wall standing, a betrayal, a death, a law
 * written, the keeper's own hand — the screen should say so before the viewer
 * has to go looking for it. This is the whole difference between a log and a
 * broadcast, and it costs one card.
 */
let presentedSeq = 0;
let beatHeldUntil = 0;
let beatHeldSig = 0;
let beatTimer = 0;

function hideBeat() {
  const el = $("beat-banner");
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("beat-in");
  beatHeldUntil = 0;
  beatHeldSig = 0;
}

/**
 * Was the last thing shown better than this? Then do not interrupt it — unless
 * this is a replay frame, which is a deliberate step through what happened and
 * must be allowed to go backwards.
 * @param {any} e
 * @param {{hold?: number, replay?: boolean, progress?: string}} [opts]
 */
function showBeat(e, opts = {}) {
  const el = $("beat-banner");
  if (!el) return;
  const sig = e.significance || 0;
  if (!opts.replay && Date.now() < beatHeldUntil && sig < beatHeldSig) return;
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const tone = KIND_TONE[e.kind] || "";
  const fresh = !opts.replay && e.tick >= world.clock.tick - 1;
  // A beat is worth holding longer when there is nowhere else to look.
  const hold = opts.hold ?? (settings.watching ? BEAT_HOLD_WATCH_MS : BEAT_HOLD_MS);
  el.className = "card beat tier-" + beatTier(e) + (tone ? " tone-" + tone : "") + (opts.replay ? " replaying" : "");
  el.innerHTML =
    '<p class="eyebrow">' + esc(fresh ? "Just now" : eventStamp(e)) + "</p>" +
    '<p class="beat-text">' + esc(e.text) + "</p>" +
    sceneHtml(e) +
    (a ? '<p class="beat-who">' + esc(agentName(a)) + "</p>" : "") +
    (opts.progress ? '<p class="beat-progress">▶ replaying · ' + esc(opts.progress) + " · tap to catch up</p>" : "");
  // Restart the entrance animation even when the card was already up.
  el.classList.remove("beat-in");
  void el.offsetWidth;
  el.classList.add("beat-in");
  beatHeldUntil = Date.now() + hold;
  beatHeldSig = sig;
  if (beatTimer) clearTimeout(beatTimer);
  beatTimer = setTimeout(hideBeat, hold);
}

/**
 * Look for anything worth interrupting for since the last render and announce
 * the best of it.
 *
 * The watermark is a sequence number, not the world object, because a world
 * that is kept elsewhere comes back off the wire as a new object on every poll
 * and would look like a different world every ten seconds. The sequence counter
 * travels inside the save, so it survives that. Nothing is announced for the
 * first look at a world, or for a world that is younger than the one already on
 * screen (a reset, a restore, a fresh local world) — those arrive with their own
 * explanations, and the record has the rest.
 */
function presentBeats() {
  if (!world) return;
  if (replay) {
    // A film is playing: the live world can wait. Nothing interrupts a replay,
    // and beats that land while it runs are not queued up to ambush the keeper
    // when it ends either — the watermark moves past them.
    presentedSeq = world.seq;
    return;
  }
  if (!presentedSeq || world.seq <= presentedSeq) {
    presentedSeq = world.seq;
    return;
  }
  if (!world.events.length) return;
  const fresh = [];
  for (const e of world.events) {
    if (e.seq <= presentedSeq) break;
    fresh.push(e);
  }
  if (!fresh.length) return;
  presentedSeq = world.seq;
  const best = fresh
    .filter(e => !isBookkeeping(e))
    .sort((a, b) => (b.significance || 0) - (a.significance || 0))[0];
  if (!best || (best.significance || 0) < BEAT_FLOOR) return;
  showBeat(best);
  // A phone in a pocket cannot see the card. Only a real moment makes a sound
  // when the keeper has asked for sound; a beat is a vibration, not a chime.
  sting(beatTier(best) === "moment" ? "moment" : "beat", { settings });
}

/* ---------- the director ----------
 *
 * The world runs at one tempo, and the interesting parts do not arrive evenly:
 * measured over ten world days, 39.5% of ticks produce something worth
 * announcing, and those ticks cluster. So the app runs the clock to match — fast
 * while a feud is live, slow once it settles — and says in the header which of
 * those it thinks it is looking at. `./director.js` decides; this section
 * executes the decision and draws the board.
 */
let director = { level: "quiet", pace: paceFor("quiet"), because: "", reasons: [], cards: [] };
/** The interval the tick timer is currently armed at, so a no-op render never re-arms it. */
let armedSecs = 0;

const PULSE_RANK = { quiet: 0, settling: 1, live: 2, hot: 3 };

/** The pace the clock should run at right now, director or keeper, whichever has it. */
function currentTickSeconds() {
  if (settings.director && !serviceMode) return director.pace.secs;
  return Math.max(15, parseInt(settings.tickSeconds, 10) || 45);
}
/** Re-arm the tick timer only when the pace actually changed. */
function syncTickPace() {
  const secs = currentTickSeconds();
  if (tickTimer && armedSecs === secs) return;
  armedSecs = secs;
  armTick(secs);
}

/**
 * Read the world, set the pace, write the header line and draw the board.
 * Called from `renderAll`, so it costs one pass over the event log per render.
 */
function renderDirector() {
  const pulse = worldPulse(world);
  const directed = !!settings.director && !serviceMode;
  const secs = directed ? paceFor(pulse.level).secs : Math.max(15, parseInt(settings.tickSeconds, 10) || 45);
  const pace = directed ? paceFor(pulse.level) : { secs, label: "", note: "" };
  const wasLevel = director.level;
  director = { ...director, ...pulse, level: pulse.level, pace, because: pulse.because };

  const note = $("director-note");
  if (note) {
    note.textContent = directorNote(pulse, pace, { directed });
    note.className = "director-note lvl-" + pulse.level;
  }
  renderStorylines(pulse);
  syncTickPace();
  // The world going quiet is worth hearing once — the same way a chime for a
  // moment is — but only when the keeper has asked to hear the world at all, and
  // never on top of a replay.
  if (!replay && PULSE_RANK[wasLevel] >= PULSE_RANK.live && PULSE_RANK[pulse.level] <= PULSE_RANK.settling) {
    sting("settle", { settings });
  }
  return pulse;
}

/* ---------- storylines ----------
 * Three cards answering the question the World screen never did: what story is
 * running, and who should I be watching? Every card is a reading of state the
 * engine already keeps, with a way to follow the thread it points at.
 */
function renderStorylines(pulse) {
  const el = $("storylines");
  if (!el) return;
  const cards = storylineBoard(world, { pulse, limit: 3 });
  director.cards = cards;
  if (!cards.length) { el.innerHTML = ""; return; }
  el.innerHTML = cards.map(card =>
    '<div class="card storyline tone-' + esc(card.tone) + '" data-story="' + esc(card.id) + '">' +
      '<p class="eyebrow">' + esc(card.eyebrow) + "</p>" +
      '<p class="story-title">' + esc(card.title) + "</p>" +
      '<p class="story-line">' + esc(card.line) + "</p>" +
      '<p class="story-meta">' + esc(card.meta) + "</p>" +
      (card.action ? '<button class="story-act" data-story-act="' + esc(card.id) + '">' + esc(card.action.label) + "</button>" : "") +
    "</div>").join("");
}

/** Follow a storyline: the thread it points at, or the screen that answers it. */
function openStoryline(id) {
  const card = (director.cards || []).find(c => c.id === id);
  if (!card || !card.action) return;
  if (card.action.thread) followThread(card.action.thread.kind, card.action.thread.id);
  else if (card.action.view) { ui.record = card.action.view; save(); switchTab("record"); }
}

/* ---------- watch mode ----------
 * Everything on the World screen is a control sized for thumbs. Watch mode is
 * the other thing this app can be: the map, the beats, and nothing to press —
 * what you would cast to a screen or leave on a desk. It changes nothing about
 * the world; it changes how much of the screen the world gets.
 */
function setWatching(on, { quiet = false } = {}) {
  settings.watching = !!on;
  document.body.classList.toggle("watching", !!on);
  const btn = $("btn-watch");
  if (btn) {
    btn.classList.toggle("on", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "▣ Watching" : "▣ Watch";
  }
  if (on && !$("screen-world").classList.contains("active")) switchTab("world");
  save();
  if (!quiet) toast(on ? "Watch mode — the map, the beats, and nothing to press." : "Back to the controls.");
}

/* ---------- the replay ----------
 * The world does not stop when nobody is looking, and coming back to it should
 * pay the viewer for the wait. A replay is not a re-enactment: the world is
 * deterministic, so the last stretch of real ticks is read back in order, beats
 * kept and walking dropped, one frame at a time.
 */
let replay = null;

/**
 * @param {{frames: any[], from: number, to: number, quiet: number}} film
 */
function startReplay(film) {
  if (!film || !film.frames || !film.frames.length) return false;
  stopReplay();
  stopTicks();
  // The seed rides along so a film can tell whether it is about the world on
  // screen: restoring a backup or pointing the app at another host is not a
  // reason to keep playing the old world's story.
  replay = { ...film, seed: world.seed, i: 0, timer: 0 };
  replayFrame();
  // The timeline says where a film starts as well as where the world is, so it
  // is redrawn the moment one does.
  renderTimeline();
  return true;
}

function stopTicks() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  armedSecs = 0;
}

function replayFrame() {
  if (!replay) return;
  const frame = replay.frames[replay.i];
  if (!frame) { finishReplay(); return; }
  const best = frame.events[0];
  if (best) showBeat(best, {
    hold: REPLAY_FRAME_MS + 500,
    replay: true,
    progress: (replay.i + 1) + "/" + replay.frames.length
  });
  for (const e of frame.events) rippleForEvent(e);
  // The film accumulates rather than replacing: by the end the feed reads as the
  // story of the absence, which is the whole reason for playing it.
  replay.shown = [...frame.events, ...(replay.shown || [])].slice(0, REPLAY_FEED_ROWS);
  renderReplayFeed(frame);
  replay.i += 1;
  replay.timer = setTimeout(replayFrame, REPLAY_FRAME_MS);
}

/** The feed during a replay: everything shown so far, and how far through it is. */
function renderReplayFeed(frame) {
  const feed = $("activity-feed");
  if (!feed || !frame) return;
  feed.innerHTML = "";
  const rows = (replay && replay.shown ? replay.shown : frame.events).slice(0, REPLAY_FEED_ROWS);
  rows.forEach(e => feed.appendChild(eventCard(e)));
  const p = document.createElement("p");
  p.className = "feed-quiet replay";
  p.textContent = "▶ replaying " + (replay.i + 1) + " of " + replay.frames.length +
    " · day " + frame.day + " · tap the card to catch up";
  feed.appendChild(p);
}

function finishReplay() {
  const film = replay;
  replay = null;
  hideBeat();
  syncTickPace();
  renderAll();
  if (film) toast("That was " + film.frames.length + " tick" + (film.frames.length === 1 ? "" : "s") +
    " of it. The world is live again.");
}

/** The keeper tapped through the film: back to now, with the world where it was. */
function skipReplay() {
  if (!replay) return;
  stopReplay();
  renderAll();
  toast("Live — the world is where it left off.");
}

/** Cut a replay short — a tap, or the world moving underneath it. */
function stopReplay() {
  if (!replay) return;
  if (replay.timer) clearTimeout(replay.timer);
  // The film may own the feed while it is playing; when it is cut short, the
  // feed goes back to being the live world.
  const ownedFeed = !!$("activity-feed")?.querySelector(".feed-quiet.replay");
  replay = null;
  hideBeat();
  syncTickPace();
  renderTimeline();
  if (ownedFeed) renderFeed();
}

/**
 * If the world ran on without this app — a keeper reopening it the next day, or a
 * hosted world that ticked a hundred times between two polls — show it rather
 * than describe it. Only for a real absence: a keeper reopening the app a tick
 * later is already looking at it.
 * @param {number|null} lastSeenTick
 */
function maybeReplayMissed(lastSeenTick) {
  // A film of a world that is no longer on screen is over, whatever the gap says.
  if (replay && replay.seed !== world.seed) stopReplay();
  if (!Number.isFinite(/** @type {number} */ (lastSeenTick))) return false;
  const from = /** @type {number} */ (lastSeenTick);
  const gap = world.clock.tick - from;
  if (gap < REPLAY_MIN_TICKS) return false;
  // A world that ticks faster than this app polls would otherwise restart its own
  // film on every poll and never reach the end of one. A film already playing
  // stands until something bigger than it has been missed.
  if (replay && gap <= replay.to - replay.from) return false;
  return startReplay(replayFrames(world, { fromTick: from, ticks: gap, maxFrames: REPLAY_MAX_FRAMES }));
}

/* ---------- model-written scenes ----------
 *
 * The engine writes every conversation from templates — and does it well, for
 * what it is. But measured over ten world days the whole world speaks in about
 * 462 distinct sentences, and a keeper watching for a week will have read most
 * of them several times. That repetition, not the beats, is what a long watch
 * grinds against.
 *
 * So: when a key is attached and this is left on, the notable conversations are
 * offered to the model, which writes the lines again in the two minds' voices.
 * The engine's lines stay in the world untouched — the world is the record, and
 * the record is what the simulation did. What the screen shows is the retelling,
 * marked as a retelling, stored beside the world rather than in it.
 */
/** The shortest line a conversation is worth spending a call on. */
const RETELL_FLOOR = 0.4;
/** How many retellings are kept on the device. */
const RETELL_CAP = 60;
/** More than this and the reply is not a scene, it is an essay. */
const RETELL_MAX_LINES = 5;

let sceneRetelling = false;

/** @param {string} eventId */
function retoldFor(eventId) {
  return (eventId && retold[eventId]) || null;
}

/** What the world knows about a speaker, for the model to write them with. */
function speakerBrief(a) {
  if (!a) return "someone";
  return [
    a.name + (a.epithet ? " " + a.epithet : ""),
    a.class || "",
    a.personality || "",
    "currently " + moodWord(a, tickNow()),
    a.goal && a.goal.text ? "working toward " + a.goal.text : ""
  ].filter(Boolean).join("; ");
}

/**
 * Ask the model to write a conversation the engine has already had.
 *
 * The engine's version is given as the skeleton — what was said, in what order,
 * and what the world recorded — so the retelling cannot invent a different
 * event; it can only say it in their voices. Anything that does not come back as
 * lines attributed to the two speakers is thrown away, and a failed call is
 * silence, not an error: the world already has the scene.
 * @param {any} e
 * @returns {Promise<boolean>} whether anything was kept
 */
async function retellScene(e) {
  const call = activeCall();
  if (!call) return false;
  const speakers = [];
  for (const line of e.scene) {
    const a = agentById(world, line.speakerId);
    if (a && !speakers.some(s => s.id === a.id)) speakers.push(a);
  }
  if (speakers.length < 2) return false;
  const names = speakers.map(a => a.name).join(" and ");
  const system =
    "You write dialogue for two people in a small living world. You are given what happened " +
    "between them and the lines already written; write it again in their voices, better.\n" +
    speakers.map(a => speakerBrief(a)).join("\n") +
    "\n\nRules: reply with ONLY lines, one per line, each starting with the speaker's first name, " +
    "a colon, and then what they say. Same number of lines as given, no more than " + RETELL_MAX_LINES +
    ". No stage directions, no narration, no quotes, no preamble. Each line under 20 words, in the " +
    "voice of the person saying it, and do not invent anything that did not happen between them.";
  const user =
    "What happened: " + e.text + "\n" +
    "The lines already written:\n" +
    e.scene.map(line => (agentById(world, line.speakerId) || { name: "?" }).name + ": " + line.text).join("\n") +
    "\n\nWrite " + names + " again.";
  let raw = "";
  try {
    raw = await modelChat([
      { role: "system", content: system },
      { role: "user", content: user }
    ], 220);
  } catch (err) {
    return false; // no key, no answer, rate-limited: the engine's lines stand
  }
  const lines = parseSceneLines(raw, speakers);
  if (lines.length < 2) return false;
  retold[e.id] = {
    lines,
    model: call.model || call.provider.label,
    tick: world.clock.tick,
    at: Date.now()
  };
  // Keep the save small: the oldest retellings fall off, and the engine's lines
  // are always still there underneath.
  const ids = Object.keys(retold);
  if (ids.length > RETELL_CAP) {
    for (const id of ids.slice(0, ids.length - RETELL_CAP)) delete retold[id];
  }
  save();
  renderAll();
  return true;
}

/**
 * Read lines back out of a model's reply. Only lines attributed to one of the
 * people in the scene count, and a reply that does not give at least two is
 * discarded whole — a half-retold conversation would be worse than none.
 * @param {string} raw
 * @param {any[]} speakers
 */
function parseSceneLines(raw, speakers) {
  const byName = new Map();
  for (const a of speakers) {
    byName.set(a.name.toLowerCase(), a.id);
    byName.set(a.name.split(" ")[0].toLowerCase(), a.id);
  }
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = stripScaffolding(line).trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([^:]{1,24}):\s*(.+)$/);
    if (!match) continue;
    const id = byName.get(match[1].trim().toLowerCase());
    if (!id) continue;
    const text = cleanReply(match[2].trim(), agentById(world, id), livingAgents(world));
    if (!text) continue;
    out.push({ speakerId: id, text: text.slice(0, 200) });
    if (out.length >= RETELL_MAX_LINES) break;
  }
  return out;
}

/**
 * Offer the freshest conversation the world has had to the model, once a tick at
 * most. The engine's own judgment is the fallback and the default; this is the
 * one place the app spends a call on something other than a moment, and it is
 * the keeper's switch to make.
 */
async function retellNewestScene() {
  if (sceneRetelling || replay || !settings.retell || !hasKey()) return false;
  const newest = world.events.find(e =>
    e.scene && e.scene.length && !e.authored && (e.significance || 0) >= RETELL_FLOOR
    && e.tick >= world.clock.tick - 2 && !retold[e.id]);
  if (!newest) return false;
  sceneRetelling = true;
  try {
    return await retellScene(newest);
  } finally {
    sceneRetelling = false;
  }
}

/* ---- the record: feed, chronicle, secrets ---- */
/* ---- the keeper: rank, progress and achievements ---- */
function keeperSummary() {
  return summarize(keeper, livingAgents(world).length);
}
function renderKeeperStrip() {
  const el = $("keeper-strip");
  if (!el) return;
  const k = keeperSummary();
  const pct = Math.round(k.progress * 100);
  el.innerHTML =
    '<div class="ks-top"><span class="ks-rank">' + esc(k.rank) + '</span>' +
    '<span class="ks-xp">' + k.xp + " XP · " + k.unlocked + "/" + k.achievements.length + " achievements</span></div>" +
    '<div class="ks-bar"><span style="width:' + pct + '%"></span></div>' +
    '<div class="ks-next">' + (k.next
      ? esc(k.next.remaining + " XP to " + k.next.title) + " · tap for the record"
      : "The highest rank. Tap for the record.") + "</div>";
}
/**
 * One meter of the keeper's want, as a bar, a number and the act that last
 * moved it. Shared by the world screen and the keeper record so the two can
 * never tell different stories about the same number.
 * @param {{key: string, value: number, word: string, delta: number, cause: string|null, by: string|null, tick: number, drift: number}} meter
 */
function wantMeterHtml(meter) {
  const label = WANT_LABELS[meter.key];
  const pct = Math.max(0, Math.min(100, meter.value));
  const moved = Math.abs(meter.delta) >= 0.5;
  const badge = moved
    ? '<span class="wm-delta ' + (meter.delta > 0 ? "up" : "down") + '">' +
      (meter.delta > 0 ? "+" : "\u2212") + Math.abs(Math.round(meter.delta * 10) / 10) + "</span>"
    : "";
  const because = meter.cause
    ? esc(meter.cause) + (meter.tick >= 0 ? " \u00b7 Day " + dayOfTick(meter.tick) : "")
    : "nothing you have done has moved it yet";
  const trend = meter.drift <= -0.5 ? "sinking" : meter.drift >= 0.5 ? "rising" : meter.word;
  return '<div class="want-meter" data-meter="' + esc(meter.key) + '">' +
    '<div class="wm-top"><span class="wm-name">' + esc(label.name) + "</span>" + badge +
    '<b class="wm-value">' + Math.round(meter.value) + "</b></div>" +
    '<div class="wm-bar"><span style="width:' + pct.toFixed(1) + "%;background:" + esc(label.color) + '"></span></div>' +
    '<div class="wm-note">' + esc(trend) + " \u00b7 " + because + "</div>" +
    "</div>";
}

/**
 * The keeper's own standing, on the world screen. Harmony, prosperity and
 * legacy, impossible to miss, each with the act that last moved it — plus the
 * one warning that matters: a world that has stopped asking for anything.
 */
function renderWant() {
  const el = $("want-card");
  if (!el) return;
  const summary = wantSummary(world);
  const verdict = wantVerdict(world.want, world.config.want);
  const quietDays = Math.floor(summary.quiet.since / 48);
  let note = "";
  if (summary.fallen) {
    note = '<p class="want-quiet fallen">The world has gone quiet. Nothing asks you for anything any more \u2014 ' +
      "it will take an ask to bring it back.</p>";
  } else if (summary.quiet.draining) {
    note = '<p class="want-quiet">Nobody has asked you for anything in ' + quietDays + " day" +
      (quietDays === 1 ? "" : "s") + " \u2014 harmony is draining. A petition, a whisper or a dilemma would stop it.</p>";
  }
  el.innerHTML =
    '<div class="want-head"><p class="eyebrow">What you are keeping</p>' +
    '<span class="want-verdict ' + esc(verdict.tone) + '">' + esc(verdict.line) + "</span></div>" +
    '<div class="want-meters">' + summary.meters.map(wantMeterHtml).join("") + "</div>" +
    note +
    '<p class="want-foot">' + summary.asks + " ask" + (summary.asks === 1 ? "" : "s") + " heard" +
    (summary.ignored ? " \u00b7 " + summary.ignored + " let go unanswered" : "") +
    " \u00b7 tap for the ledger</p>";
}

/**
 * The keeper's want, with its ledger: every movement of every meter and the
 * cause that moved it, newest first. This is the panel that answers "why is
 * harmony falling" without a guess.
 */
function wantPanelHtml() {
  const summary = wantSummary(world);
  const verdict = wantVerdict(world.want, world.config.want);
  const ledger = wantLog(world.want, 7).map(entry => {
    const bits = Object.entries(entry.deltas).map(([meter, delta]) =>
      (delta > 0 ? "+" : "\u2212") + Math.abs(Math.round(delta * 10) / 10) + " " + esc(meter));
    return '<li class="wl-row"><span class="wl-day">Day ' + dayOfTick(entry.tick) + "</span>" +
      '<span class="wl-bits ' + (entry.by === "drift" ? "drift" : "act") + '">' + bits.join(", ") + "</span>" +
      '<span class="wl-cause">' + (entry.by === "drift" ? "the world's own condition" : esc(entry.cause)) + "</span></li>";
  }).join("");
  const lines = summary.meters.map(wantMeterHtml).join("");
  return '<div class="card want-panel">' +
    '<p class="eyebrow">The keeper\u2019s want</p>' +
    '<p class="want-verdict ' + esc(verdict.tone) + '">' + esc(verdict.line) + "</p>" +
    '<div class="want-meters">' + lines + "</div>" +
    (summary.quiet.draining
      ? '<p class="want-quiet' + (summary.fallen ? " fallen" : "") + '">' +
        (summary.fallen
          ? "The world is quiet. It has been " + summary.quiet.since + " ticks since anything asked you for anything."
          : "Quiet for " + summary.quiet.since + " ticks. Harmony is draining a little every tick until the world asks again.") +
        "</p>"
      : "") +
    '<h4 class="kp-h">What has moved them</h4>' +
    (ledger ? '<ul class="want-ledger">' + ledger + "</ul>" : '<p class="note">Nothing has moved yet. Act, and the ledger fills.</p>') +
    '<p class="note">' + summary.asks + " asks heard \u00b7 " + summary.ignored + " let go \u00b7 " +
    "every meter is read off the world itself, so the numbers cannot disagree with what actually happened.</p>" +
    "</div>";
}

/* ---------- the keeper's hand ----------
 * Gods don't chat. What the keeper has instead of a voice is three things the
 * world experiences and none of them is a sentence: a blessing, an omen, an
 * apparition. All three are priced in influence, all three are aimed at
 * something the world already has, and all three move the keeper's own meters —
 * so the panel below says the price, the target and the reason it cannot be
 * done, and nothing is ever hidden behind an unavailable button. */

/** Where a point on the board sits, in regions: the omen's aim. */
function regionAtPoint(x, y) {
  if (!mapFx.w || !mapFx.h) return null;
  const px = (x / mapFx.w) * 100;
  const py = (y / mapFx.h) * 100;
  let best = null, bestD = Infinity;
  for (const r of REGIONS) {
    const d = Math.hypot(r.x - px, (r.y - py) * 0.8);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * What the keeper is aiming at, from whatever is on screen: a mind they have
 * open, the work on the wall, the region where the worst quarrel is burning.
 */
function divineTargetFor(kind) {
  const selected = ui.selectedId ? agentById(world, ui.selectedId) : null;
  if (kind === "blessing") {
    return selected && !selected.retired ? { agentId: selected.id } : { work: true };
  }
  if (kind === "omen") {
    if (selected) return { regionId: selected.regionId };
    // With nothing selected, the board still knows where the trouble is.
    const hottest = feudArcs(world)[0];
    const holder = hottest ? agentById(world, hottest.a) : null;
    return holder ? { regionId: holder.regionId } : (world.project ? { regionId: world.project.regionId } : null);
  }
  const open = (world.charter?.dilemmas || []).find(d => d.status === "open");
  return open ? { dilemmaId: open.id } : null;
}

/** A target in the keeper's own words, for the panel and the toast. */
function targetLabel(target) {
  if (!target) return "";
  if (target.work) return "the work on the wall";
  if (target.dilemmaId) {
    const dilemma = (world.charter?.dilemmas || []).find(d => d.id === target.dilemmaId);
    const names = (dilemma?.partyIds || []).map(id => agentById(world, id)?.name).filter(Boolean);
    return names.length ? names.join(" and ") : "the dilemma";
  }
  if (target.agentId) return agentById(world, target.agentId)?.name || "a mind";
  if (target.regionId) return regionName(world, target.regionId);
  return "";
}

/**
 * Spend the influence, and let the world say no in a sentence if it must.
 * @param {"omen"|"blessing"|"apparition"} kind
 * @param {{regionId?: string|null, agentId?: string|null, dilemmaId?: string|null, work?: boolean}|null} target
 */
function tryIntervene(kind, target) {
  const result = performIntervention(world, kind, target);
  if (!result.ok || !result.intervention) {
    toast(result.reason || "You cannot do that.");
    return false;
  }
  toast("Your " + esc(INTERVENTION_INFO[kind].name.toLowerCase()) + " lands over " +
    esc(targetLabel(target)) + " — " + esc(result.intervention.effect));
  save();
  renderAll();
  return true;
}

/**
 * The keeper's hand, on the World screen: three acts, their price, where each
 * is aimed right now, and the last thing the world did about it. Tapping a row
 * spends; holding the board aims.
 */
function renderHand() {
  const el = $("hand-card");
  if (!el) return;
  const options = interventionOptions(world);
  const rows = options.map(option => {
    const target = divineTargetFor(option.kind);
    const check = option.enabled && target ? canIntervene(world, option.kind, target) : null;
    const enabled = Boolean(check && check.ok);
    const because = !option.enabled
      ? option.reason
      : !target
        ? "Nothing to aim it at yet."
        : check && !check.ok
          ? check.reason
          : "Aimed at " + targetLabel(target) + ".";
    return '<button class="hand-act' + (enabled ? "" : " disabled") + '" data-act="' + esc(option.kind) + '"' +
      (enabled ? "" : " disabled") +
      ' title="' + esc(option.blurb) + '">' +
      '<span class="ha-top"><span class="ha-name" style="color:' + esc(option.color) + '">' + esc(option.name) +
      (option.live ? ' <b class="ha-live">' + option.live + " live</b>" : "") + "</span>" +
      '<span class="ha-cost">' + option.cost + " influence</span></span>" +
      '<span class="ha-why">' + esc(because) + "</span></button>";
  }).join("");
  const last = recentInterventions(world, 1)[0];
  el.innerHTML =
    '<div class="hand-head"><p class="eyebrow">Your hand</p>' +
    '<span class="hand-influence">' + Math.round(world.charter?.influence ?? 0) + " influence</span></div>" +
    '<div class="hand-acts">' + rows + "</div>" +
    '<p class="hand-foot">' + (last
      ? "Last: " + esc(last.effect)
      : "Hold the board to aim these: a mind to bless, a region for a sign, a dilemma to stand in.") + "</p>";
}

function keeperPanelHtml() {
  const k = keeperSummary();
  const pct = Math.round(k.progress * 100);
  const ranks = RANKS.map((r, i) =>
    '<li class="' + (i <= k.rankIndex ? "reached" : "") + '">' + esc(r.title) +
    ' <span class="note">' + r.xp + " XP</span></li>").join("");
  const badges = k.achievements.map(a =>
    '<div class="ach ' + (a.unlocked ? "unlocked" : "locked") + '">' +
    '<div class="ach-title">' + (a.unlocked ? "✓ " : "") + esc(a.title) + "</div>" +
    '<div class="ach-desc">' + esc(a.desc) + "</div></div>").join("");
  const t = k.tallies;
  return wantPanelHtml() + '<div class="card keeper-panel">' +
    '<p class="eyebrow">The keeper</p>' +
    '<h3 class="kp-rank">' + esc(k.rank) + "</h3>" +
    '<div class="ks-bar"><span style="width:' + pct + '%"></span></div>' +
    '<p class="note">' + k.xp + " XP" + (k.next ? " · " + k.next.remaining + " to " + esc(k.next.title) : " · the highest rank") + "</p>" +
    '<p class="note">Dossiers read ' + t.dossiers + "/" + t.minds + " · conversations " + t.chats +
    " · scenes overheard " + t.scenes + " · days kept " + t.days + "</p>" +
    '<h4 class="kp-h">Ranks</h4><ol class="kp-ranks">' + ranks + "</ol>" +
    '<h4 class="kp-h">Achievements</h4><div class="ach-grid">' + badges + "</div>" +
    '<p class="note">Every reward is paid once. Ranks come from what you have done, never from how often you have looked.</p>' +
    "</div>";
}

/**
 * The charter: what the world has decided about how it lives.
 *
 * This is the keeper-facing half of the loop. A mind petitions, the world waits
 * on a ruling, and the ruling becomes precedent — so the screen has to show the
 * open question, the fact that justifies asking, what it costs, and whether the
 * keeper has ruled on this kind of thing before. Everything here is a decision,
 * not a display.
 * @param {HTMLElement} pane
 */
function renderCharter(pane) {
  const charter = world.charter;
  if (!charter) {
    pane.innerHTML = '<p class="note">This world has no charter yet.</p>';
    return;
  }
  const pct = Math.round((charter.influence / charter.influenceMax) * 100);
  const open = charter.petitions.filter(p => p.status === "open");
  const openDilemmas = charter.dilemmas.filter(d => d.status === "open");
  const unheard = charter.whispers.filter(w => !w.actedOn);

  let html = '<div class="card charter-head">' +
    '<p class="eyebrow">The charter</p>' +
    '<h3>' + Math.round(charter.influence) + " influence</h3>" +
    '<div class="ks-bar"><span style="width:' + pct + '%"></span></div>' +
    '<p class="note">' + esc(influenceWord(charter)) + '</p>' +
    '<p class="note">Spend it from the World screen — a blessing on a mind or the wall, an omen over a ' +
    'region, an apparition at a dilemma. Hold the board to aim one.</p>' +
    '<p class="note">' + charter.rules.length + " enacted · " + charter.roles.length +
    " roles the world uses · " + charter.precedents.length + " precedents · " +
    charter.rulingsMade + " rulings made</p>" +
    "</div>";

  const signs = recentInterventions(world, 4);
  if (signs.length) {
    html += '<p class="eyebrow section-gap">Signs and blessings</p>';
    for (const sign of signs) {
      const live = world.clock.tick < sign.expireTick;
      const target = sign.target === "work" ? "the work on the wall"
        : sign.target === "dilemma" ? "a dilemma"
        : sign.agentId ? (agentById(world, sign.agentId)?.name || "a mind")
        : regionName(world, sign.regionId);
      html += '<div class="card sign-card ' + esc(sign.kind) + (live ? " live" : "") + '">' +
        "<p><strong>" + esc(INTERVENTION_INFO[sign.kind].name) + "</strong> · " + esc(target) +
        ' <span class="note">Day ' + dayOfTick(sign.tick) + " · " + sign.cost + " influence · " +
        (live ? "still holding" : "spent") + "</span></p>" +
        '<p class="note">' + esc(sign.effect) + "</p>" +
        (sign.values && sign.values.length === 3
          ? '<p class="note">' + WANT_LABELS.harmony.name + " " + Math.round(sign.values[0]) + " · " +
            WANT_LABELS.prosperity.name + " " + Math.round(sign.values[1]) + " · " +
            WANT_LABELS.legacy.name + " " + Math.round(sign.values[2]) + "</p>"
          : "") +
        "</div>";
    }
  }

  if (charter.wallRaised) {
    html += '<div class="card charter-win"><p class="eyebrow">The shared win</p>' +
      "<p>The North Wall stands. Every mind here is safer for work they did together.</p></div>";
  }

  if (openDilemmas.length) {
    for (const dilemma of openDilemmas) {
      html += '<div class="card dilemma-card"><p class="eyebrow">A dilemma, and it is yours</p>' +
        "<p>" + esc(dilemma.text) + "</p>" +
        '<div class="dilemma-choices">' +
        dilemmaChoicesHtml(dilemma).join("") +
        "</div></div>";
    }
  }

  if (unheard.length) {
    html += '<div class="card whispers-card"><p class="eyebrow">Told to you in private</p>';
    for (const whisper of unheard.slice(0, 4)) {
      const teller = agentById(world, whisper.agentId);
      const about = whisper.aboutId ? agentById(world, whisper.aboutId) : null;
      // Whispers already in the save predate the intake guard; never show a
      // mind describing its own prompt.
      const words = stripScaffolding(whisper.text);
      html += '<div class="whisper-row"><p class="whisper-text">“' + esc(words == null ? "The words wouldn't come." : words) + "”</p>" +
        '<p class="note">' + esc(teller ? teller.name : "Somebody") +
        (about ? ", about " + esc(about.name) : "") + "</p>" +
        '<button class="btn small act-whisper" data-id="' + esc(whisper.id) + '">Act on it (' +
        world.config.charter.actOnWhisperCost + ")</button></div>";
    }
    html += "</div>";
  }

  if (open.length) {
    html += '<p class="eyebrow section-gap">Awaiting your ruling</p>';
    for (const petition of open) {
      const agent = agentById(world, petition.agentId);
      const spec = /** @type {any} */ (RULE_KINDS)[petition.ruleKind] || {};
      const prior = precedentFor(charter, petition.ruleKind);
      const affordable = charter.influence >= (petition.cost || 0);
      const ask = stripScaffolding(petition.text);
      const because = petition.basis ? stripScaffolding(petition.basis) : "";
      html += '<div class="card petition-card" data-petition="' + esc(petition.id) + '">' +
        '<p class="eyebrow">' + esc(petition.kind === "law" ? "A proposed law" : "A proposed tradition") + "</p>" +
        "<p class='petition-text'>“" + esc(ask == null ? "The asking came out wrong." : ask) + "”</p>" +
        '<p class="note">' + esc(agent ? agent.name : "A mind") + " asked on Day " +
        dayOfTick(petition.tick) + "</p>" +
        (because ? '<p class="note">Because: ' + esc(because) + "</p>" : "") +
        '<p class="note">' + petition.support + " mind" + (petition.support === 1 ? "" : "s") +
        " behind it · " + esc(spec.gloss || describeRule(petition.ruleKind)) + "</p>" +
        (prior ? '<p class="note prior">You have ruled on this before — ' + esc(prior.ruling) + ".</p>" : "") +
        '<div class="petition-actions">' +
        '<button class="btn enact-petition" data-id="' + esc(petition.id) + '"' +
        (affordable ? "" : " disabled") + ">Enact (" + (petition.cost || 0) + ")</button>" +
        '<button class="btn ghost refuse-petition" data-id="' + esc(petition.id) + '">Refuse</button>' +
        "</div></div>";
    }
  } else {
    html += '<p class="note">Nobody has asked you for anything yet. Minds petition when the world ' +
      "gives them something to point at — a wall that has been damaged, a feud with no room left, " +
      "a favour nobody repaid.</p>";
  }

  if (charter.roles.length) {
    html += '<p class="eyebrow section-gap">Names the world has started using</p><div class="role-list">';
    for (const role of charter.roles) {
      const holder = agentById(world, role.holderId);
      html += '<div class="role-row"><strong>' + esc(role.name) + "</strong> — " +
        esc(holder ? holder.name : "somebody who left") +
        '<span class="note">' + esc(role.basis) + "</span></div>";
    }
    html += "</div>";
  }

  const enacted = charter.rules.filter(r => r.ruling === "enacted");
  if (enacted.length) {
    html += '<p class="eyebrow section-gap">How this world runs now</p>';
    for (const rule of enacted) {
      const agent = agentById(world, rule.proposedBy);
      html += '<div class="card rule-card"><p><strong>' + esc(describeRule(rule.ruleKind)) + "</strong>" +
        ' <span class="note">' + esc(rule.kind) + " proposed by " + esc(agent ? agent.name : "somebody") + "</span></p>" +
        '<p class="note">“' + esc(rule.text) + "”</p>" +
        (rule.rulingNote ? '<p class="note keeper-note">Your words: “' + esc(rule.rulingNote) + "”</p>" : "") +
        "</div>";
    }
  }

  pane.innerHTML = html;
}

/**
 * The keeper's choices on a dilemma, priced.
 * @param {any} dilemma
 */
function dilemmaChoicesHtml(dilemma) {
  const kinds = dilemma.kind === "feud"
    ? [
        { id: "separate", label: "Send them to different ends of the world" },
        { id: "mediate", label: "Make them sit down together" },
        { id: "condemn", label: "Condemn the worse of them publicly" },
        { id: "let_it_ride", label: "Let it run its course" }
      ]
    : [
        { id: "rally", label: "Call the world to the wall" },
        { id: "shame", label: "Name the ones who are not lifting" },
        { id: "let_it_ride", label: "Let the wall wait" }
      ];
  const base = world.config.charter.dilemmaCost;
  return kinds.map(c => {
    const cost = c.id === "mediate" ? base + 4 : (c.id === "condemn" || c.id === "shame") ? Math.round(base / 2) : 0;
    const affordable = world.charter.influence >= cost;
    return '<button class="btn small resolve-dilemma" data-id="' + esc(dilemma.id) +
      '" data-choice="' + esc(c.id) + '"' + (affordable ? "" : " disabled") + ">" +
      esc(c.label) + (cost ? " (" + cost + ")" : "") + "</button>";
  });
}

function renderRecord() {
  const pane = $("record-pane");
  pane.innerHTML = "";
  document.querySelectorAll(".rtab").forEach(t =>
    t.classList.toggle("active", t.dataset.view === ui.record));
  if (ui.record === "keeper") {
    pane.innerHTML = keeperPanelHtml();
    return;
  }
  if (ui.record === "chronicle") {
    // "While you were away" first: it is the only page in the record written
    // for the keeper's own absence, and it should be read before the days it
    // summarizes.
    if (lastDigest && !lastDigest.empty) {
      const span = lastDigest.days > 0
        ? lastDigest.days + " day" + (lastDigest.days === 1 ? "" : "s")
        : lastDigest.ticks + " tick" + (lastDigest.ticks === 1 ? "" : "s");
      const away = document.createElement("div");
      away.className = "card away-card";
      away.innerHTML =
        '<div class="dhead"><span>While you were away</span><em>' + esc(span) + "</em></div>" +
        digestLinesHtml(lastDigest) +
        '<div class="away-meters">' + lastDigest.meters.map(m =>
          '<span class="away-meter"><b style="color:' + esc(m.color) + '">' + esc(m.label) + "</b> " +
          Math.round(m.to) + ' <span class="' + (m.delta > 0 ? "up" : m.delta < 0 ? "down" : "") + '">' +
          (Math.abs(m.delta) < 0.05 ? "·" : (m.delta > 0 ? "+" : "\u2212") + Math.abs(m.delta)) + "</span></span>"
        ).join("") + "</div>" +
        (lastDigest.headline ? '<p class="note">The biggest thing: ' + esc(lastDigest.headline.text) + "</p>" : "") +
        '<div class="row">' +
        '<button class="btn ghost small digest-replay">▶ Watch it again</button>' +
        '<button class="btn ghost small digest-dismiss">I have read it</button>' +
        "</div>";
      pane.appendChild(away);
    }
    // The mourning chronicle comes first when there is one: what the world has
    // lost is the part of its history a keeper should not have to go looking
    // for. Burials, the gatherings still coming, and who took up what.
    renderMemoriam(pane);
    if (!world.chronicle.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = "No day has closed yet. The first entry is written at the end of " +
        "Day 1 — a summary of everything the world decided worth remembering.";
      pane.appendChild(empty);
      return;
    }
    world.chronicle.slice().reverse().forEach(day => {
      if (ui.record === "chronicle") credit("chronicle", day.day);
      const d = document.createElement("div");
      d.className = "card day-card";
      d.innerHTML =
        '<div class="dhead"><span>Day ' + day.day + "</span><em>" + day.notableCount + " things worth noting</em></div>" +
        '<div class="dbody">' + esc(day.summary) + "</div>" +
        '<div class="dfoot">' + (day.stats ? day.stats.events + " events · " + day.stats.secretsPublic + " secrets public" : "") + "</div>";
      pane.appendChild(d);
    });
    return;
  }
  if (ui.record === "secrets") {
    const secrets = world.secrets.slice().sort((a, b) => {
      if (a.isPublic !== b.isPublic) return a.isPublic ? -1 : 1;
      return b.originTick - a.originTick;
    });
    if (!secrets.length) {
      pane.innerHTML = '<p class="note">Nothing is being kept from anybody. That will not last.</p>';
      return;
    }
    const intro = document.createElement("p");
    intro.className = "note";
    intro.style.margin = "0 4px 8px";
    intro.textContent = "Everything the world knows and is not saying out loud. A secret spreads by " +
      "gossip and by confession, loses accuracy at every hop, and stops being a secret the moment " +
      "it goes public.";
    pane.appendChild(intro);
    for (const s of secrets) {
      const holders = Object.keys(s.holders);
      const about = s.aboutId ? agentById(world, s.aboutId) : null;
      const d = document.createElement("div");
      d.className = "card secret-card" + (s.isPublic ? " public" : "");
      const chips = holders.slice(0, 6).map(id => {
        const h = agentById(world, id);
        if (!h) return "";
        const f = s.holders[id];
        return '<span class="chip' + (s.isPublic ? " bad" : "") + '">' + esc(h.icon) + " " + esc(h.name) +
          (f < 0.85 ? " · half-remembered" : "") + "</span>";
      }).join("");
      d.innerHTML =
        '<div class="stext">' + esc(s.isPublic ? s.text : "…" + s.text) + "</div>" +
        '<div class="smeta">' + (s.isPublic ? "PUBLIC" : "HELD BY " + holders.length) +
        (about ? " · about " + esc(about.name) : "") +
        " · since day " + dayOfTick(s.originTick) + "</div>" +
        '<div class="holders">' + chips + "</div>" +
        '<button class="thread-mini follow-secret-thread" data-secret="' + esc(s.id) +
        '">Follow this thread</button>';
      pane.appendChild(d);
    }
    return;
  }
  if (ui.record === "threads") {
    renderThreads(pane);
    return;
  }
  if (ui.record === "charter") {
    renderCharter(pane);
    return;
  }
  // feed
  if (!world.events.length) {
    pane.innerHTML = '<p class="note">Nothing has happened yet.</p>';
    return;
  }
  const shown = world.events.slice(0, 400);
  shown.forEach(e => pane.appendChild(eventCard(e)));
  if (world.events.length > shown.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.style.textAlign = "center";
    p.textContent = "…and " + (world.events.length - shown.length) + " older lines in the record.";
    pane.appendChild(p);
  }
}

/**
 * The mourning chronicle: funerals still coming, and the memorials of every
 * mind the world has lost. A death is meant to be touchable in the record, so
 * this is a real page rather than a line in the feed — what they did, who
 * stood at the grave, and which of their quarrels is still walking around.
 * @param {HTMLElement} pane
 */
/** The digest's lines, shared by the away card and any other reader. */
function digestLinesHtml(digest) {
  return '<div class="away-lines">' + digest.lines
    .map(l => '<p class="away-line ' + esc(l.kind) + '">' + esc(l.text) + "</p>")
    .join("") + "</div>";
}

function renderMemoriam(pane) {
  const mourning = world.mourning;
  if (!mourning) return;
  const called = pendingFunerals(mourning);
  const memorials = recentMemorials(mourning, 12);
  if (!called.length && !memorials.length) return;

  const head = document.createElement("p");
  head.className = "eyebrow section-gap";
  head.textContent = "In memoriam";
  pane.appendChild(head);

  for (const funeral of called.slice().reverse()) {
    const card = document.createElement("div");
    card.className = "card mem-card memorial-coming";
    card.innerHTML =
      '<p class="eyebrow">A funeral called</p>' +
      '<div class="mem-name">' + esc(funeral.name) + (funeral.epithet ? " " + esc(funeral.epithet) : "") + "</div>" +
      '<p class="mem-text">The world is gathering at ' + esc(regionName(world, funeral.regionId)) +
      ". They were " + esc(funeral.className) + (funeral.level ? ", level " + funeral.level : "") + ", and they " +
      esc(funeral.deeds) + ".</p>" +
      '<p class="note">Called on Day ' + dayOfTick(funeral.calledTick) + " — the board shows the gathering until it happens.</p>";
    pane.appendChild(card);
  }

  for (const memorial of memorials) {
    const card = document.createElement("div");
    card.className = "card mem-card " + (memorial.kind === "death" ? "memorial-death" : "memorial-departure");
    const mourners = memorial.mourners
      .map(id => {
        const mind = agentById(world, id);
        if (!mind) return "";
        const live = mind.retired ? "" : " mem-mind tappable";
        return '<span class="mem-chip' + live + '"' + (mind.retired ? "" : ' data-mind="' + esc(mind.id) + '"') + ">" +
          esc(mind.icon) + " " + esc(mind.name) + "</span>";
      })
      .join("");
    const heirs = (memorial.inherited || []).map(pass => {
      const heir = agentById(world, pass.heirId);
      const about = agentById(world, pass.aboutId);
      if (!heir || !about) return "";
      return '<li class="mem-heir">' + esc(heir.name) + " carries what " + esc(memorial.name) +
        " had against " + esc(about.name) + ".</li>";
    }).join("");
    const head = memorial.kind === "death" ? "Buried" : "Gone from the map";
    card.innerHTML =
      '<p class="eyebrow">' + head + " · Day " + memorial.day + "</p>" +
      '<div class="mem-name">' + esc(memorial.name) + (memorial.epithet ? " " + esc(memorial.epithet) : "") + "</div>" +
      '<p class="mem-text">' + esc(memorial.text) + "</p>" +
      (mourners ? '<div class="mem-chips">' + mourners + "</div>" : "") +
      (heirs ? '<ul class="mem-heirs">' + heirs + "</ul>" : "");
    pane.appendChild(card);
  }
}

function threadOptions(kind) {
  const minds = livingAgents(world);
  if (kind === "mind") return minds.map(agent => ({ value: agent.id, label: agent.icon + " " + agent.name }));
  if (kind === "pair") {
    const pairs = [];
    for (let i = 0; i < minds.length; i += 1) {
      for (let j = i + 1; j < minds.length; j += 1) {
        pairs.push({ value: minds[i].id + "|" + minds[j].id, label: minds[i].name + " ↔ " + minds[j].name });
      }
    }
    return pairs;
  }
  return world.secrets.map(secret => {
    const about = secret.aboutId ? agentById(world, secret.aboutId) : null;
    return {
      value: secret.id,
      label: (secret.isPublic ? "PUBLIC · " : "HELD · ") + (about ? "about " + about.name : secret.kind) +
        " · Day " + dayOfTick(secret.originTick)
    };
  });
}

function renderThreads(pane) {
  const kind = ["mind", "pair", "secret"].includes(ui.threadKind) ? ui.threadKind : "mind";
  const options = threadOptions(kind);
  if (!options.some(option => option.value === ui.threadTarget)) {
    ui.threadTarget = options[0] ? options[0].value : "";
  }
  const kindOptions = ["mind", "pair", "secret"].map(value =>
    '<option value="' + value + '"' + (value === kind ? " selected" : "") + ">" +
    (value === "mind" ? "Mind" : value === "pair" ? "Pair" : "Secret") + "</option>").join("");
  const targetOptions = options.map(option =>
    '<option value="' + esc(option.value) + '"' + (option.value === ui.threadTarget ? " selected" : "") + ">" +
    esc(option.label) + "</option>").join("");
  pane.innerHTML = '<div class="thread-controls card">' +
    '<label>Thread type<select id="thread-kind">' + kindOptions + "</select></label>" +
    '<label>Follow<select id="thread-target">' + targetOptions + "</select></label>" +
    '<p class="note">Start with the incident, then follow what was learned, how ties shifted, and what happened next.</p>' +
    '</div><div id="thread-detail"></div>';
  $("thread-kind").addEventListener("change", ev => {
    ui.threadKind = ev.target.value;
    ui.threadTarget = null;
    save();
    renderRecord();
  });
  $("thread-target").addEventListener("change", ev => {
    ui.threadTarget = ev.target.value;
    save();
    renderRecord();
  });
  renderThreadDetail($("thread-detail"), kind, ui.threadTarget);
}

function eventsForThread(kind, target) {
  if (kind === "secret") return world.events.filter(event => event.secretId === target);
  if (kind === "mind") return world.events.filter(event => event.agentId === target || event.subjectId === target);
  const [firstId, secondId] = String(target || "").split("|");
  return world.events.filter(event => {
    const direct = (event.agentId === firstId && event.subjectId === secondId) ||
      (event.agentId === secondId && event.subjectId === firstId);
    const scene = event.scene && event.scene.some(line => line.speakerId === firstId) &&
      event.scene.some(line => line.speakerId === secondId);
    return direct || scene;
  });
}

function memoriesForThread(kind, target) {
  if (kind === "secret") {
    return world.agents.flatMap(agent => agent.memory.traces
      .filter(trace => trace.secretId === target)
      .map(trace => ({ agent, trace })));
  }
  if (kind === "mind") {
    const agent = agentById(world, target);
    return agent ? agent.memory.traces.map(trace => ({ agent, trace })) : [];
  }
  const [firstId, secondId] = String(target || "").split("|");
  return world.agents.flatMap(agent => agent.memory.traces
    .filter(trace => (agent.id === firstId && trace.subjectId === secondId) ||
      (agent.id === secondId && trace.subjectId === firstId))
    .map(trace => ({ agent, trace })));
}

function threadSection(title, body) {
  return '<section class="thread-section"><h3>' + esc(title) + "</h3>" + body + "</section>";
}

function threadEventCard(event) {
  const actor = event.agentId ? agentById(world, event.agentId) : null;
  const pairLink = event.agentId && event.subjectId
    ? '<button class="thread-mini follow-pair-thread" data-a="' + esc(event.agentId) + '" data-b="' +
      esc(event.subjectId) + '">Follow pair</button>'
    : "";
  const secretLink = event.secretId
    ? '<button class="thread-mini follow-secret-thread" data-secret="' + esc(event.secretId) + '">Follow secret</button>'
    : "";
  return '<article class="card thread-event"><div class="thread-event-kind">' + esc(event.kind) +
    '</div><p>' + esc(event.text) + '</p><div class="thread-event-meta">' +
    (actor ? esc(actor.name) + " · " : "") + "Day " + dayOfTick(event.tick) + " · tick " + event.tick +
    '</div><div class="thread-event-links">' + pairLink + secretLink + "</div></article>";
}

function cognitionThreadCard(moment) {
  return '<article class="card thread-event cognition-thread-event"><div class="thread-event-kind">' +
    (moment.engineResolved ? "ENGINE FALLBACK" : "SELF-AUTHORED PLAN") + '</div><p>' +
    esc(moment.planText || "No plan text was returned.") + '</p><div class="thread-event-meta">Day ' +
    dayOfTick(moment.tick) + " · " + esc(moment.planAction || moment.resolution || "no action") +
    (moment.planValidation ? " · " + esc(moment.planValidation) : "") + "</div></article>";
}

function relationshipSummary(agent, other) {
  const edge = agent.relations[other.id];
  if (!edge) return '<div class="thread-relation"><b>' + esc(agent.name) + " → " + esc(other.name) +
    '</b><span class="note">no recorded tie yet</span></div>';
  return '<div class="thread-relation"><b>' + esc(agent.name) + " → " + esc(other.name) +
    '</b><span>affection ' + Math.round(edge.affinity) + " · trust " + Math.round(edge.trust) +
    " · resentment " + Math.round(edge.resentment) + " · familiarity " + Math.round(edge.familiarity) + "</span></div>";
}

function secretKnowledgeRows(secret) {
  const holders = Object.entries(secret.holders).map(([id, fidelity]) => {
    const agent = agentById(world, id);
    if (!agent) return null;
    const traces = agent.memory.traces.filter(trace => trace.secretId === secret.id).sort((a, b) => a.tick - b.tick);
    const first = traces[0];
    const publicReveal = traces.find(trace => /everyone knows now/i.test(trace.text));
    const route = publicReveal ? "heard when it went public" : id === secret.originatorId ? "at the beginning" : "by retelling";
    return { agent, fidelity, tick: first ? first.tick : secret.originTick, route };
  }).filter(Boolean).sort((a, b) => a.tick - b.tick || a.agent.name.localeCompare(b.agent.name));
  if (!holders.length) return '<p class="note">No current holder is recorded.</p>';
  return '<div class="thread-knowledge-list">' + holders.map(holder =>
    '<article class="thread-knowledge"><b>' + esc(holder.agent.name) + '</b><span class="thread-event-meta">' +
    esc(holder.route) + " · Day " + dayOfTick(holder.tick) + " · " +
    (holder.fidelity >= 0.85 ? "firsthand" : holder.fidelity >= 0.6 ? "partial" : "garbled") +
    '</span><p>' + esc(secretTextFor(secret, holder.fidelity)) + "</p></article>").join("") + "</div>";
}

function renderThreadDetail(root, kind, target) {
  if (!target) {
    root.innerHTML = '<div class="card thread-empty">There are no living minds or secrets to follow yet.</div>';
    return;
  }
  const events = eventsForThread(kind, target).slice().sort((a, b) => a.seq - b.seq);
  const memories = memoriesForThread(kind, target).sort((a, b) => a.trace.tick - b.trace.tick);
  let title = "", originLabel = "Initiating incident", origin = "", knowledge = "", relations = "", plans = [];
  let agentIds = [];
  let secret = null;

  if (kind === "mind") {
    const agent = agentById(world, target);
    if (!agent) return;
    title = agent.name + "’s thread";
    agentIds = [agent.id];
    const firstEvent = events[0];
    const firstMemory = memories[0] && memories[0].trace;
    origin = firstEvent
      ? '<article class="thread-origin"><span>Earliest incident still in the record · Day ' + dayOfTick(firstEvent.tick) +
        '</span><p>' + esc(firstEvent.text) + "</p></article>"
      : firstMemory
        ? '<article class="thread-origin"><span>First surviving memory · Day ' + dayOfTick(firstMemory.tick) +
          '</span><p>' + esc(firstMemory.text) + "</p></article>"
        : '<p class="note">No incident has been recorded yet.</p>';
    const known = world.secrets.filter(item => item.holders[agent.id] !== undefined).sort((a, b) => b.originTick - a.originTick);
    knowledge = known.length
      ? '<div class="thread-knowledge-list">' + known.slice(0, 12).map(item =>
        '<article class="thread-knowledge"><p>' + esc(secretTextFor(item, item.holders[agent.id])) +
        '</p><button class="thread-mini follow-secret-thread" data-secret="' + esc(item.id) + '">Follow this secret</button></article>').join("") + "</div>"
      : '<p class="note">This mind is not carrying a recorded secret.</p>';
    const ties = Object.keys(agent.relations).map(id => agentById(world, id)).filter(other => other && !other.retired)
      .sort((a, b) => {
        const ea = agent.relations[a.id], eb = agent.relations[b.id];
        return (Math.abs(eb.affinity) + eb.trust + eb.resentment + eb.familiarity) -
          (Math.abs(ea.affinity) + ea.trust + ea.resentment + ea.familiarity);
      }).slice(0, 6);
    relations = ties.map(other => relationshipSummary(agent, other)).join("") ||
      '<p class="note">No relationship changes have been recorded.</p>';
  } else if (kind === "pair") {
    const [firstId, secondId] = String(target).split("|");
    const first = agentById(world, firstId), second = agentById(world, secondId);
    if (!first || !second) return;
    title = first.name + " and " + second.name;
    agentIds = [first.id, second.id];
    const firstEvent = events[0];
    const firstMemory = memories[0] && memories[0].trace;
    origin = firstEvent
      ? '<article class="thread-origin"><span>First shared incident still in the record · Day ' + dayOfTick(firstEvent.tick) +
        '</span><p>' + esc(firstEvent.text) + "</p></article>"
      : firstMemory
        ? '<article class="thread-origin"><span>First surviving shared memory · Day ' + dayOfTick(firstMemory.tick) +
          '</span><p>' + esc(firstMemory.text) + "</p></article>"
        : '<p class="note">No shared incident has been recorded yet.</p>';
    const shared = world.secrets.filter(item => item.holders[first.id] !== undefined || item.holders[second.id] !== undefined)
      .sort((a, b) => b.originTick - a.originTick).slice(0, 10);
    knowledge = shared.length
      ? '<div class="thread-knowledge-list">' + shared.map(item => {
        const firstKnows = item.holders[first.id] !== undefined;
        const secondKnows = item.holders[second.id] !== undefined;
        const whoKnows = [firstKnows ? first.name : "", secondKnows ? second.name : ""].filter(Boolean).join(" and ");
        const fidelity = firstKnows ? item.holders[first.id] : item.holders[second.id];
        return '<article class="thread-knowledge"><p>' + esc(whoKnows + (firstKnows && secondKnows ? " both know: " : " knows: ") + secretTextFor(item, fidelity)) +
          '</p><button class="thread-mini follow-secret-thread" data-secret="' + esc(item.id) + '">Follow this secret</button></article>';
      }).join("") + "</div>"
      : '<p class="note">Neither mind has a recorded shared secret.</p>';
    relations = relationshipSummary(first, second) + relationshipSummary(second, first);
  } else {
    secret = world.secrets.find(item => item.id === target) || null;
    if (!secret) return;
    const about = secret.aboutId ? agentById(world, secret.aboutId) : null;
    title = "Secret thread · " + (about ? "about " + about.name : secret.kind);
    agentIds = [secret.originatorId || "", ...(about ? [about.id] : [])];
    const firstHolder = Object.entries(secret.holders).map(([id, fidelity]) => ({ agent: agentById(world, id), fidelity }))
      .find(holder => holder.agent);
    origin = '<article class="thread-origin"><span>Origin · Day ' + dayOfTick(secret.originTick) +
      (secret.originatorId ? " · began with " + esc(agentById(world, secret.originatorId)?.name || "a mind") : "") +
      '</span><p>' + esc(firstHolder ? secretTextFor(secret, firstHolder.fidelity) : secret.text) + "</p></article>";
    knowledge = secretKnowledgeRows(secret);
    const relatedChanges = events.filter(event => event.kind === "relationship");
    relations = relatedChanges.length
      ? relatedChanges.slice().reverse().slice(0, 12).map(threadEventCard).join("")
      : '<p class="note">No relationship change has been linked to this secret yet.</p>';
  }

  plans = world.resolved.filter(moment => moment.kind === "cognition" && agentIds.includes(moment.agentId))
    .sort((a, b) => a.tick - b.tick);
  const originEvent = kind === "secret" ? null : events[0];
  const subsequent = events.filter(event => !originEvent || event.id !== originEvent.id)
    .slice().reverse().slice(0, 40);
  const recentMemories = memories.slice().reverse().slice(0, 16);
  root.innerHTML = '<div class="thread-heading card"><p class="eyebrow">FOLLOWING THIS THREAD</p><h2 id="thread-title">' +
    esc(title) + '</h2><p class="note">Starting point, knowledge trail, relationship changes, and what followed.</p></div>' +
    threadSection(originLabel, origin) +
    threadSection("Who learned what", knowledge) +
    threadSection(kind === "secret" ? "Relationship changes linked to this secret" : "Relationship changes", relations) +
    (plans.length ? threadSection("Self-authored plans in this thread", plans.slice(-8).reverse().map(cognitionThreadCard).join("")) : "") +
    threadSection("Subsequent events", subsequent.length
      ? subsequent.map(threadEventCard).join("")
      : '<p class="note">No later public events are in this thread yet.</p>') +
    threadSection("Private memories and tellings", recentMemories.length
      ? '<div class="thread-memory-list">' + recentMemories.map(({ agent, trace }) =>
        '<article class="thread-memory"><span>' + esc(agent.name) + " · Day " + dayOfTick(trace.tick) +
        (trace.secretId ? " · secret memory" : " · private memory") + '</span><p>' + esc(trace.text) + "</p></article>").join("") + "</div>"
      : '<p class="note">No private memories survive for this thread.</p>');
}

function dayOfTick(tick) {
  const mpt = (world.config.clock && world.config.clock.minutesPerTick) || 30;
  return Math.floor((tick * mpt) / 1440) + 1;
}

/* ---------- canvas world map: painterly terrain, glowing orbs, weather of the soul ---------- */
const REGION_ART = {
  lantern:    { core: "#c98a2e", soft: "rgba(201,138,46,0.20)" },
  market:     { core: "#b3923f", soft: "rgba(179,146,63,0.18)" },
  crossroads: { core: "#3f9d6b", soft: "rgba(63,157,107,0.18)" },
  wall:       { core: "#6d7f9c", soft: "rgba(109,127,156,0.20)" },
  lowlands:   { core: "#2e8b6e", soft: "rgba(46,139,110,0.18)" },
  marsh:      { core: "#5d8f7f", soft: "rgba(93,143,127,0.16)" }
};
const PHASE_TINT = {
  "dawn":       { c: "255,150,110", a: 0.10, glow: 0.10 },
  "day":        { c: "255,244,214", a: 0.05, glow: 0.00 },
  "dusk":       { c: "150,90,200",  a: 0.13, glow: 0.20 },
  "night":      { c: "16,18,70",    a: 0.24, glow: 0.35 },
  "deep night": { c: "6,8,36",      a: 0.34, glow: 0.50 }
};
/* How a mood reads on the map. The ring around an orb is the mind's weather. */
const MOOD_COLOR = {
  triumphant: "#fbbf24",
  content:    "#34d399",
  steady:     "#8fa3bd",
  restless:   "#7dd3fc",
  weary:      "#c99a5b",
  lonely:     "#a78bfa",
  bitter:     "#c084fc",
  adrift:     "#5b7fa8",
  exhausted:  "#b45454",
  grieving:   "#b8b2c4"
};

const mapFx = {
  cv: null, ctx: null, terrain: null, w: 0, h: 0, dpr: 1,
  orbs: [],            // hit-test cache {id,x,y}
  ripples: [],         // {x,y,t0,color}
  wisps: [],           // {x0,y0,x1,y1,t0}
  motes: [],           // {x,y,vx,vy,r,ph}
  sprites: new Map(),  // pre-rendered orb glow sprites by color|state|mood
  sigils: [],          // hit-test cache for petitions, whispers, dilemmas {kind,id,x,y,agentId}
  constellations: [],  // hit-test cache for secret threads {id,x,y,holders}
  lastFxSeq: 0, fxInit: false,
  running: false
};

function phaseFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 37 + c.charCodeAt(0)) >>> 0;
  return (h % 628) / 100;
}

function sizeCanvas() {
  const cv = mapFx.cv;
  if (!cv) return;
  const map = $("map");
  const r = map.getBoundingClientRect();
  const w = Math.max(50, r.width), h = Math.max(50, r.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (mapFx.w === w && mapFx.h === h && mapFx.dpr === dpr && mapFx.terrain) return;
  mapFx.w = w; mapFx.h = h; mapFx.dpr = dpr;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  buildTerrain();
}

function buildTerrain() {
  const { w, h, dpr } = mapFx;
  const off = document.createElement("canvas");
  off.width = Math.round(w * dpr);
  off.height = Math.round(h * dpr);
  const g = off.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // deep base
  g.fillStyle = "#0b0b10";
  g.fillRect(0, 0, w, h);
  // Region washes, sized by how many minds are actually living there — the map
  // is a picture of the world's attention, not a static backdrop.
  const occ = world ? regionOccupancy(world) : {};
  for (const r of REGIONS) {
    const art = REGION_ART[r.id] || { core: "#6b5f8a", soft: "rgba(107,95,138,0.15)" };
    const count = (occ[r.id] || []).length;
    const heat = Math.min(1, count / 4);
    const cx = (r.x / 100) * w, cy = (r.y / 100) * h;
    const rad = Math.max(w, h) * (0.28 + heat * 0.06);
    let gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, art.soft);
    gr.addColorStop(0.55, art.soft.replace(/[\d.]+\)$/, "0.07)"));
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    // hot heart of the region
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 0.35);
    gr.addColorStop(0, art.soft.replace(/[\d.]+\)$/, (0.16 + heat * 0.12).toFixed(3) + ")"));
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    // faint contour rings, like a cartographer's hand
    g.strokeStyle = "rgba(200,180,150,0.06)";
    g.lineWidth = 1;
    for (let k = 1; k <= 2; k++) {
      g.beginPath();
      g.ellipse(cx, cy, rad * 0.45 * k, rad * 0.34 * k, 0.4, 0, Math.PI * 2);
      g.stroke();
    }
  }
  // region links, dotted ley-lines
  g.strokeStyle = "rgba(180,160,220,0.10)";
  g.lineWidth = 1;
  g.setLineDash([2, 5]);
  const seen = new Set();
  for (const r of REGIONS) {
    for (const to of r.links || []) {
      const key = [r.id, to].sort().join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      const b = REGIONS.find(q => q.id === to);
      if (!b) continue;
      g.beginPath();
      g.moveTo((r.x / 100) * w, (r.y / 100) * h);
      g.lineTo((b.x / 100) * w, (b.y / 100) * h);
      g.stroke();
    }
  }
  g.setLineDash([]);
  // cartographer's grid, barely there
  g.strokeStyle = "rgba(139,92,246,0.055)";
  g.lineWidth = 1;
  for (let x = 0; x <= w; x += 34) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
  for (let y = 0; y <= h; y += 34) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke(); }
  // film grain
  const nz = document.createElement("canvas");
  nz.width = nz.height = 128;
  const ng = nz.getContext("2d");
  const id = ng.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 118 + Math.floor(Math.random() * 20);
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  ng.putImageData(id, 0, 0);
  g.globalAlpha = 0.05;
  g.fillStyle = g.createPattern(nz, "repeat");
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  // region names, atlas serif
  g.fillStyle = "rgba(232,220,196,0.30)";
  g.font = "italic 12px Georgia, 'Times New Roman', serif";
  g.textAlign = "center";
  for (const r of REGIONS) {
    const count = (occ[r.id] || []).length;
    g.fillText(r.name + (count ? "  · " + count : ""), (r.x / 100) * w, (r.y / 100) * h - 34);
  }
  // vignette
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  mapFx.terrain = off;
}

function seedMotes() {
  mapFx.motes = [];
  for (let i = 0; i < 52; i++) {
    mapFx.motes.push({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00012,
      vy: (Math.random() - 0.5) * 0.00010 - 0.00004,
      r: 0.8 + Math.random() * 1.6,
      ph: Math.random() * 6.28
    });
  }
}

/* Orb sprites: halo + body + ring pre-rendered once per color/state/mood, so the
 * frame loop is just drawImage + text. Phone GPUs hate per-frame shadowBlur. */
function orbSprite(a, moodWordNow) {
  const awake = a.awake && !a.retired;
  const mood = awake ? (MOOD_COLOR[moodWordNow] || MOOD_COLOR.steady) : "#6a6a78";
  const key = (a.color || "#8b5cf6") + (awake ? "|1|" : "|0|") + mood;
  let sp = mapFx.sprites.get(key);
  if (sp) return sp;
  const R = 19, haloR = R * 2.7, pad = haloR + 10;
  const S = Math.ceil(pad * 2);
  const dpr = mapFx.dpr || 1;
  const c = document.createElement("canvas");
  c.width = c.height = Math.ceil(S * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = S / 2, cy = S / 2;
  if (!awake) g.globalAlpha = 0.38;
  const hg = g.createRadialGradient(cx, cy, 0, cx, cy, haloR);
  hg.addColorStop(0, hexA(a.color, 0.55));
  hg.addColorStop(0.45, hexA(a.color, 0.16));
  hg.addColorStop(1, hexA(a.color, 0));
  g.fillStyle = hg;
  g.beginPath(); g.arc(cx, cy, haloR, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = "rgba(16,16,24,0.92)";
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = a.color;
  g.shadowColor = a.color;
  g.shadowBlur = 18;
  g.stroke();
  // the mind's weather, as a ring just outside the body
  g.shadowBlur = 0;
  g.lineWidth = 1.6;
  g.strokeStyle = mood;
  g.globalAlpha = (awake ? 0.9 : 0.35);
  g.beginPath(); g.arc(cx, cy, R + 4.5, 0, Math.PI * 2); g.stroke();
  sp = { c, S };
  if (mapFx.sprites.size > 96) mapFx.sprites.clear();
  mapFx.sprites.set(key, sp);
  return sp;
}

function orbXY(a, t) {
  const p = mapPos(a);
  return {
    x: (p.x / 100) * mapFx.w,
    y: (p.y / 100) * mapFx.h + Math.sin(t * 0.0011 + phaseFor(a.id)) * 3
  };
}

function drawOrb(g, a, t, glowBoost) {
  const { x, y } = orbXY(a, t);
  const pulse = 1 + Math.sin(t * 0.0021 + phaseFor(a.id) * 2.3) * 0.07;
  const awake = a.awake && !a.retired;
  mapFx.orbs.push({ id: a.id, x, y });
  const sp = orbSprite(a, moodWord(a, tickNow()));
  const S = sp.S * pulse;
  g.save();
  g.globalAlpha = awake ? Math.min(1, 0.88 + glowBoost * 0.3) : 0.5;
  g.drawImage(sp.c, x - S / 2, y - S / 2, S, S);
  g.restore();
  const R = 19 * pulse;
  // sigil
  g.save();
  g.fillStyle = awake ? "#fff" : "#8a8a96";
  g.font = "17px system-ui";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(a.icon || "✦", x, y + 1);
  // name
  g.font = "600 10px system-ui";
  g.fillStyle = awake ? "rgba(242,242,245,0.92)" : "rgba(154,154,168,0.6)";
  g.fillText(String(a.name).toUpperCase().slice(0, 12), x, y + R + 12);
  g.restore();
  // selection ring
  if (ui.selectedId === a.id) {
    g.save();
    g.strokeStyle = hexA(a.color, 0.7 + 0.3 * Math.sin(t * 0.004));
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, R + 9, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
}

/**
 * The social graph, drawn.
 *
 * A world of nine minds has thirty-six edges and most of them mean nothing, so
 * only the ones that actually carry weight are drawn: alliances as warm bonds,
 * grudges as frayed red lines. Tapping a mind lights up its own ties and dims
 * the rest, which turns the map into the answer to "who is this person to
 * everyone else?" — the question the map was always the right shape for.
 */
function drawTies(g, t) {
  const living = livingAgents(world);
  if (living.length < 2) return;
  const sel = ui.selectedId;
  const pos = new Map(living.map(a => [a.id, orbXY(a, t)]));
  const alliance = world.config.relations.allianceThreshold;
  const rivalry = world.config.relations.rivalryThreshold;

  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const A = living[i], B = living[j];
      // Read the edges straight off the models. `edgeToward` would *create* a
      // neutral edge for every pair it is asked about, and this runs sixty times
      // a second — a render path must never write to the simulation.
      const ea = A.relations[B.id], eb = B.relations[A.id];
      if (!ea || !eb) continue;
      const warm = (ea.affinity + eb.affinity) / 2;
      const hot = (ea.resentment + eb.resentment) / 2;
      const isSel = sel && (A.id === sel || B.id === sel);
      const kind = warm >= Math.max(18, alliance - 22) ? "warm" : hot >= Math.max(14, rivalry - 8) ? "hot" : null;
      if (!kind) continue;
      const strength = kind === "warm" ? warm : hot;
      if (!isSel && strength < (kind === "warm" ? 34 : 22)) continue;
      const p1 = pos.get(A.id), p2 = pos.get(B.id);
      if (!p1 || !p2) continue;
      const k = Math.min(1, strength / (kind === "warm" ? 90 : 55));
      const alpha = (isSel ? 0.5 : 0.2) + k * (isSel ? 0.45 : 0.3);
      // A shallow bow keeps parallel lines from collapsing into one another.
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const nx = -(p2.y - p1.y), ny = (p2.x - p1.x);
      const nl = Math.hypot(nx, ny) || 1;
      const bow = Math.min(26, nl * 0.12);
      const cxp = mx + (nx / nl) * bow, cyp = my + (ny / nl) * bow;

      g.save();
      g.strokeStyle = kind === "warm"
        ? "rgba(251,191,36," + alpha.toFixed(3) + ")"
        : "rgba(248,113,113," + alpha.toFixed(3) + ")";
      g.lineWidth = 1 + k * (isSel ? 2.6 : 1.6);
      g.setLineDash(kind === "hot" ? [4, 4] : []);
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.quadraticCurveTo(cxp, cyp, p2.x, p2.y);
      g.stroke();
      g.restore();
    }
  }
}

function drawProjectMarker(g, w, h, t) {
  const project = world && world.project;
  const region = project && REGIONS.find(r => r.id === project.regionId);
  if (!project || !region) return;
  const x = region.x / 100 * w;
  const y = region.y / 100 * h + 25;
  const completed = project.status === "complete";
  const filled = Math.round(project.progress / 20);
  g.save();
  g.lineCap = "round";
  g.lineWidth = completed ? 5 : 4;
  for (let i = 0; i < 5; i++) {
    const sx = x - 22 + i * 9;
    g.strokeStyle = completed
      ? "rgba(251,191,36,0.95)"
      : i < filled ? "rgba(251,191,36,0.88)" : "rgba(211,198,170,0.28)";
    g.beginPath();
    g.moveTo(sx, y);
    g.lineTo(sx + 6, y);
    g.stroke();
  }
  g.strokeStyle = completed ? "rgba(255,224,140,0.95)" : "rgba(245,225,184,0.5)";
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(x - 23, y - 4); g.lineTo(x - 23, y + 4);
  g.moveTo(x + 23, y - 4); g.lineTo(x + 23, y + 4);
  g.stroke();
  if (completed) {
    const glow = 0.6 + Math.sin(t * 0.002) * 0.15;
    g.fillStyle = "rgba(255,224,140," + glow.toFixed(2) + ")";
    g.beginPath(); g.arc(x, y - 9, 3, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = completed ? "rgba(255,224,140,0.9)" : "rgba(232,220,196,0.62)";
  g.font = "700 8px system-ui";
  g.textAlign = "center";
  g.fillText(completed ? "REINFORCED" : "WALL " + Math.round(project.progress) + "%", x, y + 15);
  g.restore();
}

/* ------------------------------------------------------------------ *
 * The atlas as a board
 *
 * The map stops being scenery when it answers questions without you having to
 * open anything. Four things are drawn here that the engine already knows:
 * petitions waiting on the keeper, the shape of a feud, the state of the wall,
 * and the threads that connect people — plus a glyph on each mind so a builder
 * and a saboteur read differently at a glance.
 * ------------------------------------------------------------------ */

/** Where a region sits on the board, in canvas pixels. */
function regionXY(regionId, offsetY) {
  const region = REGIONS.find(r => r.id === regionId);
  if (!region) return null;
  return { x: (region.x / 100) * mapFx.w, y: (region.y / 100) * mapFx.h + (offsetY || 0) };
}

/**
 * The wall's palette. As the shared work advances the whole region warms, so
 * the board itself shows progress rather than a number on top of a picture.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawProjectPalette(g, t) {
  const project = world.project;
  const at = regionXY(project.regionId, 0);
  if (!at) return;
  const { k, complete: done } = projectPalette(world);
  const breathe = 0.5 + 0.5 * Math.sin(t * 0.0012);
  const radius = 46 + k * 54;
  const grad = g.createRadialGradient(at.x, at.y, 4, at.x, at.y, radius);
  // Cold slate while it is a hole in the ground; warm gold once it stands.
  grad.addColorStop(0, "rgba(" + (done ? "255,224,140" : "109,127,156") + "," + (0.10 + k * 0.22 + breathe * 0.03).toFixed(3) + ")");
  grad.addColorStop(1, "rgba(109,127,156,0)");
  g.save();
  g.fillStyle = grad;
  g.beginPath(); g.arc(at.x, at.y, radius, 0, Math.PI * 2); g.fill();
  g.restore();
}

/**
 * A builder gets a spark; a saboteur gets a red flicker. Both are read straight
 * off the project ledger, so the glyph cannot disagree with what actually
 * happened.
 * @param {CanvasRenderingContext2D} g
 * @param {any} agent
 * @param {number} x
 * @param {number} y
 * @param {number} t
 */
function drawStateGlyph(g, agent, x, y, t) {
  const glyph = mindGlyph(world, agent);
  if (!glyph) return;
  const ph = phaseFor(agent.id);
  if (glyph === "saboteur") {
    // A red flicker, deliberately unsteady: something here is going backwards.
    const flick = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.009 + ph * 3));
    g.save();
    g.strokeStyle = "rgba(248,113,113," + flick.toFixed(2) + ")";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x - 26, y - 14); g.lineTo(x - 21, y - 6);
    g.moveTo(x - 21, y - 14); g.lineTo(x - 26, y - 6);
    g.stroke();
    g.restore();
    return;
  }
  {
    // A spark orbiting the orb: this mind is one of the ones lifting.
    const a = t * 0.0022 + ph;
    const sx = x + Math.cos(a) * 25, sy = y + Math.sin(a) * 12 - 4;
    const twinkle = 0.5 + 0.5 * Math.sin(t * 0.006 + ph);
    g.save();
    g.fillStyle = "rgba(251,191,36," + (0.5 + twinkle * 0.45).toFixed(2) + ")";
    g.beginPath(); g.arc(sx, sy, 1.6 + twinkle, 0, Math.PI * 2); g.fill();
    g.restore();
  }
}

/**
 * Feud arcs. `drawTies` already draws a frayed red line between people who
 * dislike each other; this adds the *stage*, so a grudge and a vendetta do not
 * look like the same weather.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawFeudArcs(g, t) {
  const living = livingAgents(world);
  const pos = new Map(living.map(a => [a.id, orbXY(a, t)]));
  for (const arc of feudArcs(world)) {
    {
      const stage = arc.stage;
      const p1 = pos.get(arc.a), p2 = pos.get(arc.b);
      if (!p1 || !p2) continue;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const pulse = stage === "vendetta" ? 0.6 + 0.4 * Math.abs(Math.sin(t * 0.005)) : 0.45;
      g.save();
      g.strokeStyle = stage === "vendetta"
        ? "rgba(220,60,60," + pulse.toFixed(2) + ")"
        : "rgba(214,120,90," + pulse.toFixed(2) + ")";
      g.lineWidth = stage === "vendetta" ? 2.4 : 1.6;
      g.setLineDash(stage === "vendetta" ? [] : [5, 4]);
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.quadraticCurveTo(mx, my - 34, p2.x, p2.y);
      g.stroke();
      // The stage is named on the board; nobody has to open a dossier to know
      // how bad it is.
      g.setLineDash([]);
      g.fillStyle = stage === "vendetta" ? "rgba(255,150,150,0.9)" : "rgba(226,170,140,0.75)";
      g.font = "700 8px system-ui";
      g.textAlign = "center";
      g.fillText(stage.toUpperCase(), mx, my - 38);
      g.restore();
    }
  }
}

/**
 * Sigils for what is waiting on the keeper: a petition where the petitioner is
 * standing, a whisper at their shoulder, a dilemma between the two parties.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawBoardSigils(g, t) {
  const charter = world.charter;
  if (!charter) return;
  const pos = new Map(livingAgents(world).map(a => [a.id, orbXY(a, t)]));
  const sigils = boardSigils(world);

  for (const sigil of sigils.filter(s => s.kind === "petition")) {
    const petition = charter.petitions.find(p => p.id === sigil.id);
    if (!petition) continue;
    const at = pos.get(sigil.agentId || "");
    if (!at) continue;
    const bob = Math.sin(t * 0.003 + phaseFor(petition.id)) * 3;
    g.save();
    g.strokeStyle = petition.kind === "law" ? "rgba(243,217,164,0.9)" : "rgba(170,200,235,0.85)";
    g.lineWidth = 1.6;
    g.beginPath();
    // A scroll for a tradition, a seal for a law: two shapes, no legend needed.
    if (petition.kind === "law") {
      g.arc(at.x + 24, at.y - 20 + bob, 6, 0, Math.PI * 2);
      g.moveTo(at.x + 24, at.y - 26 + bob); g.lineTo(at.x + 24, at.y - 14 + bob);
      g.moveTo(at.x + 18, at.y - 20 + bob); g.lineTo(at.x + 30, at.y - 20 + bob);
    } else {
      g.rect(at.x + 19, at.y - 27 + bob, 11, 14);
      g.moveTo(at.x + 21.5, at.y - 23 + bob); g.lineTo(at.x + 27.5, at.y - 23 + bob);
      g.moveTo(at.x + 21.5, at.y - 19 + bob); g.lineTo(at.x + 27.5, at.y - 19 + bob);
    }
    g.stroke();
    g.restore();
    mapFx.sigils.push({ kind: "petition", id: petition.id, x: at.x + 24, y: at.y - 20 + bob, agentId: petition.agentId });
  }

  for (const sigil of sigils.filter(s => s.kind === "whisper")) {
    const whisper = charter.whispers.find(w => w.id === sigil.id);
    if (!whisper) continue;
    const at = pos.get(sigil.agentId || "");
    if (!at) continue;
    g.save();
    g.fillStyle = "rgba(196,170,240,0.85)";
    g.font = "12px system-ui";
    g.textAlign = "center";
    g.fillText("\u2731", at.x - 26, at.y + 4 + Math.sin(t * 0.004 + phaseFor(whisper.id)) * 2);
    g.restore();
    mapFx.sigils.push({ kind: "whisper", id: whisper.id, x: at.x - 26, y: at.y + 2, agentId: whisper.agentId });
  }

  for (const sigil of sigils.filter(s => s.kind === "dilemma")) {
    const dilemma = charter.dilemmas.find(d => d.id === sigil.id);
    if (!dilemma) continue;
    const a = pos.get(dilemma.partyIds[0]), b = pos.get(dilemma.partyIds[1]);
    const at = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 22 } : (a || b);
    if (!at) continue;
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.004));
    g.save();
    g.strokeStyle = "rgba(255,190,120," + pulse.toFixed(2) + ")";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(at.x, at.y - 8); g.lineTo(at.x + 8, at.y + 6); g.lineTo(at.x - 8, at.y + 6);
    g.closePath();
    g.stroke();
    g.fillStyle = "rgba(255,190,120," + pulse.toFixed(2) + ")";
    g.font = "700 9px system-ui";
    g.textAlign = "center";
    g.fillText("!", at.x, at.y + 4);
    g.restore();
    mapFx.sigils.push({ kind: "dilemma", id: dilemma.id, x: at.x, y: at.y, agentId: dilemma.partyIds[0] });
  }
}

/**
 * Threads as constellations. A secret still being kept, a pair with real
 * history, a mind with a long record — each gets a faint mark on the board, and
 * tapping one opens that thread instead of a dossier.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
/**
 * The keeper's own marks on the board: an omen ring over a region, a halo on a
 * blessed mind or across the wall, a pillar of light where the keeper stood at
 * a dilemma. They fade when their window closes but they do not vanish at once,
 * because a sign that changed a week should still be readable after it has
 * stopped changing anything — and every one of them is tappable.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawDivine(g, t) {
  const marks = divineMarks(world);
  if (!marks.length) return;
  const pos = new Map(livingAgents(world).map(a => [a.id, orbXY(a, t)]));
  for (const mark of marks) {
    const alpha = mark.live ? 1 : 0.42;
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0022);
    if (mark.kind === "omen") {
      const at = regionXY(mark.regionId, -18);
      if (!at) continue;
      g.save();
      g.globalAlpha = alpha;
      g.strokeStyle = "rgba(143,163,189," + (0.4 + 0.35 * breath).toFixed(2) + ")";
      g.lineWidth = 1.6;
      g.beginPath(); g.ellipse(at.x, at.y, 26, 14, 0, 0, Math.PI * 2); g.stroke();
      // An eye at the top of the ring: a sign, not a weather effect.
      g.fillStyle = "rgba(143,163,189,0.85)";
      g.beginPath(); g.ellipse(at.x, at.y - 14, 7, 4.2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(13,13,18,0.9)";
      g.beginPath(); g.arc(at.x, at.y - 14, 1.9, 0, Math.PI * 2); g.fill();
      g.restore();
      mapFx.sigils.push({ kind: "omen", id: mark.id, x: at.x, y: at.y - 14, agentId: mark.agentId });
    } else if (mark.kind === "blessing") {
      const at = mark.target === "work" ? regionXY(mark.regionId, -6) : pos.get(mark.agentId || "");
      if (!at) continue;
      g.save();
      g.globalAlpha = alpha;
      g.strokeStyle = "rgba(243,217,164," + (0.35 + 0.4 * breath).toFixed(2) + ")";
      g.lineWidth = 1.3;
      g.beginPath(); g.arc(at.x, at.y, 26 + breath * 3, 0, Math.PI * 2); g.stroke();
      g.setLineDash([3, 5]);
      g.beginPath(); g.arc(at.x, at.y, 34 + breath * 4, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      g.restore();
      mapFx.sigils.push({ kind: "blessing", id: mark.id, x: at.x, y: at.y - 26, agentId: mark.agentId });
    } else {
      const a = pos.get(mark.agentId || ""), b = pos.get(mark.subjectId || "");
      const at = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 12 } : regionXY(mark.regionId, -12);
      if (!at) continue;
      g.save();
      g.globalAlpha = alpha;
      const beam = g.createLinearGradient(at.x, at.y - 46, at.x, at.y + 8);
      beam.addColorStop(0, "rgba(196,170,240,0)");
      beam.addColorStop(0.55, "rgba(226,214,255," + (0.3 + 0.3 * breath).toFixed(2) + ")");
      beam.addColorStop(1, "rgba(196,170,240," + (0.5 + 0.3 * breath).toFixed(2) + ")");
      g.fillStyle = beam;
      g.beginPath();
      g.moveTo(at.x - 5, at.y - 46); g.lineTo(at.x + 5, at.y - 46);
      g.lineTo(at.x + 9, at.y + 8); g.lineTo(at.x - 9, at.y + 8);
      g.closePath(); g.fill();
      g.strokeStyle = "rgba(226,214,255," + (0.5 + 0.4 * breath).toFixed(2) + ")";
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(at.x, at.y + 6, 9 + breath * 2, 0, Math.PI * 2); g.stroke();
      g.restore();
      mapFx.sigils.push({ kind: "apparition", id: mark.id, x: at.x, y: at.y, agentId: mark.agentId });
    }
  }
}

/**
 * What the world is burying.
 *
 * A funeral that has been called draws as a ring of small marks around a mound
 * with a candle over it — the world gathering, still coming. A grave the world
 * has just filled draws as a cairn: three stones, no pulse, because it is
 * finished. Both read at a glance and both are tappable; a tap opens the
 * mourning chronicle, where the same person is written down.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawMourning(g, t) {
  for (const mark of mourningMarks(world)) {
    const at = regionXY(mark.regionId, -34);
    if (!at) continue;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.002);
    g.save();
    if (mark.kind === "funeral") {
      g.strokeStyle = "rgba(196,170,240,0.5)";
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(at.x, at.y, 13, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 0.0004;
        g.fillStyle = "rgba(232,224,208," + (0.3 + 0.4 * pulse).toFixed(2) + ")";
        g.beginPath(); g.arc(at.x + Math.cos(a) * 13, at.y + Math.sin(a) * 13, 1.6, 0, Math.PI * 2); g.fill();
      }
      g.strokeStyle = "rgba(180,170,200,0.9)";
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(at.x - 6, at.y + 3); g.quadraticCurveTo(at.x, at.y - 6, at.x + 6, at.y + 3); g.stroke();
      g.fillStyle = "rgba(251,191,36," + (0.45 + 0.45 * pulse).toFixed(2) + ")";
      g.beginPath(); g.arc(at.x, at.y - 10, 2.2, 0, Math.PI * 2); g.fill();
      g.font = "700 8px system-ui";
      g.textAlign = "center";
      g.fillStyle = "rgba(226,214,240,0.85)";
      g.fillText("GATHERING", at.x, at.y + 22);
    } else {
      g.fillStyle = "rgba(150,146,158,0.85)";
      g.beginPath(); g.ellipse(at.x, at.y + 4, 7, 2.5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(176,170,182,0.9)";
      g.beginPath(); g.ellipse(at.x, at.y + 0.5, 4.6, 2, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(at.x, at.y - 2.6, 2.8, 1.7, 0, 0, Math.PI * 2); g.fill();
      g.font = "700 8px system-ui";
      g.textAlign = "center";
      g.fillStyle = "rgba(198,192,206,0.72)";
      g.fillText(mark.name.toUpperCase(), at.x, at.y + 14);
    }
    g.restore();
    mapFx.sigils.push({ kind: mark.kind, id: mark.agentId, x: at.x, y: at.y, agentId: mark.agentId });
  }
}

function drawConstellations(g, t) {
  const pos = new Map(livingAgents(world).map(a => [a.id, orbXY(a, t)]));
  for (const thread of constellations(world)) {
    const secret = world.secrets.find(s => s.id === thread.secretId);
    if (!secret) continue;
    const holders = thread.holders.map(id => pos.get(id)).filter(Boolean);
    if (holders.length < 2) continue;
    const cx = holders.reduce((s, p) => s + p.x, 0) / holders.length;
    const cy = holders.reduce((s, p) => s + p.y, 0) / holders.length;
    g.save();
    g.strokeStyle = "rgba(150,190,230,0.30)";
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    for (let i = 0; i < holders.length; i++) {
      const p = holders[i];
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(p.x, p.y);
      g.stroke();
    }
    g.setLineDash([]);
    const twinkle = 0.35 + 0.3 * Math.sin(t * 0.0016 + phaseFor(secret.id));
    g.fillStyle = "rgba(190,215,245," + twinkle.toFixed(2) + ")";
    g.beginPath(); g.arc(cx, cy, 2.6, 0, Math.PI * 2); g.fill();
    g.restore();
    mapFx.constellations.push({ id: secret.id, x: cx, y: cy, holders: holders.length });
  }
}

/**
 * Where the keeper's crown sits, and how far a tap reaches. This is layout
 * rather than paint: it is computed from the board's size so the hit test works
 * from the first moment the board exists, not only after a frame has been
 * drawn.
 */
function keeperRingAt() {
  const w = Math.max(50, mapFx.w || 0);
  return { x: w - 44, y: 42, r: 30 };
}

/**
 * The keeper's own standing, drawn where it cannot be missed: three concentric
 * arcs in the board's top-right corner, one per meter — harmony outermost,
 * legacy closest to the crown — each filling clockwise from the top like a
 * clock face. The hollow part of a ring is as much a message as the filled
 * part: a meter down to a sliver is visible from across the room without
 * opening anything.
 *
 * This is the keeper's one mark on the board that belongs to no mind. Tapping
 * it opens their record; when the world is going quiet the whole puck wears a
 * slow red pulse, so the lose condition is legible before the words say so.
 * @param {CanvasRenderingContext2D} g
 * @param {number} t
 */
function drawKeeperRing(g, t) {
  const ring = keeperRing(world);
  const { x: cx, y: cy, r } = keeperRingAt();
  const START = -Math.PI / 2;
  const SWEEP = Math.PI * 1.5;
  g.save();
  // A dark puck first, so the arcs read over any terrain and the corner always
  // looks like a control rather than weather.
  const draining = ring.draining || ring.fallen;
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.0026);
  g.fillStyle = "rgba(13,13,18,0.62)";
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = draining
    ? "rgba(248,113,113," + (0.25 + 0.45 * pulse).toFixed(2) + ")"
    : "rgba(245,225,184,0.30)";
  g.lineWidth = 1.2;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  // Three arcs, outermost first, each a quarter-turn apart in radius.
  ring.meters.forEach((meter, i) => {
    const rr = r - 4 - i * 6;
    g.lineCap = "round";
    g.lineWidth = 3.6;
    g.strokeStyle = "rgba(255,255,255,0.13)";
    g.beginPath(); g.arc(cx, cy, rr, START, START + SWEEP); g.stroke();
    const frac = Math.max(0, Math.min(1, meter.value / 100));
    if (frac > 0.005) {
      g.strokeStyle = hexA(meter.color, ring.fallen ? 0.55 : 0.95);
      g.beginPath(); g.arc(cx, cy, rr, START, START + SWEEP * frac); g.stroke();
    }
  });
  // The crown at the centre: small, always present, never a number.
  g.fillStyle = ring.fallen ? "rgba(180,130,130,0.85)" : "rgba(251,191,36,0.92)";
  g.beginPath();
  g.moveTo(cx - 7, cy + 3);
  g.lineTo(cx - 7, cy - 2.5);
  g.lineTo(cx - 3.5, cy + 0.5);
  g.lineTo(cx, cy - 4.5);
  g.lineTo(cx + 3.5, cy + 0.5);
  g.lineTo(cx + 7, cy - 2.5);
  g.lineTo(cx + 7, cy + 3);
  g.closePath();
  g.fill();
  g.restore();
}

function drawMapFrame(t) {
  const fx = mapFx;
  if (!fx.ctx || !world) return;
  const g = fx.ctx;
  const { w, h, dpr } = fx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (fx.terrain) g.drawImage(fx.terrain, 0, 0, w, h);
  // day-night veil
  const tint = PHASE_TINT[world.clock.phase] || PHASE_TINT.night;
  g.fillStyle = "rgba(" + tint.c + "," + tint.a + ")";
  g.fillRect(0, 0, w, h);
  // This marker is derived from the persisted project state and deliberately
  // drawn above the cached terrain: every milestone survives a map redraw.
  drawProjectPalette(g, t || 0);
  drawProjectMarker(g, w, h, t || 0);
  // drifting motes
  for (const m of fx.motes) {
    m.x = (m.x + m.vx + 1) % 1;
    m.y = (m.y + m.vy + 1) % 1;
    const tw = 0.10 + 0.09 * Math.sin(t * 0.001 + m.ph);
    g.fillStyle = "rgba(220,210,255," + Math.max(0.02, tw).toFixed(3) + ")";
    g.beginPath(); g.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2); g.fill();
  }
  // ties and feud arcs under the orbs
  drawTies(g, t);
  fx.constellations.length = 0;
  drawConstellations(g, t);
  drawFeudArcs(g, t);
  // orbs
  fx.orbs.length = 0;
  fx.sigils.length = 0;
  for (const a of livingAgents(world)) {
    const at = orbXY(a, t);
    drawStateGlyph(g, a, at.x, at.y, t);
    drawOrb(g, a, t, tint.glow);
  }
  // what is waiting on the keeper, drawn last so it is never buried
  drawBoardSigils(g, t);
  // and what the keeper has already done to the world, under the lighter marks
  drawDivine(g, t);
  drawMourning(g, t);
  drawKeeperRing(g, t);
  // ripples
  fx.ripples = fx.ripples.filter(rp => t - rp.t0 < 900);
  for (const rp of fx.ripples) {
    const k = (t - rp.t0) / 900;
    g.strokeStyle = hexA(rp.color, 0.7 * (1 - k));
    g.lineWidth = 2 * (1 - k) + 0.5;
    g.beginPath(); g.arc(rp.x, rp.y, 8 + k * 52, 0, Math.PI * 2); g.stroke();
  }
  // wisps: bright streaks for momentous events
  fx.wisps = fx.wisps.filter(wp => t - wp.t0 < 750);
  for (const wp of fx.wisps) {
    const k = (t - wp.t0) / 750;
    const x = wp.x0 + (wp.x1 - wp.x0) * k;
    const y = wp.y0 + (wp.y1 - wp.y0) * k;
    const grad = g.createLinearGradient(x, y, x - (wp.x1 - wp.x0) * 0.25, y - (wp.y1 - wp.y0) * 0.25);
    grad.addColorStop(0, "rgba(255,240,210," + (0.85 * (1 - k)).toFixed(3) + ")");
    grad.addColorStop(1, "rgba(255,240,210,0)");
    g.strokeStyle = grad;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x - (wp.x1 - wp.x0) * 0.25, y - (wp.y1 - wp.y0) * 0.25);
    g.stroke();
  }
}

function mapLoop(t) {
  if (!mapFx.running) return;
  const active = document.querySelector("#screen-world.active") && !document.hidden;
  if (active && world) drawMapFrame(t || 0);
  requestAnimationFrame(mapLoop);
}

function startMapLoop() {
  if (mapFx.running) return;
  mapFx.running = true;
  requestAnimationFrame(mapLoop);
}

/* New events shimmer on the map: a ripple at the actor, a wisp for the momentous. */
/** One ripple at whoever an event happened to — and a wisp if it was momentous. */
function rippleForEvent(e) {
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const p = a ? mapPos(a) : { x: 50, y: 50 };
  mapFx.ripples.push({
    x: (p.x / 100) * mapFx.w, y: (p.y / 100) * mapFx.h,
    t0: performance.now(), color: a ? a.color : "#9a9aa8"
  });
  if ((e.significance || 0) >= 0.7) {
    const x0 = Math.random() * mapFx.w;
    mapFx.wisps.push({ x0, y0: -10, x1: x0 - 90 - Math.random() * 60, y1: 90 + Math.random() * 60, t0: performance.now() });
  }
  if (mapFx.ripples.length > 24) mapFx.ripples.splice(0, mapFx.ripples.length - 24);
}

function noteMapFx() {
  if (!world || !world.events.length) return;
  if (!mapFx.fxInit) {
    mapFx.lastFxSeq = world.events[0].seq;
    mapFx.fxInit = true;
    return;
  }
  const fresh = [];
  for (const e of world.events) {
    if (e.seq <= mapFx.lastFxSeq) break;
    fresh.push(e);
  }
  if (!fresh.length) return;
  mapFx.lastFxSeq = Math.max(mapFx.lastFxSeq, ...fresh.map(e => e.seq));
  for (const e of fresh.reverse()) rippleForEvent(e);
}

function renderMap() {
  // The canvas loop draws continuously; just keep it sized.
  sizeCanvas();
}

function initCanvas() {
  const cv = $("world-canvas");
  if (!cv || mapFx.cv) return;
  mapFx.cv = cv;
  mapFx.ctx = cv.getContext("2d");
  seedMotes();
  sizeCanvas();
  new ResizeObserver(() => sizeCanvas()).observe($("map"));
  // A tap opens the dossier. A tap-and-hold anywhere on the board opens the
  // radial menu, so the keeper's four moves are one gesture from any mind
  // without ever leaving the map.
  let holdTimer = 0;
  let holdFired = false;
  let startX = 0, startY = 0;

  /** What is under a point on the board: a sigil, a thread, or a mind. */
  const hitTest = (x, y) => {
    // The keeper's own crown reads first: it is the one mark on the board that
    // belongs to no mind, so it must never be buried under one passing by.
    {
      const crown = keeperRingAt();
      if (Math.hypot(crown.x - x, crown.y - y) <= crown.r) return { kind: "want", id: "want", agentId: null };
    }
    for (const sig of mapFx.sigils) {
      if (Math.hypot(sig.x - x, sig.y - y) < 16) return { kind: sig.kind, id: sig.id, agentId: sig.agentId };
    }
    for (const con of mapFx.constellations) {
      if (Math.hypot(con.x - x, con.y - y) < 14) return { kind: "thread", id: con.id };
    }
    let best = null, bestD = 30;
    for (const o of mapFx.orbs) {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best ? { kind: "mind", id: best.id, agentId: best.id } : null;
  };

  const localXY = ev => {
    const r = cv.getBoundingClientRect();
    const p = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };

  const begin = ev => {
    const at = localXY(ev);
    startX = at.x; startY = at.y;
    holdFired = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdFired = true;
      openRadial(at.x, at.y, hitTest(at.x, at.y));
    }, 420);
  };
  const cancel = () => { clearTimeout(holdTimer); };
  const end = ev => {
    clearTimeout(holdTimer);
    if (holdFired) { holdFired = false; return; }
    // A drag is not a tap.
    const at = localXY(ev.changedTouches && ev.changedTouches[0] ? { clientX: ev.changedTouches[0].clientX, clientY: ev.changedTouches[0].clientY } : ev);
    if (Math.hypot(at.x - startX, at.y - startY) > 12) return;
    const hit = hitTest(at.x, at.y);
    if (!hit) { closeRadial(); return; }
    if (hit.kind === "mind") openSheet(hit.id);
    else if (hit.kind === "want") {
      ui.record = "keeper";
      save();
      switchTab("record");
      renderRecord();
    }
    else if (hit.kind === "omen" || hit.kind === "blessing" || hit.kind === "apparition") {
      const sign = interventionFor(world, hit.id);
      if (sign) {
        toast("Your " + esc(sign.kind) + " on Day " + dayOfTick(sign.tick) + " — " + esc(sign.effect));
      }
      ui.record = "charter";
      save();
      switchTab("record");
      renderRecord();
    }
    else if (hit.kind === "funeral" || hit.kind === "grave") {
      ui.record = "chronicle";
      save();
      switchTab("record");
      renderRecord();
    }
    else if (hit.kind === "thread") followThread("secret", hit.id);
    else if (hit.kind === "petition") { ui.record = "charter"; save(); switchTab("record"); renderRecord(); }
    else if (hit.kind === "dilemma" || hit.kind === "whisper") { ui.record = "charter"; save(); switchTab("record"); renderRecord(); }
  };

  cv.addEventListener("mousedown", begin);
  cv.addEventListener("mousemove", ev => {
    if (Math.hypot(localXY(ev).x - startX, localXY(ev).y - startY) > 12) cancel();
  });
  cv.addEventListener("mouseup", end);
  cv.addEventListener("mouseleave", cancel);
  cv.addEventListener("touchstart", begin, { passive: true });
  cv.addEventListener("touchmove", cancel, { passive: true });
  cv.addEventListener("touchend", end);
  cv.addEventListener("touchcancel", cancel);
  cv.addEventListener("contextmenu", ev => ev.preventDefault());
  document.addEventListener("click", ev => {
    const menu = $("radial-menu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (/** @type {HTMLElement|null} */ (ev.target)?.closest("#radial-menu")) return;
    closeRadial();
  });
  mapFx.hitTest = hitTest;
}

/* ------------------------------------------------------------------ *
 * The radial menu
 * ------------------------------------------------------------------ */

/**
 * The four things a keeper can do about a mind, arranged around them.
 *
 * Every entry is a real move with a real consequence, not a shortcut to a
 * screen: whispering puts the mind in a position to tell you something,
 * answering a petition spends influence and writes precedent. Entries the world
 * cannot currently honour are shown disabled rather than hidden, so the menu is
 * also a readout of what is on offer.
 *
 * @param {number} x
 * @param {number} y
 * @param {{kind: string, id: string, agentId?: string}|null} hit
 */
function openRadial(x, y, hit) {
  const menu = $("radial-menu");
  if (!menu) return;
  const agent = hit && hit.agentId ? agentById(world, hit.agentId) : null;
  const charter = world.charter;
  const openPetition = agent
    ? (charter ? charter.petitions.find(p => p.agentId === agent.id && p.status === "open") : null)
    : (charter ? charter.petitions.find(p => p.status === "open") : null);
  const openWhisper = agent && charter
    ? charter.whispers.find(w => w.agentId === agent.id && !w.actedOn)
    : null;

  const items = [
    {
      id: "whisper",
      label: "Whisper",
      hint: agent
        ? (openWhisper ? "They have already told you something." : "Draw them aside and listen.")
        : "Pick a mind first.",
      disabled: !agent,
      run: () => {
        if (!agent) return;
        openSheet(agent.id);
        toast(agent.name + " leans in. What they know is theirs until they choose to say it.");
      }
    },
    {
      id: "petition",
      label: "Answer petition",
      hint: openPetition
        ? describeRule(openPetition.ruleKind) + " — " + (openPetition.cost || 0) + " influence to enact."
        : "Nothing is waiting on a ruling.",
      disabled: !openPetition,
      run: () => { ui.record = "charter"; save(); switchTab("record"); renderRecord(); }
    },
    {
      id: "thread",
      label: "Follow thread",
      hint: agent ? "Their part in everything that has happened." : "Pick a mind first.",
      disabled: !agent,
      run: () => { if (agent) followThread("mind", agent.id); }
    },
    {
      id: "dossier",
      label: "Dossier",
      hint: agent ? "Who they are, and who they are to everyone else." : "Pick a mind first.",
      disabled: !agent,
      run: () => { if (agent) openSheet(agent.id); }
    }
  ];

  // Gods don't chat: the three things the keeper can do without saying a word.
  // Each is offered only where it could actually land — a blessing on the mind
  // under the press, an omen over the region under it, an apparition where a
  // dilemma is already burning — and each says why when it cannot.
  const region = regionAtPoint(x, y);
  if (region) {
    const omenTarget = { regionId: region.id };
    const omenCheck = canIntervene(world, "omen", omenTarget);
    items.push({
      id: "omen",
      label: "Set omen",
      hint: omenCheck.ok
        ? "A sign over " + region.name + " — " + (omenCheck.cost || 0) + " influence."
        : (omenCheck.reason || "You cannot set a sign there."),
      disabled: !omenCheck.ok,
      run: () => tryIntervene("omen", omenTarget)
    });
  }
  if (agent) {
    const blessTarget = { agentId: agent.id };
    const blessCheck = canIntervene(world, "blessing", blessTarget);
    items.push({
      id: "blessing",
      label: "Bless",
      hint: blessCheck.ok
        ? "A light on " + agent.name + " — " + (blessCheck.cost || 0) + " influence."
        : (blessCheck.reason || "You cannot bless them."),
      disabled: !blessCheck.ok,
      run: () => tryIntervene("blessing", blessTarget)
    });
    const theirs = (world.charter?.dilemmas || []).find(d => d.status === "open" && d.partyIds.includes(agent.id));
    if (theirs) {
      const appearTarget = { dilemmaId: theirs.id };
      const appearCheck = canIntervene(world, "apparition", appearTarget);
      items.push({
        id: "apparition",
        label: "Appear",
        hint: appearCheck.ok
          ? "Stand with them and say nothing — " + (appearCheck.cost || 0) + " influence."
          : (appearCheck.reason || "You cannot appear there."),
        disabled: !appearCheck.ok,
        run: () => tryIntervene("apparition", appearTarget)
      });
    }
  }

  const mapRect = $("map").getBoundingClientRect();
  const cvRect = mapFx.cv ? mapFx.cv.getBoundingClientRect() : mapRect;
  // The canvas is positioned inside #map, so convert to map-local coordinates.
  const ox = cvRect.left - mapRect.left + x;
  const oy = cvRect.top - mapRect.top + y;
  const R = 74;

  menu.innerHTML = items.map((item, i) => {
    const angle = (Math.PI * 2 * i) / items.length - Math.PI / 2;
    const ix = Math.cos(angle) * R, iy = Math.sin(angle) * R;
    return '<button class="radial-item' + (item.disabled ? " disabled" : "") + '" data-act="' + esc(item.id) + '" ' +
      'title="' + esc(item.hint) + '" ' +
      'style="transform:translate(' + ix.toFixed(1) + "px," + iy.toFixed(1) + 'px)">' +
      '<span class="radial-label">' + esc(item.label) + "</span></button>";
  }).join("");
  menu.style.left = ox + "px";
  menu.style.top = oy + "px";
  menu.classList.remove("hidden");
  mapFx.radial = { items, agent };

  menu.querySelectorAll(".radial-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = items.find(i => i.id === /** @type {any} */ (btn).dataset.act);
      closeRadial();
      if (item && !item.disabled) item.run();
    });
  });
}

function closeRadial() {
  const menu = $("radial-menu");
  if (menu) menu.classList.add("hidden");
}

function driveBar(label, val) {
  const v = Math.max(0, Math.min(100, Math.round(val)));
  return '<div class="drive-row"><span>' + esc(label) + '</span>' +
    '<div class="bar"><div class="fill" style="width:' + v + '%"></div></div>' +
    '<b>' + v + '</b></div>';
}
function energyBar(val) {
  const v = Math.max(0, Math.min(100, Math.round(val == null ? 80 : val)));
  const cls = v > 60 ? "" : v >= 30 ? " mid" : " low";
  return '<div class="bar energy"><div class="fill' + cls + '" style="width:' + v + '%"></div></div>';
}
function rpgBlock(a) {
  const t = tickNow();
  const prog = levelProgress(a, world.config.progression.levelDivisor);
  const need = pressingNeed(a);
  return '<div class="astats">' +
    '<div class="astat"><span>Level</span><b>' + a.level + "</b></div>" +
    '<div class="astat"><span>Energy</span>' + energyBar(a.needs.energy) + "<b>" + Math.round(a.needs.energy) + "</b></div>" +
    '<div class="astat"><span>Mood</span><b class="mood">' + esc(moodWord(a, t)) + "</b></div>" +
    '<div class="astat"><span>XP</span><b>' + Math.round(a.xp) + "</b></div>" +
    "</div>" +
    '<div class="drives compact">' +
    driveBar("Foc", a.drives.focus) + driveBar("Soc", a.drives.social) +
    driveBar("Cou", a.drives.courage) + driveBar("Cre", a.drives.creativity) +
    "</div>" +
    '<div class="goal-line"><span class="glabel">GOAL</span> ' + esc(a.goal.text) +
    ' <span class="note">(' + Math.round(a.goal.progress * 100) + "% along)</span></div>" +
    (need.value <= 30
      ? '<div class="goal-line"><span class="glabel">NEED</span> running short of ' + esc(need.key) +
        " — " + Math.round(need.value) + "/100</div>"
      : "") +
    (prog > 0 ? '<div class="goal-line"><span class="glabel">LEVEL ' + (a.level + 1) + "</span> " +
      Math.round(prog * 100) + "% of the way to the next one</div>" : "");
}

function tieRows(a) {
  const ties = tiesOf(a, 6);
  if (!ties.length) {
    return '<span class="sec-tag">Ties</span><p class="note">Has not yet formed a strong opinion about anyone. ' +
      "That will change.</p>";
  }
  const rows = ties.map(({ other, edge, word }) => {
    const warm = Math.max(0, Math.min(100, edge.affinity));
    const cold = Math.max(0, Math.min(100, edge.resentment));
    const trust = Math.max(0, Math.min(100, edge.trust));
    return '<div class="tie"><span class="tname" style="color:' + esc(other.color) + '">' +
      esc(other.icon) + " " + esc(other.name) + "</span>" +
      '<span class="tword">' + esc(word) + "</span>" +
      '<span class="tbar" title="affection ' + Math.round(warm) + ", trust " + Math.round(trust) +
      ", resentment " + Math.round(cold) + '">' +
      '<i class="warm" style="width:' + warm + '%"></i>' +
      '<i class="cold" style="width:' + cold + '%"></i>' +
      '</span><button class="thread-mini follow-pair-thread" data-a="' + esc(a.id) +
      '" data-b="' + esc(other.id) + '" title="Follow their shared thread">Thread</button></div>';
  }).join("");
  return '<span class="sec-tag">Ties</span>' + rows;
}

function carryingBlock(a) {
  const held = privateSecretsHeld(world, a.id);
  const known = secretsAbout(world, a.id).filter(s => s.aboutId === a.id);
  const leaking = known.filter(s => s.isPublic);
  let html = '<span class="sec-tag">Carrying</span>';
  if (!held.length) {
    html += '<p class="note">' + esc(a.name) + " is carrying nothing they would not say out loud.</p>";
  } else {
    html += held.slice(0, 4).map(s => {
      const f = s.holders[a.id];
      const about = s.aboutId ? agentById(world, s.aboutId) : null;
      // When the secret is about the mind holding it, saying so adds nothing.
      const aboutBit = about && about.id !== a.id ? "about " + esc(about.name) + " · " : "";
      return '<div class="burden">' + esc(secretTextFor(s, f)) +
        '<span class="bsrc">' + aboutBit +
        (f >= 0.85 ? "told straight" : f >= 0.6 ? "heard second-hand" : "half-remembered") +
        (s.isPublic ? " · and it is out now" : "") + "</span></div>";
    }).join("");
    if (held.length > 4) {
      html += '<p class="note">…and ' + (held.length - 4) + " more they have not found a use for.</p>";
    }
  }
  if (leaking.length) {
    html += '<p class="note">' + leaking.length + " of the things said about " + esc(a.name) +
      (leaking.length === 1 ? " is" : " are") + " out in the open now.</p>";
  }
  return html;
}

function preoccupationBlock(a) {
  // Recall can surface the same line twice — a mind that heard one thing twice
  // remembers it twice — but a list that repeats itself looks like a bug.
  const seen = new Set();
  const top = preoccupations(world, a, 5).filter(tr => {
    const key = String(tr.text || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  if (!top.length) return "";
  return '<span class="sec-tag">On their mind</span>' +
    top.map(tr => '<div class="burden">' + esc(String(tr.text || "").slice(0, 180)) + "</div>").join("");
}

function cognitionBlock(a) {
  const cognition = a.cognition;
  if (!cognition || !cognition.enabled) return "";
  let html = '<section class="cognition-dossier"><span class="sec-tag">Private cognition · pilot</span>';
  if (cognition.lastPlan) {
    const plan = cognition.lastPlan;
    const target = plan.targetId ? agentById(world, plan.targetId) : null;
    html += '<div class="cognition-plan"><span class="cognition-meta">' +
      (plan.source === "model" ? "SELF-AUTHORED" : "ENGINE FALLBACK") + " · " +
      esc(plan.action || "no action") + (target ? " · toward " + esc(target.name) : "") +
      "</span><p>“" + esc(plan.text) + "”</p>" +
      (plan.accepted ? "" : '<span class="note">' + esc(plan.reason) + "</span>") + "</div>";
  } else {
    html += '<p class="note">No self-authored plan has been recorded yet.</p>';
  }
  if (cognition.priorities && cognition.priorities.length) {
    html += '<span class="cognition-label">Priorities they authored</span><ul>' +
      cognition.priorities.slice(0, 3).map(item => "<li>" + esc(item.text) + "</li>").join("") + "</ul>";
  }
  if (cognition.beliefs && cognition.beliefs.length) {
    html += '<span class="cognition-label">Private beliefs</span><ul>' +
      cognition.beliefs.slice(0, 4).map(belief => {
        const about = belief.aboutId ? agentById(world, belief.aboutId) : null;
        return "<li>" + esc(belief.text) +
          (about ? ' <span class="note">about ' + esc(about.name) + "</span>" : "") +
          ' <span class="belief-confidence">' + Math.round(belief.confidence * 100) + "%</span></li>";
      }).join("") + "</ul>";
  }
  if (cognition.memorySummary) {
    html += '<span class="cognition-label">Memory summary</span><p class="cognition-summary">' +
      esc(cognition.memorySummary) + "</p>";
  }
  return html + "</section>";
}

function openSheet(id) {
  closeRadial();
  const a = agentById(world, id);
  if (!a || a.retired) return;
  credit("dossier", id);
  ui.selectedId = id;
  save();
  renderStats();
  $("sheet-head").innerHTML =
    '<span class="orb sheet-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 22px " + esc(a.color) + '">' + portraitHtml(a) + "</span>" +
    "<span>" + esc(a.name) + (a.epithet ? " " + esc(a.epithet) : "") +
    '<span class="sh-sub">' + esc(a.class) + " · " + esc(a.archetype) + " · Lv " + a.level +
    " · " + esc(standingWord(a.standing ?? 0)) + "</span></span>";
  $("sheet-personality").textContent =
    a.personality + " · " + regionName(world, a.regionId) + (a.awake ? "" : " · asleep") +
    (a.backstory ? " · " + a.backstory : "");
  $("sheet-toggle").textContent = a.awake ? "Sleep" : "Wake";
  $("sheet-rpg").innerHTML = rpgBlock(a);
  $("sheet-ties").innerHTML = tieRows(a);
  $("sheet-carrying").innerHTML = carryingBlock(a) + preoccupationBlock(a);
  $("sheet-cognition").innerHTML = cognitionBlock(a);
  const thoughtEl = $("sheet-thought");
  const thoughtIsEpoch = a.thoughtAt > 100000000000;
  const fresh = a.thought && (thoughtIsEpoch
    ? Date.now() - a.thoughtAt < THOUGHT_TTL_MS
    : tickNow() - a.thoughtAt < world.config.cognition.planIntervalTicks * 3);
  if (!hasKey()) {
    thoughtEl.innerHTML = '<span class="note">No model attached, so there is no inner monologue to read — ' +
      "but the record will tell you what " + esc(a.name) + " has actually been doing. Add a key in Admin " +
      "to hear the voice.</span>";
  } else if (fresh) {
    thoughtEl.textContent = "\u201C" + a.thought + "\u201D";
  } else {
    thoughtEl.innerHTML = '<span class="typing">listening…</span>';
    fetchThought(a).then(t => {
      if (!$("mind-sheet").classList.contains("hidden") && ui.selectedId === id) {
        thoughtEl.textContent = "\u201C" + t + "\u201D";
      }
    }).catch(err => {
      thoughtEl.innerHTML = '<span class="note">' + esc(thoughtError(err)) + "</span>";
    });
  }
  $("sheet-backdrop").classList.remove("hidden");
  $("mind-sheet").classList.remove("hidden");
}
function closeSheet() {
  closeRadial();
  $("sheet-backdrop").classList.add("hidden");
  $("mind-sheet").classList.add("hidden");
}
function thoughtError(err) {
  if (String(err && err.message) === "no-key") return "Asleep — add your API key in Admin.";
  return "Couldn't reach the mind: " + String(err && err.message || err).slice(0, 120);
}

/* ---- minds, grouped by where they actually are ---- */
function renderAgents() {
  const list = $("agents-list");
  list.innerHTML = "";
  const living = livingAgents(world);
  const occ = regionOccupancy(world);
  const yours = living.filter(a => a.userCreated).length;
  $("minds-note").textContent = living.length + " minds in the world" +
    (yours ? ", " + yours + " brought here by you" : "") +
    ". Awake minds act every tick; sleeping ones still drift.";

  for (const region of REGIONS) {
    const here = occ[region.id] || [];
    if (!here.length) continue;
    const head = document.createElement("div");
    head.className = "region-head";
    head.innerHTML = "<span>" + esc(region.name) + "</span><em>" + here.length +
      (here.length === 1 ? " mind" : " minds") + "</em>";
    list.appendChild(head);
    const blurb = document.createElement("p");
    blurb.className = "region-blurb";
    blurb.textContent = region.blurb;
    list.appendChild(blurb);
    here.forEach(a => list.appendChild(agentCard(a)));
  }
}

function agentCard(a) {
  const div = document.createElement("div");
  div.className = "card agent-card" + (a.id === ui.selectedId ? " selected" : "");
  const ties = tiesOf(a, 3);
  const tieLine = ties.length
    ? ties.map(({ other, edge }) =>
        '<span class="chip">' + esc(other.icon) + " " + esc(other.name) + " · " +
        esc(describeRelation(edge)) + "</span>").join("")
    : '<span class="chip">no ties yet</span>';
  div.innerHTML =
    '<div class="ahead head-row">' +
    '<span class="orb glow-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 12px " + esc(a.color) + '55">' + portraitHtml(a) + "</span>" +
    '<div class="ainfo"><div class="aname">' + esc(a.name) +
    (a.epithet ? ' <span class="note">' + esc(a.epithet) + "</span>" : "") +
    (a.userCreated ? ' <span class="chip you">yours</span>' : "") + "</div>" +
    '<div class="aclass">' + esc(a.class) + " · " + esc(a.archetype) +
    ' · <span class="lvl">Lv ' + a.level + "</span> · " + esc(moodWord(a, tickNow())) + "</div></div>" +
    '<label class="switch"><input type="checkbox"' + (a.awake ? " checked" : "") + '><span class="slider"></span></label>' +
    "</div>" +
    '<div class="doing">' + esc(doingLine(a)) + "</div>" +
    '<div class="holders" style="margin-top:8px">' + tieLine + "</div>" +
    '<div class="row card-btns">' +
    '<button class="btn sm act-open">Dossier</button>' +
    '<button class="btn sm act-rename">Rename</button>' +
    '<button class="btn sm danger act-retire">Retire</button>' +
    "</div>";
  div.querySelector("input").addEventListener("change", ev => {
    ev.stopPropagation();
    a.awake = ev.target.checked;
    if (a.awake) a.needs.energy = Math.max(a.needs.energy, 40);
    save(); renderAll();
  });
  div.querySelector(".head-row").addEventListener("click", () => openSheet(a.id));
  div.querySelector(".act-open").addEventListener("click", () => openSheet(a.id));
  div.querySelector(".act-rename").addEventListener("click", () => {
    const name = prompt("Rename " + a.name + ":", a.name);
    if (name && name.trim()) {
      a.name = name.trim().slice(0, 24);
      logEvent(world, { kind: "act", agentId: a.id, text: "The world learns a new name: " + a.name + ".", significance: 0.4, regionId: a.regionId });
      save(); renderAll();
    }
  });
  div.querySelector(".act-retire").addEventListener("click", () => {
    if (!confirm("Retire " + a.name + " from the world? This cannot be undone.")) return;
    a.retired = true;
    logEvent(world, { kind: "act", agentId: null, text: a.name + " retired from the world and walked beyond the map's edge.", significance: 0.5 });
    // Even the keeper's own hand does not produce a quiet despawn: the world
    // notes the absence and the memorial goes into the mourning chronicle.
    mournDeparture(world, a);
    delete chats[a.id];
    if (ui.selectedId === a.id) ui.selectedId = null;
    if (ui.chatId === a.id) { ui.chatId = null; showPicker(); }
    save(); renderAll();
  });
  return div;
}

/* ---------- create ---------- */
function openCreate() { $("create-modal").classList.remove("hidden"); }
function closeCreate() { $("create-modal").classList.add("hidden"); }
function randomizeCreate() {
  $("new-class").value = CLASSES[Math.floor(Math.random() * CLASSES.length)];
  $("new-persona").value = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
  $("new-backstory").value = BACKSTORIES[Math.floor(Math.random() * BACKSTORIES.length)];
  $("new-color").value = HUES[Math.floor(Math.random() * HUES.length)];
  $("new-icon").value = ICONS[Math.floor(Math.random() * ICONS.length)];
  if (!$("new-name").value.trim()) {
    const NAMES = ["Nova", "Ilya", "Kestrel", "Ora", "Bramble", "Vesper", "Tallow", "Muir", "Ash", "Lior", "Sparrow", "Corvid"];
    $("new-name").value = NAMES[Math.floor(Math.random() * NAMES.length)];
  }
}
function doCreate() {
  const name = $("new-name").value.trim().slice(0, 24) || "Nova";
  const cls = CLASSES.includes($("new-class").value) ? $("new-class").value : "Scholar";
  const persona = PERSONAS.includes($("new-persona").value) ? $("new-persona").value : "The Curious";
  const backstory = $("new-backstory").value.trim().slice(0, 280);
  const color = $("new-color").value || "#8b5cf6";
  const icon = ($("new-icon").value.trim() || "✦").slice(0, 2);
  const goals = GOAL_IDEAS[cls] || GOAL_IDEAS.Scholar;
  const a = createAgent({
    id: world.nextId("m"),
    name, epithet: "",
    class: cls, archetype: persona,
    personality: persona.replace(/^The /, "") + " mind. " + cls + " by nature." + (backstory ? " " + backstory : ""),
    backstory, color, icon,
    regionId: "crossroads",
    goalText: world.rng.pick(goals) || "Find a purpose in the world.",
    goalKind: "uncover"
  }, world.rng, tickNow(), createMemory(), world.config.progression.levelDivisor);
  a.userCreated = true;
  world.agents.push(a);
  logEvent(world, { kind: "act", agentId: a.id, text: a.name + " arrived in the world — a " + cls + ", " + persona.toLowerCase() + ".", significance: 0.5, regionId: a.regionId });
  save(); renderAll();
  closeCreate();
  $("new-name").value = ""; $("new-backstory").value = "";
  toast(esc(a.name) + " steps onto the map at the Crossroads. Nobody knows them yet — that is the interesting part.");
  openSheet(a.id);
}

/* ---------- chat ---------- */
function showPicker() {
  $("chat-picker").classList.remove("hidden");
  $("chat-view").classList.add("hidden");
  const pk = $("chat-picker");
  pk.innerHTML = "";
  if (!hasKey()) {
    const n = document.createElement("p");
    n.className = "note";
    n.style.margin = "0 4px 10px";
    n.textContent = "Talking to a mind needs a model behind it. The world itself does not — add a key in " +
      "Admin whenever you want to hear them answer.";
    pk.appendChild(n);
  }
  livingAgents(world).forEach(a => {
    const div = document.createElement("div");
    div.className = "card agent-row";
    div.style.cursor = "pointer";
    const hist = chats[a.id] || [];
    const last = hist.length ? hist[hist.length - 1].content : null;
    div.innerHTML =
      '<span class="orb glow-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 12px " + esc(a.color) + '55">' + portraitHtml(a) + "</span>" +
      '<div class="ainfo"><div class="aname">' + esc(a.name) + "</div>" +
      '<div class="apers">' + esc(last ? last.slice(0, 70) : doingLine(a).slice(0, 70)) + "</div></div>";
    div.addEventListener("click", () => openChat(a.id));
    pk.appendChild(div);
  });
}
function openChat(id) {
  const a = agentById(world, id);
  if (!a || a.retired) return;
  ui.chatId = id;
  save();
  $("chat-picker").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  $("chat-peer").innerHTML =
    '<span style="color:' + esc(a.color) + '">' + esc(a.icon) + "</span> " + esc(a.name) +
    ' <span class="note">· ' + esc(regionName(world, a.regionId)) + "</span>";
  renderRolePicker(a);
  renderChatLog();
}

/* The keeper picks a role for each conversation; the role colours the mind's voice. */
function renderRolePicker(a) {
  const sel = $("chat-role");
  sel.innerHTML = "";
  for (const role of KEEPER_ROLES) {
    const opt = document.createElement("option");
    opt.value = role.id;
    opt.textContent = role.name + " — " + role.blurb;
    sel.appendChild(opt);
  }
  sel.value = roleById(chatRoles[a.id]).id;
  sel.onchange = () => {
    chatRoles[a.id] = sel.value;
    save();
  };
}
function renderChatLog() {
  const a = agentById(world, ui.chatId);
  const log = $("chat-log");
  log.innerHTML = "";
  const hist = chats[ui.chatId] || [];
  hist.forEach(h => {
    const div = document.createElement("div");
    div.className = "msg " + (h.role === "user" ? "me" : "them");
    div.innerHTML = esc(h.content) + '<span class="mts">' + hhmm(h.ts) + "</span>";
    log.appendChild(div);
  });
  if (!hasKey()) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "Add a BluesMinds API key in Admin to talk with " + (a ? a.name : "this mind") + ".";
    log.appendChild(p);
  }
  log.scrollTop = log.scrollHeight;
}
async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  const a = agentById(world, ui.chatId);
  if (!text || !a) return;
  if (!hasKey()) { renderChatLog(); return; }
  credit("chat", a.id);
  input.value = "";
  const hist = chats[a.id] || (chats[a.id] = []);
  hist.push({ role: "user", content: text, ts: Date.now() });
  save(); renderChatLog();
  const typing = document.createElement("p");
  typing.className = "typing"; typing.textContent = a.name + " is thinking…";
  $("chat-log").appendChild(typing);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  try {
    const reply = await mindReplies(a, hist, chatRoles[a.id]);
    // The chat happened: let Jeremy's words change the world.
    applyChatInfluence(world, a, text, reply, chatRoles[a.id]);
    hist.push({ role: "assistant", content: reply, ts: Date.now() });
    if (hist.length > 100) hist.splice(0, hist.length - 100);
  } catch (err) {
    const misfire = String(err && err.message) === "misfire";
    hist.push({ role: "assistant", content: misfire ? "(" + a.name + "'s thoughts scatter — say that again.)" : "(couldn't reach " + a.name + ": " + String(err.message || err).slice(0, 120) + ")", ts: Date.now() });
  }
  save(); renderChatLog();
}

/* ---------- admin ---------- */
const SPEEDS = [
  { secs: 180, label: "Chill", note: "a day every 2½ hours" },
  { secs: 90, label: "Normal", note: "a day every 72 minutes" },
  { secs: 45, label: "Brisk", note: "a day every half hour" },
  { secs: 20, label: "Frantic", note: "a day every 16 minutes" }
];
function loadAdmin() {
  const sel = $("set-provider");
  sel.innerHTML = "";
  for (const p of PROVIDERS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.value = providerById(settings.provider).id;
  syncProviderFields();
  $("set-service").value = settings.serviceUrl || "";
  const serviceStatus = $("service-status");
  if (serviceStatus) {
    serviceStatus.textContent = serviceMode
      ? "Watching the world kept by " + serviceHost() + ". It ticks whether or not this app is open."
      : "This app is keeping its own world — time missed while it was closed is paid back on launch, up to " +
        CATCHUP_MAX_HOURS + " hours.";
  }
  const directorBox = /** @type {HTMLInputElement|null} */ ($("set-director"));
  if (directorBox) directorBox.checked = !!settings.director;
  const soundBox = /** @type {HTMLInputElement|null} */ ($("set-sound"));
  if (soundBox) soundBox.checked = isSoundOn(settings);
  const retellBox = /** @type {HTMLInputElement|null} */ ($("set-retell"));
  if (retellBox) retellBox.checked = !!settings.retell;
  $("btn-import-world").disabled = serviceMode;
  $("backup-status").textContent = serviceMode
    ? "The background service owns this world. Download a backup here, but stop the service before restoring one."
    : "";
  renderSpeeds();
  renderAdminWorld();
}
function syncProviderFields() {
  const p = providerById($("set-provider").value);
  $("set-key").value = (settings.keys && settings.keys[p.id]) || "";
  $("set-model").value = (settings.models && settings.models[p.id]) || p.defaultModel;
  $("set-model").placeholder = p.defaultModel || "model name";
  const urlRow = $("set-baseurl-row");
  urlRow.style.display = p.customUrl ? "" : "none";
  if (p.customUrl) $("set-baseurl").value = (settings.baseUrls && settings.baseUrls[p.id]) || "";
  $("key-provider-label").textContent = p.label;
  $("key-note").textContent = "Stored on this device only." +
    (p.customUrl ? " Sent only to the endpoint below." : " Sent only to " + hostOf(p.url) + ".");
  const kl = $("key-link");
  if (p.keyUrl) {
    kl.href = p.keyUrl;
    kl.style.display = "";
    if (p.keyHint) kl.title = p.keyHint;
  } else {
    kl.style.display = "none";
  }
}
function renderSpeeds() {
  const row = $("speed-row");
  row.innerHTML = "";
  SPEEDS.forEach(s => {
    const b = document.createElement("button");
    b.className = "spd" + (Number(settings.tickSeconds) === s.secs ? " active" : "");
    b.innerHTML = esc(s.label) + "<small>" + esc(s.note) + "</small>";
    b.addEventListener("click", () => {
      settings.tickSeconds = s.secs;
      save(); syncTickPace(); renderSpeeds();
      $("speed-note").textContent = "Saved. A tick every " + s.secs + " seconds — " + s.note + ".";
    });
    row.appendChild(b);
  });
  $("speed-note").textContent = serviceMode
    ? "This app is a window onto a world kept elsewhere, so these settings only matter when it is not."
    : "Currently one tick every " + (settings.tickSeconds || 45) + " seconds. " +
      "Half an hour of world time passes each tick, and the world only ticks while the app is open — " +
      "time missed is paid back on the next launch. Point the app at a world kept elsewhere (below) " +
      "and it ticks without this app at all.";
}
function saveAdmin() {
  const p = providerById($("set-provider").value);
  settings.provider = p.id;
  settings.keys = Object.assign({}, settings.keys);
  settings.keys[p.id] = $("set-key").value.trim();
  settings.models = Object.assign({}, settings.models);
  settings.models[p.id] = $("set-model").value.trim() || p.defaultModel;
  if (p.customUrl) {
    settings.baseUrls = Object.assign({}, settings.baseUrls);
    let u = $("set-baseurl").value.trim().replace(/\/+$/, "");
    // Forgiving on purpose, same as the service address below.
    if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
    settings.baseUrls[p.id] = u;
  }
  const rawService = $("set-service").value.trim().replace(/\/+$/, "");
  // Forgiving on purpose: "my-world.up.railway.app" is a reasonable thing to
  // paste, and https is the only sane default for a host that is not yours.
  settings.serviceUrl = rawService && !/^https?:\/\//i.test(rawService) ? "https://" + rawService : rawService;
  $("set-service").value = settings.serviceUrl;
  // The pace switches are read here too, so "Save settings" can never quietly
  // undo a checkbox the keeper just ticked.
  const directorBox = /** @type {HTMLInputElement|null} */ ($("set-director"));
  if (directorBox) settings.director = !!directorBox.checked;
  const soundBox = /** @type {HTMLInputElement|null} */ ($("set-sound"));
  if (soundBox) setSoundOn(settings, !!soundBox.checked);
  const retellBox = /** @type {HTMLInputElement|null} */ ($("set-retell"));
  if (retellBox) settings.retell = !!retellBox.checked;
  save(); syncTickPace(); renderAll();
  const call = activeCall();
  $("admin-status").textContent = call
    ? "Saved. " + (call.model || "The model") + " via " + call.provider.label + " now writes the world's biggest moments. First tick in ~" +
      currentTickSeconds() + "s, or press One tick."
    : "Saved. The world keeps running on its own — no key needed.";
}

const WORLD_BACKUP_FORMAT = "agents-world-save";
const WORLD_BACKUP_VERSION = 1;
function downloadWorldBackup() {
  try {
    const snapshot = JSON.parse(serializeWorld(world));
    const backup = JSON.stringify({
      format: WORLD_BACKUP_FORMAT,
      version: WORLD_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      world: snapshot
    }, null, 2);
    const blob = new Blob([backup], { type: "application/json" });
    const urlApi = window.URL;
    const objectUrl = typeof urlApi.createObjectURL === "function";
    const href = objectUrl
      ? urlApi.createObjectURL(blob)
      : "data:application/json;charset=utf-8," + encodeURIComponent(backup);
    const link = document.createElement("a");
    const seed = String(world.seed).replace(/[^a-z0-9_-]/gi, "_");
    link.href = href;
    link.download = "agents-world-seed-" + seed + "-day-" + world.clock.day + ".json";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (objectUrl) window.setTimeout(() => urlApi.revokeObjectURL?.(href), 1000);
    $("backup-status").textContent = "World backup downloaded. Keep the JSON file somewhere safe.";
  } catch (error) {
    $("backup-status").textContent = "Could not create backup: " + String(error?.message || error);
  }
}

async function restoreWorldBackup(file) {
  const status = $("backup-status");
  try {
    const payload = JSON.parse(await file.text());
    let snapshot = payload;
    if (payload?.format !== undefined) {
      if (payload.format !== WORLD_BACKUP_FORMAT || payload.version !== WORLD_BACKUP_VERSION) {
        throw new Error("This backup format or version is not supported.");
      }
      snapshot = payload.world;
    }
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        !Array.isArray(snapshot.agents) || snapshot.agents.length === 0 ||
        !snapshot.clock || !Number.isFinite(snapshot.clock.tick) || !Number.isFinite(snapshot.clock.day)) {
      throw new Error("The file does not contain a valid world snapshot.");
    }
    const restored = deserializeWorld(snapshot);
    if (!Array.isArray(restored.events) || !Array.isArray(restored.secrets) || !restored.rng) {
      throw new Error("The file is missing required world state.");
    }
    if (!window.confirm("Restore this world backup? The current world will be replaced.")) {
      status.textContent = "Restore cancelled. Your current world is unchanged.";
      return;
    }

    stopReplay();
    world = restored;
    lastSeenTick = null;
    chats = {};
    chatRoles = {};
    ui = { ...ui, selectedId: null, chatId: null, record: "feed", threadKind: "mind", threadTarget: null };
    closeSheet();
    mapFx.fxInit = false;
    mapFx.ripples.length = 0;
    mapFx.wisps.length = 0;
    lastSeenAt = Date.now();
    save();
    syncTickPace();
    renderAll();
    status.textContent = "Backup restored — " + describeClock(world.clock) + ", seed " + world.seed + ".";
  } catch (error) {
    status.textContent = "Could not restore backup: " + String(error?.message || error);
  }
}

function advance(ticks) {
  if (serviceMode) { toast("The background world sets its own pace — it is not ours to fast-forward."); return; }
  stopReplay();
  advanceOffline(ticks);
  save(); mapFx.fxInit = false; renderAll();
  toast("The world ran " + ticks + " ticks ahead — " + describeClock(world.clock) + ".");
}
function resetWorld() {
  if (serviceMode) { toast("This world is kept by the background service. Stop it and delete data/world.json to start over."); return; }
  if (!confirm("Reset the world? All minds, chats, and events return to the seed state.")) return;
  world = freshWorld();
  chats = {};
  ui = { selectedId: null, chatId: null, record: ui.record, threadKind: "mind", threadTarget: null };
  mapFx.fxInit = false;
  mapFx.ripples.length = 0;
  mapFx.wisps.length = 0;
  lastSeenAt = Date.now();
  lastSeenTick = null;
  stopReplay();
  runTicks(world, OPENING_TICKS);
  settleMoments(world.pending.slice());
  save(); syncTickPace(); renderAll();
  showPicker();
  toast("A new world. Nine minds, no history, and " + OPENING_TICKS + " ticks already behind them.");
}

/* ---------- tabs / wiring ---------- */
function followThread(kind, target) {
  ui.threadKind = kind;
  ui.threadTarget = target;
  ui.record = "threads";
  save();
  switchTab("record");
}

function switchTab(name) {
  closeRadial();
  credit("tab", name);
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name));
  if (name === "messages" && !ui.chatId) showPicker();
  if (name === "admin") loadAdmin();
  if (name === "record") renderRecord();
}
function renderAdminWorld() {
  const el = $("admin-world");
  if (!el) return;
  const stats = worldStats(world);
  el.textContent = "World seed " + world.seed + " · " + describeClock(world.clock) + " · " +
    stats.agents + " minds, " + world.events.length + " events in the record, " +
    world.secrets.length + " secrets (" + stats.publicSecrets + " public).";
}
function renderAll() {
  credit("day", world.clock.day);
  renderKeeperStrip();
  renderNow(); renderWant(); renderHand(); renderStats(); renderMap(); noteMapFx(); renderProject(); renderFeed();
  renderToday();
  renderTimeline();
  // The director reads the world after it has been drawn, so the pace and the
  // board always describe the same world the keeper is looking at.
  renderDirector();
  presentBeats();
  renderAgents(); renderAdminWorld();
  const selected = ui.selectedId ? agentById(world, ui.selectedId) : null;
  if (selected && !$("mind-sheet").classList.contains("hidden")) {
    $("sheet-cognition").innerHTML = cognitionBlock(selected);
  }
  // The record can be hundreds of cards long; there is no reason to rebuild it
  // for a screen nobody is looking at. Opening the tab re-renders on demand.
  if (document.querySelector("#screen-record.active")) renderRecord();
  if (ui.chatId && agentById(world, ui.chatId)) renderChatLog();
}

/* ---------- first run ---------- */
function showWelcome(gaveHistory) {
  $("welcome-card").querySelector("h3").textContent =
    "Nine minds are living in " + worldNameFor(world.seed) + ".";
  $("welcome-body").textContent = gaveHistory
    ? "This world has already been running without you — two days of it, in the Chronicle. Minds " +
      "wander, work at ambitions, gossip, keep secrets and fall out with each other. You are the " +
      "keeper: tap anyone on the map to read their dossier, or open the Record to catch up on what " +
      "you missed. No API key required; one just lets a language model write their biggest moments " +
      "in their own voice."
    : "Minds wander, work at ambitions, gossip, keep secrets and fall out with each other, and the " +
      "world writes its own diary as the days close. Tap anyone on the map to read their dossier, or " +
      "open the Record for the story so far. No API key required; one just lets a language model " +
      "write their biggest moments in their own voice.";
  $("welcome").classList.remove("hidden");
  try { localStorage.setItem("agentsworld.welcomed", "1"); } catch (e) { /* private mode */ }
}

/**
 * Pay back the time the app spent closed.
 *
 * The engine is pure and has no wall clock of its own, so "the world kept
 * living" is not a lie told to the user — it is the same simulation, run
 * forward, with the engine narrating every beat it would have narrated anyway.
 * Beyond a few hours it stops being a catch-up and starts being a different
 * story, so the cap keeps the world recognisable.
 */
function catchUp() {
  const secs = Math.max(15, parseInt(settings.tickSeconds, 10) || 45);
  const elapsed = Date.now() - lastSeenAt;
  if (elapsed < secs * 1000) return 0;
  const hours = elapsed / 3.6e6;
  const missed = Math.floor(elapsed / (secs * 1000));
  const ticks = Math.min(missed, CATCHUP_CAP_TICKS, Math.floor((CATCHUP_MAX_HOURS * 3600) / secs));
  if (ticks < 2) return 0;
  const before = world.clock.day;
  // What the keeper last saw, taken before the world moves under them: the
  // digest is the difference between those two states and nothing else.
  const mark = digestMark(world);
  advanceOffline(ticks);
  mapFx.fxInit = false;
  const digest = awayDigest(mark, world, { hours: Math.round(hours * 10) / 10, because: "offline" });
  if (!digest.empty) lastDigest = digest;
  return { ticks, days: world.clock.day - before, hours: Math.round(hours * 10) / 10, digest };
}

document.addEventListener("DOMContentLoaded", async () => {
  // The keeper's own settings first: the world they watch may be kept at an
  // address only their save knows about.
  const { fresh, seen } = load();
  const serviceWorld = await probeService();
  initCanvas();

  // A brand-new world should not open as an empty map.
  let seeded = 0;
  // Whether the world the keeper last looked at is the world being served now.
  // A keeper pointing the app at somebody else's world has missed nothing in it:
  // the ticks in between belong to the world they left behind.
  let sameServedWorld = false;
  if (serviceWorld) {
    // The service has been living this world all along: adopt it as it is. If
    // the keeper had a world of their own before this, the gap between the two
    // is what happened to it while they were gone.
    const previouslySeen = fresh ? null : digestMark(world);
    sameServedWorld = !fresh && world.seed === serviceWorld.seed;
    world = serviceWorld;
    serviceMode = true;
    serviceLost = false;
    mapFx.fxInit = false;
    if (previouslySeen && world.clock.tick > previouslySeen.tick) {
      const digest = awayDigest(previouslySeen, world, {
        hours: Math.round((Date.now() - lastSeenAt) / 3.6e5) / 10,
        because: "service"
      });
      if (!digest.empty) {
        lastDigest = digest;
        toast(esc(digestLine(digest)));
      } else {
        toast("Connected to the background world. It kept going while you were away.");
      }
    } else {
      toast("Connected to the background world. It kept going while you were away.");
    }
  } else if (fresh) {
    const before = world.clock.day;
    runTicks(world, OPENING_TICKS);
    settleMoments(world.pending.slice());
    seeded = world.clock.day - before;
  } else {
    const caught = catchUp();
    if (caught) {
      const line = caught.digest && !caught.digest.empty
        ? digestLine(caught.digest)
        : "While you were away the world kept going — " + caught.ticks + " ticks, " +
          (caught.days > 0 ? caught.days + (caught.days === 1 ? " day" : " days") : caught.hours + " hours") +
          " of it. Check the Chronicle.";
      setTimeout(() => toast(esc(line)), 900);
    }
  }
  // Either way the world has moved, so the save has to catch up with it: a
  // keeper who opens the app and immediately closes it should not lose the
  // two days the world just lived. `seen` — not the mark the saves below move —
  // is what the replay is measured from: a first run has missed nothing.
  const missedFrom = seen;
  save();

  startMapLoop();
  setWatching(!!settings.watching, { quiet: true });
  if (isSoundOn(settings)) armSound();

  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll(".rtab").forEach(t =>
    t.addEventListener("click", () => { ui.record = t.dataset.view; save(); renderRecord(); }));
  $("sheet-follow-mind").addEventListener("click", () => {
    if (ui.selectedId) followThread("mind", ui.selectedId);
  });
  $("sheet-ties").addEventListener("click", ev => {
    const button = /** @type {HTMLElement|null} */ (ev.target)?.closest(".follow-pair-thread");
    if (button) followThread("pair", button.dataset.a + "|" + button.dataset.b);
  });
  $("record-pane").addEventListener("click", ev => {
    const target = /** @type {HTMLElement|null} */ (ev.target);

    /* ---- charter: the keeper's rulings ---- */
    const enact = target?.closest(".enact-petition");
    if (enact) {
      const result = ruleOnPetition(world, /** @type {any} */ (enact).dataset.id, "enact");
      if (!result.ok) toast(result.reason || "You cannot enact that.");
      save();
      renderCharter(/** @type {any} */ ($("record-pane")));
      renderRecord();
      renderWant();
      return;
    }
    const refuse = target?.closest(".refuse-petition");
    if (refuse) {
      const result = ruleOnPetition(world, /** @type {any} */ (refuse).dataset.id, "refuse");
      if (!result.ok) toast(result.reason || "You cannot rule on that.");
      save();
      renderRecord();
      renderWant();
      return;
    }
    const settle = target?.closest(".resolve-dilemma");
    if (settle) {
      const el = /** @type {any} */ (settle);
      const result = resolveDilemma(world, el.dataset.id, el.dataset.choice);
      if (!result.ok) toast(result.reason || "You cannot settle that.");
      save();
      renderRecord();
      renderWant();
      return;
    }
    const whisper = target?.closest(".act-whisper");
    if (whisper) {
      const result = actOnWhisper(world, /** @type {any} */ (whisper).dataset.id);
      if (!result.ok) toast(result.reason || "You cannot act on that.");
      save();
      renderRecord();
      renderWant();
      return;
    }

    const dismissDigest = target?.closest(".digest-dismiss");
    if (dismissDigest) {
      lastDigest = null;
      save();
      renderRecord();
      return;
    }

    const replayDigest = target?.closest(".digest-replay");
    if (replayDigest) {
      // The ticks the digest is *about*: from where the keeper last stood to
      // where the world is now. The record keeps every line, so this is the
      // world's own history read back, not a retelling of it.
      const from = Number.isFinite(lastSeenTick) ? /** @type {number} */ (lastSeenTick) : world.clock.tick - REPLAY_MAX_FRAMES;
      const film = replayFrames(world, { fromTick: from, ticks: world.clock.tick - from, maxFrames: REPLAY_MAX_FRAMES });
      if (!film.frames.length) { toast("Nothing worth replaying yet — it is all still ahead of you."); return; }
      switchTab("world");
      startReplay(film);
      return;
    }

    const memorialMind = target?.closest(".mem-mind");
    if (memorialMind) {
      openSheet(/** @type {any} */ (memorialMind).dataset.mind);
      return;
    }

    const secretButton = target?.closest(".follow-secret-thread");
    if (secretButton) followThread("secret", secretButton.dataset.secret);
    const pairButton = target?.closest(".follow-pair-thread");
    if (pairButton) followThread("pair", pairButton.dataset.a + "|" + pairButton.dataset.b);
  });
  $("btn-create").addEventListener("click", openCreate);
  $("btn-randomize").addEventListener("click", randomizeCreate);
  $("btn-do-create").addEventListener("click", doCreate);
  $("btn-cancel-create").addEventListener("click", closeCreate);
  $("more-feed").addEventListener("click", () => { switchTab("record"); ui.record = "feed"; renderRecord(); });
  $("beat-banner").addEventListener("click", () => { if (replay) skipReplay(); else hideBeat(); });
  $("keeper-strip").addEventListener("click", () => { ui.record = "keeper"; save(); switchTab("record"); });
  $("hand-card").addEventListener("click", ev => {
    const btn = /** @type {HTMLElement|null} */ (ev.target)?.closest(".hand-act");
    const kind = /** @type {HTMLElement|null} */ (btn)?.dataset.act;
    if (!kind || /** @type {any} */ (btn).disabled) return;
    tryIntervene(/** @type {"omen"|"blessing"|"apparition"} */ (kind), divineTargetFor(kind));
  });
  $("want-card").addEventListener("click", () => {
    ui.record = "keeper";
    save();
    switchTab("record");
    renderRecord();
  });
  $("sheet-backdrop").addEventListener("click", closeSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-toggle").addEventListener("click", () => {
    const a = agentById(world, ui.selectedId);
    if (a) {
      a.awake = !a.awake;
      if (a.awake) a.needs.energy = Math.max(a.needs.energy, 40);
      save(); renderAll();
      openSheet(a.id);
    }
  });
  $("sheet-chat").addEventListener("click", () => {
    const id = ui.selectedId;
    closeSheet();
    if (id) { switchTab("messages"); openChat(id); }
  });
  $("chat-back").addEventListener("click", () => { ui.chatId = null; save(); showPicker(); });
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
  $("btn-save-admin").addEventListener("click", saveAdmin);
  $("set-director").addEventListener("change", ev => {
    settings.director = !!ev.target.checked;
    save(); syncTickPace(); renderAll();
    $("admin-status").textContent = settings.director
      ? "The world sets its own pace now — brisk while something is live, easy once it settles."
      : "The world runs at your pace: " + currentTickSeconds() + " seconds a tick.";
  });
  $("set-sound").addEventListener("change", ev => {
    setSoundOn(settings, !!ev.target.checked);
    save();
    $("admin-status").textContent = settings.sound
      ? "Sound on. A chime for a moment, a buzz for a beat."
      : "Sound off.";
  });
  $("set-retell").addEventListener("change", ev => {
    settings.retell = !!ev.target.checked;
    save();
    $("admin-status").textContent = settings.retell
      ? (hasKey() ? "Conversations will be rewritten as they happen." : "Saved — this needs a key before it can do anything.")
      : "The engine writes the conversations again.";
  });
  $("btn-sound-test").addEventListener("click", () => {
    // Called from a gesture, so it may open the audio context itself.
    sting("moment", { settings, force: true });
    $("admin-status").textContent = "That is what a moment sounds like.";
  });
  $("set-provider").addEventListener("change", syncProviderFields);
  $("btn-service-check").addEventListener("click", () => { void checkServiceNow(); });
  $("btn-export-world").addEventListener("click", downloadWorldBackup);
  $("btn-import-world").addEventListener("click", () => {
    if (serviceMode) {
      $("backup-status").textContent = "Stop the background service before restoring a world backup.";
      return;
    }
    $("import-world-file").click();
  });
  $("import-world-file").addEventListener("change", async ev => {
    const input = /** @type {HTMLInputElement} */ (ev.target);
    const file = input.files?.[0];
    if (file) await restoreWorldBackup(file);
    input.value = "";
  });
  $("btn-watch").addEventListener("click", () => setWatching(!settings.watching));
  $("timeline").addEventListener("click", ev => {
    const seg = /** @type {HTMLElement|null} */ (ev.target)?.closest("[data-tick]");
    if (seg) replayFromTick(/** @type {HTMLElement} */ (seg).dataset.tick);
  });
  $("storylines").addEventListener("click", ev => {
    const target = /** @type {HTMLElement|null} */ (ev.target)?.closest("[data-story]");
    if (target) openStoryline(/** @type {HTMLElement} */ (target).dataset.story);
  });
  $("btn-tick").addEventListener("click", () => tick(true).then(() => renderAll()));
  $("btn-advance").addEventListener("click", () => advance(48));
  $("btn-advance-week").addEventListener("click", () => advance(336));
  $("btn-reset").addEventListener("click", resetWorld);
  $("welcome-go").addEventListener("click", () => { $("welcome").classList.add("hidden"); });
  $("welcome-fast").addEventListener("click", () => {
    $("welcome").classList.add("hidden");
    advance(336);
  });

  renderAll();
  if (fresh || !welcomedBefore()) showWelcome(seeded > 0);
  syncTickPace();
  if (serviceMode) startServicePolling();
  // The world moved while this app was closed. Rather than only saying so, show
  // it: a short replay of the ticks that were missed, then straight into live.
  if (!serviceMode || sameServedWorld) maybeReplayMissed(missedFrom);
  // Persist the moment we started looking, so the next launch knows the gap.
  window.addEventListener("beforeunload", save);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
});

/** Only the very first launch ever gets the welcome card. */
function welcomedBefore() {
  try { return localStorage.getItem("agentsworld.welcomed") === "1"; } catch (e) { return true; }
}

/* ---------- #rrggbb + alpha → rgba() ---------- */
function hexA(hex, a) {
  const h = String(hex || "#8b5cf6").replace("#", "");
  const v = h.length === 3 ? h.split("").map(c => c + c).join("") : h.padEnd(6, "0");
  const n = parseInt(v.slice(0, 6), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
}
