/**
 * The Agent: a mind with needs, drives, an ambition, a memory, and opinions
 * about everyone else.
 *
 * An agent is a plain data object. All behaviour lives in `engine/systems/*`,
 * all of it reaching the agent through the functions in this module. Keeping the
 * shape flat and serialisable means the whole world can be written to JSON, sent
 * over a socket, or seeded into a test with one line.
 */

import { clamp } from "../config.js";

/**
 * @typedef {import("./memory.js").Memory} Memory
 * @typedef {import("./relationships.js").RelationEdge} RelationEdge
 */

/**
 * @typedef {object} NeedSet
 * @property {number} energy      Physical reserve. Empty means forced rest.
 * @property {number} connection  Need for company. Empty means lonely, and loneliness drives bad decisions.
 * @property {number} esteem      Need to matter to others. Empty means bitter.
 * @property {number} meaning     Need for purpose. Empty means drifting.
 */

/**
 * @typedef {object} DriveSet
 * @property {number} focus
 * @property {number} social
 * @property {number} courage
 * @property {number} creativity
 */

/**
 * @typedef {object} Goal
 * @property {string} text
 * @property {string} kind        Machine-readable: "uncover" | "protect" | "unite" | "build" | "master" | "avenge"
 * @property {number} progress    0..1
 * @property {number} since       Tick the goal was adopted.
 * @property {number} priority    Multiplier on the weight this goal carries in decisions.
 */

/**
 * @typedef {object} CognitionBelief
 * @property {string} id
 * @property {string} text
 * @property {number} confidence
 * @property {string|null} aboutId
 * @property {number} tick
 */

/**
 * @typedef {object} AgentCognition
 * @property {boolean} enabled
 * @property {{text: string, tick: number}[]} priorities
 * @property {CognitionBelief[]} beliefs
 * @property {string} memorySummary
 * @property {number} lastPlanTick
 * @property {number} nextPlanTick
 * @property {number} planCount
 * @property {{tick: number, text: string, action: string, targetId: string|null, accepted: boolean, reason: string, source: string}} [lastPlan]
 */

/**
 * @typedef {object} Agent
 * @property {string} id
 * @property {string} name
 * @property {string} epithet
 * @property {string} class        Scholar | Warden | Diplomat | Maker
 * @property {string} archetype    Personality archetype name.
 * @property {string} personality  Free-text description used in prompts.
 * @property {string} backstory
 * @property {string} color
 * @property {string} icon
 * @property {string} regionId
 * @property {string} homeRegionId  Where this mind belongs. Gives the map meaning and stops everyone migrating to the busiest place.
 * @property {boolean} awake
 * @property {boolean} userCreated
 * @property {NeedSet} needs
 * @property {DriveSet} drives
 * @property {string} mood       Ambient mood word; see `moodWord`.
 * @property {number} moodUntil  Tick until which a transient mood holds.
 * @property {string} [moodReason]
 * @property {number} moodLevel   0..100 chat-driven mood, 50 neutral. Jeremy's
 *                               words shift it; it decays toward 50 each tick
 *                               and tips `moodWord` at the extremes.
 * @property {{text: string, tick: number}} [suggestedGoal]  A directive Jeremy
 *                               gave in chat, awaiting possible adoption.
 * @property {number} xp
 * @property {number} level
 * @property {Goal} goal
 * @property {AgentCognition} cognition  Private, durable cognition for the small pilot cast.
 * @property {Record<string, RelationEdge>} relations
 * @property {Memory} memory
 * @property {number} createdTick
 * @property {number} lastActedTick          Tick this mind last resolved an intent.
 * @property {number} lastReflectionTick     Tick it was last offered a quiet beat.
 * @property {number} [lastConfideTick]      Tick it last unburdened itself.
 * @property {number} [lastDialogueTick]     Tick it last had a real conversation.
 * @property {number} [lastGoalLoggedTick]   Tick its ongoing work last reached the feed.
 * @property {number} [lastSecretHatchTick]  Tick a deed of its own last became a secret.
 * @property {string} thought     Last private thought (kept for the UI).
 * @property {number} thoughtAt
 * @property {boolean} retired
 * @property {number} standing    -100..100. What the room thinks of them: public
 *                                 reputation, separate from any one mind's private
 *                                 affection. Earned by public deeds, moved faster
 *                                 by gossip than by truth.
 * @property {number} [adriftTicks] Consecutive ticks with connection below the
 *                                 lonely threshold. Resets when they feel held.
 * @property {string} [departureKind] "left" or "died", once they are gone.
 * @property {boolean} seedCast       True for the original nine. They are
 *                                 protected from random departure.
 */

/** Class definitions: the baseline a mind drifts back toward. */
export const CLASSES = {
  Scholar: {
    drives: { focus: 80, social: 40, courage: 35, creativity: 65 },
    flavor: "Studies the world to understand it.",
    /** Which needs this class satisfies more easily. */
    aptitude: { meaning: 1.3, connection: 0.9 }
  },
  Warden: {
    drives: { focus: 55, social: 35, courage: 85, creativity: 40 },
    flavor: "Stands guard over what matters.",
    aptitude: { energy: 1.2, esteem: 1.1 }
  },
  Diplomat: {
    drives: { focus: 45, social: 90, courage: 50, creativity: 55 },
    flavor: "Weaves others together.",
    aptitude: { connection: 1.35, esteem: 1.15 }
  },
  Maker: {
    drives: { focus: 65, social: 45, courage: 55, creativity: 90 },
    flavor: "Builds what the world needs.",
    aptitude: { meaning: 1.2, energy: 1.1 }
  }
};

/** Personality archetypes: the lens a mind sees its own story through. */
export const ARCHETYPES = {
  "The Curious": { blurb: "Asks questions the world hasn't heard.", bias: { focus: 8, creativity: 6 } },
  "The Stoic": { blurb: "Endures; speaks only when it counts.", bias: { focus: 6, courage: 4, social: -8 } },
  "The Dreamer": { blurb: "Sees what could be, not only what is.", bias: { creativity: 10, focus: -4 } },
  "The Bold": { blurb: "Acts first and answers later.", bias: { courage: 12, focus: -6 } },
  "The Kind": { blurb: "Would rather be wronged than do wrong.", bias: { social: 10, courage: -4 } },
  "The Proud": { blurb: "Measures everything against their own name.", bias: { esteem: 0, courage: 6, social: -2 } }
};

export const DRIVE_KEYS = /** @type {const} */ (["focus", "social", "courage", "creativity"]);
export const NEED_KEYS = /** @type {const} */ (["energy", "connection", "esteem", "meaning"]);

/**
 * Level from XP: a square-root curve, so early levels come fast and later ones
 * take real commitment. Level 1 at 0 XP; level 5 at 16*divisor XP.
 * @param {number} xp
 * @param {number} divisor
 */
export function levelFromXp(xp, divisor) {
  return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / divisor));
}

/**
 * XP required to reach a given level. Inverse of `levelFromXp`.
 * @param {number} level
 * @param {number} divisor
 */
export function xpForLevel(level, divisor) {
  const l = Math.max(1, level) - 1;
  return l * l * divisor;
}

/**
 * Progress toward the next level, 0..1. Handy for UI bars.
 * @param {import("../model/agent.js").Agent} agent
 * @param {number} divisor
 * @returns {number}
 */
export function levelProgress(agent, divisor) {
  const current = xpForLevel(agent.level, divisor);
  const next = xpForLevel(agent.level + 1, divisor);
  if (next <= current) return 0;
  return clamp((agent.xp - current) / (next - current), 0, 1);
}

/**
 * The class a mind most behaves like. Unknown classes fall back to Scholar so a
 * @param {import("./agent.js").Agent} agent
 * corrupt save can never crash the sim.
 * @param {Agent} agent
 */
export function classOf(agent) {
  return CLASSES[/** @type {keyof typeof CLASSES} */ (agent.class)] ? agent.class : "Scholar";
}

/**
 * Baseline value of a drive for this agent's class.
 * @param {import("../model/agent.js").Agent} agent
 * @param {string} drive
 * @returns {number}
 */
export function driveBase(agent, drive) {
  const cls = /** @type {any} */ (CLASSES[/** @type {keyof typeof CLASSES} */ (classOf(agent))]);
  return cls.drives[drive] ?? 50;
}

/**
 * Generate a needs/drives set for a new mind, jittered so no two are identical.
 * @param {string} className
 * @param {string} archetype
 * @param {import("../rng.js").Rng} rng
 */
export function rollStats(className, archetype, rng) {
  const cls = CLASSES[/** @type {keyof typeof CLASSES} */ (className)] || CLASSES.Scholar;
  const arch = ARCHETYPES[/** @type {keyof typeof ARCHETYPES} */ (archetype)] || ARCHETYPES["The Curious"];

  /** @type {any} */
  const drives = {};
  const clsDrives = /** @type {Record<string, number>} */ (/** @type {unknown} */ (cls.drives));
  const bias = /** @type {Record<string, number>} */ (/** @type {unknown} */ (arch.bias));
  for (const key of DRIVE_KEYS) {
    const base = (clsDrives[key] ?? 50) + (bias[key] || 0);
    drives[key] = clamp(Math.round(rng.gauss(base, 7)), 5, 100);
  }

  /** @type {NeedSet} */
  const needs = { energy: 82, connection: 65, esteem: 60, meaning: 68 };
  for (const key of NEED_KEYS) {
    needs[key] = clamp(Math.round(rng.gauss(needs[key], 8)), 25, 100);
  }

  return { drives, needs };
}

/**
 * One word for what the room thinks of a mind, from its public standing.
 * @param {number} standing
 */
export function standingWord(standing) {
  if (standing >= 60) return "revered";
  if (standing >= 30) return "respected";
  if (standing >= 10) return "well-regarded";
  if (standing <= -60) return "notorious";
  if (standing <= -30) return "disreputable";
  if (standing <= -10) return "suspect";
  return "unknown";
}

/**
 * How this mind feels right now, in one word, for prompts and the UI.
 *
 * Order matters: a transient triumph outranks everything, then acute need
 * outranks mood, and only then does ambient mood get a say.
 * @param {Agent} agent
 * @param {number} tick
 */
export function moodWord(agent, tick) {
  if (agent.mood === "triumphant" && tick < agent.moodUntil) return "triumphant";
  const n = agent.needs;
  if (n.energy <= 15) return "exhausted";
  if (n.meaning <= 15) return "adrift";
  if (n.esteem <= 15) return "bitter";
  if (n.connection <= 15) return "lonely";
  if (n.energy <= 35) return "weary";
  if (n.connection <= 35) return "restless";
  // Chat-driven mood tips the word at the extremes, but a real transient mood
  // (triumph, a named state) still wins, and depletion words above win first.
  const moodLevel = agent.moodLevel ?? 50;
  if ((!agent.mood || agent.mood === "steady") && moodLevel >= 75) return "bright";
  if ((!agent.mood || agent.mood === "steady") && moodLevel <= 25) return "low";
  if (agent.mood && agent.mood !== "triumphant") return agent.mood;
  if (n.energy > 65 && n.meaning > 60 && n.connection > 55) return "content";
  return "steady";
}

/**
 * The need most in deficit, and how bad it is. Drives most decisions.
 * @param {Agent} agent
 * @returns {{ key: string, value: number, deficit: number }}
 */
export function pressingNeed(agent) {
  let worst = { key: "energy", value: 100, deficit: 0 };
  for (const key of NEED_KEYS) {
/**
 * @param {import("./agent.js").Agent} agent
 */
    const value = agent.needs[key];
    const deficit = 100 - value;
    if (deficit > worst.deficit) worst = { key, value, deficit };
  }
  return worst;
}

/**
 * Average drive value — a crude measure of how forceful a mind is.
 * @param {import("../model/agent.js").Agent} agent
 * @returns {number}
 */
export function driveMean(agent) {
  let sum = 0;
  for (const key of DRIVE_KEYS) sum += agent.drives[key];
  return sum / DRIVE_KEYS.length;
}

/**
 * How alike two minds are in temperament. Used for chemistry: people click with
 * others who want the same things and grate against those who don't.
 *
 * The drives are centred on 50 before comparing. Without that, every pair of
 * minds looks similar — all four drives are positive numbers, so raw cosine
 * similarity sits near 0.9 for almost everyone and the world becomes uniformly
 * pleasant. Centring measures *preference* rather than magnitude, which is what
 * actually decides whether two people get along.
 *
 * @param {Agent} a
 * @param {Agent} b
 * @returns {number} -1 (opposites) .. 1 (kindred)
 */
export function temperamentOverlap(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const key of DRIVE_KEYS) {
    const x = a.drives[key] - 50;
    const y = b.drives[key] - 50;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Diminishing returns on satisfaction.
 *
 * A mind that is nearly full gains almost nothing from another good hour; a mind
 * at the floor gains a great deal. Without this the needs system saturates —
 * every mind ends up pinned at 100 on every axis and stops having any reason to
 * do anything, and the whole simulation goes quiet.
 *
 * @param {number} current 0..100
 * @param {number} amount  Nominal gain at zero.
 */
export function needGain(current, amount) {
  const headroom = Math.max(0, 1 - current / 100);
  return amount * Math.pow(headroom, 1.15);
}

/**
 * A JSON-safe initial cognition record. Pilot status and the first plan offset
 * are assigned by createWorld; keeper-created minds begin outside the pilot.
 * @param {boolean} [enabled]
 * @param {number} [nextPlanTick]
 * @returns {AgentCognition}
 */
export function createCognitionState(enabled = false, nextPlanTick = -1) {
  return {
    enabled,
    priorities: [],
    beliefs: [],
    memorySummary: "",
    lastPlanTick: -1,
    nextPlanTick,
    planCount: 0
  };
}

/**
 * Build a brand-new agent.
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {string} [spec.epithet]
 * @param {string} spec.class
 * @param {string} spec.archetype
 * @param {string} spec.personality
 * @param {string} spec.backstory
 * @param {string} spec.color
 * @param {string} spec.icon
 * @param {string} spec.regionId
 * @param {string} spec.goalText
 * @param {string} [spec.goalKind]
 * @param {boolean} [spec.seedCast]
 * @param {import("../rng.js").Rng} rng
 * @param {number} tick
 * @param {import("./memory.js").Memory} memory
 * @param {number} [levelDivisor]
 * @returns {Agent}
 */
export function createAgent(spec, rng, tick, memory, levelDivisor = 45) {
  const { drives, needs } = rollStats(spec.class, spec.archetype, rng);
  const divisor = levelDivisor;
  return {
    id: spec.id,
    name: spec.name,
    epithet: spec.epithet || "",
    class: spec.class,
    archetype: spec.archetype,
    personality: spec.personality,
    backstory: spec.backstory,
    color: spec.color,
    icon: spec.icon,
    regionId: spec.regionId,
    homeRegionId: spec.regionId,
    awake: true,
    userCreated: false,
    seedCast: spec.seedCast || false,
    needs,
    drives,
    mood: "steady",
    moodUntil: 0,
    moodReason: undefined,
    moodLevel: 50,
    xp: 0,
    level: levelFromXp(0, divisor),
    goal: {
      text: spec.goalText,
      kind: spec.goalKind || "uncover",
      progress: 0,
      since: tick,
      priority: 1
    },
    cognition: createCognitionState(),
    relations: {},
    memory,
    createdTick: tick,
    lastActedTick: -1,
    lastReflectionTick: -1,
    thought: "",
    thoughtAt: 0,
    retired: false,
    standing: 0
  };
}

/**
 * Mark a mind as triumphant. Overrides ambient mood for a while.
 * @param {Agent} agent
 * @param {number} tick
 * @param {number} durationTicks
 * @param {string} [reason]
 */
export function triumph(agent, tick, durationTicks, reason) {
  agent.mood = "triumphant";
  agent.moodUntil = tick + durationTicks;
  agent.moodReason = reason;
}

/**
 * Award XP and report whether the mind levelled up.
 * @param {Agent} agent
 * @param {number} amount
 * @param {number} divisor
 * @returns {{ levelled: boolean, level: number }}
 */
export function grantXp(agent, amount, divisor) {
  agent.xp += Math.max(0, amount);
  const before = agent.level;
  agent.level = levelFromXp(agent.xp, divisor);
  return { levelled: agent.level > before, level: agent.level };
}

/**
 * A compact one-line state summary. This is what the model sees about a mind's
 * condition, so it lives here rather than in the prompt layer.
 * @param {Agent} agent
 * @param {number} tick
 */
export function stateLine(agent, tick) {
  const n = agent.needs;
  const d = agent.drives;
  return (
    `Energy ${Math.round(n.energy)}/100, Connection ${Math.round(n.connection)}/100, ` +
    `Esteem ${Math.round(n.esteem)}/100, Meaning ${Math.round(n.meaning)}/100 — feeling ${moodWord(agent, tick)}. ` +
    `Level ${agent.level}. Goal: ${agent.goal.text} (${Math.round(agent.goal.progress * 100)}% along). ` +
    `Temperament: focus ${d.focus}, social ${d.social}, courage ${d.courage}, creativity ${d.creativity}.`
  );
}
