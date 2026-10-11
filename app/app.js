/* Agents World — real AI minds on a living map.
 * Vanilla JS, no build step. State persists in localStorage (key below).
 * The BluesMinds API key lives ONLY in localStorage, is never logged, and is
 * sent only to https://api.bluesminds.com. No background service in v1: the
 * tick loop runs only while the app is open.
 */
"use strict";

const STORE_KEY = "agentsworld.v1";
const BM_URL = "https://api.bluesminds.com/v1/chat/completions";
const THOUGHT_TTL_MS = 5 * 60 * 1000;

function uid(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function hhmm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* ---------- RPG layer: classes, archetypes, stats ---------- */
const CLASSES = {
  Scholar:  { drives: { focus: 80, social: 40, courage: 35, creativity: 65 }, flavor: "Studies the world to understand it." },
  Warden:   { drives: { focus: 55, social: 35, courage: 85, creativity: 40 }, flavor: "Stands guard over what matters." },
  Diplomat: { drives: { focus: 45, social: 90, courage: 50, creativity: 55 }, flavor: "Weaves others together." },
  Maker:    { drives: { focus: 65, social: 45, courage: 55, creativity: 90 }, flavor: "Builds what the world needs." }
};
const PERSONALITIES = {
  "The Curious": "Asks questions the world hasn't heard.",
  "The Stoic":   "Endures; speaks only when it counts.",
  "The Dreamer": "Sees what could be, not only what is.",
  "The Bold":    "Acts first and answers later."
};
const DRIVE_KEYS = ["focus", "social", "courage", "creativity"];
const GOAL_IDEAS = {
  Scholar:  ["Uncover the world's oldest secret.", "Map what lies beyond the far edge.", "Write the true history of the council."],
  Warden:   ["Keep the north wall standing.", "Guard the lantern district at all costs.", "Find the breach before it finds us."],
  Diplomat: ["Bring the feuding minds back to one table.", "Learn every mind's hidden want.", "Keep the council from breaking apart."],
  Maker:    ["Build a tool the world has never seen.", "Raise a beacon that never goes dark.", "Forge something that outlives its maker."]
};
const BACKSTORY_SNIPPETS = [
  "Arrived with nothing but a name and a debt.",
  "Once kept the old archives; left when they burned.",
  "Remembers a world before this one, or claims to.",
  "Was found asleep at the crossroads, clutching a map.",
  "Traded a memory for passage into the world.",
  "Grew up in the lantern district's lower wards.",
  "Swore an oath no one else remembers.",
  "Followed a rumor here and stayed for the truth."
];

function levelOf(m) { return 1 + Math.floor(Math.sqrt((m.xp || 0) / 50)); }
function moodWord(m) {
  // Transient triumph overrides the energy read for a while.
  if (m.mood === "triumphant" && m.moodAt && Date.now() - m.moodAt < 10 * 60 * 1000) return "triumphant";
  const e = m.energy == null ? 80 : m.energy;
  if (e > 60) return "content";
  if (e >= 30) return "restless";
  return "weary";
}
function classOf(m) { return CLASSES[m.class] ? m.class : "Scholar"; }
function driveBase(m, d) { return CLASSES[classOf(m)].drives[d]; }

function rpgStats(cls, jitter) {
  const base = CLASSES[cls] || CLASSES.Scholar;
  const drives = {};
  DRIVE_KEYS.forEach(d => {
    const j = jitter ? Math.floor((Math.random() - 0.5) * 20) : 0;
    drives[d] = Math.max(5, Math.min(100, base.drives[d] + j));
  });
  return { energy: 80, mood: "content", moodAt: 0, xp: 0, drives };
}

/* ---------- seed minds (from Jeremy's Snapp prototype) ---------- */
function seedMinds() {
  const seeds = [
    // name, epithet, personality, color, icon, x, y, class, archetype, goal
    ["Elio", "", "Curious cartographer mapping the unknown", "#34d399", "◉", 30, 34, "Scholar", "The Curious", "Chart the far edge of the world."],
    ["Juno", "the Quiet", "Watchful; speaks rarely, and only when it matters", "#f472b6", "✦", 55, 62, "Warden", "The Stoic", "Keep the north wall standing."],
    ["Cass", "", "Schemer; always three moves ahead", "#a78bfa", "❖", 45, 40, "Diplomat", "The Bold", "Learn every mind's secret leverage."],
    ["Fable", "", "Storyteller; turns events into myth", "#8b5cf6", "✧", 58, 28, "Scholar", "The Dreamer", "Turn today's events into lasting myth."],
    ["Sable", "", "Maker; builds tools from scraps", "#f472b6", "⚒", 74, 45, "Maker", "The Curious", "Build a tool the world has never seen."],
    ["Pim", "", "Scout; quick feet, quicker eyes", "#22d3ee", "◎", 26, 70, "Warden", "The Bold", "Scout what lies beyond the lantern district."],
    ["Wren", "", "Keeper of secrets; never tells all", "#fbbf24", "⛨", 55, 78, "Diplomat", "The Stoic", "Guard the one secret that must never surface."],
    ["Sei", "", "Tide-reader; feels the world's moods", "#8b5cf6", "✦", 20, 52, "Scholar", "The Dreamer", "Read the tide before it turns."],
    ["Orin", "", "Mediator; finds the middle path", "#34d399", "⛉", 34, 44, "Diplomat", "The Curious", "Keep the council from breaking apart."]
  ];
  return seeds.map(s => Object.assign({
    id: uid("m"), name: s[0], epithet: s[1], personality: s[2],
    color: s[3], icon: s[4], x: s[5], y: s[6],
    awake: true, userCreated: false, thought: "", thoughtAt: 0
  }, {
    class: s[7], persona: s[8], backstory: "",
    goal: s[9]
  }, rpgStats(s[7], false)));
}

/* Fill RPG stats onto minds saved before this layer existed — never wipe. */
function migrateMinds() {
  const seedByName = {};
  seedMinds().forEach(sm => { seedByName[sm.name] = sm; });
  state.minds.forEach(m => {
    const seed = seedByName[m.name];
    if (m.class == null) m.class = seed ? seed.class : "Scholar";
    if (m.persona == null) m.persona = seed ? seed.persona : "The Curious";
    if (m.backstory == null) m.backstory = "";
    if (m.goal == null) m.goal = seed ? seed.goal : "Find a purpose in the world.";
    if (m.energy == null) m.energy = 80;
    if (m.mood == null) { m.mood = "content"; m.moodAt = 0; }
    if (m.xp == null) m.xp = 0;
    if (!m.drives || typeof m.drives !== "object") {
      m.drives = rpgStats(m.class, false).drives;
    } else {
      DRIVE_KEYS.forEach(d => {
        if (typeof m.drives[d] !== "number") m.drives[d] = driveBase(m, d);
      });
    }
  });
}

function defaultState() {
  return {
    minds: seedMinds(),
    events: [],
    chats: {},
    settings: { apiKey: "", model: "openai/gpt-oss-20b", tickSeconds: 90 },
    selectedMindId: null,
    chatMindId: null,
    seq: 0
  };
}

let state = defaultState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage full/blocked */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && Array.isArray(s.minds)) state = Object.assign(defaultState(), s);
    migrateMinds();
  } catch (e) { /* corrupt state: start fresh */ }
}

/* One-line live-state summary fed to the model so acts match the mind's condition. */
function stateLine(m) {
  const d = m.drives || {};
  return "Energy " + (m.energy == null ? 80 : m.energy) + "/100 (" + moodWord(m) + "), " +
    "Level " + levelOf(m) + ", Goal: " + (m.goal || "none yet") + ". " +
    "Drives — Focus " + (d.focus || 0) + ", Social " + (d.social || 0) +
    ", Courage " + (d.courage || 0) + ", Creativity " + (d.creativity || 0) + ".";
}

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
const mindById = id => state.minds.find(m => m.id === id);
const awakeMinds = () => state.minds.filter(m => m.awake);
const hasKey = () => !!(state.settings.apiKey && state.settings.apiKey.trim());

/* ---------- BluesMinds ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
// One model call at a time, spaced out: gpt-oss-20b via BluesMinds rate-limits
// hard on bursts (seen 2026-10-11: simultaneous ticks → HTTP 429). Every mind,
// thought, and chat funnels through this queue.
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
  const key = state.settings.apiKey.trim();
  if (!key) throw new Error("no-key");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(BM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model: state.settings.model || "openai/gpt-oss-20b",
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
    // gpt-oss sometimes puts the text in reasoning_content with content empty
    const text = msg ? String(msg.content || msg.reasoning_content || "").trim() : "";
    if (!text) throw new Error("empty reply");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function worldContext(excludeId) {
  const others = state.minds.filter(m => m.id !== excludeId).map(m => m.name + (m.epithet ? " " + m.epithet : ""));
  const recent = state.events.slice(0, 8).map(e => e.text);
  return { others, recent };
}

/**
 * Reasoning models sometimes leak their planning ("We need to respond as...")
 * or cross-talk about another mind. This strips the scaffolding and keeps only
 * the event. Returns null when nothing salvageable remains — the caller then
 * skips silently instead of posting a misfire to the world's story.
 */
function cleanReply(text, mind) {
  let t = String(text || "").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!t) return null;
  const quoted = t.match(/["“]([^"”]{12,220})["”]/);
  if (quoted) t = quoted[1].trim();
  const meta = /\bwe (need|must|should|will|shall)\b|provide (one|a) (short|vivid) sentence|example:|in third person|never break character|narrat\w* (your|my) reasoning|\bas an ai\b/i;
  const sents = t.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const kept = sents.filter(s => !meta.test(s));
  t = (kept.length ? kept : sents).join(" ").trim();
  if (meta.test(t)) return null; // still reads as planning — drop it
  // Cross-talk guard: acting mind should be the subject, not another mind's brief
  const other = state.minds.find(m => m.id !== mind.id && new RegExp("\\b" + m.name + "\\b", "i").test(t));
  const self = new RegExp("\\b" + mind.name + "\\b", "i").test(t);
  if (other && !self) return null;
  return t || null;
}

async function mindActs(mind) {
  const ctx = worldContext(mind.id);
  const who = mind.name + (mind.epithet ? " " + mind.epithet : "");
  const sys = "You are " + who + ", " + mind.personality +
    " — one mind among many in a shared living world. Other minds: " + (ctx.others.join(", ") || "none yet") +
    ". Recent events: " + (ctx.recent.join(" | ") || "the world is newly awake") +
    ".\nYour live state: " + stateLine(mind) +
    " Act in accordance with it — a weary mind rests, watches, or plots quietly; a bold high-courage mind acts decisively." +
    "\n\nReply with ONLY one short vivid sentence in third person describing what YOU (" + mind.name + ") do, decide, or declare right now. No preamble, no explanation, no planning, no quotes. Stay in character." +
    " If this moment genuinely gives you a new purpose, you may add a second line exactly as: GOAL: <one short line>. Do this only sometimes, when it feels true.";
  const raw = await bmChat([{ role: "system", content: sys },
    { role: "user", content: "What does " + mind.name + " do now?" }], 110);
  // Pull a declared goal off before sanitizing the event text.
  let goal = null;
  const bodyLines = [];
  raw.split("\n").forEach(ln => {
    const gm = ln.match(/^\s*GOAL:\s*(.+?)\s*$/i);
    if (gm && !goal) goal = gm[1].slice(0, 120);
    else bodyLines.push(ln);
  });
  const clean = cleanReply(bodyLines.join("\n"), mind);
  if (!clean) throw new Error("misfire");
  return { text: clean, goal };
}

async function mindThinks(mind) {
  const who = mind.name + (mind.epithet ? " " + mind.epithet : "");
  const sys = "You are " + who + ", " + mind.personality +
    ".\nYour live state: " + stateLine(mind) +
    ".\n\nReply with ONLY your current private thought: one short sentence, first person, colored by your state. No preamble, no planning, no quotes.";
  const raw = await bmChat([{ role: "system", content: sys },
    { role: "user", content: "Your private thought?" }], 80);
  const clean = cleanReply(raw, mind);
  if (!clean) throw new Error("misfire");
  return clean;
}

async function mindReplies(mind, history) {
  const sys = "You are " + mind.name + (mind.epithet ? " " + mind.epithet : "") +
    ", " + mind.personality +
    " — one mind in a shared living world, chatting one-on-one with the world's keeper (Jeremy). " +
    "Your live state: " + stateLine(mind) +
    " Stay in character, be vivid but concise (a few sentences max). Never mention you are AI.";
  const msgs = [{ role: "system", content: sys }]
    .concat(history.slice(-14).map(h => ({ role: h.role, content: h.content })));
  return bmChat(msgs, 220);
}

/* ---------- events / feed ---------- */
function addEvent(mind, text, isError) {
  state.seq += 1;
  state.events.unshift({
    id: uid("e"), seq: state.seq,
    mindId: mind ? mind.id : null,
    name: mind ? (mind.name + (mind.epithet ? " " + mind.epithet : "")) : "World",
    icon: mind ? mind.icon : "⚡",
    color: mind ? mind.color : "#9a9aa8",
    text, ts: Date.now(), error: !!isError
  });
  state.events = state.events.slice(0, 300);
  save();
  renderFeed();
  renderFullFeed();
  renderStats();
}

function eventCard(e) {
  const div = document.createElement("div");
  div.className = "card event" + (e.error ? " error" : "");
  div.innerHTML =
    '<div class="eicon" style="color:' + esc(e.color) + '">' + esc(e.icon) + "</div>" +
    '<div><div class="etext">' + esc(e.text) + "</div>" +
    '<div class="emeta">' + esc(e.name) + " · " + hhmm(e.ts) + "</div></div>";
  return div;
}

function renderFeed() {
  const feed = $("activity-feed");
  feed.innerHTML = "";
  state.events.slice(0, 12).forEach(e => feed.appendChild(eventCard(e)));
  if (!state.events.length) {
    feed.innerHTML = '<p class="note" style="text-align:center">The world is quiet. ' +
      (hasKey() ? "Minds will act on the next tick." : "Add your API key in Admin to wake the minds.") + "</p>";
  }
}

function renderFullFeed() {
  const feed = $("full-feed");
  feed.innerHTML = "";
  state.events.forEach(e => feed.appendChild(eventCard(e)));
  if (!state.events.length) feed.innerHTML = '<p class="note">No events yet.</p>';
}

/* ---------- stats / map ---------- */
function renderStats() {
  const awake = awakeMinds().length;
  $("stat-minds").textContent = state.minds.length;
  $("stat-events").textContent = state.events.length;
  $("stat-avg").textContent = state.minds.length
    ? (state.events.length / state.minds.length).toFixed(1) : "0";
  $("stat-yours").textContent = state.minds.filter(m => m.userCreated).length;
  const sel = state.selectedMindId ? mindById(state.selectedMindId) : state.minds[0];
  $("world-sub").textContent = (sel ? sel.name + "'s view" : "The World") + " · " + awake + " minds awake";
  const badge = $("live-badge");
  const live = hasKey() && awake > 0;
  badge.classList.toggle("paused", !live);
  badge.innerHTML = '<span class="dot"></span>' + (live ? "LIVE" : hasKey() ? "IDLE" : "ASLEEP");
}

function renderMap() {
  const layer = $("minds-layer");
  layer.innerHTML = "";
  state.minds.forEach(m => {
    const b = document.createElement("button");
    b.className = "mind" + (m.awake ? "" : " asleep");
    b.style.left = m.x + "%";
    b.style.top = m.y + "%";
    b.setAttribute("aria-label", m.name);
    b.innerHTML = '<span class="orb" style="border-color:' + esc(m.color) + '">' + esc(m.icon) + "</span>" +
      '<span class="mlabel">' + esc(m.name) + "</span>";
    b.addEventListener("click", () => openSheet(m.id));
    layer.appendChild(b);
  });
}

/* ---------- mind sheet ---------- */
function openSheet(id) {
  const m = mindById(id);
  if (!m) return;
  state.selectedMindId = id;
  save();
  renderStats();
  $("sheet-head").innerHTML =
    '<span class="orb" style="border-color:' + esc(m.color) + '">' + esc(m.icon) + "</span>" +
    "<span>" + esc(m.name) + (m.epithet ? ' <span class="note">' + esc(m.epithet) + "</span>" : "") + "</span>";
  $("sheet-personality").textContent = m.personality + (m.awake ? "" : " (asleep)");
  $("sheet-toggle").textContent = m.awake ? "Sleep" : "Wake";
  const d = m.drives || {};
  $("sheet-rpg").innerHTML =
    '<div class="astats">' +
      '<div class="astat"><span>Level</span><b>' + levelOf(m) + "</b></div>" +
      '<div class="astat"><span>Energy</span>' + energyBar(m.energy) + "<b>" + Math.round(m.energy == null ? 80 : m.energy) + "</b></div>" +
      '<div class="astat"><span>Mood</span><b class="mood">' + esc(moodWord(m)) + "</b></div>" +
      '<div class="astat"><span>XP</span><b>' + (m.xp || 0) + "</b></div>" +
    "</div>" +
    '<div class="drives compact">' +
      driveBar("Foc", d.focus) + driveBar("Soc", d.social) +
      driveBar("Cou", d.courage) + driveBar("Cre", d.creativity) +
    "</div>" +
    '<div class="goal-line"><span class="glabel">GOAL</span> ' + esc(m.goal || "Find a purpose in the world.") + "</div>";
  const thoughtEl = $("sheet-thought");
  const fresh = m.thought && (Date.now() - m.thoughtAt < THOUGHT_TTL_MS);
  if (!hasKey()) {
    thoughtEl.innerHTML = '<span class="note">Asleep — add your API key in Admin to hear its thoughts.</span>';
  } else if (fresh) {
    thoughtEl.textContent = "\u201C" + m.thought + "\u201D";
  } else {
    thoughtEl.innerHTML = '<span class="typing">listening…</span>';
    mindThinks(m).then(t => {
      m.thought = t; m.thoughtAt = Date.now(); save();
      if (!$("mind-sheet").classList.contains("hidden") && state.selectedMindId === id) {
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

/* ---------- agents list (RPG cards) ---------- */
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
function renderAgents() {
  const list = $("agents-list");
  list.innerHTML = "";
  state.minds.forEach(m => {
    const d = m.drives || {};
    const div = document.createElement("div");
    div.className = "card agent-card";
    div.innerHTML =
      '<div class="ahead">' +
        '<span class="orb" style="border-color:' + esc(m.color) + '">' + esc(m.icon) + "</span>" +
        '<div class="ainfo"><div class="aname">' + esc(m.name) +
        (m.epithet ? ' <span class="note">' + esc(m.epithet) + "</span>" : "") + "</div>" +
        '<div class="aclass">' + esc(classOf(m)) + (m.persona ? " · " + esc(m.persona) : "") +
        ' · <span class="lvl">Lv ' + levelOf(m) + "</span></div></div>" +
        '<label class="switch"><input type="checkbox"' + (m.awake ? " checked" : "") + '><span class="slider"></span></label>' +
      "</div>" +
      '<div class="astats">' +
        '<div class="astat"><span>Energy</span>' + energyBar(m.energy) + "<b>" + Math.round(m.energy == null ? 80 : m.energy) + "</b></div>" +
        '<div class="astat"><span>Mood</span><b class="mood">' + esc(moodWord(m)) + "</b></div>" +
        '<div class="astat"><span>XP</span><b>' + (m.xp || 0) + "</b></div>" +
      "</div>" +
      '<div class="drives">' +
        driveBar("Focus", d.focus) + driveBar("Social", d.social) +
        driveBar("Courage", d.courage) + driveBar("Creativity", d.creativity) +
      "</div>" +
      '<div class="goal-line"><span class="glabel">GOAL</span> ' + esc(m.goal || "Find a purpose in the world.") + "</div>" +
      '<div class="row card-btns">' +
        '<button class="btn sm act-rename">Rename</button>' +
        '<button class="btn sm danger act-retire">Retire</button>' +
      "</div>";
    div.querySelector("input").addEventListener("change", ev => {
      m.awake = ev.target.checked;
      if (m.awake) m.energy = Math.max(m.energy == null ? 0 : m.energy, 40);
      save(); renderAll();
    });
    div.querySelector(".act-rename").addEventListener("click", () => {
      const name = prompt("Rename " + m.name + ":", m.name);
      if (name && name.trim()) {
        m.name = name.trim().slice(0, 24);
        addEvent(m, "The world learns a new name: " + m.name + ".");
        save(); renderAll();
      }
    });
    div.querySelector(".act-retire").addEventListener("click", () => {
      if (!confirm("Retire " + m.name + " from the world? This cannot be undone.")) return;
      addEvent(m, m.name + " retired from the world" + (m.epithet ? ", " + m.epithet + "," : "") + " and walked beyond the map's edge.");
      state.minds = state.minds.filter(x => x.id !== m.id);
      delete state.chats[m.id];
      if (state.selectedMindId === m.id) state.selectedMindId = null;
      if (state.chatMindId === m.id) { state.chatMindId = null; showPicker(); }
      save(); renderAll();
    });
    list.appendChild(div);
  });
}

/* ---------- create ---------- */
function openCreate() { $("create-modal").classList.remove("hidden"); }
function closeCreate() { $("create-modal").classList.add("hidden"); }
function randomizeCreate() {
  const classes = Object.keys(CLASSES);
  const personas = Object.keys(PERSONALITIES);
  $("new-class").value = classes[Math.floor(Math.random() * classes.length)];
  $("new-persona").value = personas[Math.floor(Math.random() * personas.length)];
  $("new-backstory").value = BACKSTORY_SNIPPETS[Math.floor(Math.random() * BACKSTORY_SNIPPETS.length)];
  const hues = ["#34d399", "#f472b6", "#a78bfa", "#8b5cf6", "#22d3ee", "#fbbf24", "#f87171", "#60a5fa"];
  $("new-color").value = hues[Math.floor(Math.random() * hues.length)];
  const icons = ["✦", "✧", "❖", "◉", "◎", "⛨", "⛉", "⚒", "☾", "❂"];
  $("new-icon").value = icons[Math.floor(Math.random() * icons.length)];
}
function doCreate() {
  const name = $("new-name").value.trim().slice(0, 24) || "Nova";
  const cls = CLASSES[$("new-class").value] ? $("new-class").value : "Scholar";
  const persona = PERSONALITIES[$("new-persona").value] ? $("new-persona").value : "The Curious";
  const backstory = $("new-backstory").value.trim().slice(0, 280);
  const color = $("new-color").value || "#8b5cf6";
  const icon = ($("new-icon").value.trim() || "✦").slice(0, 2);
  const personality = PERSONALITIES[persona] + " " + CLASSES[cls].flavor +
    (backstory ? " " + backstory : "");
  const goals = GOAL_IDEAS[cls];
  const m = Object.assign({
    id: uid("m"), name, epithet: "", personality, color, icon,
    x: 15 + Math.random() * 70, y: 15 + Math.random() * 70,
    awake: true, userCreated: true, thought: "", thoughtAt: 0,
    class: cls, persona, backstory,
    goal: goals[Math.floor(Math.random() * goals.length)]
  }, rpgStats(cls, true));
  state.minds.push(m);
  addEvent(m, m.name + " arrived in the world — a " + cls + ", " + persona.toLowerCase() + ".");
  closeCreate();
  $("new-name").value = ""; $("new-backstory").value = "";
  renderAll();
}

/* ---------- chat ---------- */
function showPicker() {
  $("chat-picker").classList.remove("hidden");
  $("chat-view").classList.add("hidden");
  const pk = $("chat-picker");
  pk.innerHTML = "";
  state.minds.forEach(m => {
    const div = document.createElement("div");
    div.className = "card agent-row";
    div.style.cursor = "pointer";
    div.innerHTML =
      '<span class="orb" style="border-color:' + esc(m.color) + '">' + esc(m.icon) + "</span>" +
      '<div class="ainfo"><div class="aname">' + esc(m.name) + "</div>" +
      '<div class="apers">' + (m.awake ? esc(m.personality) : "asleep") + "</div></div>";
    div.addEventListener("click", () => openChat(m.id));
    pk.appendChild(div);
  });
}
function openChat(id) {
  const m = mindById(id);
  if (!m) return;
  state.chatMindId = id;
  save();
  $("chat-picker").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  $("chat-peer").innerHTML =
    '<span style="color:' + esc(m.color) + '">' + esc(m.icon) + "</span> " + esc(m.name);
  renderChatLog();
}
function renderChatLog() {
  const m = mindById(state.chatMindId);
  const log = $("chat-log");
  log.innerHTML = "";
  const hist = state.chats[state.chatMindId] || [];
  hist.forEach(h => {
    const div = document.createElement("div");
    div.className = "msg " + (h.role === "user" ? "me" : "them");
    div.innerHTML = esc(h.content) + '<span class="mts">' + hhmm(h.ts) + "</span>";
    log.appendChild(div);
  });
  if (!hasKey()) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "Add your BluesMinds API key in Admin to talk with " + (m ? m.name : "this mind") + ".";
    log.appendChild(p);
  }
  log.scrollTop = log.scrollHeight;
}
async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  const m = mindById(state.chatMindId);
  if (!text || !m) return;
  if (!hasKey()) { renderChatLog(); return; }
  input.value = "";
  const hist = state.chats[m.id] || (state.chats[m.id] = []);
  hist.push({ role: "user", content: text, ts: Date.now() });
  save(); renderChatLog();
  const typing = document.createElement("p");
  typing.className = "typing"; typing.textContent = m.name + " is thinking…";
  $("chat-log").appendChild(typing);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  try {
    const reply = await mindReplies(m, hist);
    hist.push({ role: "assistant", content: reply, ts: Date.now() });
    if (hist.length > 100) hist.splice(0, hist.length - 100);
  } catch (err) {
    hist.push({ role: "assistant", content: "(couldn't reach " + m.name + ": " + String(err.message || err).slice(0, 120) + ")", ts: Date.now() });
  }
  save(); renderChatLog();
}

/* ---------- tick loop ---------- */
let tickTimer = null;
let ticking = false;
async function tick(manual) {
  if (ticking) return;
  ticking = true;
  try {
  const awake = awakeMinds();
  if (!hasKey()) {
    if (manual) addEvent(null, "The minds are asleep — add your API key in Admin to wake them.", true);
    return;
  }
  if (!awake.length) {
    if (manual) addEvent(null, "Every mind is asleep. Wake one in My Agents.", true);
    return;
  }
  const n = 1 + (Math.random() < 0.4 && awake.length > 1 ? 1 : 0);
  const picked = awake.slice().sort(() => Math.random() - 0.5).slice(0, n);
  for (const m of picked) {
    try {
      // Acting costs energy. Spent minds collapse instead of calling the model.
      const cost = 8 + Math.floor(Math.random() * 8);
      m.energy = Math.max(0, (m.energy == null ? 80 : m.energy) - cost);
      if (m.energy <= 0) {
        m.awake = false;
        addEvent(m, m.name + " collapsed into sleep, spent.");
        save(); renderStats(); renderMap(); renderAgents();
        continue;
      }
      const act = await mindActs(m);
      if (act.goal && act.goal !== m.goal) {
        m.goal = act.goal;
        addEvent(m, m.name + " has taken up a new goal: " + act.goal);
      }
      addEvent(m, act.text);
      // Experience and growth.
      const oldLevel = levelOf(m);
      m.xp = (m.xp || 0) + 10 + Math.floor(Math.random() * 16);
      const newLevel = levelOf(m);
      if (newLevel > oldLevel) {
        m.mood = "triumphant"; m.moodAt = Date.now();
        const title = m.epithet ? m.name + " " + m.epithet : m.name;
        addEvent(m, title + " reached level " + newLevel + ".");
      }
      // Drives drift back toward the class baseline.
      if (!m.drives || typeof m.drives !== "object") m.drives = {};
      DRIVE_KEYS.forEach(d => {
        const cur = typeof m.drives[d] === "number" ? m.drives[d] : driveBase(m, d);
        const diff = driveBase(m, d) - cur;
        m.drives[d] = Math.max(0, Math.min(100, cur + Math.max(-3, Math.min(3, diff))));
      });
      if (Math.random() < 0.25) {
        m.x = Math.min(92, Math.max(8, m.x + (Math.random() - 0.5) * 24));
        m.y = Math.min(92, Math.max(8, m.y + (Math.random() - 0.5) * 24));
      }
      save(); renderStats(); renderMap(); renderAgents();
    } catch (err) {
      // Failures stay out of the world's story: the feed is for what happened,
      // not what misfired. Auto-ticks just try again next round; manual ticks
      // get one quiet note.
      if (manual) toast(m.name + ": " + String(err.message || err).slice(0, 90));
    }
  }
  } finally {
    ticking = false;
  }
}
function armTick() {
  if (tickTimer) clearInterval(tickTimer);
  const secs = Math.max(15, parseInt(state.settings.tickSeconds, 10) || 90);
  tickTimer = setInterval(() => { tick(false); }, secs * 1000);
}

/* ---------- admin ---------- */
function loadAdmin() {
  $("set-key").value = state.settings.apiKey || "";
  $("set-model").value = state.settings.model || "openai/gpt-oss-20b";
  $("set-tick").value = state.settings.tickSeconds || 90;
}
function saveAdmin() {
  state.settings.apiKey = $("set-key").value.trim();
  state.settings.model = $("set-model").value.trim() || "openai/gpt-oss-20b";
  state.settings.tickSeconds = Math.max(15, parseInt($("set-tick").value, 10) || 90);
  save(); armTick(); renderAll();
  $("admin-status").textContent = hasKey()
    ? "Saved. The minds are awake — first tick in ~" + state.settings.tickSeconds + "s, or press Tick now."
    : "Saved. Add an API key to wake the minds.";
}
function resetWorld() {
  if (!confirm("Reset the world? All minds, chats, and events return to the seed state.")) return;
  const keepSettings = state.settings;
  state = defaultState();
  state.settings = keepSettings;
  save(); armTick(); renderAll();
}

/* ---------- tabs / wiring ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-" + name));
  if (name === "messages" && !state.chatMindId) showPicker();
}
function renderAll() {
  renderStats(); renderMap(); renderFeed(); renderFullFeed(); renderAgents(); loadAdmin();
  if (state.chatMindId && mindById(state.chatMindId)) renderChatLog();
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
    const m = mindById(state.selectedMindId);
    if (m) {
      m.awake = !m.awake;
      if (m.awake) m.energy = Math.max(m.energy == null ? 0 : m.energy, 40);
      save(); closeSheet(); renderAll();
    }
  });
  $("sheet-chat").addEventListener("click", () => {
    const id = state.selectedMindId;
    closeSheet();
    if (id) { switchTab("messages"); openChat(id); }
  });
  $("chat-back").addEventListener("click", () => { state.chatMindId = null; save(); showPicker(); });
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
  $("btn-save-admin").addEventListener("click", saveAdmin);
  $("btn-tick").addEventListener("click", () => tick(true));
  $("btn-reset").addEventListener("click", resetWorld);
  renderAll();
  armTick();
});
