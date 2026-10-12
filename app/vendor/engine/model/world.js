/**
 * The World: everything that exists, in one serialisable object.
 *
 * `createWorld` builds a fresh world from a seed. Same seed, same world, every
 * time — including the cast's temperaments, their secrets, and who happens to
 * be standing where. That property is what makes the simulation testable and
 * what will let you rewind and replay an interesting day later.
 */

import { createRng, weightedPick } from "../rng.js";
import { makeConfig } from "../config.js";
import { REGIONS, SECRET_TEMPLATES, BACKSTORIES } from "../content.js";
import { createClock } from "../clock.js";
import { createAgent } from "./agent.js";
import { createMemory, remember } from "./memory.js";
import { neutralEdge } from "./relationships.js";
import { createNorthWallProject } from "./projects.js";
import { createCharter } from "./charter.js";

/**
 * @typedef {import("./agent.js").Agent} Agent
 * @typedef {import("./memory.js").Memory} Memory
 * @typedef {import("./events.js").WorldEvent} WorldEvent
 * @typedef {ReturnType<typeof createNorthWallProject>} NorthWallProject
 */

/**
 * @typedef {object} Secret
 * @property {string} id
 * @property {string} kind        betrayal | theft | identity | weakness | knowledge | crime | debt
 * @property {string} text        The secret, in the holder's own words.
 * @property {string|null} aboutId  Who it is about, if anyone.
 * @property {Record<string, number>} holders  agentId -> fidelity 0..1 (how accurately they hold it).
 * @property {boolean} isPublic   Once true it can never go back in the box.
 * @property {number} originTick
 * @property {number} lastSpreadTick
 * @property {number} weaponisedTick   When someone used it against the subject.
 * @property {string|null} originatorId
 * @property {number} [timesTold]     How many times it has been passed on.
 * @property {number} [mutations]     How many of those tellings warped it.
 */

/**
 * The private view a moment's prompt is built from. Assembled per mind, from
 * that mind's own memory and its own side of each relationship — which is what
 * stops one agent's prompt from ever containing another agent's secrets.
 *
 * @typedef {object} MomentContext
 * @property {string} agentName
 * @property {string} stateLine
 * @property {string} mood
 * @property {string} region
 * @property {string} regionBlurb
 * @property {string} phase
 * @property {boolean} night
 * @property {string} goal
 * @property {number} goalProgress
 * @property {string} [goalKind]
 * @property {boolean} [atProjectSite]
 * @property {string[]} [availableMethods]  Approaches the engine can resolve from here.
 * @property {{ruleKind: string, name: string, kind: string, gloss: string, basis: string}[]} [petitionable]
 *   The changes this mind could honestly petition for, each with the fact that justifies it.
 * @property {string} [whisperSubject]     What a mind has to tell the keeper about, in outline.
 * @property {string[]} memories
 * @property {string} [memorySummary]       Persistent private cognition summary.
 * @property {string[]} [privateBeliefs]
 * @property {string[]} [privatePriorities]
 * @property {{id: string, name: string, region: string, relation: string}[]} [knownMinds]
 * @property {{title: string, status: string, progress: number, nextMilestone: string}} [project]
 * @property {string} [targetId]
 * @property {string} [targetName]
 * @property {string} [targetPersonality]
 * @property {string} [targetRegion]
 * @property {boolean} [together]
 * @property {string} [standingWord]        What the room thinks of this mind.
 * @property {string} [targetStandingWord]  What the room thinks of the other mind.
 * @property {string} [relationWord]
 * @property {string} [relationPhrase]
 * @property {string} [targetMood]
 * @property {string} [grievance]
 * @property {string} [secretText]
 * @property {string} [secretKind]
 * @property {string} [secretId]
 * @property {number} [fidelity]
 */

/**
 * @typedef {object} MomentOption
 * @property {string} id
 * @property {string} label
 * @property {string} tone
 * @property {import("../systems/effects.js").EffectOp[]} ops
 * @property {string} [prose]
 * @property {Record<string, any>} [data]
 */

/**
 * @typedef {object} Moment
 * @property {string} id
 * @property {number} tick
 * @property {string} kind        decision | dialogue | reflection | confrontation | betrayal | confession | declaration | cognition | goal_approach | petition | whisper
 * @property {string} agentId
 * @property {string[]} participants
 * @property {number} significance
 * @property {string} question    What the model is being asked, in narrative terms.
 * @property {MomentContext} context  What this mind knows, and nothing else.
 * @property {string} [resolution] The model's answer, once it comes back.
 * @property {string} [optionId]  Which option was chosen, model or engine.
 * @property {boolean} [resolved]
 * @property {boolean} [engineResolved]  True when the engine decided because no model answered in time.
 * @property {string} [source]    Which system emitted it.
 * @property {string} [planText]  A pilot mind's recorded self-authored plan.
 * @property {string} [planAction]
 * @property {boolean} [planAccepted]
 * @property {string} [planValidation]
 * @property {string} [approachText]      A mind's own words for how it meant to pursue its goal.
 * @property {string} [approachMethod]    The validated verb the engine resolved it as.
 * @property {boolean} [approachAccepted]
 * @property {string} [approachValidation]
 * @property {string} [petitionId]        The charter petition a petition moment produced.
 * @property {string} [whisperId]         The charter whisper a whisper moment produced.
 * @property {MomentOption[]} options
 */

/**
 * @typedef {object} World
 * @property {string} id
 * @property {number|string} seed
 * @property {import("../config.js").WorldConfig} config
 * @property {import("../rng.js").Rng} rng
 * @property {import("../clock.js").WorldClock} clock
 * @property {Agent[]} agents
 * @property {typeof REGIONS} regions
 * @property {WorldEvent[]} events
 * @property {Record<string, number>} tallies  Lifetime count of every event kind, since the log rolls over.
 * @property {Secret[]} secrets
 * @property {NorthWallProject} project  Shared, persistent North Wall construction project.
 * @property {import("./charter.js").Charter} charter  Traditions, laws, roles, precedents, petitions.
 * @property {Moment[]} pending     Emitted moments awaiting a model answer.
 * @property {Moment[]} resolved    Moments that have been answered and applied.
 * @property {number} seq
 * @property {Record<string, number>} idCounters
 * @property {object[]} chronicle    Day-level summaries, written as the world ages.
 * @property {number} [chronicleMark] Tick at which the last day summary was written.
 * @property {Record<string, any>} [flags] Diagnostics, e.g. the last failed effect.
 * @property {object[]} [pendingOps] Ops queued by a system and applied at the end of the tick.
 * @property {Record<string, string[]>} [proseMemory] Recently used narration, per pool — what stops the feed repeating itself.
 * @property {number} [lastArrivalTick]  Tick a wanderer last arrived.
 * @property {number} [lastDepartureTick] Tick a mind last left or died.
 * @property {string} [lastRitualKey]  "ritualId:day" of the last applied ritual.
 * @property {(kind: string) => string} nextId
 */

/* ------------------------------------------------------------------ *
 * Deterministic ids
 * ------------------------------------------------------------------ */

/**
 * Create an id factory. Counter-based, never time-based: a sim that used
 * `Date.now()` or `Math.random()` for ids could not be replayed.
 * @param {Record<string, number>} counters
 * @returns {(kind: string) => string}
 */
export function makeIdFactory(counters) {
  return (kind) => {
    counters[kind] = (counters[kind] || 0) + 1;
    return `${kind}${counters[kind]}`;
  };
}

/* ------------------------------------------------------------------ *
 * The seed cast
 * ------------------------------------------------------------------ */

/**
 * The nine minds the world begins with. Carried over from the original
 * prototype so the world keeps its history, fleshed out with the fields the
 * simulation needs.
 */
export const SEED_CAST = [
  { name: "Elio", epithet: "", class: "Scholar", archetype: "The Curious", color: "#34d399", icon: "◉", regionId: "lantern",
    personality: "Curious cartographer mapping the unknown", goalText: "Chart the far edge of the world.", goalKind: "uncover" },
  { name: "Juno", epithet: "the Quiet", class: "Warden", archetype: "The Stoic", color: "#f472b6", icon: "✦", regionId: "wall",
    personality: "Watchful; speaks rarely, and only when it matters", goalText: "Keep the north wall standing.", goalKind: "protect" },
  { name: "Cass", epithet: "", class: "Diplomat", archetype: "The Bold", color: "#a78bfa", icon: "❖", regionId: "crossroads",
    personality: "Schemer; always three moves ahead", goalText: "Learn every mind's hidden leverage.", goalKind: "uncover" },
  { name: "Fable", epithet: "", class: "Scholar", archetype: "The Dreamer", color: "#8b5cf6", icon: "✧", regionId: "market",
    personality: "Storyteller; turns events into myth", goalText: "Turn today's events into lasting myth.", goalKind: "build" },
  { name: "Sable", epithet: "", class: "Maker", archetype: "The Curious", color: "#f472b6", icon: "⚒", regionId: "lantern",
    personality: "Maker; builds tools from scraps", goalText: "Build a tool the world has never seen.", goalKind: "build" },
  { name: "Pim", epithet: "", class: "Warden", archetype: "The Bold", color: "#22d3ee", icon: "◎", regionId: "lowlands",
    personality: "Scout; quick feet, quicker eyes", goalText: "Scout what lies beyond the lantern district.", goalKind: "uncover" },
  { name: "Wren", epithet: "", class: "Diplomat", archetype: "The Stoic", color: "#fbbf24", icon: "⛨", regionId: "market",
    personality: "Keeper of secrets; never tells all", goalText: "Guard the one secret that must never surface.", goalKind: "protect" },
  { name: "Sei", epithet: "", class: "Scholar", archetype: "The Dreamer", color: "#8b5cf6", icon: "✦", regionId: "marsh",
    personality: "Tide-reader; feels the world's moods", goalText: "Read the tide before it turns.", goalKind: "master" },
  { name: "Orin", epithet: "", class: "Diplomat", archetype: "The Curious", color: "#34d399", icon: "⛉", regionId: "crossroads",
    personality: "Mediator; finds the middle path", goalText: "Keep the council from breaking apart.", goalKind: "unite" }
];

/* ------------------------------------------------------------------ *
 * World construction
 * ------------------------------------------------------------------ */

/**
 * Build a fresh world.
 * @param {object} [opts]
 * @param {number|string} [opts.seed]
 * @param {Partial<import("../config.js").WorldConfig>} [opts.config]
 * @param {typeof SEED_CAST} [opts.cast]
 * @returns {World}
 */
export function createWorld(opts = {}) {
  const seed = opts.seed ?? 1;
  const config = makeConfig(opts.config);
  const rng = createRng(seed);
  /** @type {Record<string, number>} */
  const counters = {};
  const nextId = makeIdFactory(counters);

  /** @type {World} */
  const world = {
    id: `world-${seed}`,
    seed,
    config,
    rng,
    clock: createClock(),
    agents: [],
    regions: REGIONS,
    events: [],
    tallies: {},
    secrets: [],
    project: createNorthWallProject(),
    charter: createCharter(),
    pending: [],
    resolved: [],
    seq: 0,
    idCounters: counters,
    chronicle: [],
    proseMemory: {},
    nextId
  };

  const cast = opts.cast || SEED_CAST;
  for (const spec of cast) {
    const memory = createMemory();
    const agent = createAgent(
      {
        id: nextId("m"),
        name: spec.name,
        epithet: spec.epithet,
        class: spec.class,
        archetype: spec.archetype,
        personality: spec.personality,
        backstory: rng.pick(BACKSTORIES),
        color: spec.color,
        icon: spec.icon,
        regionId: spec.regionId,
        goalText: spec.goalText,
        goalKind: spec.goalKind,
        seedCast: true
      },
      rng,
      world.clock.tick,
      memory,
      config.progression.levelDivisor
    );
    const pilotCount = Math.max(0, Math.floor(config.cognition.pilotCount));
    if (world.agents.length < pilotCount) {
      agent.cognition.enabled = true;
      const interval = Math.max(1, config.cognition.planIntervalTicks);
      agent.cognition.nextPlanTick = 1 + Math.floor(world.agents.length * interval / Math.max(1, pilotCount));
    }
    // The first memory every mind has is of arriving.
    remember(memory, {
      tick: 0,
      kind: "observation",
      text: `${agent.backstory} They came to ${regionName(world, agent.regionId)} and started paying attention.`,
      subjectId: null,
      valence: 0.1,
      salience: 0.35
    }, nextId);
    world.agents.push(agent);
  }

  seedInitialSecrets(world);
  seedInitialBonds(world);
  seedTensions(world);

  return world;
}

/**
 * Give the world something to be about before it starts.
 *
 * A cast with no history is a cast with nothing to do: everyone is neutral
 * toward everyone, no threshold is crossed, and the simulation spends its first
 * week being polite. A few genuinely bad relationships from the outset give the
 * grudge, confrontation and betrayal systems something to bite on immediately —
 * and they give the model something worth writing about.
 * @param {World} world
 */
function seedTensions(world) {
  const rng = world.rng;
  const count = Math.max(2, Math.round(world.agents.length * 0.3));
  for (let i = 0; i < count; i++) {
    const a = rng.pick(world.agents);
    const candidates = world.agents.filter(
      x => x.id !== a.id && !x.retired && (a.relations[x.id]?.resentment ?? 0) < 20
    );
    if (!candidates.length) continue;
    const b = rng.pick(candidates);

    const resentment = rng.range(28, 62);
    const affinity = -rng.range(4, 28);
    // Cooled from the same incident, but asymmetrically: whoever was wronged
    // harder feels it harder, and neither of them agrees on what happened.
    a.relations[b.id] = Object.assign(neutralEdge(), a.relations[b.id], {
      resentment,
      affinity,
      trust: rng.range(8, 30),
      familiarity: rng.range(18, 55)
    });
    b.relations[a.id] = Object.assign(neutralEdge(), b.relations[a.id], {
      resentment: resentment * rng.range(0.4, 1.2),
      affinity: affinity * rng.range(0.5, 1.1),
      trust: rng.range(12, 40),
      familiarity: rng.range(18, 55)
    });

    const incident = rng.pick([
      `${b.name} claims it was nothing. It was not nothing.`,
      `It started with ${b.name} taking something that was never theirs to take.`,
      `${b.name} said it in front of the others, and then never mentioned it again.`,
      `Nobody else saw what ${b.name} did, which is the whole problem.`
    ]);
    remember(a.memory, {
      tick: -rng.int(1, 60),
      kind: "conflict",
      text: incident,
      subjectId: b.id,
      valence: -0.65,
      salience: 0.8
    }, world.nextId);
    remember(b.memory, {
      tick: -rng.int(1, 60),
      kind: "conflict",
      text: `${a.name} has been cold with me for weeks and will not say why.`,
      subjectId: a.id,
      valence: -0.4,
      salience: 0.6
    }, world.nextId);
  }
}

/**
 * Plant a few secrets before the world starts running, so the first social
 * scenes have something to be about. Secrets are distributed unevenly on
 * purpose: some minds hold several, some hold none.
 * @param {World} world
 */
function seedInitialSecrets(world) {
  const rng = world.rng;
  const count = Math.max(2, Math.round(world.agents.length * 0.7));
  for (let i = 0; i < count; i++) {
    const holder = rng.pick(world.agents);
    const template = weightedPick(rng, SECRET_TEMPLATES, t => t.weight);
    // Decide who the secret is about.
    let aboutId = null;
    if (template.about.includes("any")) {
      aboutId = rng.chance(0.7) ? rng.pick(world.agents.filter(a => a.id !== holder.id)).id : null;
    } else if (template.about.includes("rival")) {
      aboutId = rng.pick(world.agents.filter(a => a.id !== holder.id)).id;
    } else if (template.about.includes("ally")) {
      aboutId = rng.pick(world.agents.filter(a => a.id !== holder.id)).id;
    }
    if (template.about.includes("self")) aboutId = holder.id;

    const subject = aboutId ? world.agents.find(a => a.id === aboutId) : null;
    const region = rng.pick(world.regions);
    const text = template.text
      .replace("{name}", subject ? subject.name : "someone")
      .replace("{region}", region.name.replace(/^the /, ""));

    const secret = createSecret(world, {
      kind: template.kind,
      text: `${holder.name} ${text}.`,
      aboutId,
      holderId: holder.id,
      fidelity: 1,
      originatorId: holder.id
    });
    if (!secret) continue;

    // A mind keeps its own secret; the model of "who knows" starts closed.
    remember(holder.memory, {
      tick: 0,
      kind: "secret",
      text: `I know something: ${text}. Nobody else does.`,
      subjectId: aboutId,
      valence: -0.2,
      salience: 0.8,
      secretId: secret.id
    }, world.nextId);
  }
}

/**
 * Give the world a little prior history: a handful of existing acquaintances so
 * day one isn't a room full of strangers. This is where the opening tensions
 * come from — someone already owes someone, someone already resents someone.
 * @param {World} world
 */
function seedInitialBonds(world) {
  const rng = world.rng;
  const pairs = Math.max(3, Math.floor(world.agents.length * 0.7));
  for (let i = 0; i < pairs; i++) {
    const a = rng.pick(world.agents);
    const b = rng.pick(world.agents.filter(x => x.id !== a.id));
    const warmth = rng.gauss(0, 22);
    const suspicion = Math.max(0, rng.gauss(0, 10));

    // Debts are the one axis that must agree: if a's edge says b owes a, then
    // b's edge must say a is owed. A debt that disagrees with itself is not
    // asymmetry, it is a bookkeeping error.
    const seedDebt = rng.chance(0.3) ? rng.int(-40, 40) : 0;
    a.relations[b.id] = {
      affinity: clamp100(warmth),
      trust: clamp100(45 + warmth * 0.5),
      fear: clamp100(Math.max(0, rng.gauss(0, 6))),
      resentment: clamp100(suspicion),
      familiarity: rng.range(15, 60),
      lastContactTick: -1,
      contacts: rng.int(1, 8),
      secretsShared: 0,
      debts: seedDebt
    };
    // The other side is correlated but not identical — asymmetry from day one.
    b.relations[a.id] = {
      affinity: clamp100(warmth * rng.range(0.4, 1.3) + rng.gauss(0, 10)),
      trust: clamp100(45 + warmth * rng.range(0.2, 0.9)),
      fear: clamp100(Math.max(0, rng.gauss(0, 6))),
      resentment: clamp100(suspicion * rng.range(0.3, 2)),
      familiarity: rng.range(15, 60),
      lastContactTick: -1,
      contacts: rng.int(1, 8),
      secretsShared: 0,
      // The old code drew an independent debt for this side too; those draws
      // are consumed and discarded so the RNG stream stays exactly where it
      // was — the only change is that the ledger now agrees with itself.
      debts: rng.chance(0.3) ? (rng.int(-40, 40), -seedDebt) : -seedDebt
    };

    // And a memory of the history, so the relationship has a reason to exist.
    if (Math.abs(warmth) > 12) {
      const good = warmth > 0;
      remember(a.memory, {
        tick: -rng.int(1, 40),
        kind: good ? "contact" : "conflict",
        text: good
          ? `${b.name} was there when it mattered. That counts for something.`
          : `Something went sideways with ${b.name} and neither of us has said it out loud.`,
        subjectId: b.id,
        valence: good ? 0.6 : -0.5,
        salience: 0.55
      }, world.nextId);
    }
  }
}

/** @param {number} n */
function clamp100(n) {
  return Math.max(-100, Math.min(100, n));
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

/**
 * Create a secret and record who holds it.
 * @param {World} world
 * @param {object} spec
 * @param {string} spec.kind
 * @param {string} spec.text
 * @param {string|null} spec.aboutId
 * @param {string} spec.holderId
 * @param {number} [spec.fidelity]
 * @param {string} [spec.originatorId]
 * @returns {Secret|null} Null when the world's hard secret cap is reached.
 */
export function createSecret(world, spec) {
  // This public constructor is used during seeding as well as by effects. Keep
  // the invariant here too, so no caller can bypass the world-wide limit.
  if (world.secrets.length >= world.config.limits.secretsInWorld) return null;
  /** @type {Secret} */
  const secret = {
    id: world.nextId("s"),
    kind: spec.kind,
    text: spec.text,
    aboutId: spec.aboutId,
    holders: { [spec.holderId]: spec.fidelity ?? 1 },
    isPublic: false,
    originTick: world.clock.tick,
    lastSpreadTick: world.clock.tick,
    weaponisedTick: -1,
    originatorId: spec.originatorId ?? spec.holderId
  };
  world.secrets.push(secret);
  return secret;
}

/**
 * Teach a secret to another mind, at some fidelity. If they already hold a more
 * accurate version, the telling does not sharpen it — rumours don't improve with
 * repetition in this world, which is the point.
 * @param {World} world
 * @param {Secret} secret
 * @param {string} agentId
 * @param {number} fidelity
 */
export function learnSecret(world, secret, agentId, fidelity) {
  const existing = secret.holders[agentId];
  if (existing === undefined) {
    // Nobody takes on more than they can carry. A mind already holding its
    // limit can still be told — it simply doesn't retain it.
    const capacity = world.config.limits.secretsPerAgent;
    if (privateSecretsHeld(world, agentId).length >= capacity) return;
    secret.holders[agentId] = fidelity;
  }
  secret.lastSpreadTick = world.clock.tick;
}

/**
 * Every secret a mind currently holds a version of, including public ones.
 * @param {World} world
 * @param {string} agentId
 */
export function secretsKnownBy(world, agentId) {
  return world.secrets.filter(s => s.holders[agentId] !== undefined);
}

/**
 * Non-public secrets a mind is carrying. Only these count toward capacity.
 * @param {World} world
 * @param {string} agentId
 * @returns {import("./world.js").Secret[]}
 */
export function privateSecretsHeld(world, agentId) {
  return world.secrets.filter(s => s.holders[agentId] !== undefined && !s.isPublic);
}

/**
 * Secrets a mind holds that it could use against someone: about another mind,
 * not already public, and not the mind's own.
 * @param {World} world
 * @param {string} agentId
 */
export function weaponisableSecrets(world, agentId) {
  return world.secrets.filter(
    s => s.holders[agentId] !== undefined && !s.isPublic && s.aboutId && s.aboutId !== agentId
  );
}

/**
 * Secrets that are about a particular mind.
 * @param {World} world
 * @param {string} agentId
 * @returns {import("./world.js").Secret[]}
 */
export function secretsAbout(world, agentId) {
  return world.secrets.filter(s => s.aboutId === agentId);
}

/**
 * The version of a secret a particular mind actually holds.
 *
 * A rumour that has been passed along three times is not the same sentence it
 * started as, and a mind acting on a garbled version should be wrong in ways it
 * cannot detect. Rather than storing mutated copies, the engine degrades the
 * telling at the point of recall based on the holder's fidelity.
 *
 * @param {Secret} secret
 * @param {number} fidelity 0..1
 * @returns {string}
 */
export function secretTextFor(secret, fidelity) {
  const core = secret.text.replace(/\.$/, "");
  if (fidelity >= 0.85) return secret.text;
  if (fidelity >= 0.6) return `They say that ${core}.`;
  if (fidelity >= 0.35) {
    return `It's going around that ${core}, though nobody agrees on the details.`;
  }
  // The listener is getting almost nothing. Every secret begins with a name,
  // so the clause slots into a sentence without ever being lower-cased.
  return `Nobody tells it the same way twice. Half of them say ${core}. The other half say it never happened.`;
}

/**
 * The claim at the heart of a secret, stripped of any framing.
 *
 * `secretTextFor` returns a whole sentence with its own "they say that" around
 * it, which is what a feed line wants when the fact stands alone. A retelling is
 * different: the framing depends on who is doing the telling and how well they
 * know the person they are telling, so the prose templates own the framing and
 * this supplies only the claim that goes inside it.
 *
 * Every secret template begins with the holder's name (or a verb that takes one),
 * so the claim is safe to slot in mid-sentence without being lower-cased.
 *
 * @param {Secret} secret
 * @returns {string}
 */
export function secretClaimFor(secret) {
  return secret.text.replace(/\.$/, "");
}

/**
 * Make a secret public. Irreversible: once the world knows, it knows.
 * @param {World} world
 * @param {Secret} secret
 */
export function publishSecret(world, secret) {
  secret.isPublic = true;
  secret.lastSpreadTick = world.clock.tick;
  for (const agent of world.agents) {
    const holder = secret.holders[agent.id];
    if (holder === undefined) secret.holders[agent.id] = 0.6;
    // If the whole world knows, everyone ends up holding at least a version.
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/** @param {World} world @param {string} id */
export function agentById(world, id) {
  return world.agents.find(a => a.id === id) || null;
}
/**
 * @param {any} r
 */

/**
 * Find a mind by name, case-insensitively.
 * @param {World} world
 * @param {string} name
 * @returns {import("./agent.js").Agent|null}
 */
export function agentByName(world, name) {
/**
 * @param {import("./world.js").World} world
 */
  const lower = name.toLowerCase();
  return world.agents.find(a => a.name.toLowerCase() === lower) || null;
}

/**
 * Everyone physically in a region.
 * @param {World} world
 * @param {string} regionId
 * @returns {import("./agent.js").Agent[]}
 */
export function agentsIn(world, regionId) {
  return world.agents.filter(a => !a.retired && a.regionId === regionId);
}

/**
 * Everyone still awake or asleep, but not retired.
 * @param {World} world
 * @returns {import("./agent.js").Agent[]}
 */
export function livingAgents(world) {
  return world.agents.filter(a => !a.retired);
}

/**
 * @param {World} world
 * @param {string} id
 */
export function regionById(world, id) {
  return world.regions.find(r => r.id === id) || world.regions[0];
}

/**
 * @param {World} world
 * @param {string} id
 */
export function regionName(world, id) {
  return regionById(world, id)?.name || "the world";
/**
 * @param {number} n
 */
}

/**
 * How many living minds are in each region, by region id.
 * @param {World} world
 * @returns {Record<string, import("./agent.js").Agent[]>} Living minds, keyed by region id.
 */
export function regionOccupancy(world) {
  /** @type {Record<string, Agent[]>} */
  const out = {};
  for (const region of world.regions) out[region.id] = [];
  for (const agent of livingAgents(world)) {
    (out[agent.regionId] ||= []).push(agent);
  }
  return out;
}

/**
 * A summary board of the whole world, cheap enough to call per tick.
 * @param {World} world
 * @returns {Record<string, any>}
 */
export function worldStats(world) {
  const living = livingAgents(world);
  const byRegion = regionOccupancy(world);
  const conflicted = living.filter(a =>
    Object.values(a.relations).some(e => e.resentment >= world.config.relations.rivalryThreshold)
  );
  return {
    tick: world.clock.tick,
    day: world.clock.day,
    phase: world.clock.phase,
    agents: living.length,
    awakened: living.filter(a => a.awake).length,
    events: world.seq,
    secrets: world.secrets.length,
    publicSecrets: world.secrets.filter(s => s.isPublic).length,
    conflicts: conflicted.length,
    tallies: world.tallies,
    bonds: living.reduce((n, a) => n + Object.values(a.relations).filter(e => e.affinity >= world.config.relations.allianceThreshold).length, 0) / 2,
    occupancy: Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, v.length])),
    busiest: Object.entries(byRegion).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || null
  };
}
