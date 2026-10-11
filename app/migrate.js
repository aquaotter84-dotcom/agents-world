/* Migrate a v1 (ad-hoc) save into an engine world. Pure: no DOM, no storage.
 * Old minds match engine agents by name; user-created minds become new agents.
 * Old events are folded into the engine log; old chats are remapped by name.
 */
import {
  createWorld, agentById, livingAgents,
  levelFromXp, DRIVE_KEYS
} from "./vendor/engine/index.js";
import { createAgent } from "./vendor/engine/model/agent.js";
import { createMemory } from "./vendor/engine/model/memory.js";
import { logEvent } from "./vendor/engine/model/events.js";

const VALID_CLASSES = ["Scholar", "Warden", "Diplomat", "Maker"];

/**
 * @param {object} old  the parsed agentsworld.v1 save
 * @param {number|string} seed
 * @returns {{ world: object, chats: Record<string, Array> }}
 */
export function migrateV1Save(old, seed) {
  const world = createWorld({ seed });
  const divisor = world.config.progression.levelDivisor;
  const byName = new Map(world.agents.map(a => [a.name, a]));
  const idMap = {};

  for (const m of old.minds || []) {
    let a = byName.get(m.name);
    if (!a) {
      a = createAgent({
        id: world.nextId("m"),
        name: String(m.name || "Nova").slice(0, 24),
        epithet: m.epithet || "",
        class: VALID_CLASSES.includes(m.class) ? m.class : "Scholar",
        archetype: m.persona || "The Curious",
        personality: m.personality || "",
        backstory: m.backstory || "",
        color: m.color || "#8b5cf6",
        icon: m.icon || "✦",
        regionId: "crossroads",
        goalText: m.goal || "Find a purpose in the world.",
        goalKind: "uncover"
      }, world.rng, world.clock.tick, createMemory(), divisor);
      a.userCreated = true;
      world.agents.push(a);
      byName.set(a.name, a);
    }
    if (VALID_CLASSES.includes(m.class)) a.class = m.class;
    if (m.persona) a.archetype = m.persona;
    if (m.personality) a.personality = m.personality;
    if (m.backstory) a.backstory = m.backstory;
    if (m.color) a.color = m.color;
    if (m.icon) a.icon = m.icon;
    if (m.goal) a.goal.text = String(m.goal).slice(0, 120);
    if (typeof m.energy === "number") a.needs.energy = Math.max(0, Math.min(100, m.energy));
    if (typeof m.xp === "number") {
      a.xp = Math.max(0, m.xp);
      a.level = levelFromXp(a.xp, divisor);
    }
    if (m.drives && typeof m.drives === "object") {
      for (const d of DRIVE_KEYS) {
        if (typeof m.drives[d] === "number") a.drives[d] = Math.max(0, Math.min(100, m.drives[d]));
      }
    }
    a.awake = m.awake !== false;
    if (m.userCreated) a.userCreated = true;
    if (m.thought) { a.thought = String(m.thought).slice(0, 240); a.thoughtAt = m.thoughtAt || 0; }
    if (m.id) idMap[m.id] = a.id;
  }

  // Old events are newest-first; fold them in oldest-first so the log reads right.
  const agentForOldId = oldId => {
    const nid = idMap[oldId];
    return nid ? agentById(world, nid) : null;
  };
  for (const e of (old.events || []).slice().reverse()) {
    const agent = e.mindId ? agentForOldId(e.mindId) : null;
    logEvent(world, {
      kind: "act",
      agentId: agent ? agent.id : null,
      text: String(e.text || "").slice(0, 600),
      significance: 0.3,
      regionId: agent ? agent.regionId : undefined
    });
  }

  const chats = {};
  for (const [oldId, hist] of Object.entries(old.chats || {})) {
    const nid = idMap[oldId];
    if (nid && Array.isArray(hist)) chats[nid] = hist;
  }

  return { world, chats };
}
