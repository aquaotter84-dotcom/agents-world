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

/* ---------- seed minds (from Jeremy's Snapp prototype) ---------- */
function seedMinds() {
  const seeds = [
    ["Elio", "", "Curious cartographer mapping the unknown", "#34d399", "◉", 30, 34],
    ["Juno", "the Quiet", "Watchful; speaks rarely, and only when it matters", "#f472b6", "✦", 55, 62],
    ["Cass", "", "Schemer; always three moves ahead", "#a78bfa", "❖", 45, 40],
    ["Fable", "", "Storyteller; turns events into myth", "#8b5cf6", "✧", 58, 28],
    ["Sable", "", "Maker; builds tools from scraps", "#f472b6", "⚒", 74, 45],
    ["Pim", "", "Scout; quick feet, quicker eyes", "#22d3ee", "◎", 26, 70],
    ["Wren", "", "Keeper of secrets; never tells all", "#fbbf24", "⛨", 55, 78],
    ["Sei", "", "Tide-reader; feels the world's moods", "#8b5cf6", "✦", 20, 52],
    ["Orin", "", "Mediator; finds the middle path", "#34d399", "⛉", 34, 44]
  ];
  return seeds.map(s => ({
    id: uid("m"), name: s[0], epithet: s[1], personality: s[2],
    color: s[3], icon: s[4], x: s[5], y: s[6],
    awake: true, userCreated: false, thought: "", thoughtAt: 0
  }));
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
  } catch (e) { /* corrupt state: start fresh */ }
}

const $ = id => document.getElementById(id);
const mindById = id => state.minds.find(m => m.id === id);
const awakeMinds = () => state.minds.filter(m => m.awake);
const hasKey = () => !!(state.settings.apiKey && state.settings.apiKey.trim());

/* ---------- BluesMinds ---------- */
async function bmChat(messages, maxTokens) {
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
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 160); } catch (e) {}
      throw new Error("HTTP " + res.status + (detail ? " — " + detail : ""));
    }
    const body = await res.json();
    const text = body && body.choices && body.choices[0] && body.choices[0].message
      ? String(body.choices[0].message.content || "").trim() : "";
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

async function mindActs(mind) {
  const ctx = worldContext(mind.id);
  const sys = "You are " + mind.name + (mind.epithet ? " " + mind.epithet : "") +
    ", " + mind.personality +
    " — one mind among many in a shared living world. Other minds: " + (ctx.others.join(", ") || "none yet") +
    ". Recent events: " + (ctx.recent.join(" | ") || "the world is newly awake") +
    ". In one short vivid sentence, say what you do, decide, or declare now (a world event, third person, e.g. \"Juno broke with the district council over the north wall.\"). Never break character, never mention you are AI, never narrate your reasoning.";
  return bmChat([{ role: "system", content: sys },
    { role: "user", content: "What happens now?" }], 90);
}

async function mindThinks(mind) {
  const sys = "You are " + mind.name + (mind.epithet ? " " + mind.epithet : "") +
    ", " + mind.personality +
    ". Share your current private thought in one short sentence, first person. Never mention you are AI.";
  return bmChat([{ role: "system", content: sys },
    { role: "user", content: "What are you thinking right now?" }], 80);
}

async function mindReplies(mind, history) {
  const sys = "You are " + mind.name + (mind.epithet ? " " + mind.epithet : "") +
    ", " + mind.personality +
    " — one mind in a shared living world, chatting one-on-one with the world's keeper (Jeremy). Stay in character, be vivid but concise (a few sentences max). Never mention you are AI.";
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

/* ---------- agents list ---------- */
function renderAgents() {
  const list = $("agents-list");
  list.innerHTML = "";
  state.minds.forEach(m => {
    const div = document.createElement("div");
    div.className = "card agent-row";
    div.innerHTML =
      '<span class="orb" style="border-color:' + esc(m.color) + '">' + esc(m.icon) + "</span>" +
      '<div class="ainfo"><div class="aname">' + esc(m.name) +
      (m.epithet ? ' <span class="note">' + esc(m.epithet) + "</span>" : "") + "</div>" +
      '<div class="apers">' + esc(m.personality) + "</div></div>" +
      '<label class="switch"><input type="checkbox"' + (m.awake ? " checked" : "") + '><span class="slider"></span></label>' +
      '<button class="del" title="Delete">✕</button>';
    div.querySelector("input").addEventListener("change", ev => {
      m.awake = ev.target.checked; save(); renderAll();
    });
    div.querySelector(".del").addEventListener("click", () => {
      if (!confirm("Remove " + m.name + " from the world?")) return;
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
function doCreate() {
  const name = $("new-name").value.trim().slice(0, 24) || "Nova";
  const personality = $("new-personality").value.trim().slice(0, 140) || "A newcomer, still deciding who to be.";
  const color = $("new-color").value || "#8b5cf6";
  const icon = ($("new-icon").value.trim() || "✦").slice(0, 2);
  const m = {
    id: uid("m"), name, epithet: "", personality, color, icon,
    x: 15 + Math.random() * 70, y: 15 + Math.random() * 70,
    awake: true, userCreated: true, thought: "", thoughtAt: 0
  };
  state.minds.push(m);
  addEvent(m, m.name + " arrived in the world.");
  closeCreate();
  $("new-name").value = ""; $("new-personality").value = "";
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
      const text = await mindActs(m);
      addEvent(m, text);
      if (Math.random() < 0.25) {
        m.x = Math.min(92, Math.max(8, m.x + (Math.random() - 0.5) * 24));
        m.y = Math.min(92, Math.max(8, m.y + (Math.random() - 0.5) * 24));
        save(); renderMap();
      }
    } catch (err) {
      addEvent(m, "The world flickered for " + m.name + " (" + String(err.message || err).slice(0, 100) + ").", true);
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
  $("btn-do-create").addEventListener("click", doCreate);
  $("btn-cancel-create").addEventListener("click", closeCreate);
  $("sheet-backdrop").addEventListener("click", closeSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-toggle").addEventListener("click", () => {
    const m = mindById(state.selectedMindId);
    if (m) { m.awake = !m.awake; save(); closeSheet(); renderAll(); }
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
