/**
 * Every tunable number in the simulation lives here.
 *
 * Design rule: the engine has no magic numbers in its systems. If you want to
 * change how fast a world moves, or how bitter a grudge gets, change it here and
 * the tests will tell you what broke.
 */

export const DEFAULT_CONFIG = {
  clock: {
    /**
     * How much world time passes per simulation tick.
     *
     * Half an hour per tick means a world day is 48 ticks — fast enough that
     * needs, moods and grudges visibly move within a session, slow enough that a
     * mind's day still reads like a day.
     */
    minutesPerTick: 30
  },

  needs: {
    /**
     * Per-tick drift for each need (0..100 scale). Negative drains.
     * Values chosen so a mind left entirely alone gets desperate over ~a day
     * of world time, not over three ticks.
     */
    drift: {
      energy: -0.75,
      connection: -0.55,
      esteem: -0.08,
      meaning: -0.22
    },
    /** How fast needs return toward their baseline when satisfied. */
    recovery: {
      energy: 4.5,
      connection: 7.0,
      esteem: 2.5,
      meaning: 3.0
    },
    /** Below this, the need is urgent and can force an intent regardless of drives. */
    urgentThreshold: 15,
    /** Resting restores this much energy per tick when the rest intent resolves. */
    restRecovery: 9,
    /** Energy a sleeping mind recovers per tick. */
    sleepRecovery: 6.5,
    /** A sleeping mind wakes on its own once energy crosses this. */
    wakeThreshold: 72
  },

  memory: {
    /** Traces remembered before consolidation kicks in. */
    capacity: 120,
    /** Salience decays by this factor per tick (multiplicative, half-life ~ derived). */
    salienceDecayPerTick: 0.994,
    /** Traces below this salience are forgotten entirely during consolidation. */
    forgetBelow: 0.05,
    /** Recall scoring weights. */
    recall: {
      halfLifeTicks: 400,
      relevanceBonus: 1.8,
      secretBonus: 1.25,
      /** Cap on how many traces a single recall returns by default. */
      defaultLimit: 8
    },
    /** When over capacity, this many oldest traces get folded into one summary. */
    consolidationBatch: 24
  },

  relations: {
    /** Affinity decays toward neutral with time apart. */
    affinityDecayPerTick: 0.03,
    /** Familiarity fades much more slowly than affinity. */
    familiarityDecayPerTick: 0.004,
    /** Resentment cools, but far more slowly than affinity — grudges last. */
    resentmentDecayPerTick: 0.006,
    /** Fear fades with time apart. */
    fearDecayPerTick: 0.02,
    /** Familiarity gained just by being in the same place. */
    proximityFamiliarity: 0.35,
    /** Bonds at or above this affinity count as an alliance. */
    allianceThreshold: 45,
    /**
     * Resentment at or above this counts as a rivalry. Kept low on purpose: a
     * world where a grudge has to reach 35 before anyone will act on it is a
     * world where nobody ever acts on anything.
     */
    rivalryThreshold: 24,
    /** Mutual affinity above this, from both sides, counts as a faction edge. */
    factionMutualThreshold: 40
  },

  social: {
    /** Chance a gossip exchange mutates the fact before it is passed on. */
    gossipMutationChance: 0.22,
    /** Fidelity lost per hop; at 0 the tale is pure invention. */
    gossipFidelityLoss: 0.18,
    /** A mind will only confide in someone it trusts at least this much. */
    confideTrustFloor: 55,
    /** Beneath this trust, a held secret is more likely to be weaponised than kept. */
    betrayalTrustCeiling: 38,
    /** Resentment needed before a mind will consider using what it knows. */
    betrayalResentmentFloor: 22,
    /**
     * Ticks before the same two minds will confront each other again. Without a
     * cooldown a grudge becomes a loop: the same argument, every tick, forever.
     */
    conflictCooldownTicks: 34,
    /** Ticks before the same secret can be passed on again. */
    gossipCooldownTicks: 8,
    /** Ticks before the same secret can move again. */
    confideCooldownTicks: 10,
    /**
     * Ticks before a mind will unburden itself to anyone again.
     *
     * Telling someone the thing you have never told anyone is a rare, weighty
     * act. Without a personal interval a mind with several burdens simply tells
     * someone every few hours, forever, and the world fills up with confessions
     * and nothing else.
     */
    confideIntervalTicks: 26,
    /** Multiplier applied to affinity change when the interaction is a first meeting. */
    firstMeetingMultiplier: 1.6
  },

  progression: {
    /**
     * Level curve: level = 1 + floor(sqrt(xp / divisor)).
     *
     * Tuned so the world has to run for a couple of dozen days before anyone
     * reaches level 6. A world where everyone is level 8 after a weekend has
     * nowhere left to go.
     */
    levelDivisor: 200,
    /**
     * Global multiplier on every XP award. Levelling should be a slow, visible
     * consequence of a life well lived — not a number that ticks up every time
     * a mind says hello.
     */
    xpMultiplier: 0.42,
    /** A "triumphant" mood lasts this many ticks after a level-up or triumph. */
    triumphDurationTicks: 12
  },

  moments: {
    /**
     * The LLM budget. The engine emits at most this many moments per tick, and
     * never more than `maxPerMinute` across the rolling window — the server
     * actually paces the calls, this is just the engine-side admission policy.
     */
    maxPerTick: 2,
    maxPerMinute: 12,
    /** Utility score an intent must reach before it may become a model moment. */
    significanceFloor: 62,
    /** Guarantee a mind gets one model-driven reflection at least this often. */
    reflectionIntervalTicks: 60,
    /** How many ticks a moment may wait for a model before the engine answers it itself. */
    maxPendingTicks: 3,
    /** Kinds of intent that are always considered moment-worthy when they fire. */
    alwaysMomentKinds: ["confront", "betray", "confide", "declare"]
  },

  limits: {
    /** World event log length. Roughly two world days of ordinary activity. */
    events: 2000,
    /** Events at or below this significance are texture, not history. */
    quietSignificance: 0.16,
    /** Per-agent memory traces retained after consolidation. */
    agentMemories: 160,
    /** How often a mind's ongoing work shows up in the public feed, in ticks. */
    goalLogInterval: 6,
    /** Only events at or above this make it into a day's summary. */
    chronicleSignificance: 0.55,
    /**
     * Most secrets one mind can hold. This is a load-bearing limit, not a
     * tidiness one: burden scales with how much you are carrying, so an
     * uncapped mind ends up confiding constantly and doing nothing else.
     */
    secretsPerAgent: 5,
    /** Most secrets the world will hold before old ones stop being replaced. */
    secretsInWorld: 60
  }
};

/**
 * The config's type is derived from the defaults rather than declared beside
 * them. One source of truth: adding a tunable cannot leave the type behind, and
 * the type cannot promise a setting that does not exist.
 * @typedef {typeof DEFAULT_CONFIG} WorldConfig
 */

/**
 * Shallow-merge user overrides into a copy of the defaults, section by section.
 * Unknown keys are preserved so future systems can carry their own config.
 * @param {Partial<WorldConfig>} [overrides]
 * @returns {WorldConfig}
 */
export function makeConfig(overrides) {
  /** @type {any} */
  const out = structuredClone(DEFAULT_CONFIG);
  if (!overrides) return out;
  for (const [section, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[section]) {
      out[section] = { ...out[section], ...value };
    } else {
      out[section] = value;
    }
  }
  return out;
}

/**
 * Clamp a number into a range. Used all over the sim.
 * @param {number} n
 * @param {number} min
 * @param {number} max
 */
export function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}
