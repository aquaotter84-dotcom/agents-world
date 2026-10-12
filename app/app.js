/* Agents World — the engine is the brain, the app is its face.
 * Vanilla JS ES module, no build step. The deterministic simulation engine
 * (vendored from engine/) owns the world; this file renders it and spends the
 * model budget on the engine's moments. State persists in localStorage.
 *
 * Two rules shape everything here:
 *
 *   1. The world never waits for a model. With an API key the biggest beats of
 *      each tick are written by BluesMinds; without one the engine narrates
 *      them itself. Either way the map moves, the feed fills, and days close
 *      into chronicle entries. A key changes the voice, not the world.
 *   2. The engine already knows more than the screen was showing — grudges,
 *      bonds, factions, secrets, what each mind is chewing on — so the UI's job
 *      is to put that on the surface rather than to invent a layer on top.
 *
 * The API key lives ONLY in localStorage, is never logged, and is sent only to
 * https://api.bluesminds.com. No background service: ticks run while the app is
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
  pendingFunerals, recentMemorials, mournDeparture
} from "./vendor/engine/index.js";
import { createAgent } from "./vendor/engine/model/agent.js";
import { createMemory } from "./vendor/engine/model/memory.js";
import { logEvent } from "./vendor/engine/model/events.js";
import { buildPrompt, parseReply } from "./vendor/server/prompt.js";
import { migrateV1Save } from "./migrate.js";
import { portraitSvg } from "./portrait.js";
import { award, summarize, normalizeKeeper, emptyKeeper, RANKS } from "./keeper.js";
import { cleanReply, stripScaffolding } from "./reply-sanitize.js";
import { boardSigils, mindGlyph, feudArcs, constellations, projectPalette, keeperRing, mourningMarks } from "./board.js";

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
const BM_URL = "https://api.bluesminds.com/v1/chat/completions";
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
let settings = { apiKey: "", model: "openai/gpt-oss-20b", tickSeconds: 45 };
let chats = {};
let chatRoles = {};
let ui = { selectedId: null, chatId: null, record: "feed", threadKind: "mind", threadTarget: null };
let lastSeenAt = Date.now();
let keeper = emptyKeeper();

/* ---------- the background service ----------
 * When the runner (server/index.js) is alive it owns the clock: the world keeps
 * ticking whether or not this app is open. In that case the app is a window
 * onto the service's world — it adopts the saved world, stops ticking locally
 * and polls for new ticks. Without a service it runs its own world as before. */
let serviceMode = false;
let servicePollTimer = null;
let serviceLost = false;
const SERVICE_POLL_MS = 10000;

async function probeService() {
  try {
    const r = await fetch("api/world", { cache: "no-store" });
    if (!r.ok) return null;
    return deserializeWorld(await r.text());
  } catch (e) {
    return null; // no service, or not served over http at all (the APK)
  }
}

function startServicePolling() {
  if (servicePollTimer) clearInterval(servicePollTimer);
  servicePollTimer = setInterval(async () => {
    const next = await probeService();
    if (!next) {
      if (!serviceLost) toast("The background world has gone quiet — it will catch up when it is back.");
      serviceLost = true;
      return;
    }
    serviceLost = false;
    if (next.clock.tick === world.clock.tick) return;
    world = next;
    save();
    renderAll();
  }, SERVICE_POLL_MS);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      world: serializeWorld(world),
      settings, chats, chatRoles, ui, keeper, lastSeenAt: Date.now()
    }));
  } catch (e) { /* storage full/blocked */ }
}
function freshWorld(seed) {
  return createWorld({ seed: seed ?? (1 + Math.floor(Math.random() * 1e9)) });
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      world = deserializeWorld(s.world);
      settings = Object.assign(settings, s.settings);
      chats = s.chats || {};
      chatRoles = s.chatRoles || {};
      ui = Object.assign(ui, s.ui);
      keeper = normalizeKeeper(s.keeper);
      lastSeenAt = s.lastSeenAt || Date.now();
      return { fresh: false };
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
          if (old.settings.apiKey) settings.apiKey = old.settings.apiKey;
          if (old.settings.model) settings.model = old.settings.model;
          if (old.settings.tickSeconds) settings.tickSeconds = old.settings.tickSeconds;
        }
        lastSeenAt = Date.now();
        save();
        return { fresh: true };
      }
    }
  } catch (e) { /* corrupt: fall through to fresh */ }
  world = freshWorld();
  lastSeenAt = Date.now();
  save();
  return { fresh: true };
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
const hasKey = () => !!(settings.apiKey && settings.apiKey.trim());
const agentName = a => a.name + (a.epithet ? " " + a.epithet : "");
const modelLabel = () => (hasKey() ? (settings.model || "a model") : "the engine");

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

/* ---------- BluesMinds: one call at a time, spaced, with 429 backoff ---------- */
let bmQueue = Promise.resolve();
let bmNextAt = 0;
let bmBackoffUntil = 0;
const BM_GAP_MS = 4000;

async function bmChat(messages, maxTokens) {
  const task = bmQueue.then(async () => {
    const now = Date.now();
    if (now < bmBackoffUntil) await sleep(bmBackoffUntil - now);
    const gap = bmNextAt - Date.now();
    if (gap > 0) await sleep(gap);
    try {
      return await bmChatOnce(messages, maxTokens);
    } finally {
      bmNextAt = Date.now() + BM_GAP_MS;
    }
  });
  bmQueue = task.catch(() => {}); // a failed call must not break the chain
  return task;
}

async function bmChatOnce(messages, maxTokens) {
  const key = settings.apiKey.trim();
  if (!key) throw new Error("no-key");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(BM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model: settings.model || "openai/gpt-oss-20b",
        messages,
        max_tokens: maxTokens || 120,
        temperature: 0.9
      }),
      signal: ctrl.signal
    });
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("retry-after") || "0", 10);
      bmBackoffUntil = Date.now() + Math.max(isNaN(ra) ? 0 : ra * 1000, 30000);
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
}

async function resolveMomentWithModel(moment, manual) {
  const { messages, maxTokens } = buildPrompt(world, moment);
  if (!messages.length) return;
  try {
    const raw = await bmChat(messages, maxTokens);
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
  const raw = await bmChat([
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
  let clean = cleanReply(await bmChat(msgs, 220), a, livingAgents(world));
  if (!clean) {
    // One retry with a firmer nudge before giving up on this reply.
    const retry = msgs.concat([{ role: "user", content: "Reply now, in character — no planning, no preamble, only the reply itself." }]);
    clean = cleanReply(await bmChat(retry, 220), a, livingAgents(world));
  }
  if (!clean) throw new Error("misfire");
  return clean;
}

function armTick() {
  if (tickTimer) clearInterval(tickTimer);
  const secs = Math.max(15, parseInt(settings.tickSeconds, 10) || 45);
  tickTimer = setInterval(() => { tick(false); }, secs * 1000);
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
  gossip: "mist", contact: "mist"
};
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

function sceneHtml(scene) {
  if (!scene || !scene.length) return "";
  return '<div class="scene">' + scene.map(line => {
    const sp = agentById(world, line.speakerId);
    const who = sp ? sp.name : "?";
    const color = sp ? sp.color : "#9a9aa8";
    return '<div class="sline"><span class="swho" style="color:' + esc(color) + '">' + esc(who) +
      '</span> ' + esc(line.text) + "</div>";
  }).join("") + "</div>";
}
function eventCard(e) {
  if (e.scene && e.scene.length) credit("scene", e.id);
  if (e.kind === "betrayal") credit("betrayal", e.id);
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const icon = a ? a.icon : "⚡";
  const color = a ? a.color : "#9a9aa8";
  const name = a ? agentName(a) : "World";
  const tone = KIND_TONE[e.kind] || "";
  const div = document.createElement("div");
  div.className = "card event" + (tone ? " tone-" + tone : "");
  div.innerHTML =
    '<div class="eicon' + (a ? " tappable" : "") + '" style="color:' + esc(color) + '">' + (a ? portraitHtml(a) : esc(icon)) + "</div>" +
    '<div><div class="etext">' + esc(e.text) + "</div>" + sceneHtml(e.scene) +
    '<div class="emeta"><span class="ewho">' + esc(name) + "</span> · " + esc(eventStamp(e)) + "</div></div>";
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
  badge.innerHTML = '<span class="dot"></span>' + (!live ? "RECOVERING" : hasKey() ? "LIVE" : "SELF-RUNNING");
  $("live-note").textContent = !live
    ? "sleeping minds recover and wake on their own"
    : hasKey() ? (settings.model || "model") : "the engine writes it";
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
function renderFeed() {
  const feed = $("activity-feed");
  feed.innerHTML = "";
  world.events.slice(0, 6).forEach(e => feed.appendChild(eventCard(e)));
  if (!world.events.length) {
    feed.innerHTML = '<p class="note" style="text-align:center">The world is quiet. Give it a tick.</p>';
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
    '<p class="note">' + charter.rules.length + " enacted · " + charter.roles.length +
    " roles the world uses · " + charter.precedents.length + " precedents · " +
    charter.rulingsMade + " rulings made</p>" +
    "</div>";

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
  for (const e of fresh.reverse()) {
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
  }
  if (mapFx.ripples.length > 24) mapFx.ripples.splice(0, mapFx.ripples.length - 24);
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
  $("set-key").value = settings.apiKey || "";
  $("set-model").value = settings.model || "openai/gpt-oss-20b";
  $("btn-import-world").disabled = serviceMode;
  $("backup-status").textContent = serviceMode
    ? "The background service owns this world. Download a backup here, but stop the service before restoring one."
    : "";
  renderSpeeds();
  renderAdminWorld();
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
      save(); armTick(); renderSpeeds();
      $("speed-note").textContent = "Saved. A tick every " + s.secs + " seconds — " + s.note + ".";
    });
    row.appendChild(b);
  });
  $("speed-note").textContent = "Currently one tick every " + (settings.tickSeconds || 45) + " seconds. " +
    "Half an hour of world time passes each tick, and the world only ticks while the app is open — " +
    "time missed is paid back on the next launch.";
}
function saveAdmin() {
  settings.apiKey = $("set-key").value.trim();
  settings.model = $("set-model").value.trim() || "openai/gpt-oss-20b";
  save(); armTick(); renderAll();
  $("admin-status").textContent = hasKey()
    ? "Saved. " + (settings.model || "The model") + " now writes the world's biggest moments. First tick in ~" +
      (settings.tickSeconds || 45) + "s, or press One tick."
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

    world = restored;
    chats = {};
    chatRoles = {};
    ui = { ...ui, selectedId: null, chatId: null, record: "feed", threadKind: "mind", threadTarget: null };
    closeSheet();
    mapFx.fxInit = false;
    mapFx.ripples.length = 0;
    mapFx.wisps.length = 0;
    lastSeenAt = Date.now();
    save();
    armTick();
    renderAll();
    status.textContent = "Backup restored — " + describeClock(world.clock) + ", seed " + world.seed + ".";
  } catch (error) {
    status.textContent = "Could not restore backup: " + String(error?.message || error);
  }
}

function advance(ticks) {
  if (serviceMode) { toast("The background world sets its own pace — it is not ours to fast-forward."); return; }
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
  runTicks(world, OPENING_TICKS);
  settleMoments(world.pending.slice());
  save(); armTick(); renderAll();
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
  renderNow(); renderWant(); renderStats(); renderMap(); noteMapFx(); renderProject(); renderFeed();
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
  advanceOffline(ticks);
  mapFx.fxInit = false;
  return { ticks, days: world.clock.day - before, hours: Math.round(hours * 10) / 10 };
}

document.addEventListener("DOMContentLoaded", async () => {
  const serviceWorld = await probeService();
  const { fresh } = load();
  initCanvas();

  // A brand-new world should not open as an empty map.
  let seeded = 0;
  if (serviceWorld) {
    // The service has been living this world all along: adopt it as it is.
    world = serviceWorld;
    serviceMode = true;
    serviceLost = false;
    mapFx.fxInit = false;
    toast("Connected to the background world. It kept going while you were away.");
  } else if (fresh) {
    const before = world.clock.day;
    runTicks(world, OPENING_TICKS);
    settleMoments(world.pending.slice());
    seeded = world.clock.day - before;
  } else {
    const caught = catchUp();
    if (caught) {
      setTimeout(() => {
        toast("While you were away the world kept going — " + caught.ticks + " ticks, " +
          (caught.days > 0 ? caught.days + (caught.days === 1 ? " day" : " days") : caught.hours + " hours") +
          " of it. Check the Chronicle.");
      }, 900);
    }
  }
  // Either way the world has moved, so the save has to catch up with it: a
  // keeper who opens the app and immediately closes it should not lose the
  // two days the world just lived.
  save();

  startMapLoop();

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
  $("keeper-strip").addEventListener("click", () => { ui.record = "keeper"; save(); switchTab("record"); });
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
  armTick();
  if (serviceMode) startServicePolling();
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
