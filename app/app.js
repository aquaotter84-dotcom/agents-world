/* Agents World — the engine is the brain, the app is its face.
 * Vanilla JS ES module, no build step. The deterministic simulation engine
 * (vendored from engine/) owns the world; this file renders it and spends the
 * model budget on the engine's moments. State persists in localStorage.
 * The BluesMinds API key lives ONLY in localStorage, is never logged, and is
 * sent only to https://api.bluesminds.com. No background service: ticks run
 * only while the app is open.
 */
import {
  createWorld, step, resolveMoment,
  serializeWorld, deserializeWorld,
  agentById, livingAgents, regionName,
  moodWord, stateLine, describeClock, phaseOf,
  REGIONS, GOAL_IDEAS, BACKSTORIES,
  bondsOf, rivalsOf
} from "./vendor/engine/index.js";
import { createAgent } from "./vendor/engine/model/agent.js";
import { createMemory } from "./vendor/engine/model/memory.js";
import { logEvent } from "./vendor/engine/model/events.js";
import { buildPrompt, parseReply } from "./vendor/server/prompt.js";
import { migrateV1Save } from "./migrate.js";

const STORE_KEY = "agentsworld.v2";
const OLD_KEY = "agentsworld.v1";
const BM_URL = "https://api.bluesminds.com/v1/chat/completions";
const THOUGHT_TTL_MS = 5 * 60 * 1000;

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
let settings = { apiKey: "", model: "openai/gpt-oss-20b", tickSeconds: 90 };
let chats = {};
let ui = { selectedId: null, chatId: null };

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      world: serializeWorld(world),
      settings, chats, ui
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
      ui = Object.assign(ui, s.ui);
      return;
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
        save();
        return;
      }
    }
  } catch (e) { /* corrupt: fall through to fresh */ }
  world = freshWorld();
  save();
}

/* ---------- tiny DOM helpers ---------- */
const $ = id => document.getElementById(id);
let toastTimer = null;
function toast(msg) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}
const tickNow = () => world.clock.tick;
const hasKey = () => !!(settings.apiKey && settings.apiKey.trim());
const agentName = a => a.name + (a.epithet ? " " + a.epithet : "");

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

/* Reasoning models leak planning ("We need to respond as...") or cross-talk.
 * Strip the scaffolding; null means misfire — skip silently. */
function cleanReply(text, agent) {
  let t = String(text || "").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!t) return null;
  const quoted = t.match(/["“]([^"”]{12,220})["”]/);
  if (quoted) t = quoted[1].trim();
  const meta = /\bwe (need|must|should|will|shall)\b|provide (one|a) (short|vivid) sentence|example:|in third person|never break character|narrat\w* (your|my) reasoning|\bas an ai\b/i;
  const sents = t.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const kept = sents.filter(s => !meta.test(s));
  t = (kept.length ? kept : sents).join(" ").trim();
  if (meta.test(t)) return null;
  const other = livingAgents(world).find(m => m.id !== agent.id && new RegExp("\\b" + m.name + "\\b", "i").test(t));
  const self = new RegExp("\\b" + agent.name + "\\b", "i").test(t);
  if (other && !self) return null;
  return t || null;
}

/* ---------- the engine loop ---------- */
let tickTimer = null;
let ticking = false;

async function tick(manual) {
  if (ticking) return;
  ticking = true;
  try {
    if (!hasKey()) {
      if (manual) toast("The minds are asleep — add your API key in Admin to wake them.");
      return;
    }
    const awake = livingAgents(world).filter(a => a.awake);
    if (!awake.length) {
      if (manual) toast("Every mind is asleep. Wake one in My Agents.");
      return;
    }
    const report = step(world);
    save();
    renderWorld();
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
      renderWorld();
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
  const clean = cleanReply(raw, a);
  if (!clean) throw new Error("misfire");
  a.thought = clean;
  a.thoughtAt = Date.now();
  save();
  return clean;
}

async function mindReplies(a, history) {
  const sys = "You are " + agentName(a) + ", " + a.personality +
    " — one mind in a shared living world, chatting one-on-one with the world's keeper (Jeremy). " +
    "Live state: " + stateLine(a, tickNow()) +
    ". Stay in character, be vivid but concise (a few sentences max). Never mention you are AI.";
  const msgs = [{ role: "system", content: sys }]
    .concat(history.slice(-14).map(h => ({ role: h.role, content: h.content })));
  return bmChat(msgs, 220);
}

function armTick() {
  if (tickTimer) clearInterval(tickTimer);
  const secs = Math.max(15, parseInt(settings.tickSeconds, 10) || 90);
  tickTimer = setInterval(() => { tick(false); }, secs * 1000);
}

/* ---------- rendering ---------- */
/* Rarity tones for the feed, by engine event kind. */
const KIND_TONE = {
  triumph: "gold", level: "gold", goal: "gold",
  betrayal: "blood", conflict: "blood", death: "blood",
  secret: "violet", confide: "violet",
  world: "ember", chronicle: "ember",
  gossip: "mist", contact: "mist"
};
/* Stamp events "Day 3 · dusk" from the engine's own clock math. */
function eventStamp(e) {
  try {
    const mpt = (world.config && world.config.minutesPerTick) || 30;
    const mins = world.clock.minutes - (world.clock.tick - e.tick) * mpt;
    const day = Math.floor(mins / 1440) + 1;
    const hour = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
    return "Day " + day + " · " + phaseOf(hour);
  } catch (err) {
    return "tick " + e.tick;
  }
}
function eventCard(e) {
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const icon = a ? a.icon : "⚡";
  const color = a ? a.color : "#9a9aa8";
  const name = a ? agentName(a) : "World";
  const tone = KIND_TONE[e.kind] || "";
  const div = document.createElement("div");
  div.className = "card event" + (tone ? " tone-" + tone : "");
  div.innerHTML =
    '<div class="eicon" style="color:' + esc(color) + '">' + esc(icon) + "</div>" +
    '<div><div class="etext">' + esc(e.text) + "</div>" +
    '<div class="emeta">' + esc(name) + " · " + esc(eventStamp(e)) + "</div></div>";
  return div;
}

function renderFeed() {
  const feed = $("activity-feed");
  feed.innerHTML = "";
  world.events.slice(0, 12).forEach(e => feed.appendChild(eventCard(e)));
  if (!world.events.length) {
    feed.innerHTML = '<p class="note" style="text-align:center">The world is quiet. ' +
      (hasKey() ? "Minds will act on the next tick." : "Add your API key in Admin to wake the minds.") + "</p>";
  }
}
function renderFullFeed() {
  const feed = $("full-feed");
  feed.innerHTML = "";
  world.events.forEach(e => feed.appendChild(eventCard(e)));
  if (!world.events.length) feed.innerHTML = '<p class="note">No events yet.</p>';
}

function renderStats() {
  const living = livingAgents(world);
  const awake = living.filter(a => a.awake).length;
  $("stat-minds").textContent = living.length;
  $("stat-events").textContent = world.events.length;
  $("stat-avg").textContent = living.length ? (world.events.length / living.length).toFixed(1) : "0";
  $("stat-yours").textContent = living.filter(a => a.userCreated).length;
  const sel = ui.selectedId ? agentById(world, ui.selectedId) : living[0];
  $("world-sub").textContent = (sel ? sel.name + "'s view" : "The World") + " · " + awake + " minds awake";
  const badge = $("live-badge");
  const live = hasKey() && awake > 0;
  badge.classList.toggle("paused", !live);
  badge.innerHTML = '<span class="dot"></span>' + (live ? "LIVE" : hasKey() ? "IDLE" : "ASLEEP");
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

const mapFx = {
  cv: null, ctx: null, terrain: null, w: 0, h: 0, dpr: 1,
  orbs: [],            // hit-test cache {id,x,y}
  ripples: [],         // {x,y,t0,color}
  wisps: [],           // {x0,y0,x1,y1,t0}
  motes: [],           // {x,y,vx,vy,r,ph}
  sprites: new Map(),  // pre-rendered orb glow sprites by color|state
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
  // painterly region washes, layered
  for (const r of REGIONS) {
    const art = REGION_ART[r.id] || { core: "#6b5f8a", soft: "rgba(107,95,138,0.15)" };
    const cx = (r.x / 100) * w, cy = (r.y / 100) * h;
    const rad = Math.max(w, h) * 0.30;
    let gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, art.soft);
    gr.addColorStop(0.55, art.soft.replace(/[\d.]+\)$/, "0.07)"));
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    // hot heart of the region
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 0.35);
    gr.addColorStop(0, art.soft.replace(/[\d.]+\)$/, "0.16)"));
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
    g.fillText(r.name, (r.x / 100) * w, (r.y / 100) * h - 34);
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

/* Orb sprites: halo + body + ring pre-rendered once per color/state, so the
 * frame loop is just drawImage + text. Phone GPUs hate per-frame shadowBlur. */
function orbSprite(a) {
  const awake = a.awake && !a.retired;
  const key = (a.color || "#8b5cf6") + (awake ? "|1" : "|0");
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
  sp = { c, S };
  if (mapFx.sprites.size > 48) mapFx.sprites.clear();
  mapFx.sprites.set(key, sp);
  return sp;
}

function drawOrb(g, a, t, glowBoost) {
  const p = mapPos(a);
  const x = (p.x / 100) * mapFx.w;
  const y = (p.y / 100) * mapFx.h + Math.sin(t * 0.0011 + phaseFor(a.id)) * 3;
  const pulse = 1 + Math.sin(t * 0.0021 + phaseFor(a.id) * 2.3) * 0.07;
  const awake = a.awake && !a.retired;
  mapFx.orbs.push({ id: a.id, x, y });
  const sp = orbSprite(a);
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
  g.fillText(String(a.name).toUpperCase().slice(0, 12), x, y + R + 11);
  g.restore();
  // selection ring
  if (ui.selectedId === a.id) {
    g.save();
    g.strokeStyle = hexA(a.color, 0.7 + 0.3 * Math.sin(t * 0.004));
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, R + 7, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
}

/* #rrggbb + alpha → rgba() */
function hexA(hex, a) {
  const h = String(hex || "#8b5cf6").replace("#", "");
  const v = h.length === 3 ? h.split("").map(c => c + c).join("") : h.padEnd(6, "0");
  const n = parseInt(v.slice(0, 6), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
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
  // drifting motes
  for (const m of fx.motes) {
    m.x = (m.x + m.vx + 1) % 1;
    m.y = (m.y + m.vy + 1) % 1;
    const tw = 0.10 + 0.09 * Math.sin(t * 0.001 + m.ph);
    g.fillStyle = "rgba(220,210,255," + Math.max(0.02, tw).toFixed(3) + ")";
    g.beginPath(); g.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2); g.fill();
  }
  // orbs
  fx.orbs.length = 0;
  for (const a of livingAgents(world)) drawOrb(g, a, t, tint.glow);
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
  cv.addEventListener("click", ev => {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bestD = 30;
    for (const o of mapFx.orbs) {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best) openSheet(best.id);
  });
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
  return '<div class="astats">' +
    '<div class="astat"><span>Level</span><b>' + a.level + "</b></div>" +
    '<div class="astat"><span>Energy</span>' + energyBar(a.needs.energy) + "<b>" + Math.round(a.needs.energy) + "</b></div>" +
    '<div class="astat"><span>Mood</span><b class="mood">' + esc(moodWord(a, t)) + "</b></div>" +
    '<div class="astat"><span>XP</span><b>' + a.xp + "</b></div>" +
    "</div>" +
    '<div class="drives compact">' +
    driveBar("Foc", a.drives.focus) + driveBar("Soc", a.drives.social) +
    driveBar("Cou", a.drives.courage) + driveBar("Cre", a.drives.creativity) +
    "</div>" +
    '<div class="goal-line"><span class="glabel">GOAL</span> ' + esc(a.goal.text) + "</div>";
}

function openSheet(id) {
  const a = agentById(world, id);
  if (!a || a.retired) return;
  ui.selectedId = id;
  save();
  renderStats();
  $("sheet-head").innerHTML =
    '<span class="orb sheet-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 22px " + esc(a.color) + '">' + esc(a.icon) + "</span>" +
    "<span>" + esc(a.name) + (a.epithet ? ' <span class="note">' + esc(a.epithet) + "</span>" : "") + "</span>";
  $("sheet-personality").textContent =
    a.class + " · " + a.archetype + " — " + a.personality + " · " +
    regionName(world, a.regionId) + (a.awake ? "" : " (asleep)");
  $("sheet-toggle").textContent = a.awake ? "Sleep" : "Wake";
  const bondNames = bondsOf(a, world.config)
    .map(id => { const b = agentById(world, id); return b ? b.name : null; })
    .filter(Boolean).slice(0, 3);
  const rivalNames = rivalsOf(a, world.config)
    .map(id => { const b = agentById(world, id); return b ? b.name : null; })
    .filter(Boolean).slice(0, 3);
  const ties = (bondNames.length ? "Allied: " + bondNames.join(", ") + ". " : "") +
    (rivalNames.length ? "At odds: " + rivalNames.join(", ") + "." : "");
  $("sheet-rpg").innerHTML = rpgBlock(a) +
    (ties ? '<div class="goal-line"><span class="glabel">TIES</span> ' + esc(ties) + "</div>" : "");
  const thoughtEl = $("sheet-thought");
  const fresh = a.thought && (Date.now() - a.thoughtAt < THOUGHT_TTL_MS);
  if (!hasKey()) {
    thoughtEl.innerHTML = '<span class="note">Asleep — add your API key in Admin to hear its thoughts.</span>';
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
  $("sheet-backdrop").classList.add("hidden");
  $("mind-sheet").classList.add("hidden");
}
function thoughtError(err) {
  if (String(err && err.message) === "no-key") return "Asleep — add your API key in Admin.";
  return "Couldn't reach the mind: " + String(err && err.message || err).slice(0, 120);
}

function renderAgents() {
  const list = $("agents-list");
  list.innerHTML = "";
  livingAgents(world).forEach(a => {
    const div = document.createElement("div");
    div.className = "card agent-card";
    div.innerHTML =
      '<div class="ahead">' +
      '<span class="orb glow-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 12px " + esc(a.color) + '55">' + esc(a.icon) + "</span>" +
      '<div class="ainfo"><div class="aname">' + esc(a.name) +
      (a.epithet ? ' <span class="note">' + esc(a.epithet) + "</span>" : "") + "</div>" +
      '<div class="aclass">' + esc(a.class) + " · " + esc(a.archetype) +
      ' · <span class="lvl">Lv ' + a.level + "</span></div></div>" +
      '<label class="switch"><input type="checkbox"' + (a.awake ? " checked" : "") + '><span class="slider"></span></label>' +
      "</div>" +
      rpgBlock(a) +
      '<div class="goal-line"><span class="glabel">REGION</span> ' + esc(regionName(world, a.regionId)) + "</div>" +
      '<div class="row card-btns">' +
      '<button class="btn sm act-rename">Rename</button>' +
      '<button class="btn sm danger act-retire">Retire</button>' +
      "</div>";
    div.querySelector("input").addEventListener("change", ev => {
      a.awake = ev.target.checked;
      if (a.awake) a.needs.energy = Math.max(a.needs.energy, 40);
      save(); renderWorld();
    });
    div.querySelector(".act-rename").addEventListener("click", () => {
      const name = prompt("Rename " + a.name + ":", a.name);
      if (name && name.trim()) {
        a.name = name.trim().slice(0, 24);
        logEvent(world, { kind: "act", agentId: a.id, text: "The world learns a new name: " + a.name + ".", significance: 0.4, regionId: a.regionId });
        save(); renderWorld();
      }
    });
    div.querySelector(".act-retire").addEventListener("click", () => {
      if (!confirm("Retire " + a.name + " from the world? This cannot be undone.")) return;
      a.retired = true;
      logEvent(world, { kind: "act", agentId: null, text: a.name + " retired from the world and walked beyond the map's edge.", significance: 0.5 });
      delete chats[a.id];
      if (ui.selectedId === a.id) ui.selectedId = null;
      if (ui.chatId === a.id) { ui.chatId = null; showPicker(); }
      save(); renderWorld();
    });
    list.appendChild(div);
  });
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
  save(); renderWorld();
  closeCreate();
  $("new-name").value = ""; $("new-backstory").value = "";
}

/* ---------- chat ---------- */
function showPicker() {
  $("chat-picker").classList.remove("hidden");
  $("chat-view").classList.add("hidden");
  const pk = $("chat-picker");
  pk.innerHTML = "";
  livingAgents(world).forEach(a => {
    const div = document.createElement("div");
    div.className = "card agent-row";
    div.style.cursor = "pointer";
    div.innerHTML =
      '<span class="orb glow-orb" style="border-color:' + esc(a.color) + ";box-shadow:0 0 12px " + esc(a.color) + '55">' + esc(a.icon) + "</span>" +
      '<div class="ainfo"><div class="aname">' + esc(a.name) + "</div>" +
      '<div class="apers">' + (a.awake ? esc(a.personality) : "asleep") + "</div></div>";
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
    '<span style="color:' + esc(a.color) + '">' + esc(a.icon) + "</span> " + esc(a.name);
  renderChatLog();
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
    p.textContent = "Add your BluesMinds API key in Admin to talk with " + (a ? a.name : "this mind") + ".";
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
  input.value = "";
  const hist = chats[a.id] || (chats[a.id] = []);
  hist.push({ role: "user", content: text, ts: Date.now() });
  save(); renderChatLog();
  const typing = document.createElement("p");
  typing.className = "typing"; typing.textContent = a.name + " is thinking…";
  $("chat-log").appendChild(typing);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  try {
    const reply = await mindReplies(a, hist);
    hist.push({ role: "assistant", content: reply, ts: Date.now() });
    if (hist.length > 100) hist.splice(0, hist.length - 100);
  } catch (err) {
    hist.push({ role: "assistant", content: "(couldn't reach " + a.name + ": " + String(err.message || err).slice(0, 120) + ")", ts: Date.now() });
  }
  save(); renderChatLog();
}

/* ---------- admin ---------- */
function loadAdmin() {
  $("set-key").value = settings.apiKey || "";
  $("set-model").value = settings.model || "openai/gpt-oss-20b";
  $("set-tick").value = settings.tickSeconds || 90;
  renderAdminWorld();
}
function saveAdmin() {
  settings.apiKey = $("set-key").value.trim();
  settings.model = $("set-model").value.trim() || "openai/gpt-oss-20b";
  settings.tickSeconds = Math.max(15, parseInt($("set-tick").value, 10) || 90);
  save(); armTick(); renderWorld();
  $("admin-status").textContent = hasKey()
    ? "Saved. The minds are awake — first tick in ~" + settings.tickSeconds + "s, or press Tick now."
    : "Saved. Add an API key to wake the minds.";
}
function resetWorld() {
  if (!confirm("Reset the world? All minds, chats, and events return to the seed state.")) return;
  world = freshWorld();
  chats = {};
  ui = { selectedId: null, chatId: null };
  mapFx.fxInit = false;
  mapFx.ripples.length = 0;
  mapFx.wisps.length = 0;
  save(); armTick(); renderWorld();
  showPicker();
}

/* ---------- tabs / wiring ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name));
  if (name === "messages" && !ui.chatId) showPicker();
  if (name === "admin") loadAdmin();
}
function renderAdminWorld() {
  const el = $("admin-world");
  if (el) el.textContent =
    "World seed " + world.seed + " · " + describeClock(world.clock) +
    " · " + livingAgents(world).length + " minds, " + world.events.length + " events in the record.";
}
function renderWorld() {
  renderStats(); renderMap(); noteMapFx(); renderFeed(); renderFullFeed(); renderAgents(); renderAdminWorld();
  if (ui.chatId && agentById(world, ui.chatId)) renderChatLog();
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  initCanvas();
  startMapLoop();
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("btn-create").addEventListener("click", openCreate);
  $("btn-randomize").addEventListener("click", randomizeCreate);
  $("btn-do-create").addEventListener("click", doCreate);
  $("btn-cancel-create").addEventListener("click", closeCreate);
  $("sheet-backdrop").addEventListener("click", closeSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-toggle").addEventListener("click", () => {
    const a = agentById(world, ui.selectedId);
    if (a) {
      a.awake = !a.awake;
      if (a.awake) a.needs.energy = Math.max(a.needs.energy, 40);
      save(); closeSheet(); renderWorld();
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
  $("btn-tick").addEventListener("click", () => tick(true));
  $("btn-reset").addEventListener("click", resetWorld);
  renderWorld();
  armTick();
});
