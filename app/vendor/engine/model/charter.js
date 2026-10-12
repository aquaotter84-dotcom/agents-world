/**
 * The charter: everything the world has decided about how it lives.
 *
 * A world that only simulates moods and errands is a weather report. What makes
 * a place a *place* is that it accumulates rules nobody wrote down at the start
 * — a tradition somebody proposed after a bad week, a law that exists because
 * one mind kept sabotaging the wall, a role a mind grew into because that is
 * what they kept being seen doing.
 *
 * None of that is authored in advance. A mind proposes, the keeper rules, the
 * ruling becomes precedent, and the precedent changes what the engine will
 * validate next time. The world's customs are a record of play.
 *
 * This module holds the shape of that record and the arithmetic on the keeper's
 * influence. It never decides anything on its own.
 */

import { clamp } from "../config.js";

/**
 * @typedef {object} CharterRule
 * @property {string} id
 * @property {string} text         The rule as the proposing mind worded it.
 * @property {string} kind         tradition | law
 * @property {string} ruleKind     Which engine behaviour it modifies (RULE_KINDS).
 * @property {string} proposedBy   Agent id.
 * @property {number} proposedTick
 * @property {string} [ruling]     enacted | refused | lapsed
 * @property {number} [ruledTick]
 * @property {string} [rulingNote] The keeper's words, if they gave any.
 * @property {string} [precedentId]
 */

/**
 * @typedef {object} CharterRole
 * @property {string} id
 * @property {string} name         The role's name, from the behaviour that earned it.
 * @property {string} holderId
 * @property {string} basis        The observed pattern, in plain words.
 * @property {number} tick
 * @property {number} weight       How strongly the pattern was established.
 */

/**
 * @typedef {object} Precedent
 * @property {string} id
 * @property {string} text
 * @property {string} ruleKind
 * @property {string} ruling       enacted | refused
 * @property {number} tick
 * @property {string} [fromRuleId]
 */

/**
 * @typedef {object} Petition
 * @property {string} id
 * @property {string} agentId
 * @property {string} text         The petition in the petitioner's own words.
 * @property {string} ruleKind
 * @property {string} kind         tradition | law
 * @property {number} tick
 * @property {number} support      Minds the engine can count behind it.
 * @property {number} oppose
 * @property {string} [basis]      The observed fact that justifies asking.
 * @property {string} [precedentId] The earlier ruling this petition leans on.
 * @property {string} [status]     open | enacted | refused | lapsed
 * @property {number} [cost]       Influence the keeper would spend to enact it.
 */

/**
 * @typedef {object} Dilemma
 * @property {string} id
 * @property {string} text
 * @property {string[]} partyIds
 * @property {string} kind         feud | scarcity | succession | rule
 * @property {number} tick
 * @property {string} [status]     open | resolved | lapsed
 * @property {string} [resolution]
 */

/**
 * @typedef {object} Whisper
 * @property {string} id
 * @property {string} agentId      Who told the keeper.
 * @property {string|null} aboutId
 * @property {string} text
 * @property {number} tick
 * @property {boolean} [actedOn]   Whether the keeper used it.
 */

/**
 * @typedef {object} Charter
 * @property {number} influence       The keeper's spendable standing in the world.
 * @property {number} influenceMax
 * @property {CharterRule[]} rules
 * @property {CharterRole[]} roles
 * @property {Precedent[]} precedents
 * @property {Petition[]} petitions
 * @property {Dilemma[]} dilemmas
 * @property {Whisper[]} whispers
 * @property {Record<string, number>} active   Live modifiers from enacted rules.
 * @property {number} rulingsMade
 * @property {number} [nextDilemmaTick]   Tick at which the engine may raise another dilemma.
 * @property {number} [lastInfluenceTick] Tick influence was last regenerated.
 * @property {number} [wallRaisedTick]
 * @property {boolean} wallRaised     The shared win condition, once met.
 * @property {number} [wallRaisedTick]
 */

/**
 * The behaviours a rule may modify. A mind proposes a *kind* of rule in its own
 * words; the engine maps that kind onto a concrete, bounded change it already
 * knows how to apply. Nothing outside this list can be legislated.
 *
 * @type {Record<string, {name: string, kind: "tradition"|"law", cost: number, gloss: string}>}
 */
export const RULE_KINDS = Object.freeze({
  share_the_fire:  { name: "Share the fire",       kind: "tradition", cost: 8,  gloss: "Minds in the same place keep each other company more easily." },
  open_houses:     { name: "Open houses",          kind: "tradition", cost: 8,  gloss: "People who share a place come to know each other faster." },
  wall_first:      { name: "The wall comes first", kind: "law",       cost: 14, gloss: "Work on the North Wall goes further for everyone." },
  no_undermining:  { name: "No undermining",       kind: "law",       cost: 16, gloss: "Sabotage needs a much deeper grievance to bethinkable." },
  quiet_hours:     { name: "Quiet hours",          kind: "tradition", cost: 10, gloss: "Old scores are not settled after dark." },
  debts_honoured:  { name: "Debts are honoured",   kind: "law",       cost: 12, gloss: "A favour owed does not quietly stop mattering." },
  say_it_plainly:  { name: "Say it plainly",       kind: "tradition", cost: 10, gloss: "Rumour travels less far from what was actually said." },
  mourn_the_gone:  { name: "Mourn the gone",       kind: "tradition", cost: 6,  gloss: "A mind who collapses is not judged harshly for it." }
});

/** Every rule kind a model may propose, in the order they are offered. */
export const RULE_KIND_LIST = Object.keys(RULE_KINDS);

/** Influence the keeper starts with. Enough to enact two or three things. */
export const STARTING_INFLUENCE = 30;
export const INFLUENCE_MAX = 100;

/** @returns {Charter} */
export function createCharter() {
  return {
    influence: STARTING_INFLUENCE,
    influenceMax: INFLUENCE_MAX,
    rules: [],
    roles: [],
    precedents: [],
    petitions: [],
    dilemmas: [],
    whispers: [],
    active: {},
    rulingsMade: 0,
    wallRaised: false
  };
}

/**
 * Coerce whatever came out of a save into a valid charter. An old world simply
 * has no customs yet, which is the honest answer.
 * @param {unknown} raw
 * @returns {Charter}
 */
export function normalizeCharter(raw) {
  const base = createCharter();
  const c = /** @type {any} */ (raw);
  if (!c || typeof c !== "object") return base;
  /** @param {unknown} value */
  const list = (value) => (Array.isArray(value) ? value.filter(x => x && typeof x === "object") : []);
  return {
    ...base,
    ...c,
    influence: Number.isFinite(c.influence) ? clamp(c.influence, 0, c.influenceMax ?? INFLUENCE_MAX) : base.influence,
    influenceMax: Number.isFinite(c.influenceMax) ? c.influenceMax : INFLUENCE_MAX,
    rules: list(c.rules),
    roles: list(c.roles),
    precedents: list(c.precedents),
    petitions: list(c.petitions),
    dilemmas: list(c.dilemmas),
    whispers: list(c.whispers),
    active: c.active && typeof c.active === "object" ? c.active : {},
    rulingsMade: Number.isFinite(c.rulingsMade) ? c.rulingsMade : 0,
    wallRaised: Boolean(c.wallRaised)
  };
}

/**
 * Move the keeper's influence, clamped into range.
 * @param {Charter} charter
 * @param {number} delta
 * @returns {number} what was actually spent or granted
 */
export function moveInfluence(charter, delta) {
  const before = charter.influence;
  charter.influence = clamp(charter.influence + delta, 0, charter.influenceMax);
  return charter.influence - before;
}

/**
 * The live value of an enacted rule, or 0 when nothing has legislated it.
 * @param {Charter} charter
 * @param {string} ruleKind
 */
export function ruleStrength(charter, ruleKind) {
  return charter.active[ruleKind] || 0;
}

/**
 * Whether a rule kind is currently enacted.
 * @param {Charter} charter
 * @param {string} ruleKind
 */
export function isEnacted(charter, ruleKind) {
  return ruleStrength(charter, ruleKind) > 0;
}

/**
 * A plain-English reading of the keeper's standing, for the UI.
 * @param {Charter} charter
 */
export function influenceWord(charter) {
  const pct = charter.influence / charter.influenceMax;
  if (pct >= 0.8) return "the world does what you say before you finish saying it";
  if (pct >= 0.6) return "your word carries real weight";
  if (pct >= 0.35) return "people listen, mostly";
  if (pct >= 0.15) return "you are a voice among others";
  return "you have little left to spend";
}

/**
 * The most recent precedent bearing on a rule kind, if the keeper has ruled on
 * it before. Consistency is what makes a ruling a precedent rather than a mood.
 * @param {Charter} charter
 * @param {string} ruleKind
 * @returns {Precedent|null}
 */
export function precedentFor(charter, ruleKind) {
  for (let i = charter.precedents.length - 1; i >= 0; i--) {
    if (charter.precedents[i].ruleKind === ruleKind) return charter.precedents[i];
  }
  return null;
}
