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
    /**
     * Mutual affinity above this, from both sides, counts as a faction edge.
     *
     * Set high on purpose. Affinity saturates: a pair who like each other end up
     * pinned near 100, and a chain of merely-friendly edges then unions the whole
     * cast into one group of seven. A faction that contains everybody tells you
     * nothing and looks like a bug on the map. At this threshold the world
     * resolves into a handful of real camps with unaligned minds between them.
     */
    factionMutualThreshold: 58
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
    firstMeetingMultiplier: 1.6,
    /**
     * How strongly each kind of talk pulls at a mind, and how often it may happen.
     *
     * Ordinary opinion — what a mind thinks of somebody who is not in the room —
     * is the cheapest social act there is: it needs nothing but company and a
     * memory. When it scored within a couple of points of everything else it won
     * most ticks by default, and half of every day in the feed was small talk.
     * Secrets are still the potent version; having a view about somebody is now
     * a choice rather than the world's resting state.
     */
    talkScoring: {
      /** Base pull of the gossip intent, before secrets, opinions or friendship. */
      base: 9,
      /** Added when there is nothing but an opinion to share. */
      opinion: 6,
      /** Added for having a secret worth passing on, once. */
      secretBonus: 13,
      /** Added per secret the speaker could pass on. */
      secretPerSecret: 6,
      /** Added when the listener passes for a friend. */
      friendBonus: 8
    },
    /**
     * Ticks before the same two minds spend time together again.
     *
     * A conversation is an event; a pair who talk every single tick are not
     * having one, they are filling the log. Twelve ticks is a quarter of a world
     * day — often enough that news still travels and friendships still deepen,
     * rare enough that the day has room in it for work, wandering and trouble.
     *
     * This governs both halves of being together: seeking each other's company,
     * and talking about somebody who is not there.
     */
    pairCooldownTicks: 12
  },

  standing: {
    /**
     * Public reputation, -100..100, separate from private affection. Public
     * deeds move it; gossip moves it faster than the deeds themselves, because
     * the room always hears the story before it checks the facts.
     */
    deedBetray: -16,
    deedConfrontPublic: -6,
    deedHoldOver: -4,
    deedForgive: 10,
    deedLevel: 8,
    /** Standing gained or lost when gossip paints someone warm or unkind. */
    gossipPull: 7,
    /** Reputations fade toward obscurity when nobody is talking. */
    decayPerTick: 0.02
  },

  turnover: {
    /**
     * The cast turns over: new minds wander in, and old ones drift away or die.
     * The original nine and any mind the keeper made are protected — the world
     * can surprise its keeper, but it may not erase what he built.
     */
    /** Ticks between arrival considerations. */
    arrivalIntervalTicks: 96,
    /** Chance of an arrival each time one is considered. */
    arrivalChance: 0.4,
    /** The world never grows past this many living minds. */
    maxCast: 14,
    /** Ticks between departure considerations. */
    departureIntervalTicks: 144,
    /** Chance of a departure each time one is considered. */
    departureChance: 0.35,
    /** The world never shrinks below this many living minds. */
    minCast: 6,
    /** Connection below this means a mind is adrift. */
    lonelyThreshold: 22,
    /** Ticks adrift before leaving becomes thinkable. */
    lonelyTicks: 240,
    /** Ticks lived before death enters the picture at all. */
    deathAgeTicks: 1440,
    /** Chance a departure is a death rather than a leaving, once old enough. */
    deathChance: 0.25
  },

  want: {
    /**
     * The keeper's own score: harmony, prosperity, legacy.
     *
     * These meters are not a resource — nothing is bought with them. They are
     * a reading of the world's condition (the `*Base` and `*Per*` numbers
     * below turn facts the engine already tracks into a 0..100 meter) and a
     * ledger of what the keeper's acts did to it (`acts`, at the bottom).
     *
     * `driftPerTick` is how fast a meter follows the reading: slow enough that
     * a change is watched rather than blinked through, fast enough that a
     * keeper who fixes the thing that was broken sees it land the same day.
     */
    enabled: true,
    driftPerTick: 0.35,
    driftLogIntervalTicks: 24,

    /** A bond is counted when both sides like each other at least this much. */
    bondThreshold: 45,
    /** Connection below this counts a mind as alone — the same line turnover uses. */
    lonelyThreshold: 22,

    harmonyBase: 46,
    harmonyPerBond: 4.5,
    harmonyPerRivalry: 5,
    harmonyPerVendetta: 9,
    harmonyPerLonely: 4.5,

    prosperityBase: 22,
    prosperityPerWallPoint: 0.3,
    prosperityPerHand: 2.2,
    /** A favour repaid or called in is shared work actually landing. */
    prosperityPerFavour: 2.6,
    prosperityPerInterference: 2.5,
    /** Unrepaid debt is prosperity that is stuck in one pocket. */
    prosperityPerDebtPoint: 0.03,
    favourWindowTicks: 144,
    interferenceWindowTicks: 144,

    legacyBase: 12,
    legacyPerRule: 6,
    legacyRuleCap: 30,
    legacyPerRole: 4,
    legacyRoleCap: 20,
    /** A role whose holder is gone is a name the world no longer uses. */
    legacyPerBrokenRole: 3,
    legacyPerPrecedent: 1.1,
    legacyPerDay: 0.5,
    legacyForWallRaised: 10,

    /**
     * The lose condition, made legible.
     *
     * If nothing has asked the keeper for anything for `quietAfterTicks`, the
     * harmony reading is penalised by `quietDecayPerTick` per silent tick, up
     * to `quietMaxPenalty` — so a world left alone long enough spends all of
     * the harmony it had. At the floor, with the silence unbroken for
     * `fallenGraceTicks` more, the world is declared quiet: still alive, still
     * simulating, but no longer asking, and it stays that way until an ask
     * arrives.
     */
    quietAfterTicks: 144,
    quietDecayPerTick: 0.6,
    quietMaxPenalty: 55,
    quietLogIntervalTicks: 48,
    fallenGraceTicks: 48,

    /**
     * What each keeper act does to the keeper's own meters. These are the
     * visible deltas: the panel shows the movement, with the act that caused it,
     * every time a ruling, a dilemma, a whisper or the wall lands.
     *
     * Refusing is not punished — a keeper who says no has still ruled, and
     * precedent is legacy. Ignoring a petition is the thing with no upside.
     */
    acts: {
      enact: { legacy: 6, harmony: 3 },
      refuse: { legacy: 1, harmony: -2 },
      lapse: { harmony: -1.5 },
      separate: { harmony: 3 },
      mediate: { harmony: 5, prosperity: 1 },
      condemn: { harmony: -1, legacy: 1 },
      rally: { prosperity: 5, harmony: 2 },
      shame: { prosperity: 2, harmony: -1 },
      let_it_ride: { harmony: -1 },
      whisper: { harmony: -3, legacy: 2 },
      wall_raised: { prosperity: 12, legacy: 6, harmony: 6 }
    }
  },

  rumour: {
    /**
     * Gossip warps as it spreads. Each retelling has this chance of mutating
     * the claim: details sharpen or soften, and sometimes the name at the
     * centre of the story changes. The secret underneath stays what it was —
     * what the room *says* becomes its own creature.
     */
    mutationChance: 0.35,
    /** Share of mutations that swap the subject's name for someone else's. */
    nameSwapChance: 0.2,
    /** Share of mutations that sharpen the claim rather than soften it. */
    exaggerateChance: 0.35
  },

  vendetta: {
    /**
     * Feuds escalate through stages as resentment between a pair grows:
     * grudge → rivalry → vendetta. Each stage changes what the pair will do
     * to each other and how the world talks about it.
     */
    grudgeAt: 18,
    rivalryAt: 35,
    vendettaAt: 60,
    /** Betrayal scores this much harder when the pair are in vendetta. */
    betrayalMultiplier: 1.5,
    /** Extra confront utility at vendetta stage — it wants settling. */
    confrontBonus: 14
  },

  rituals: {
    /**
     * Recurring world events on the engine's clock. Rituals give the calendar
     * a shape: the world gathers, then goes quiet, then gathers again. Minds
     * feel them in their needs and lean with them in their choices.
     */
    list: [
      {
        id: "gathering",
        name: "Gathering Night",
        everyDays: 7,
        offsetDays: 5,
        phase: "dusk",
        blurb: "the night the world comes together",
        needs: { connection: 14, esteem: 6, energy: -4 },
        intentBias: "seek_company",
        lines: [
          "It is Gathering Night, and the world leans toward itself.",
          "Gathering Night: every road leads somewhere with people in it.",
          "The calendar turns to Gathering Night, and solitude feels like a choice."
        ]
      },
      {
        id: "quiet",
        name: "Quiet Day",
        everyDays: 9,
        offsetDays: 2,
        phase: null,
        blurb: "the day the world holds its breath",
        needs: { meaning: 10, energy: 6, connection: -5 },
        intentBias: "observe",
        lines: [
          "It is Quiet Day. The world speaks softly, and minds listen.",
          "Quiet Day: nobody is in a hurry, and that is the point.",
          "The calendar turns to Quiet Day, and even the gossip rests."
        ]
      }
    ]
  },

  favours: {
    /**
     * Debt written onto the ledger when one mind does another a favour.
     *
     * On the edge's `debts` axis, positive means "they owe me" and negative
     * means "I owe them" — the ledger must never be read backwards, because
     * the whole point of a favour is knowing who owes whom.
     */
    amount: 18,
    /** Debts at or below this are too small to call in; they settle silently. */
    trivialBelow: 6,
    /** Outstanding debt worth acting on — below this, calling in feels petty. */
    callInThreshold: 14,
    /**
     * Ticks of grace after a favour before the debt may be called in.
     * Asking for repayment the same afternoon the favour was done reads as
     * a transaction, not a relationship.
     */
    graceTicks: 24,
    /** Debts fade by this much per tick; old obligations quietly stop mattering. */
    debtDecayPerTick: 0.12,
    /** Ticks before the same pair can create another favour debt. */
    createCooldownTicks: 30,
    /** Ticks before the same creditor may call in another favour from the same debtor. */
    callInCooldownTicks: 48,
    /** Utility per point of outstanding debt when scoring the call_in intent. */
    debtUtilityPull: 1.1
  },

  projects: {
    /** Ticks before the same mind can interfere with shared construction again. */
    interferenceCooldownTicks: 48,
    /** Resentment needed before interference becomes a plausible engine choice. */
    interferenceResentmentFloor: 22
  },

  charter: {
    /**
     * The world's customs. A mind may petition the keeper for a change, minds
     * whisper to the keeper, roles emerge from what minds are actually seen
     * doing, and every ruling the keeper makes becomes precedent that shapes
     * what the engine will validate next time.
     */
    enabled: true,
    /** A mind may petition this often, in world ticks. */
    petitionIntervalTicks: 48,
    /** How many petitions may wait on the keeper at once. */
    maxOpenPetitions: 3,
    /** Ticks before an unanswered petition lapses. */
    petitionLapseTicks: 96,
    /** Influence regained per day kept, up to the cap. */
    influencePerDay: 4,
    /** Influence granted for ruling on a petition, enacted or not. */
    influencePerRuling: 3,
    whispersEnabled: true,
    /** A mind may whisper this often, in world ticks. */
    whisperIntervalTicks: 72,
    maxOpenWhispers: 2,
    /** Influence the keeper spends to act on something they were told in private. */
    actOnWhisperCost: 6,
    /** Influence the keeper spends to settle a dilemma. */
    dilemmaCost: 10,
    /** Ticks of no wall work before the stall becomes the keeper's problem. */
    dilemmaStagnantTicks: 120,
    /** How far ahead of the field a mind must be before a role is minted. */
    roleLeadMargin: 6,
    /** The smallest observed pattern that can earn a role at all. */
    roleMinWeight: 8,
    /** How many roles the world will recognise at once. */
    maxRoles: 6,
    /** Ticks between two dilemmas being raised. */
    dilemmaIntervalTicks: 168
  },

  proposals: {
    /**
     * Proposal-based minds. When a mind acts on its own goal, the model proposes
     * the *approach* in its own words and the engine decides whether that
     * approach is actually possible here, what it costs, and what follows. The
     * engine never lets a model supply numbers or consequences.
     */
    enabled: true,
    /** A mind gets one model-authored approach this often, in world ticks. */
    intervalTicks: 20,
    /** Only minds whose goal is this far from finished are worth asking. */
    maxGoalProgress: 0.98,
    /** Hard bound on the approach text a model may write. */
    approachMaxChars: 240,
    /** A proposal that is still unanswered blocks the next one for this mind. */
    maxPendingPerMind: 1,
    /** Below this energy the engine will not validate any ambitious approach. */
    minEnergy: 12
  },

  cognition: {
    /** Only this many starting minds receive periodic open-plan model calls. */
    pilotCount: 2,
    /** A pilot mind makes one model-authored plan this often, in world ticks. */
    planIntervalTicks: 24,
    /** Bound private cognition data written by model responses. */
    maxBeliefs: 8,
    maxPriorities: 3,
    summaryMaxChars: 360,
    planMaxChars: 220
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
    alwaysMomentKinds: ["confront", "betray", "confide", "declare", "call_in"]
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
