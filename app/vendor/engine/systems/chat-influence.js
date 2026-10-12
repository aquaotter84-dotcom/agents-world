/**
 * Chat influence: Jeremy's one-on-one chats change the simulation.
 *
 * This module is the bridge between the keeper and the world. Everything here
 * is deterministic and offline-safe — no model calls. The chat reply already
 * happened (that's the one model call per exchange); this runs after it.
 *
 * What a chat does:
 *  1. Sentiment — a small lexicon scores Jeremy's message, with intensifiers
 *     ("very") and negation ("not good" is not good).
 *  2. Mood — warm words lift the mind's moodLevel (+6..10), cold words lower
 *     it (-6..10), clamped 0..100. The keeper's role modulates slightly: a
 *     Demon's barbs cut deeper, a Spirit's comfort soothes more.
 *  3. Memory — a compact trace of what Jeremy said, so minds can recall it
 *     through the normal recall paths.
 *  4. Mentions — naming another living mind warms or chills the speaker's
 *     feelings toward them, by the message's sentiment.
 *  5. Goal seeding — directives ("you should…", "promise me…") are stored as
 *     suggestedGoal; the engine gives the mind a small per-tick chance to
 *     adopt it, announced in the feed.
 *  6. Company — talking is company: a little connection need is satisfied.
 */

import { clamp } from "../config.js";
import { remember } from "../model/memory.js";
import { adjustEdge } from "../model/relationships.js";
import { logEvent } from "../model/events.js";
import { livingAgents } from "../model/world.js";
import { needGain } from "../model/agent.js";

/** Words that warm a message. Curated to avoid atmospheric false positives. */
const POSITIVE = new Set(
  ("adore amazing awesome beautiful beloved best bless blessed brave bravery bright brilliant " +
    "calm celebrate charm charming cheer cheerful cherish comfort comforting courage dear delight " +
    "delighted dream dreams excellent fantastic fond friend friends friendship fun funny gentle glad " +
    "glory good gorgeous grateful gratitude great happy heart hopeful hope inspire inspired inspiring " +
    "joy joyful kind kindness laugh laughter light love loved lovely loyal lucky magic marvelous merry " +
    "nice peace peaceful perfect pleasant precious proud radiant rejoice safe smile soft splendid strong " +
    "strength sun sunny sweet tender thank thanks thrill triumph true trust truth warm warmth welcome " +
    "wise wisdom wonderful worthy").split(" ")
);

/** Words that chill a message. */
const NEGATIVE = new Set(
  ("afraid agony alone anger angry anguish awful bad battle betray betrayal betrayed bitter blame " +
    "bleak blood bored broken brutal burn chaos cheat cheated cruel cruelty cry cursed damage damn " +
    "danger dead death decay deceit defeat despair despise destroy die dire disaster dread dreadful " +
    "dumb enemy evil fail failed failure fake fear fearful fight filth fool foolish frail furious gloom " +
    "grave grief grim guilty guilt hate hateful hideous hollow horror horrible hurt hurts idiot ignore " +
    "ill jealous kill lame lie lies liar lonely lose loss lost mad mean menace miserable misery mistake " +
    "mourn murder nasty nightmare pain painful panic pathetic poison prison rage regret rotten ruin " +
    "sad scare scared scream shame sin sorrow storm stupid suffer suffering tears terrible terror thief " +
    "threat torment toxic tragedy ugly unfair unhappy unloved vile violent war weak weary wicked " +
    "worry worried wound wrong wreck").split(" ")
);

/** Multipliers applied to the next sentiment word. */
const INTENSIFIERS = {
  very: 1.5, really: 1.5, so: 1.4, deeply: 1.6, truly: 1.4,
  extremely: 1.8, incredibly: 1.8, absolutely: 1.7, quite: 1.2,
  rather: 1.15, too: 1.3
};

/** Words that flip the next sentiment word's sign. */
const NEGATIONS = new Set(
  "not no never don't doesn't didn't won't can't cannot isn't aren't wasn't weren't couldn't shouldn't wouldn't".split(" ")
);

/**
 * Score a message's sentiment. Positive warms, negative chills.
 * @param {string} text
 * @returns {number} Weighted sum; >= 1 is warm, <= -1 is cold.
 */
export function scoreSentiment(text) {
  const tokens = String(text || "").toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  let score = 0;
  let negate = false;
  let mult = 1;
  for (const tok of tokens) {
    if (NEGATIONS.has(tok)) { negate = true; continue; }
    const inten = Object.prototype.hasOwnProperty.call(INTENSIFIERS, tok)
      ? /** @type {number} */ (INTENSIFIERS[/** @type {keyof typeof INTENSIFIERS} */ (tok)])
      : 0;
    if (inten) { mult *= inten; continue; }
    let v = 0;
    if (POSITIVE.has(tok)) v = 1;
    else if (NEGATIVE.has(tok)) v = -1;
    else continue;
    if (negate) { v = -v; negate = false; }
    score += v * mult;
    mult = 1;
  }
  // Round to 2dp so the value is stable and readable in reports.
  return Math.round(score * 100) / 100;
}

/**
 * @param {number} score
 * @returns {"warm" | "cold" | "neutral"}
 */
export function sentimentKind(score) {
  if (score >= 1) return "warm";
  if (score <= -1) return "cold";
  return "neutral";
}

/**
 * Small, documented keeper-role modulation of chat mood shifts.
 * A Demon's barbs cut deeper; a Spirit's comfort soothes more.
 * @type {Record<string, { warm: number, cold: number }>}
 */
const ROLE_MOOD_MOD = {
  demon: { warm: 0, cold: 2 },
  spirit: { warm: 2, cold: 0 }
};

/** Per-tick chance a mind adopts a goal Jeremy suggested in chat. */
export const GOAL_ADOPT_PER_TICK = 0.08;

/** Mood swing magnitude at or above this reaches the feed. */
export const FEED_SWING_THRESHOLD = 8;

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Other living minds named in the text (word-boundary, case-insensitive).
 * @param {string} text
 * @param {import("../model/world.js").World} world
 * @param {string} excludeId  The speaker: never "mentions" themselves.
 * @returns {import("../model/agent.js").Agent[]}
 */
function findMentions(text, world, excludeId) {
  /** @type {import("../model/agent.js").Agent[]} */
  const found = [];
  for (const other of livingAgents(world)) {
    if (other.id === excludeId) continue;
    if (found.some(f => f.id === other.id)) continue;
    const re = new RegExp("\\b" + escapeRegExp(other.name) + "\\b", "i");
    if (re.test(text)) found.push(other);
  }
  return found;
}

/** Directive patterns: Jeremy telling a mind what to do or become. */
const DIRECTIVE_RES = [
  /\byou should\s+([^.!?]+)/i,
  /\btry to\s+([^.!?]+)/i,
  /\byour goal is\s+(?:to\s+)?([^.!?]+)/i,
  /\bpromise me\s+(?:that\s+)?(?:you(?:'ll| will)\s+)?([^.!?]+)/i,
  /\bi want you to\s+([^.!?]+)/i,
  /\bmake sure you\s+([^.!?]+)/i
];

/**
 * Pull a goal directive out of Jeremy's message, if it carries one.
 * @param {string} text
 * @returns {string|null} The goal text, trimmed to 120 chars.
 */
export function detectDirective(text) {
  for (const re of DIRECTIVE_RES) {
    const m = String(text || "").match(re);
    if (m && m[1] && m[1].trim().length >= 3) {
      return m[1].trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return null;
}

/**
 * Guess a machine-readable goal kind from the text.
 * @param {string} text
 * @returns {string}
 */
function guessGoalKind(text) {
  const t = text.toLowerCase();
  if (/\b(protect|guard|keep safe|defend|shelter)\b/.test(t)) return "protect";
  if (/\b(build|make|create|craft|forge)\b/.test(t)) return "build";
  if (/\b(unite|together|befriend|gather|reconcile)\b/.test(t)) return "unite";
  if (/\b(master|learn|practice|train|perfect)\b/.test(t)) return "master";
  if (/\b(avenge|revenge|punish|destroy|ruin)\b/.test(t)) return "avenge";
  return "uncover";
}

/**
 * @typedef {object} ChatInfluenceReport
 * @property {number} sentiment        Raw lexicon score.
 * @property {"warm" | "cold" | "neutral"} kind
 * @property {number} moodShift        Applied to moodLevel (0 when neutral).
 * @property {string[]} mentionedIds   Other minds named in the message.
 * @property {boolean} goalSeeded      A directive was stored as suggestedGoal.
 */

/**
 * Apply one chat exchange's influence to the world. Runs after the reply is
 * written — deterministic, no model involved.
 *
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent  The mind Jeremy talked to.
 * @param {string} userText   Jeremy's message.
 * @param {string} replyText  The mind's reply (kept for future use; the reply
 *                            itself doesn't shift the world, Jeremy's words do).
 * @param {string} [roleId]   The keeper role worn for this chat.
 * @returns {ChatInfluenceReport}
 */
export function applyChatInfluence(world, agent, userText, replyText, roleId) {
  void replyText;
  const tick = world.clock.tick;
  const text = String(userText || "");
  const sentiment = scoreSentiment(text);
  const kind = sentimentKind(sentiment);

  /* ---- 2. Mood ---- */
  let moodShift = 0;
  if (kind !== "neutral") {
    const mag = clamp(6 + Math.floor(Math.abs(sentiment) / 2), 6, 10);
    const mod = (roleId && ROLE_MOOD_MOD[roleId]) || { warm: 0, cold: 0 };
    const bonus = kind === "warm" ? mod.warm : mod.cold;
    moodShift = (kind === "warm" ? 1 : -1) * (mag + bonus);
    agent.moodLevel = clamp((agent.moodLevel ?? 50) + moodShift, 0, 100);
    if (Math.abs(moodShift) >= FEED_SWING_THRESHOLD) {
      logEvent(world, {
        kind: "contact",
        agentId: agent.id,
        text: kind === "warm"
          ? `Jeremy's words lift ${agent.name}'s spirits.`
          : `Jeremy's words leave a mark on ${agent.name}.`,
        significance: 0.4,
        regionId: agent.regionId
      });
    }
  }

  /* ---- 3. Memory ---- */
  remember(agent.memory, {
    kind: "contact",
    text: `Jeremy told me: "${text.slice(0, 120)}"`,
    subjectId: null,
    tick,
    valence: clamp(sentiment / 4, -1, 1),
    salience: 0.7
  }, world.nextId);

  /* ---- 4. Third-mind mentions ---- */
  const mentioned = kind === "neutral" ? [] : findMentions(text, world, agent.id);
  const s = kind === "warm" ? 1 : kind === "cold" ? -1 : 0;
  for (const other of mentioned) {
    // Praise warms the speaker toward the named mind; warnings chill.
    adjustEdge(agent, other.id, { affinity: s * 4, trust: s * 4 }, tick);
  }

  /* ---- 5. Goal seeding ---- */
  const directive = detectDirective(text);
  const goalSeeded = directive !== null;
  if (goalSeeded) {
    agent.suggestedGoal = { text: /** @type {string} */ (directive), tick };
  }

  /* ---- 6. Company ---- */
  agent.needs.connection = clamp(
    agent.needs.connection + needGain(agent.needs.connection, 6), 0, 100);

  return {
    sentiment,
    kind,
    moodShift,
    mentionedIds: mentioned.map(m => m.id),
    goalSeeded
  };
}

/**
 * Per-tick chat fallout: mood drifts back to baseline, and a suggested goal
 * may be adopted. Called from the passive-drift pass of `step`.
 *
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function settleChat(world, agent) {
  const tick = world.clock.tick;
  const ml = agent.moodLevel ?? 50;
  if (ml !== 50) {
    const drift = Math.sign(50 - ml) * Math.min(2, Math.abs(50 - ml));
    agent.moodLevel = clamp(ml + drift, 0, 100);
  }
  const sg = agent.suggestedGoal;
  if (sg && agent.awake && !agent.retired) {
    if (world.rng.float() < GOAL_ADOPT_PER_TICK) {
      agent.goal = {
        text: sg.text,
        kind: guessGoalKind(sg.text),
        progress: 0,
        since: tick,
        priority: 1
      };
      delete agent.suggestedGoal;
      logEvent(world, {
        kind: "goal",
        agentId: agent.id,
        text: `${agent.name} takes Jeremy's words to heart: ${sg.text}`,
        significance: 0.6,
        regionId: agent.regionId
      });
      remember(agent.memory, {
        kind: "goal",
        text: `Jeremy gave me a new purpose: "${sg.text}"`,
        subjectId: null,
        tick,
        valence: 0.6,
        salience: 0.85
      }, world.nextId);
    }
  }
}
