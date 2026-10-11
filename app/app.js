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
  moodWord, stateLine, describeClock,
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
function eventCard(e) {
  const a = e.agentId ? agentById(world, e.agentId) : null;
  const icon = a ? a.icon : "⚡";
  const color = a ? a.color : "#9a9aa8";
  const name = a ? agentName(a) : "World";
  const div = document.createElement("div");
  div.className = "card event";
  div.innerHTML =
    '<div class="eicon" style="color:' + esc(color) + '">' + esc(icon) + "</div>" +
    '<div><div class="etext">' + esc(e.text) + "</div>" +
    '<div class="emeta">' + esc(name) + " · tick " + e.tick + "</div></div>";
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

function renderMap() {
  const layer = $("minds-layer");
  layer.innerHTML = "";
  livingAgents(world).forEach(a => {
    const p = mapPos(a);
    const b = document.createElement("button");
    b.className = "mind" + (a.awake ? "" : " asleep");
    b.style.left = p.x + "%";
    b.style.top = p.y + "%";
    b.setAttribute("aria-label", a.name);
    b.innerHTML = '<span class="orb" style="border-color:' + esc(a.color) + '">' + esc(a.icon) + "</span>" +
      '<span class="mlabel">' + esc(a.name) + "</span>";
    b.addEventListener("click", () => openSheet(a.id));
    layer.appendChild(b);
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
    '<span class="orb" style="border-color:' + esc(a.color) + '">' + esc(a.icon) + "</span>" +
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
      '<span class="orb" style="border-color:' + esc(a.color) + '">' + esc(a.icon) + "</span>" +
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
      '<span class="orb" style="border-color:' + esc(a.color) + '">' + esc(a.icon) + "</span>" +
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
  renderStats(); renderMap(); renderFeed(); renderFullFeed(); renderAgents(); renderAdminWorld();
  if (ui.chatId && agentById(world, ui.chatId)) renderChatLog();
}

document.addEventListener("DOMContentLoaded", () => {
  load();
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
