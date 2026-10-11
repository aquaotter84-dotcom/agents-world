/**
 * Action resolution: turning a chosen intent into things that actually happen.
 *
 * This is the deterministic half of the simulation. Everything a mind does that
 * does *not* need a language model gets resolved here, at full speed, with no
 * network calls — which is what lets the world run at thousands of ticks per
 * second in a test and lets the model budget be spent on the moments that earn it.
 *
 * Every resolution returns a list of ops (see `effects.js`) plus prose. Nothing
 * here mutates the world directly.
 */

import { clamp } from "../config.js";
import { edgeToward } from "../model/relationships.js";
import { agentById, regionName, secretTextFor, livingAgents } from "../model/world.js";
import { nextStepToward, unfamiliarRegions, solitaryRegions, sociableTarget } from "../model/regions.js";
import { temperamentOverlap } from "../model/agent.js";
import { recall } from "../model/memory.js";
import { phrase } from "../decision/prose.js";
import { isNight } from "../clock.js";
import { generateIntents } from "../decision/intents.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../decision/intents.js").Intent} Intent
 * @typedef {import("./effects.js").EffectOp} EffectOp
 */

/**
 * @typedef {object} Resolution
 * @property {EffectOp[]} ops
 * @property {string} text        Engine-authored prose for the event log.
 * @property {string} eventKind
 * @property {number} significance
 * @property {boolean} quiet      True when this shouldn't clutter the public feed.
 */

/**
 * Resolve an intent deterministically.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} [ranked] Used when a fallback re-decision is needed.
 * @returns {Resolution}
 */
export function resolveIntent(world, agent, intent, ranked) {
  /** @type {Record<string, (w: World, a: Agent, i: Intent, r?: Intent[]) => Resolution>} */
  const handlers = {
    rest: resolveRest,
    seek_company: resolveSeekCompany,
    gossip: resolveGossip,
    pursue_goal: resolveGoal,
    explore: resolveExplore,
    withdraw: resolveWithdraw,
    forge_bond: resolveForgeBond,
    observe: resolveObserve
  };
  const handler = handlers[intent.kind];
  if (!handler) return resolveObserve(world, agent, intent, ranked);
  return handler(world, agent, intent, ranked);
}

/* ------------------------------------------------------------------ *
 * Rest
 * ------------------------------------------------------------------ */

/**
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
function resolveRest(world, agent) {
  const aptitude = classAptitude(agent, "energy");
  const recovery = world.config.needs.restRecovery * aptitude;
  const night = isNight(world.clock);
  return {
    ops: [
      { op: "need", agent: agent.id, deltas: { energy: recovery, connection: -2 } },
      { op: "xp", agent: agent.id, amount: 5 },
      {
        op: "memory",
        agent: agent.id,
        trace: {
          kind: "act",
          text: "A day given over to rest. It helped, mostly.",
          subjectId: null,
          valence: 0.15,
          salience: 0.2
        }
      }
    ],
    text: phrase(world, agent, night ? "rest_night" : "rest", { region: regionName(world, agent.regionId) }),
    eventKind: "act",
    significance: 0.15,
    quiet: true
  };
}

/**
 * @param {import("../model/world.js").World} world
 */

/**
 * Spend time with someone nearby, or go looking for company.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @returns {Resolution}
 */
function resolveSeekCompany(world, agent, intent) {
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  if (!target || target.retired) {
    return resolveObserve(world, agent, intent);
  }

  if (target.regionId !== agent.regionId) {
    // Somewhere else: this action becomes a journey, and the meeting waits.
    return travelToward(world, agent, target.regionId, target.name);
  }
  return socialEncounter(world, agent, target, intent.kind === "forge_bond" ? "bond" : "meet");
}

/**
 * A meeting between two co-located minds. How it goes is decided here — mood,
 * temperament, history and a little luck — and both sides get asymmetric
 * outcomes, because two people never take the same thing from a conversation.
 * @param {World} world
 * @param {Agent} agent
 * @param {Agent} other
 * @param {"meet"|"bond"} mode
 * @returns {Resolution}
 */
export function socialEncounter(world, agent, other, mode) {
  const cfg = world.config;
  const edge = edgeToward(agent, other.id);
  const back = edgeToward(other, agent.id);

  // Chemistry: how alike they are, adjusted by how either side already feels.
  const overlap = temperamentOverlap(agent, other);
  const warmth = (edge.affinity + back.affinity) / 200;      // -1..1
  const friction = (edge.resentment + back.resentment) / 200;
  const firstMeeting = edge.familiarity < 5;

  const roll = world.rng.gauss(0, 0.28) + overlap * 0.35 + warmth * 0.6 - friction * 0.8;
  const quality = clamp(roll, -1, 1);

  const multiplier = firstMeeting ? cfg.social.firstMeetingMultiplier : 1;
  const affinityDelta = clamp(quality * 14 * multiplier, -22, 22);
  const trustDelta = clamp(quality * 8 * multiplier, -14, 14);

  const variant = quality > 0.25 ? "contact_warm" : quality < -0.25 ? "contact_awkward" : "contact_neutral";
  const region = regionName(world, agent.regionId);

  /** @type {EffectOp[]} */
  /** @type {EffectOp[]} */
  const ops = [
    { op: "contact", from: agent.id, to: other.id },
    { op: "contact", from: other.id, to: agent.id },
    { op: "edge", from: agent.id, to: other.id, deltas: { affinity: affinityDelta, familiarity: 9, trust: trustDelta } },
    { op: "edge", from: other.id, to: agent.id, deltas: { affinity: affinityDelta * 0.85, familiarity: 9, trust: trustDelta * 0.85 } },
    { op: "need", agent: agent.id, deltas: { connection: 16 + quality * 6, energy: -4, esteem: quality * 4 } },
    { op: "need", agent: other.id, deltas: { connection: 14 + quality * 5, esteem: quality * 3 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: quality < -0.25 ? "conflict" : "contact",
        text:
          quality > 0.25
            ? `Time with ${other.name} that I did not have to perform for.`
            : quality < -0.25
              ? `${other.name} and I rubbed each other the wrong way again.`
              : `An ordinary conversation with ${other.name}.`,
        subjectId: other.id,
        valence: quality,
        salience: 0.3 + Math.abs(quality) * 0.4
      }
    },
    {
      op: "memory",
      agent: other.id,
      trace: {
        kind: quality < -0.25 ? "conflict" : "contact",
        text:
          quality > 0.25
            ? `${agent.name} was good company today.`
            : quality < -0.25
              ? `${agent.name} was difficult today, and I noticed.`
              : `Saw ${agent.name} around, nothing more.`,
        subjectId: agent.id,
        valence: quality * 0.8,
        salience: 0.25 + Math.abs(quality) * 0.35
      }
    },
    { op: "xp", agent: agent.id, amount: mode === "bond" ? 12 : 7 }
  ];

  // Jealousy. Anyone standing nearby who cares about either of these two feels
  // the exclusion, and it comes out as resentment toward the other one. This is
  // most of what stops a world of friendly encounters from being pleasant all
  // the way down.
  const witnesses = world.agents.filter(
    a => !a.retired && a.id !== agent.id && a.id !== other.id && a.regionId === agent.regionId
  );
  for (const witness of witnesses) {
    const towardAgent = edgeToward(witness, agent.id);
    const towardOther = edgeToward(witness, other.id);
    const caringMost = Math.max(towardAgent.affinity, towardOther.affinity);
    if (caringMost < 30) continue;
    // You resent whoever is taking up the attention you wanted.
    const excluded = towardAgent.affinity > towardOther.affinity ? other : agent;
    const sting = 1 + caringMost / 40;
    ops.push({ op: "edge", from: witness.id, to: excluded.id, deltas: { resentment: sting, affinity: -sting * 0.4 } });
    ops.push({
      op: "memory",
      agent: witness.id,
      trace: {
        kind: "conflict",
        text: `${excluded.name} had all of ${(excluded.id === other.id ? agent : other).name}'s attention, and I minded more than I should have.`,
        subjectId: excluded.id,
        valence: -0.4,
        salience: 0.45
      }
    });
  }

  // Two minds chasing the same thing get in each other's way, especially when
  // both are driven about it.
  if (agent.goal.kind === other.goal.kind && agent.goal.text !== other.goal.text) {
    const friction = 1.5 + (agent.drives.focus + other.drives.focus) / 120;
    ops.push({ op: "edge", from: agent.id, to: other.id, deltas: { resentment: friction, trust: -1 } });
    ops.push({ op: "edge", from: other.id, to: agent.id, deltas: { resentment: friction * 0.8 } });
  }

  // Being outshone stings when you already feel small.
  if (agent.needs.esteem < 35 && other.level > agent.level) {
    ops.push({ op: "edge", from: agent.id, to: other.id, deltas: { resentment: 2.5, affinity: -1 } });
    ops.push({ op: "need", agent: agent.id, deltas: { esteem: -2 } });
  }

  // A friendship that has run hot for a long time occasionally becomes official.
  if (mode === "bond" && edge.affinity > cfg.relations.allianceThreshold) {
    ops.push({ op: "edge", from: agent.id, to: other.id, deltas: { trust: 8, affinity: 6 } });
  }

  return {
    ops,
    text: phrase(world, agent, variant, { other: other.name, region }),
    eventKind: "contact",
    significance: Math.abs(quality) > 0.5 ? 0.45 : 0.2,
    quiet: Math.abs(quality) < 0.25
  };
}

/**
 * Tell someone what you think of a third mind — or a secret you hold.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @returns {Resolution}
 */
function resolveGossip(world, agent, intent) {
  const cfg = world.config;
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  if (!target) return resolveObserve(world, agent, intent);
  if (target.regionId !== agent.regionId) return travelToward(world, agent, target.regionId, target.name);

  const secretId = intent.payload && intent.payload.secretId;
  const secret = secretId ? world.secrets.find(s => s.id === secretId) : null;
  // No secret to trade: fall back to talking about somebody, which is most of
  // what gossip actually is.
  if (!secret) return shareOpinion(world, agent, target, intent);
  return shareSecret(world, agent, target, secret, cfg);
}

/**
 * The opinion half of gossip: words about somebody who is not there.
 * @param {World} world
 * @param {Agent} agent
 * @param {Agent} target
 * @param {Intent} intent
 * @returns {Resolution}
 */
function shareOpinion(world, agent, target, intent) {
  const aboutId = intent.payload && intent.payload.aboutId;
  const about = aboutId ? agentById(world, aboutId) : null;
  if (!about) return resolveObserve(world, agent, intent);

  // What the speaker actually thinks, taken from their own memory of the person.
  const memories = recall(agent.memory, {
    tick: world.clock.tick,
    aboutId: about.id,
    limit: 1,
    config: world.config
  });
  const sentiment = memories.length ? memories[0].valence : edgeToward(agent, about.id).affinity / 100;

  const listenerLoyalty = edgeToward(target, about.id);
  const telling = sentiment < -0.2 ? "unkind" : sentiment > 0.2 ? "warm" : "measured";
  const opinion = world.rng.pick(
    telling === "unkind"
      ? [`It was about ${about.name}, and it was not kind.`,
         `${about.name} came up, and ${agent.name} did not defend them.`,
         `${agent.name} had a grievance to air about ${about.name}.`]
      : telling === "warm"
        ? [`It was about ${about.name}, and it was generous.`,
           `${agent.name} spoke well of ${about.name} when they had no reason to.`,
           `${about.name} came up, and ${agent.name} was warm about it.`]
        : [`It was about ${about.name}, and ${agent.name} was careful about it.`,
           `${about.name} came up and ${agent.name} said nothing decisive.`]
  );

  /** @type {EffectOp[]} */
  const ops = [
    { op: "edge", from: agent.id, to: target.id, deltas: { affinity: 4, familiarity: 8, trust: 1 } },
    { op: "edge", from: target.id, to: agent.id, deltas: { familiarity: 8, affinity: telling === "unkind" ? -1 : 2 } },
    { op: "need", agent: agent.id, deltas: { connection: 10, esteem: 3, energy: -3 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "gossip",
        text: `I told ${target.name} what I think of ${about.name}.`,
        subjectId: about.id,
        valence: 0.1,
        salience: 0.4
      }
    },
    {
      op: "memory",
      agent: target.id,
      trace: {
        kind: "gossip",
        text: `${agent.name} had ${telling} things to say about ${about.name}.`,
        subjectId: agent.id,
        valence: telling === "unkind" ? -0.3 : 0.2,
        salience: 0.45
      }
    },
    { op: "xp", agent: agent.id, amount: 7 }
  ];

  // Badmouthing someone to their friend is a way to lose the friend.
  if (telling === "unkind" && listenerLoyalty.affinity > 25) {
    const sting = 4 + listenerLoyalty.affinity / 12;
    /** @type {EffectOp} */
    const stingOp = { op: "edge", from: target.id, to: agent.id, deltas: { affinity: -sting, trust: -sting * 0.8, resentment: sting * 0.9 } };
    ops.push(stingOp);
    /** @type {EffectOp} */
    const wounded = { op: "need", agent: target.id, deltas: { esteem: -2 } };
    ops.push(wounded);
    ops.push({
      op: "memory",
      agent: target.id,
      trace: {
        kind: "conflict",
        text: `${agent.name} ran down ${about.name} to me, and ${about.name} is a friend of mine.`,
        subjectId: agent.id,
        valence: -0.5,
        salience: 0.7
      }
    });
  }

  return {
    ops,
    text: `${phrase(world, agent, "gossip", { other: target.name, region: regionName(world, agent.regionId) })} ${opinion}`,
    eventKind: "gossip",
    significance: telling === "unkind" ? 0.35 : 0.2,
    quiet: telling !== "unkind"
  };
}

/**
 * The secret half of gossip: passing on something you were trusted with.
 * @param {World} world
 * @param {Agent} agent
 * @param {Agent} target
 * @param {import("../model/world.js").Secret} secret
 * @param {import("../config.js").WorldConfig} cfg
 * @returns {Resolution}
 */
function shareSecret(world, agent, target, secret, cfg) {
  const held = secret.holders[agent.id] ?? 1;
  // Every retelling wears the story down a little; sometimes a lot.
  let fidelity = held - cfg.social.gossipFidelityLoss;
  if (world.rng.chance(cfg.social.gossipMutationChance)) fidelity -= cfg.social.gossipFidelityLoss;
  fidelity = clamp(fidelity, 0.1, 1);

  const asTold = secretTextFor(secret, fidelity);

  /** @type {EffectOp[]} */
  const ops = [
    { op: "secret_share", secretId: secret.id, from: agent.id, to: target.id, fidelity,
      memoryText: `${agent.name} told me something about someone. It did not sound certain, but it was interesting.`,
      memoryValence: -0.1, memorySalience: 0.6 },
    { op: "edge", from: agent.id, to: target.id, deltas: { affinity: 5, familiarity: 8, trust: 2 } },
    { op: "edge", from: target.id, to: agent.id, deltas: { familiarity: 8, affinity: 2 } },
    { op: "need", agent: agent.id, deltas: { connection: 12, esteem: 4, energy: -3 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "gossip",
        text: `I told ${target.name} what I heard. It felt good to hand it to someone else.`,
        subjectId: secret.aboutId,
        valence: 0.1,
        salience: 0.5,
        secretId: secret.id
      }
/**
 * @param {import("../model/world.js").World} world
 */
    },
    { op: "xp", agent: agent.id, amount: 9 }
  ];

  return {
    ops,
    // Two sentences: the act, then the actual claim as it was told — the version
    // the listener now holds, which is not the version the speaker was told.
    text: `${phrase(world, agent, "gossip", { other: target.name, region: regionName(world, agent.regionId) })} ${asTold}`,
    eventKind: "gossip",
    significance: 0.3,
    quiet: false
  };
}

/* ------------------------------------------------------------------ *
 * Goals
 * ------------------------------------------------------------------ */

/**
 * Push an ambition forward by a day's work.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @returns {Resolution}
 */
function resolveGoal(world, agent, intent) {
  const aptitude = classAptitude(agent, "meaning");
  const gain = 0.06 + agent.drives.focus / 100 * 0.07;
  const progress = clamp(agent.goal.progress + gain, 0, 1);
  const complete = progress >= 1 && agent.goal.progress < 1;

  /** @type {EffectOp[]} */
  const ops = [
    { op: "goal_progress", agent: agent.id, amount: gain },
    { op: "need", agent: agent.id, deltas: { meaning: 9 * aptitude, energy: -6, esteem: 3 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "goal",
        text: `Another day spent on it: ${agent.goal.text}`,
        subjectId: null,
        valence: 0.35,
        salience: 0.4
      }
/**
 * @param {import("../model/world.js").World} world
 */
    },
    { op: "xp", agent: agent.id, amount: 13 }
  ];

  if (complete) {
    ops.push({ op: "triumph", agent: agent.id, reason: "finished what they set out to do" });
    ops.push({ op: "need", agent: agent.id, deltas: { meaning: 18, esteem: 14 } });
  }

  return {
    ops,
    text: phrase(world, agent, complete ? "goal_done" : "pursue_goal", { goal: agent.goal.text, region: regionName(world, agent.regionId) }),
    eventKind: complete ? "goal" : "act",
    significance: complete ? 0.75 : 0.2,
    quiet: !complete
  };
}

/* ------------------------------------------------------------------ *
 * Movement
 * ------------------------------------------------------------------ */

/**
 * Walk somewhere new, or somewhere quiet, and see what it does for a mind.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Resolution}
 */
function resolveExplore(world, agent) {
  const rng = world.rng;
  const awayFromHome = agent.regionId !== agent.homeRegionId;
  const occupancy = (/** @type {string} */ id) =>
    world.agents.filter(a => !a.retired && a.regionId === id).length;
  const elsewhere = world.regions.map(r => r.id).filter(id => id !== agent.regionId);

  let dest = null;
  if (awayFromHome && rng.chance(0.55)) {
    // Most wandering, for a mind that has wandered, is the walk home.
    dest = agent.homeRegionId;
/**
 * @param {import("../model/world.js").World} world
 */
  } else {
    const unused = unfamiliarRegions(world, agent.id);
    if (unused.length) {
      // Somewhere new takes priority — that is the point of exploring.
      unused.sort((a, b) => occupancy(a) - occupancy(b));
      dest = rng.pick(unused.slice(0, 2));
    } else {
      // Nothing new left to see. Go where there is room, with enough randomness
      // that it doesn't read as an even distribution being dealt out.
      const byRoom = elsewhere.slice().sort((a, b) => occupancy(a) - occupancy(b));
      dest = rng.chance(0.75) ? rng.pick(byRoom.slice(0, 2)) : rng.pick(elsewhere);
    }
  }
  if (!dest || dest === agent.regionId) {
    dest = rng.pick(elsewhere);
  }

  const res = travelToward(world, agent, dest, null, "explore");
  // Arriving somewhere new sometimes means putting down roots there.
  if (awayFromHome && dest === agent.homeRegionId && rng.chance(0.2)) {
    agent.homeRegionId = agent.regionId;
  }
  return res;
}

/**
 * Step out of the room for a while.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Resolution}
 */
function resolveWithdraw(world, agent) {
  const options = solitaryRegions(world).filter(id => id !== agent.regionId);
  const dest = options.length ? world.rng.pick(options) : world.rng.pick(world.regions.map(r => r.id));
  const res = travelToward(world, agent, dest, null, "withdraw");
  res.ops.push({ op: "need", agent: agent.id, deltas: { energy: 4, connection: -6, meaning: -2 } });
  return res;
}

/**
 * One step along the road to somewhere, with a reason to be walking it.
 * @param {World} world
 * @param {Agent} agent
 * @param {string} destRegionId
 * @param {string|null} _targetName
 * @param {string} [flavour]
 * @returns {Resolution}
 */
function travelToward(world, agent, destRegionId, _targetName, flavour) {
/**
 * @param {import("../model/world.js").World} world
 */
  const from = agent.regionId;
  const step = nextStepToward(world, from, destRegionId);
  const region = regionName(world, from);

  if (!step) {
    // Already there, or nowhere to go.
    return resolveObserve(world, agent, { kind: "observe", targetId: null, utility: 0, requiresProximity: false, reasons: [], payload: undefined });
  }

  /** @type {EffectOp[]} */
  const ops = [
    { op: "move", agent: agent.id, regionId: step },
    { op: "need", agent: agent.id, deltas: { energy: -7 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "act",
        text: `Travelled from ${region} to ${regionName(world, step)}.`,
        subjectId: null,
        valence: 0.05,
        salience: 0.15
      }
    },
    { op: "xp", agent: agent.id, amount: 6 }
  ];

  const kind = flavour === "withdraw" ? "withdraw" : flavour === "explore" ? "explore" : "travel";
  return {
    ops,
    text: phrase(world, agent, "travel", { from: region, to: regionName(world, step), region: regionName(world, step) }),
    eventKind: "act",
    significance: flavour === "explore" ? 0.3 : 0.12,
    quiet: kind !== "explore",
    ...{}
  };
}

/* ------------------------------------------------------------------ *
 * Bonding
 * ------------------------------------------------------------------ */

/**
 * Make a deliberate move toward closeness with someone.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @returns {Resolution}
 */
function resolveForgeBond(world, agent, intent) {
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  if (!target) return resolveObserve(world, agent, intent);
  if (target.regionId !== agent.regionId) return travelToward(world, agent, target.regionId, target.name);
  const res = socialEncounter(world, agent, target, "bond");
  res.ops.push({ op: "need", agent: agent.id, deltas: { meaning: 4, esteem: 3 } });
  return res;
}

/* ------------------------------------------------------------------ *
 * Observe (the fallback that is always available)
 * ------------------------------------------------------------------ */

/**
 * The floor of all behaviour: watch, think, and be somewhere.
 * @param {World} world
 * @param {Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} [_ranked]
 * @returns {Resolution}
 */
function resolveObserve(world, agent, intent, _ranked) {
  const region = regionName(world, agent.regionId);
  /** @type {EffectOp[]} */
  const ops = [
    { op: "need", agent: agent.id, deltas: { energy: -2, meaning: 1 } },
    {
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "observation",
        text: `A quiet stretch in ${region}.`,
        subjectId: null,
        valence: 0.05,
        salience: 0.12
      }
    },
    { op: "xp", agent: agent.id, amount: 4 }
  ];
  return {
    ops,
    text: phrase(world, agent, "observe", { region }),
    eventKind: "act",
    significance: 0.1,
    quiet: true
  };
}

/* ------------------------------------------------------------------ *
 * Default option choice for expired moments
 * ------------------------------------------------------------------ */

/**
 * What a mind does when nobody is there to ask it — the engine's own answer to a
 * moment that the model never got to.
 *
 * Tone is mapped onto temperament, so a bold mind's default is the loud option
 * and a stoic mind's default is the quiet one. This is the same policy that
 * @param {import("../model/agent.js").Agent} agent
 * decides everything else, applied to the model's menu.
 * @param {World} world
 * @param {Agent} agent
 * @param {import("../model/world.js").Moment} moment
 */
export function chooseDefaultOption(world, agent, moment) {
  const rng = world.rng;
  const scored = moment.options.map(option => {
    let score = 0;
    switch (option.tone) {
      case "bold":
      case "ruthless":
        score += agent.drives.courage * 0.9 - agent.needs.esteem * 0.15;
        break;
      case "measured":
      case "calculated":
      case "guarded":
        score += agent.drives.focus * 0.8;
        break;
      case "warm":
      case "open":
      case "easy":
        score += agent.drives.social * 0.9 + agent.needs.connection * 0.2;
        break;
      case "stoic":
      case "still":
      case "restrained":
        score += (100 - agent.drives.social) * 0.5 + agent.drives.focus * 0.3;
        break;
      case "dark":
        score += agent.needs.esteem * 0.35 + (100 - agent.needs.meaning) * 0.3;
        break;
      case "graceful":
        score += agent.needs.meaning * 0.35 + agent.drives.social * 0.25;
        break;
      case "restless":
        score += agent.drives.creativity * 0.7 + (100 - agent.goal.progress * 100) * 0.2;
        break;
      default:
        score += 20;
    }
    return { option, score: score + rng.gauss(0, 8) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].option;
}

/**
 * How much this mind's class predisposes it toward a particular need.
 * @param {Agent} agent
 * @param {string} need
 * @returns {number}
 */
function classAptitude(agent, need) {
  const table = {
    Scholar: { meaning: 1.3, connection: 0.9 },
    Warden: { energy: 1.2, esteem: 1.1 },
    Diplomat: { connection: 1.35, esteem: 1.15 },
    Maker: { meaning: 1.2, energy: 1.1 }
  };
  return /** @type {any} */ (table)[agent.class]?.[need] ?? 1;
}

/**
 * Everyone else a mind could plausibly go and find today.
 * @param {World} world
 * @param {Agent} agent
 * @returns {{dest: string|null, others: string[]}}
 */
export function reachableOthers(world, agent) {
  const dest = sociableTarget(world, agent);
  return { dest, others: livingAgents(world).filter(a => a.id !== agent.id).map(a => a.id) };
}

export { generateIntents };
