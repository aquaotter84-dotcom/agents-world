/**
 * The keeper's daily trials: a short action loop over the real simulation.
 *
 * A trial is completed only by the act it names. The app reports successful
 * engine acts here; this module owns the day's deck, progress and one-time
 * completion marks. It has no DOM, storage or engine imports, so the whole
 * loop can be tested without a browser.
 */

export const TRIAL_DEFS = Object.freeze({
  dossier: {
    id: "dossier", title: "Know who is hurting",
    task: "Open the dossier of the mind most in need of a keeper.",
    act: "Find them", event: "dossier", xp: 10, influence: 2
  },
  "bless-mind": {
    id: "bless-mind", title: "Leave a light with someone",
    task: "Bless one mind. Their needs lift now; their work goes further for two days.",
    act: "Bless them · 5", event: "bless-mind", xp: 10, influence: 2
  },
  omen: {
    id: "omen", title: "Cool the hottest quarrel",
    task: "Set an omen over a troubled region. Grudges cool while the sign holds.",
    act: "Set the omen · 7", event: "omen", xp: 10, influence: 2
  },
  "bless-work": {
    id: "bless-work", title: "Build tomorrow",
    task: "Bless the shared work. Every hand on the North Wall goes further.",
    act: "Bless the work · 5", event: "bless-work", xp: 10, influence: 2
  },
  ruling: {
    id: "ruling", title: "Answer what the world asks",
    task: "Settle a dilemma, rule on a petition, or act on a whisper. Your choice becomes history.",
    act: "Make your ruling", event: "ruling", xp: 10, influence: 2
  },
  camp: {
    id: "camp", title: "Stand with the camp",
    task: "Spend influence on one camp intervention. The Hold will feel it.",
    act: "Answer the camp", event: "camp", xp: 10, influence: 2
  },
  create: {
    id: "create", title: "Bring in somebody new",
    task: "Create a mind with a past and a purpose. The social world will make room for them.",
    act: "Create a mind", event: "create", xp: 10, influence: 2
  },
  thread: {
    id: "thread", title: "Follow the live wire",
    task: "Open the thread of a feud or a mind. Know the story before you touch it.",
    act: "Follow the thread", event: "thread", xp: 10, influence: 2
  },
  chronicle: {
    id: "chronicle", title: "Remember what happened",
    task: "Read today’s Chronicle. What you remember becomes part of your keeper’s record.",
    act: "Open the Chronicle", event: "chronicle", xp: 10, influence: 2
  }
});

export const TRIAL_COMPLETION_BONUS = Object.freeze({ xp: 20, influence: 6 });

/** @typedef {{id:string,title:string,task:string,act:string,event:string,xp:number,influence:number}} TrialDef */
/** @typedef {{seed:string,day:number,done:string[],bonus:boolean,tutorial:boolean,deck:string[]|null}} TrialsState */
/** @param {string} id @returns {TrialDef} */
function definition(id) {
  return /** @type {Record<string, TrialDef>} */ (TRIAL_DEFS)[id];
}

/** @param {any} world @param {boolean} [tutorial] @returns {TrialsState} */
export function emptyTrials(world, tutorial = false) {
  return {
    seed: String(world.seed),
    day: Math.max(1, Math.floor(world.clock.day)),
    done: /** @type {string[]} */ ([]),
    bonus: false,
    tutorial,
    deck: /** @type {string[]|null} */ (null)
  };
}

/**
 * Restore only sane state belonging to this world and day. A new day is a new
 * three-act loop; an old or corrupt save cannot pay twice.
 * @param {unknown} raw @param {any} world
 * @returns {TrialsState}
 */
export function normalizeTrials(raw, world) {
  if (!raw || typeof raw !== "object") return emptyTrials(world, true);
  const value = /** @type {any} */ (raw);
  const day = Math.max(1, Math.floor(world.clock.day));
  if (String(value.seed) !== String(world.seed) || value.day !== day) return emptyTrials(world);
  return {
    seed: String(world.seed),
    day,
    done: Array.isArray(value.done)
      ? [...new Set(value.done.filter((/** @type {unknown} id */ id) => typeof id === "string" && id in TRIAL_DEFS))]
      : [],
    bonus: Boolean(value.bonus),
    tutorial: Boolean(value.tutorial),
    deck: Array.isArray(value.deck)
      ? value.deck.filter((/** @type {unknown} id */ id) => typeof id === "string" && id in TRIAL_DEFS)
      : null
  };
}

/** @param {unknown} value */
function hash(value) {
  let h = 0;
  for (const c of String(value)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** @param {string[]} ids @param {any} world */
function eligible(ids, world) {
  return ids.filter(id => {
    if (id === "chronicle") return (world.chronicle || []).length > 0;
    if (id === "bless-work") return world.project?.status === "active";
    if (id === "camp") return world.settlement?.status === "active";
    if (id === "ruling") {
      const c = world.charter || {};
      return (c.petitions || []).some((/** @type {any} */ p) => p.status === "open")
        || (c.dilemmas || []).some((/** @type {any} */ d) => d.status === "open")
        || (c.whispers || []).some((/** @type {any} */ w) => !w.actedOn);
    }
    return true;
  });
}

/** @param {string[]} ids @param {any} world @param {number} salt @param {string} fallback */
function pick(ids, world, salt, fallback) {
  const options = eligible(ids, world);
  if (!options.length) return fallback;
  return options[(hash(world.seed) + world.clock.day * 7 + salt) % options.length];
}

/**
 * Three complementary acts: know the world, intervene in it, then change its
 * longer course. The first chain is a teachable sequence; later days rotate.
 * @param {any} world @param {TrialsState} state
 * @returns {string[]}
 */
export function trialDeck(world, state) {
  if (state.tutorial) return ["dossier", "bless-mind", "omen"];
  // Eligibility can change after an act (a ruling closes its petition, shared
  // work can finish). Keep the dealt thread stable until the next world day.
  if (Array.isArray(state.deck) && state.deck.length === 3
    && new Set(state.deck).size === 3
    && state.deck.every((/** @type {unknown} id */ id) => typeof id === "string" && id in TRIAL_DEFS)) {
    return state.deck.slice();
  }
  const deck = [
    pick(["dossier", "thread", "chronicle"], world, 1, "dossier"),
    pick(["bless-mind", "omen", "bless-work"], world, 2, "bless-mind"),
    pick(["ruling", "camp", "create"], world, 3, "create")
  ];
  state.deck = deck;
  return deck.slice();
}

/** @param {any} world @param {TrialsState} state */
export function trialSummary(world, state) {
  const deck = trialDeck(world, state);
  const trials = deck.map(id => ({ ...definition(id), done: state.done.includes(id) }));
  return {
    trials,
    active: trials.find(trial => !trial.done) || null,
    completed: trials.filter(trial => trial.done).length,
    total: trials.length,
    bonus: state.bonus
  };
}

/**
 * Record a successful act. Returns only newly completed trials and whether this
 * call finished the chain; repeating an act can never pay a second time.
 * @param {TrialsState} state @param {any} world @param {string} action
 */
export function recordTrialAction(state, world, action) {
  const deck = trialDeck(world, state);
  const id = deck.find(trialId => definition(trialId).event === action && !state.done.includes(trialId));
  if (!id) return { completed: [], bonus: false };
  state.done.push(id);
  const complete = deck.every(trialId => state.done.includes(trialId));
  const bonus = complete && !state.bonus;
  if (bonus) state.bonus = true;
  return { completed: [definition(id)], bonus };
}
