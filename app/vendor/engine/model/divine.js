/**
 * The keeper's interventions: apparitions, omens and blessings.
 *
 * The keeper does not talk to the world. Chat is a private channel between the
 * keeper and one mind; what the *world* experiences of the keeper is this — a
 * light over a workshop, a sign hanging over a valley, something standing where
 * two people were about to have the worst conversation of their lives. Nothing
 * anyone said. Nothing a model wrote.
 *
 * An intervention is a record with a life: it happens on a tick, it changes
 * something, and it stays legible for a while after — on the board as a mark,
 * in the record as a line, and in the fiction as a thing the minds remember.
 * When its window closes the effect stops, but the mark lingers a little longer
 * so the world can be read after the fact rather than only while it is on.
 *
 * Nothing here draws from the RNG, and nothing here writes to the world: this
 * module is the shape of the record plus readers over it. The effects live in
 * `systems/divine.js`, which is the only place that spends influence.
 */

/** The three ways the keeper can be present without speaking. */
export const INTERVENTION_KINDS = /** @type {const} */ (["omen", "blessing", "apparition"]);

/** How many interventions the world remembers. Older ones fall off the front. */
export const INTERVENTION_CAP = 32;

/**
 * @typedef {object} Intervention
 * @property {string} id
 * @property {"omen"|"blessing"|"apparition"} kind
 * @property {"region"|"mind"|"work"|"dilemma"} target  What it was aimed at.
 * @property {string|null} agentId     The mind it was mostly about, if any.
 * @property {string|null} subjectId   The other mind, for an apparition.
 * @property {string|null} regionId
 * @property {string|null} dilemmaId
 * @property {number} tick
 * @property {number} expireTick       While `tick < expireTick` it still bites.
 * @property {number} markUntil        How long the board keeps drawing it.
 * @property {number} cost             Influence spent.
 * @property {string} text             What the world saw, in one line.
 * @property {string} effect           What it actually did, in one line.
 * @property {number[]} [values]       The keeper's meters right after it landed.
 */

/**
 * The world's record of keeper interventions.
 * @typedef {object} Divine
 * @property {Intervention[]} interventions
 * @property {Record<string, number>} lastTick  Latest use per kind, for cooldowns.
 * @property {Record<string, number>} counts    Total uses per kind, since the world began.
 */

/** @returns {Divine} */
export function createDivine() {
  return { interventions: [], lastTick: {}, counts: {} };
}

/**
 * Coerce whatever came out of a save into a usable record. An old world simply
 * has never been visited, which is the honest answer.
 * @param {unknown} raw
 * @returns {Divine}
 */
export function normalizeDivine(raw) {
  const base = createDivine();
  const d = /** @type {any} */ (raw);
  if (!d || typeof d !== "object") return base;
  const list = Array.isArray(d.interventions) ? d.interventions : [];
  const interventions = list
    .filter(/** @param {any} entry */ entry => entry && typeof entry === "object" && INTERVENTION_KINDS.includes(entry.kind))
    .slice(-INTERVENTION_CAP)
    .map(/** @param {any} entry */ entry => ({
      ...entry,
      id: String(entry.id),
      target: entry.target || "region",
      tick: Number.isFinite(entry.tick) ? entry.tick : 0,
      expireTick: Number.isFinite(entry.expireTick) ? entry.expireTick : 0,
      markUntil: Number.isFinite(entry.markUntil) ? entry.markUntil : Number.isFinite(entry.expireTick) ? entry.expireTick : 0,
      cost: Number.isFinite(entry.cost) ? entry.cost : 0,
      text: String(entry.text || ""),
      effect: String(entry.effect || "")
    }));
  return {
    interventions,
    lastTick: d.lastTick && typeof d.lastTick === "object" ? { ...d.lastTick } : {},
    counts: d.counts && typeof d.counts === "object" ? { ...d.counts } : {}
  };
}

/** Push an intervention, capped and newest-last. @param {Divine} divine @param {Intervention} intervention */
export function recordIntervention(divine, intervention) {
  divine.interventions.push(intervention);
  if (divine.interventions.length > INTERVENTION_CAP) {
    divine.interventions.splice(0, divine.interventions.length - INTERVENTION_CAP);
  }
  divine.counts[intervention.kind] = (divine.counts[intervention.kind] || 0) + 1;
  divine.lastTick[intervention.kind] = intervention.tick;
  return intervention;
}

/**
 * Interventions still doing something, newest last.
 * @param {Divine} divine
 * @param {number} tick
 * @param {Intervention["kind"]} [kind]
 */
export function liveInterventions(divine, tick, kind) {
  if (!divine) return [];
  return divine.interventions.filter(iv => (kind ? iv.kind === kind : true) && tick < iv.expireTick);
}

/**
 * Interventions the board should still be drawing: live, plus a fading window
 * after the effect has ended, so an omen can be read after the fact.
 * @param {Divine} divine
 * @param {number} tick
 */
export function markedInterventions(divine, tick) {
  if (!divine) return [];
  return divine.interventions.filter(iv => tick < iv.markUntil);
}

/** @param {Divine} divine @param {string} id @returns {Intervention|null} */
export function interventionById(divine, id) {
  if (!divine) return null;
  for (let i = divine.interventions.length - 1; i >= 0; i--) {
    if (divine.interventions[i].id === id) return divine.interventions[i];
  }
  return null;
}

/**
 * The omen hanging over a region right now, if there is one. Called by the
 * decision layer when a mind weighs whether to confront somebody: a mind
 * standing under a sign thinks harder about it.
 * @param {Divine} divine
 * @param {number} tick
 * @param {string|null|undefined} regionId
 * @returns {Intervention|null}
 */
export function liveOmenForRegion(divine, tick, regionId) {
  if (!divine || !regionId) return null;
  for (let i = divine.interventions.length - 1; i >= 0; i--) {
    const iv = divine.interventions[i];
    if (iv.kind === "omen" && iv.regionId === regionId && tick < iv.expireTick) return iv;
  }
  return null;
}

/**
 * Whether a mind is carrying a blessing right now. Read by the project system:
 * a blessed pair of hands gets more wall out of the same day's work.
 * @param {Divine} divine
 * @param {number} tick
 * @param {string|undefined} agentId
 * @returns {Intervention|null}
 */
export function liveBlessingForAgent(divine, tick, agentId) {
  if (!divine || !agentId) return null;
  for (let i = divine.interventions.length - 1; i >= 0; i--) {
    const iv = divine.interventions[i];
    if (iv.kind === "blessing" && iv.target === "mind" && iv.agentId === agentId && tick < iv.expireTick) return iv;
  }
  return null;
}

/**
 * Whether the wall work itself is under a blessing right now.
 * @param {Divine} divine
 * @param {number} tick
 * @returns {Intervention|null}
 */
export function liveBlessingForWork(divine, tick) {
  if (!divine) return null;
  for (let i = divine.interventions.length - 1; i >= 0; i--) {
    const iv = divine.interventions[i];
    if (iv.kind === "blessing" && iv.target === "work" && tick < iv.expireTick) return iv;
  }
  return null;
}
