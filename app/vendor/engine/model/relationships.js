/**
 * Relationships: the directed graph of what every mind thinks of every other.
 *
 * Edges are *asymmetric on purpose*. Cass may adore Wren while Wren merely
 * tolerates Cass, and the drama of this world lives almost entirely in that gap.
 * Nothing here is ever fully known to a mind — an agent acts on its own side of
 * the edge, and can be completely wrong about the other.
 *
 * Four independent axes, because collapsing them loses the interesting cases:
 *   affinity     - Do I like them?          (-100 .. 100)
 *   trust        - Do I believe them?       (0 .. 100)
 *   fear         - Do I avoid them?         (0 .. 100)
 *   resentment   - Do I owe them for a hurt?(0 .. 100)
 *
 * Resentment is separate from low affinity on purpose: you can like someone
 * enormously and still be unable to let go of what they did.
 */

import { clamp } from "../config.js";
import { RELATION_WORDS } from "../content.js";

/**
 * @typedef {object} RelationEdge
 * @property {number} affinity
 * @property {number} trust
 * @property {number} fear
 * @property {number} resentment
 * @property {number} familiarity    0..100. How well I know them, not how much I like them.
 * @property {number} lastContactTick
 * @property {number} contacts       Total interactions, for "someone I've known a long time".
 * @property {number} secretsShared  Secrets of mine I have let them hold.
 * @property {number} debts         Positive: they owe me. Negative: I owe them.
 * @property {number} [lastConflictTick] When this pair last had it out, so they don't live the same argument forever.
 * @property {number} [lastFavourTick] When a favour was last done between this pair, for the creation cooldown and call-in grace period.
 * @property {number} [lastCallInTick] When a debt was last called in between this pair, for the call-in cooldown.
 */

/** A mind's default posture toward a stranger. */
export function neutralEdge() {
  return {
    affinity: 0,
    trust: 40,
    fear: 0,
    resentment: 0,
    familiarity: 0,
    lastContactTick: -1,
    contacts: 0,
    secretsShared: 0,
    debts: 0
  };
}

/**
 * Get (creating if needed) a mind's edge toward another.
 * @param {import("./agent.js").Agent} agent
 * @param {string} otherId
 * @returns {RelationEdge}
 */
export function edgeToward(agent, otherId) {
  let edge = agent.relations[otherId];
  if (!edge) {
    edge = neutralEdge();
    agent.relations[otherId] = edge;
  }
  return edge;
}

/**
 * Apply deltas to an edge and clamp everything into range.
 * @param {import("./agent.js").Agent} agent
 * @param {string} otherId
 * @param {Partial<RelationEdge>} deltas
 * @param {number} tick
 * @returns {RelationEdge}
 */
export function adjustEdge(agent, otherId, deltas, tick) {
  const edge = edgeToward(agent, otherId);
  if (deltas.affinity) edge.affinity = clamp(edge.affinity + deltas.affinity, -100, 100);
  if (deltas.trust) edge.trust = clamp(edge.trust + deltas.trust, 0, 100);
  if (deltas.fear) edge.fear = clamp(edge.fear + deltas.fear, 0, 100);
  if (deltas.resentment) edge.resentment = clamp(edge.resentment + deltas.resentment, 0, 100);
  if (deltas.familiarity) edge.familiarity = clamp(edge.familiarity + deltas.familiarity, 0, 100);
  if (deltas.debts) edge.debts = clamp(edge.debts + deltas.debts, -100, 100);
  if (tick >= 0) edge.lastContactTick = tick;
  return edge;
}

/**
 * Record that two minds actually spent time together.
 * @param {import("./agent.js").Agent} agent
 * @param {string} otherId
 * @param {number} tick
 * @param {any} familiarityGain
 */
export function recordContact(agent, otherId, tick, familiarityGain) {
  const edge = edgeToward(agent, otherId);
  edge.contacts += 1;
  edge.lastContactTick = tick;
  edge.familiarity = clamp(edge.familiarity + familiarityGain, 0, 100);
  return edge;
}

/**
 * Time heals, but unevenly: affection and fear fade quickly, familiarity barely
 * at all, and resentment almost not at all. Old friends can become strangers;
 * old grudges rarely do.
 * @param {import("./agent.js").Agent} agent
 * @param {number} tick
 * @param {import("../config.js").WorldConfig} config
 */
export function decayRelations(agent, tick, config) {
  const cfg = config.relations;
  for (const otherId of Object.keys(agent.relations)) {
    const edge = agent.relations[otherId];
    // Resentment cools fastest when the two are nowhere near each other.
    edge.affinity = toward(edge.affinity, 0, cfg.affinityDecayPerTick);
    edge.familiarity = toward(edge.familiarity, 0, cfg.familiarityDecayPerTick);
    edge.resentment = toward(edge.resentment, 0, cfg.resentmentDecayPerTick);
    // Debts fade too, in both directions — old obligations quietly stop
    // mattering. This is what keeps the ledger from filling up with ancient
    // favours nobody will ever call in.
    edge.debts = toward(edge.debts, 0, config.favours.debtDecayPerTick);
/**
 * @param {number} value
 */
    // Trust drifts back toward the stranger baseline, not toward zero.
    edge.trust = toward(edge.trust, 40, cfg.familiarityDecayPerTick * 2);
  }
}

/**
 * Move `value` toward `target` by at most `step`.
 * @param {number} value
 * @param {number} target
 * @param {number} step
 * @returns {number}
 */
function toward(value, target, step) {
  if (value > target) return Math.max(target, value - step);
  if (value < target) return Math.min(target, value + step);
  return value;
}

/**
 * One word for how a mind regards someone, from that mind's side of the edge.
 * @param {RelationEdge} edge
 */
export function describeRelation(edge) {
  if (edge.resentment >= 60 && edge.affinity < -10) return "hostile";
  if (edge.affinity >= 70 && edge.trust >= 60) return "bonded";
  if (edge.affinity >= 45) return "friendly";
  if (edge.affinity >= 15) return "warm";
  if (edge.affinity <= -50) return "hostile";
  if (edge.affinity <= -20) return "strained";
  if (edge.affinity <= -5) return "cool";
  return "neutral";
}

/**
 * A phrase describing the relationship, for prompts.
 * @param {import("../model/relationships.js").RelationEdge} edge
 * @returns {string}
 */
export function relationPhrase(edge) {
  const word = describeRelation(edge);
  return RELATION_WORDS[/** @type {keyof typeof RELATION_WORDS} */ (word)] || RELATION_WORDS.neutral;
}

/**
 * Everyone this mind would consider an ally.
 * @param {import("./agent.js").Agent} agent
 * @param {import("../config.js").WorldConfig} config
 */
export function bondsOf(agent, config) {
  return Object.entries(agent.relations)
    .filter(([, e]) => e.affinity >= config.relations.allianceThreshold)
    .map(([id]) => id);
}

/**
 * Minds this one has a standing grievance with.
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../config.js").WorldConfig} config
 * @returns {string[]}
 */
export function rivalsOf(agent, config) {
  return Object.entries(agent.relations)
    .filter(([, e]) => e.resentment >= config.relations.rivalryThreshold || e.affinity <= -35)
    .map(([id]) => id);
}

/**
 * Everyone this mind is wary of.
 * @param {import("../model/agent.js").Agent} agent
 * @returns {string[]}
 */
export function fearedOf(agent) {
  return Object.entries(agent.relations).filter(([, e]) => e.fear >= 40).map(([id]) => id);
}

/**
 * Who this mind trusts most, optionally excluding people they're already close
 * to. Used for deciding who to confide in.
 * @param {import("./agent.js").Agent} agent
 * @param {string[]} candidates
 */
export function mostTrusted(agent, candidates) {
  let best = null;
  let bestScore = -Infinity;
  for (const id of candidates) {
    const edge = agent.relations[id];
    if (!edge) continue;
    const score = edge.trust + edge.affinity * 0.5 - edge.fear * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Faction detection: pairs whose affection for each other is mutual.
 *
 * Deliberately simple and computed on demand rather than maintained — the world
 * is small enough that O(n^2) each time anyone asks is cheaper than keeping a
 * structure consistent, and it can't drift out of sync with the edges.
 *
 * @param {import("./agent.js").Agent[]} agents
 * @param {import("../config.js").WorldConfig} config
 * @returns {string[][]} Groups of agent ids, each of size 2+.
 */
export function factions(agents, config) {
  const live = agents.filter(a => !a.retired);
  const byId = new Map(live.map(a => [a.id, a]));
  const threshold = config.relations.factionMutualThreshold;

  /**
   * Union-find over mutual-affection edges.
   * @type {Map<string, string>}
   */
  const parent = new Map();
  const find = (/** @type {string} */ x) => {
    let root = x;
    while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = /** @type {string} */ (parent.get(cur));
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (/** @type {string} */ a, /** @type {string} */ b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const a of live) parent.set(a.id, a.id);

  const pairs = new Set();
  for (const a of live) {
    for (const [otherId, edge] of Object.entries(a.relations)) {
      if (!byId.has(otherId)) continue;
      if (edge.affinity < threshold) continue;
      const back = byId.get(otherId)?.relations[a.id];
      if (!back || back.affinity < threshold) continue;
      const key = [a.id, otherId].sort().join("|");
      if (pairs.has(key)) continue;
      pairs.add(key);
      union(a.id, otherId);
    }
  }

  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

/**
 * A human-readable summary of the social graph, for prompts.
 * @param {import("./agent.js").Agent} agent
 * @param {Map<string, import("./agent.js").Agent>} byId
 * @param {number} limit
 */
export function relationsSummary(agent, byId, limit = 6) {
  const entries = Object.entries(agent.relations)
    .map(([id, edge]) => ({ id, edge, other: byId.get(id) }))
    .filter(e => e.other && !e.other.retired)
    // Only surface relationships the mind would actually think about.
    .filter(e => e.edge.familiarity > 5 || Math.abs(e.edge.affinity) > 10 || e.edge.resentment > 10)
    .sort((a, b) => importance(b.edge) - importance(a.edge))
    .slice(0, limit);

  return entries.map(({ edge, other }) => {
    const bits = [describeRelation(edge)];
    if (edge.resentment >= 30) bits.push("still sore about something");
    if (edge.fear >= 30) bits.push("wary of");
    // debts > 0 means they owe me; debts < 0 means I owe them. The phrases
    // read from this mind's side of the edge, so they must not be swapped.
    if (edge.debts > 20) bits.push("is owed a favour by them");
    if (edge.debts < -20) bits.push("owes them a favour");
    if (edge.trust < 20) bits.push("doesn't trust");
    return `${other?.name}: ${bits.join(", ")}`;
  });
}

/**
 * How much an edge matters to the mind holding it.
 * @param {import("../model/relationships.js").RelationEdge} edge
 * @returns {number}
 */
function importance(edge) {
  return Math.abs(edge.affinity) + edge.resentment * 1.2 + edge.fear + edge.familiarity * 0.4 + Math.abs(edge.debts) * 0.5;
}

/** Feud stages, coldest first. */
export const FEUD_STAGES = ["grudge", "rivalry", "vendetta"];

/**
 * The feud stage between two minds, from the hotter side of the pair.
 * Resentment is directional, but a feud is something a pair *has* — it takes
 * the maximum, because one mind's vendetta is enough for both of them.
 * @param {import("./relationships.js").RelationEdge|undefined} edgeA
 * @param {import("./relationships.js").RelationEdge|undefined} edgeB
 * @param {import("../config.js").WorldConfig} config
 * @returns {"grudge"|"rivalry"|"vendetta"|null}
 */
export function feudStage(edgeA, edgeB, config) {
  const heat = Math.max(edgeA?.resentment ?? 0, edgeB?.resentment ?? 0);
  const v = config.vendetta;
  if (heat >= v.vendettaAt) return "vendetta";
  if (heat >= v.rivalryAt) return "rivalry";
  if (heat >= v.grudgeAt) return "grudge";
  return null;
}
