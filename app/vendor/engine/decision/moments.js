/**
 * Moments: the beats that are worth spending a language model on.
 *
 * The engine can resolve most of a mind's day by itself — resting, walking,
 * small talk, grinding at a goal. But some beats genuinely need a mind to
 * *choose*, and those are the ones that make the world feel inhabited.
 *
 * A moment is built as a question plus a small set of pre-computed options.
 * Every option carries its own mechanical consequences, written here in code.
 * The model picks an option and writes the prose. That arrangement gives the
 * model real agency over the story without ever giving it the ability to corrupt
 * the simulation — it is choosing between roads the engine already paved.
 */

import { clamp } from "../config.js";
import { recall } from "../model/memory.js";
import { edgeToward, relationPhrase, describeRelation, feudStage } from "../model/relationships.js";
import { regionById, regionName, agentById } from "../model/world.js";
import { GOAL_IDEAS } from "../content.js";
import { stateLine, moodWord, standingWord } from "../model/agent.js";
import { isNight } from "../clock.js";

/**
 * @typedef {import("../model/world.js").Moment} Moment
 * @typedef {import("./intents.js").Intent} Intent
 */

/**
 * Decide whether this intent deserves the model's attention.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} ranked
 * @returns {boolean}
 */
export function isMomentWorthy(world, agent, intent, ranked) {
  const cfg = world.config.moments;
  if (!intent) return false;
  if (cfg.alwaysMomentKinds.includes(intent.kind)) return true;
  if (intent.utility >= cfg.significanceFloor) return true;

  // A mind that has gone a long time without being asked what it thinks will
  // eventually get asked, even if nothing dramatic is happening. This is what
  // keeps quiet minds from becoming invisible.
  if (world.clock.tick - agent.lastReflectionTick >= cfg.reflectionIntervalTicks) return true;

  // A near-tie between two very different impulses is itself interesting: the
  // mind is genuinely torn, and that is worth a model's judgement.
  const second = ranked[1];
  if (second && intent.utility - second.utility < 4 && intent.utility > 40 && intent.kind !== second.kind) {
    return true;
  }
  return false;
}

/**
 * Build the moment for a chosen intent.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {Intent[]} ranked
 * @returns {Moment|null}
 */
export function buildMoment(world, agent, intent, ranked) {
  if (!isMomentWorthy(world, agent, intent, ranked)) return null;
  const tick = world.clock.tick;

  switch (intent.kind) {
    case "confront":
      return confrontMoment(world, agent, intent, tick);
    case "confide":
      return confideMoment(world, agent, intent, tick);
    case "betray":
      return betrayMoment(world, agent, intent, tick);
    case "seek_company":
      return dialogueMoment(world, agent, intent, tick);
    case "forge_bond":
      return dialogueMoment(world, agent, intent, tick);
    case "conflict":
      return confrontMoment(world, agent, intent, tick);
    case "call_in":
      return callInMoment(world, agent, intent, tick);
    default:
      return reflectionMoment(world, agent, intent, tick, ranked);
  }
}

/* ------------------------------------------------------------------ *
 * Shared context assembly
 * ------------------------------------------------------------------ */

/**
 * The private context a mind brings to a moment. This is deliberately limited to
 * what *this* mind knows — the engine resolves the other party's side
 * separately, so one agent's prompt can never leak another's secrets.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {string|null} targetId
 */
function contextFor(world, agent, targetId) {
  const target = targetId ? agentById(world, targetId) : null;
  const region = regionById(world, agent.regionId);
  const memories = recall(agent.memory, {
    tick: world.clock.tick,
    aboutId: targetId,
    limit: 5,
    config: world.config,
    rng: world.rng
  });

  /** @type {any} */
  const ctx = {
    agentName: agent.name + (agent.epithet ? " " + agent.epithet : ""),
    stateLine: stateLine(agent, world.clock.tick),
    mood: moodWord(agent, world.clock.tick),
    region: region.name,
    regionBlurb: region.blurb,
    phase: world.clock.phase,
    night: isNight(world.clock),
    goal: agent.goal.text,
    goalProgress: agent.goal.progress,
    standingWord: standingWord(agent.standing ?? 0),
    memories: memories.map(m => m.text)
  };

  if (target) {
    ctx.targetId = target.id;
    ctx.targetName = target.name;
    ctx.targetPersonality = target.personality;
    ctx.targetRegion = regionName(world, target.regionId);
    ctx.together = target.regionId === agent.regionId;
    ctx.relationWord = describeRelation(edgeToward(agent, target.id));
    ctx.relationPhrase = relationPhrase(edgeToward(agent, target.id));
    ctx.targetMood = moodWord(target, world.clock.tick);
    ctx.targetStandingWord = standingWord(target.standing ?? 0);
  }
  return ctx;
}

/**
 * Assemble the moment object itself.
 * @param {import("../model/world.js").World} world
 * @param {string} kind
 * @param {import("../model/agent.js").Agent} agent
 * @param {any} context
 * @param {any} question
 * @param {any[]} options
 * @param {number} significance
 * @param {any} source
 */
function makeMoment(world, kind, agent, context, question, options, significance, source) {
  const tick = world.clock.tick;

  // Whatever a mind decides in a confrontation or a betrayal, the pair has now
  // had it out — they don't get to run the same scene again next tick. Injecting
  // this here rather than into each option means no future option can forget it.
  const targetId = context.targetId;
  if (targetId && (kind === "confrontation" || kind === "betrayal")) {
    options = options.map(o => ({
      ...o,
      ops: [{ op: "conflict", from: agent.id, to: targetId }, ...o.ops]
    }));
  }

  return {
    id: world.nextId("mo"),
    tick,
    kind,
    agentId: agent.id,
    participants: [agent.id].concat(context.targetId ? [context.targetId] : []),
    significance: clamp(significance, 0, 1),
    question,
    context,
    options,
    resolved: false,
    source
  };
/**
 * @param {import("../model/world.js").World} world
 */
}

/* ------------------------------------------------------------------ *
 * Moment builders
 * ------------------------------------------------------------------ */

/**
 * Build the moment where something has to be said out loud.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @returns {Moment|null}
 */
function confrontMoment(world, agent, intent, tick) {
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  if (!target) return null;
  const edge = edgeToward(agent, target.id);
  const ctx = contextFor(world, agent, target.id);
  ctx.grievance = grievanceOf(agent, target, world);

  const escalate = edge.resentment >= 55 && agent.drives.courage >= 55;
  const stage = feudStage(edge, edgeToward(target, agent.id), world.config);

  const options = [
    {
      id: "say_it_publicly",
      label: `Say it in front of everyone`,
      tone: "bold",
      ops: [
        { op: "edge", from: target.id, to: agent.id, deltas: { trust: -18, affinity: -12, resentment: 14 }, reason: "being confronted in public" },
        { op: "standing", agent: agent.id, delta: world.config.standing.deedConfrontPublic },
        { op: "edge", from: agent.id, to: target.id, deltas: { resentment: -30, familiarity: 4 }, reason: "saying the grievance aloud" },
        { op: "need", agent: agent.id, deltas: { esteem: 12, connection: 6, energy: -6 } },
        { op: "need", agent: target.id, deltas: { esteem: -12 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "conflict",
            text: `I said it out loud, in front of everyone. ${target.name} will not forget it.`,
            subjectId: target.id,
            valence: -0.35,
            salience: 0.75
          }
        },
        {
          op: "memory",
          agent: target.id,
          trace: {
            kind: "conflict",
            text: `${agent.name} shamed me in front of the others.`,
            subjectId: agent.id,
            valence: -0.7,
            salience: 0.8
          }
        },
        { op: "xp", agent: agent.id, amount: 22 }
      ],
      escalates: escalate
    },
    {
      id: "take_them_aside",
      label: "Take them aside and say it quietly",
      tone: "measured",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { resentment: -22, trust: 6, familiarity: 6 }, reason: "a quiet confrontation" },
        { op: "edge", from: target.id, to: agent.id, deltas: { trust: 4, affinity: 2 }, reason: "a quiet confrontation" },
        { op: "need", agent: agent.id, deltas: { esteem: 5, connection: 10, energy: -4 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "conflict",
            text: `I finally told ${target.name} what I've been holding against them. It was quiet, and it was enough.`,
            subjectId: target.id,
            valence: 0.25,
            salience: 0.7
          }
        },
        {
          op: "memory",
          agent: target.id,
          trace: {
            kind: "contact",
            text: `${agent.name} pulled me aside about something I'd done. They were fairer about it than I expected.`,
            subjectId: agent.id,
            valence: -0.1,
            salience: 0.55
          }
        },
        { op: "xp", agent: agent.id, amount: 16 }
      ]
    },
    {
      id: "let_it_go",
      label: "Decide it isn't worth carrying",
      tone: "graceful",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { resentment: -34, fear: -6 }, reason: "letting the grievance go" },
        { op: "need", agent: agent.id, deltas: { meaning: 8, esteem: 6, energy: 4 } },
        { op: "mood", agent: agent.id, value: "steady", durationTicks: 20, reason: "let something go" },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "observation",
            text: `I let it go. What ${target.name} did still happened, but I'm not carrying it anymore.`,
            subjectId: target.id,
            valence: 0.5,
            salience: 0.65
          }
        },
        { op: "xp", agent: agent.id, amount: 20 }
      ]
    },
    {
      id: "walk_away_seething",
      label: "Say nothing, and let it fester",
      tone: "dark",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { resentment: 16, trust: -10 }, reason: "letting the grievance fester" },
        { op: "need", agent: agent.id, deltas: { esteem: -8, meaning: -6, connection: -5 } },
        { op: "mood", agent: agent.id, value: "bitter", durationTicks: 30, reason: "swallowed it again" },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "conflict",
            text: `I said nothing to ${target.name}. Again. I will not forget this one.`,
            subjectId: target.id,
            valence: -0.6,
            salience: 0.85
          }
        },
        { op: "xp", agent: agent.id, amount: 8 }
      ]
    },
    // Only a vendetta earns this option: ending it, whatever it costs. It
    // settles the ledger of hurt in one direction or the other, and the room
    // will remember that it happened.
    ...(stage === "vendetta"
      ? [
          {
            id: "end_it",
            label: `End it with ${target.name}, whatever it costs`,
            tone: "dark",
            ops: [
              { op: "edge", from: agent.id, to: target.id, deltas: { resentment: -70, affinity: -15, fear: -10 } },
              { op: "edge", from: target.id, to: agent.id, deltas: { resentment: -40, trust: -15, fear: 15 } },
              { op: "standing", agent: agent.id, delta: world.config.standing.deedConfrontPublic },
              { op: "need", agent: agent.id, deltas: { esteem: 14, meaning: -8, energy: -10 } },
              { op: "need", agent: target.id, deltas: { esteem: -16, connection: -8 } },
              {
                op: "memory",
                agent: agent.id,
                trace: {
                  kind: "conflict",
                  text: `It is finished between me and ${target.name}. Whatever it cost, it is paid.`,
                  subjectId: target.id,
                  valence: -0.2,
                  salience: 0.95
                }
              },
              {
                op: "memory",
                agent: target.id,
                trace: {
                  kind: "conflict",
                  text: `${agent.name} ended it. I will be feeling that for a long time.`,
                  subjectId: agent.id,
                  valence: -0.7,
                  salience: 0.9
                }
              },
              { op: "xp", agent: agent.id, amount: 30 }
            ],
            escalates: true
          }
        ]
      : [])
/**
 * @param {import("../model/world.js").World} world
 */
  ];

  const question =
    `${agent.name} has been carrying something about ${target.name}. ` +
    `What does ${agent.name} do about it?`;

  return makeMoment(world, "confrontation", agent, ctx, question, options, 0.7, "confront");
}

/**
 * Build the moment where a held secret could be handed to someone.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @returns {Moment|null}
 */
function confideMoment(world, agent, intent, tick) {
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  const secretId = intent.payload && intent.payload.secretId;
  const secret = secretId ? world.secrets.find(s => s.id === secretId) : null;
  if (!target || !secret) return null;

  const ctx = contextFor(world, agent, target.id);
  ctx.secretText = secret.text;
  ctx.secretKind = secret.kind;
  ctx.secretId = secret.id;

  const options = [
    {
      id: "tell_them_everything",
      label: "Tell them all of it",
      tone: "open",
      ops: [
        { op: "secret_share", secretId: secret.id, from: agent.id, to: target.id, fidelity: 1,
          memoryText: `${agent.name} told me something and asked me to hold it.`, memoryValence: -0.1, memorySalience: 0.75 },
        { op: "edge", from: agent.id, to: target.id, deltas: { trust: 14, affinity: 8, familiarity: 8, secretsShared: 1 } },
        { op: "need", agent: agent.id, deltas: { connection: 26, meaning: 8, esteem: 4, energy: -3 } },
        { op: "need", agent: target.id, deltas: { esteem: 5, connection: 8 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "confide",
            text: `I told ${target.name} the whole thing. It is theirs now too.`,
            subjectId: target.id,
            valence: 0.7,
            salience: 0.9
          }
        },
        { op: "xp", agent: agent.id, amount: 24 }
      ]
    },
    {
      id: "tell_them_part",
      label: "Tell them a version of it",
      tone: "guarded",
      ops: [
        { op: "secret_share", secretId: secret.id, from: agent.id, to: target.id, fidelity: 0.5,
          memoryText: `${agent.name} told me something, though it felt like there was more to it.`, memoryValence: 0, memorySalience: 0.55 },
        { op: "edge", from: agent.id, to: target.id, deltas: { trust: 6, familiarity: 6, secretsShared: 1 } },
        { op: "need", agent: agent.id, deltas: { connection: 12, energy: -2 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "confide",
            text: `I gave ${target.name} the shape of it but not the whole. Safer that way.`,
            subjectId: target.id,
            valence: 0.3,
            salience: 0.6
          }
        },
        { op: "xp", agent: agent.id, amount: 14 }
      ]
    },
    {
      id: "keep_it",
      label: "Decide to keep carrying it",
      tone: "stoic",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { trust: 3 } },
        { op: "need", agent: agent.id, deltas: { connection: -8, meaning: 4, esteem: 2 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "secret",
            text: `I nearly told ${target.name} and didn't. Some things are mine to carry.`,
            subjectId: target.id,
            valence: 0.2,
            salience: 0.7
          }
        },
        { op: "xp", agent: agent.id, amount: 12 }
      ]
    }
  ];

  const question =
    `${agent.name} has been holding something. ${target.name} is someone they trust. ` +
    `Does ${agent.name} tell them?`;
/**
 * @param {number} a
 */

  return makeMoment(world, "confession", agent, ctx, question, options, 0.75, "confide");
}

/**
 * Build the moment where a trust could be sold for something.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @returns {Moment|null}
 */
function betrayMoment(world, agent, intent, tick) {
  const subject = intent.targetId ? agentById(world, intent.targetId) : null;
  const secretId = intent.payload && intent.payload.secretId;
  const secret = secretId ? world.secrets.find(s => s.id === secretId) : null;
  if (!subject || !secret) return null;

  const ctx = contextFor(world, agent, subject.id);
  ctx.secretText = secret.text;
  ctx.secretKind = secret.kind;
  ctx.secretId = secret.id;
  ctx.fidelity = secret.holders[agent.id] ?? 1;

  const witnesses = world.agents.filter(a => a.id !== agent.id && a.id !== subject.id && !a.retired);

  const options = [
    {
      id: "say_it_out_loud",
      label: "Say it out loud, where everyone can hear",
      tone: "ruthless",
      ops: [
        { op: "secret_publish", secretId: secret.id, by: agent.id },
        { op: "standing", agent: agent.id, delta: world.config.standing.deedBetray },
        { op: "edge", from: subject.id, to: agent.id, deltas: { trust: -60, affinity: -45, resentment: 65, fear: 10 } },
        { op: "need", agent: subject.id, deltas: { esteem: -26, connection: -14, meaning: -10 } },
        { op: "need", agent: agent.id, deltas: { esteem: 10, meaning: 12, connection: -8 } },
        { op: "mood", agent: subject.id, value: "bitter", durationTicks: 60, reason: "exposed" },
        { op: "mood", agent: agent.id, value: "triumphant", durationTicks: 20, reason: "settled a score" },
        // Everyone watching learns what kind of person the betrayer is.
        ...witnesses.map(w => ({
          op: "edge",
          from: w.id,
          to: agent.id,
          deltas: { trust: -16, fear: 8 }
        })),
        ...witnesses.map(w => ({
          op: "memory",
          agent: w.id,
          trace: {
            kind: "betrayal",
            text: `${agent.name} said it in front of everyone. Nobody will trust them the same way again.`,
            subjectId: agent.id,
            valence: -0.6,
            salience: 0.85
          }
        })),
        // What everybody just watched becomes a piece of information worth
        // holding. The betrayer is now the subject of a secret, which is a
        // fitting thing to happen to someone who just did that.
        {
          op: "secret_new",
          holders: witnesses.map(w => w.id),
          about: agent.id,
          kind: "crime",
          text: `${agent.name} sold out ${subject.name} in front of the whole room, and did not look sorry about it`
        },
        { op: "edge", from: agent.id, to: subject.id, deltas: { resentment: -20, trust: -20 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "betrayal",
            text: `I told them what ${subject.name} did. I will not pretend I feel bad about it.`,
            subjectId: subject.id,
            valence: 0.1,
            salience: 0.95
          }
        },
        { op: "xp", agent: agent.id, amount: 28 }
      ]
    },
    {
      id: "let_it_slip",
      label: "Let it slip to one person who will spread it",
      tone: "calculated",
      ops: [
        (() => {
          const vessel = pickVessel(world, agent, subject.id);
          return vessel
            ? { op: "secret_share", secretId: secret.id, from: agent.id, to: vessel.id, fidelity: 0.45,
                memoryText: `${agent.name} let something slip about ${subject.name}, and it did not sound like an accident.`, memoryValence: -0.3, memorySalience: 0.7 }
            : { op: "need", agent: agent.id, deltas: { meaning: -6 } };
        })(),
        { op: "edge", from: agent.id, to: subject.id, deltas: { resentment: -12, trust: -8 } },
        { op: "need", agent: agent.id, deltas: { esteem: 5, meaning: 6, connection: -2 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "betrayal",
            text: `I let it slip about ${subject.name}. If it comes back to me, I'll deny it.`,
            subjectId: subject.id,
            valence: -0.15,
            salience: 0.8
          }
        },
        { op: "xp", agent: agent.id, amount: 20 }
      ]
    },
    {
      id: "sit_on_it",
      label: "Sit on it — this time",
      tone: "restrained",
      ops: [
        { op: "edge", from: agent.id, to: subject.id, deltas: { resentment: 10 } },
        { op: "need", agent: agent.id, deltas: { meaning: -8, esteem: -4 } },
        { op: "mood", agent: agent.id, value: "bitter", durationTicks: 25, reason: "held it in" },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "secret",
            text: `I could have ruined ${subject.name} today and I didn't. I don't know if that makes me better or weaker.`,
            subjectId: subject.id,
            valence: -0.3,
            salience: 0.85
          }
        },
        { op: "xp", agent: agent.id, amount: 12 }
      ]
    }
  ];

  const question =
    `${agent.name} knows something that could ruin ${subject.name}, and has every reason to use it. ` +
    `What does ${agent.name} do?`;

  return makeMoment(world, "betrayal", agent, ctx, question, options, 0.9, "betray");
}

/**
 * Who here could be trusted with something heavy.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {string|null} excludeId
 * @returns {import("../model/agent.js").Agent|null}
 */
function pickVessel(world, agent, excludeId) {
  const candidates = world.agents.filter(
    a => a.id !== agent.id && a.id !== excludeId && !a.retired && a.regionId === agent.regionId
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.drives.social - a.drives.social)[0];
}

/**
 * An ordinary conversation worth letting a model write.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @returns {Moment|null}
 */
function dialogueMoment(world, agent, intent, tick) {
  const target = intent.targetId ? agentById(world, intent.targetId) : null;
  const ctx = contextFor(world, agent, target ? target.id : null);
  if (!target) return reflectionMoment(world, agent, intent, tick, []);

  const edge = edgeToward(agent, target.id);
  const bonding = intent.kind === "forge_bond";

  const options = [
    {
      id: bonding ? "open_up" : "genuine_moment",
      label: bonding ? "Actually try to get closer" : "Let the conversation go somewhere real",
      tone: "warm",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { affinity: 9, trust: 7, familiarity: 7 } },
        { op: "edge", from: target.id, to: agent.id, deltas: { affinity: 6, trust: 4, familiarity: 7 } },
        { op: "need", agent: agent.id, deltas: { connection: 20, meaning: 5 } },
        { op: "need", agent: target.id, deltas: { connection: 14 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "contact",
            text: `A real conversation with ${target.name}, the kind that changes the shape of things.`,
            subjectId: target.id,
            valence: 0.7,
            salience: 0.6
          }
        },
        {
          op: "memory",
          agent: target.id,
          trace: {
            kind: "contact",
            text: `${agent.name} was honest with me today. I did not expect that.`,
            subjectId: agent.id,
            valence: 0.6,
            salience: 0.55
          }
        },
        { op: "xp", agent: agent.id, amount: 16 }
      ]
    },
    {
      id: "keep_it_light",
      label: "Keep it light and easy",
      tone: "easy",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { affinity: 4, familiarity: 8 } },
        { op: "edge", from: target.id, to: agent.id, deltas: { affinity: 3, familiarity: 8 } },
        { op: "need", agent: agent.id, deltas: { connection: 12 } },
        { op: "need", agent: target.id, deltas: { connection: 9 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "contact",
            text: `An easy hour with ${target.name}. Nothing happened, which was the point.`,
            subjectId: target.id,
            valence: 0.4,
            salience: 0.35
          }
        },
        { op: "xp", agent: agent.id, amount: 8 }
      ]
    },
    {
      id: "test_the_water",
      label: "Steer it toward something they might be hiding",
      tone: "probing",
      ops: [
        { op: "edge", from: agent.id, to: target.id, deltas: { familiarity: 6, trust: -1 } },
        { op: "edge", from: target.id, to: agent.id, deltas: { trust: -3, affinity: -1 } },
        { op: "need", agent: agent.id, deltas: { connection: 8, meaning: 6, esteem: 4 } },
        // Occasionally it works and the model gets hold of something.
        ...(edge.trust >= 50 && world.rng.chance(0.35)
          ? [leakAnOption(world, agent, target)].filter(Boolean)
          : []),
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "contact",
            text: `I asked ${target.name} a few careful questions. I learned something about how they think.`,
            subjectId: target.id,
            valence: 0.1,
            salience: 0.5
          }
        },
        { op: "xp", agent: agent.id, amount: 14 }
      ]
    }
  ];

  const question =
    `${agent.name} and ${target.name} are together at ${ctx.region}. ` +
    `They are ${ctx.relationWord} to each other. What passes between them?`;

  return makeMoment(world, "dialogue", agent, ctx, question, options, 0.38, intent.kind);
}

/**
 * An extra op for the moment a secret slips out of someone by accident.
 * Returns null when there is nothing in this mind's keeping to let slip.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../model/agent.js").Agent} target
 * @returns {import("../systems/effects.js").EffectOp|null}
 */
function leakAnOption(world, agent, target) {
  const candidates = world.secrets.filter(
    s => s.holders[target.id] !== undefined && s.holders[agent.id] === undefined && !s.isPublic
  );
  if (!candidates.length) return null;
  const secret = candidates[0];
  return {
    op: "secret_share",
    secretId: secret.id,
    from: target.id,
    to: agent.id,
    fidelity: 0.6,
    memoryText: `${target.name} let something slip without meaning to.`,
    memoryValence: -0.05,
    memorySalience: 0.6
  };
}

/**
 * A quiet beat where a mind takes stock of what it has become.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @param {Intent[]} [ranked]
 * @returns {Moment|null}
 */
function reflectionMoment(world, agent, intent, tick, ranked) {
  const ctx = contextFor(world, agent, intent.targetId || null);

  // A mind only reaches for a new ambition when the current one has stopped
  // giving it anything: either it is nearly finished, or it has stopped
  // meaning much. Offering fresh goals every quiet moment makes the whole cast
  // churn through purposes they never pursue.
  const stalled = agent.needs.meaning < 52 || agent.goal.progress > 0.6;
  const ideas = GOAL_IDEAS[/** @type {keyof typeof GOAL_IDEAS} */ (agent.class)] || GOAL_IDEAS.Scholar;
  const fresh = stalled ? ideas.filter(g => g !== agent.goal.text).slice(0, 3) : [];

  const options = [
    {
      id: "stay_the_course",
      label: `Keep at it: ${agent.goal.text}`,
      tone: "steady",
      ops: [
        { op: "goal_progress", agent: agent.id, amount: 0.14 },
        { op: "need", agent: agent.id, deltas: { meaning: 11, esteem: 4 } },
        { op: "xp", agent: agent.id, amount: 12 }
      ]
    },
    ...fresh.map((text, index) => ({
      id: `new_goal_${index}`,
      label: `Take up something new: ${text}`,
      tone: "restless",
      prose: `{name} set down {oldgoal} and took up something else instead: {newgoal}.`,
      data: { newGoal: text },
      ops: [
        { op: "goal", agent: agent.id, text, kind: "uncover" },
        { op: "need", agent: agent.id, deltas: { meaning: 14, energy: -3 } },
        { op: "xp", agent: agent.id, amount: 14 }
      ]
    })),
    {
      id: "just_watch",
      label: "Let the moment pass and just watch",
      tone: "still",
      ops: [
        { op: "need", agent: agent.id, deltas: { energy: 6, connection: -3 } },
        { op: "xp", agent: agent.id, amount: 4 }
      ]
    }
  ];

  const question = `What is ${agent.name} thinking about, and what do they decide to do with the day?`;
  return makeMoment(world, "reflection", agent, ctx, question, options, 0.35, "reflection");
}

/**
 * Build the moment where an owed favour comes due.
 *
 * The creditor (agent) is owed by the debtor (target). Three ways to play it:
 * ask plainly and settle it, hold it over them as leverage, or tear the debt
 * up as an act of grace. The payoffs deliberately avoid minting instant
 * friendship — trust and relief move, not affection at alliance scale.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Intent} intent
 * @param {number} tick
 * @returns {Moment|null}
 */
function callInMoment(world, agent, intent, tick) {
  const debtor = intent.targetId ? agentById(world, intent.targetId) : null;
  if (!debtor) return null;
  const edge = edgeToward(agent, debtor.id);
  if (edge.debts <= 0) return null;

  const ctx = contextFor(world, agent, debtor.id);
  ctx.debt = Math.round(edge.debts);

  const options = [
    {
      id: "ask_plainly",
      label: `Ask ${debtor.name} to repay the favour, plainly`,
      tone: "measured",
      ops: [
        { op: "call_in", from: agent.id, to: debtor.id },
        { op: "edge", from: agent.id, to: debtor.id, deltas: { trust: 6, familiarity: 4 } },
        { op: "edge", from: debtor.id, to: agent.id, deltas: { trust: 6, familiarity: 4, resentment: -6 } },
        { op: "need", agent: agent.id, deltas: { esteem: 5, connection: 6 } },
        { op: "need", agent: debtor.id, deltas: { connection: 6, esteem: 3 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "act",
            text: `I asked ${debtor.name} to repay what they owed me, and they did. Clean.`,
            subjectId: debtor.id,
            valence: 0.4,
            salience: 0.6
          }
        },
        {
          op: "memory",
          agent: debtor.id,
          trace: {
            kind: "act",
            text: `${agent.name} called in the favour I owed them. It is settled now, and I feel lighter for it.`,
            subjectId: agent.id,
            valence: 0.3,
            salience: 0.6
          }
        },
        { op: "xp", agent: agent.id, amount: 16 }
      ]
    },
    {
      id: "hold_it_over",
      label: "Hold it over them instead of collecting",
      tone: "calculated",
      ops: [
        // Deliberately no call_in op: the debt stays on the books. Leverage,
        // not settlement — and it costs trust rather than building it.
        { op: "standing", agent: agent.id, delta: world.config.standing.deedHoldOver },
        { op: "edge", from: agent.id, to: debtor.id, deltas: { trust: -6, familiarity: 3 } },
        { op: "edge", from: debtor.id, to: agent.id, deltas: { trust: -4, fear: 10, resentment: 8 } },
        { op: "need", agent: agent.id, deltas: { esteem: 6, meaning: -4 } },
        { op: "need", agent: debtor.id, deltas: { esteem: -6, connection: -4 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "act",
            text: `I reminded ${debtor.name} what they owe me, without asking for it back. Let them sit with that.`,
            subjectId: debtor.id,
            valence: -0.1,
            salience: 0.65
          }
        },
        {
          op: "memory",
          agent: debtor.id,
          trace: {
            kind: "act",
            text: `${agent.name} made sure I remembered I owe them. It was not a request.`,
            subjectId: agent.id,
            valence: -0.5,
            salience: 0.7
          }
        },
        { op: "xp", agent: agent.id, amount: 14 }
      ]
    },
    {
      id: "tear_it_up",
      label: "Tear the debt up — call it even",
      tone: "graceful",
      ops: [
        { op: "call_in", from: agent.id, to: debtor.id },
        { op: "standing", agent: agent.id, delta: world.config.standing.deedForgive },
        // Grace pays off in trust and relief, not in instant alliance. The
        // affinity bumps stay well below the alliance threshold on their own.
        { op: "edge", from: agent.id, to: debtor.id, deltas: { affinity: 8, trust: 8, familiarity: 5 } },
        { op: "edge", from: debtor.id, to: agent.id, deltas: { affinity: 10, trust: 10, resentment: -12, fear: -8 } },
        { op: "need", agent: agent.id, deltas: { meaning: 8, esteem: 4, connection: 6 } },
        { op: "need", agent: debtor.id, deltas: { connection: 10, esteem: 6 } },
        { op: "mood", agent: agent.id, value: "steady", durationTicks: 24, reason: "forgave a debt" },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "act",
            text: `I told ${debtor.name} to forget what they owed me. Some debts are better torn up.`,
            subjectId: debtor.id,
            valence: 0.6,
            salience: 0.75
          }
        },
        {
          op: "memory",
          agent: debtor.id,
          trace: {
            kind: "act",
            text: `${agent.name} forgave what I owed them outright. I will not forget that.`,
            subjectId: agent.id,
            valence: 0.7,
            salience: 0.8
          }
        },
        { op: "xp", agent: agent.id, amount: 18 }
      ]
    }
  ];

  const question =
    `${debtor.name} owes ${agent.name} a favour, and the debt has been sitting there. ` +
    `What does ${agent.name} do about it?`;

  return makeMoment(world, "call_in", agent, ctx, question, options, 0.65, "call_in");
}

/* ------------------------------------------------------------------ *
 * Grievance assembly
 * ------------------------------------------------------------------ */

/**
 * The specific thing this mind is angry about, in their own words. Uses memory
 * rather than the relationship record, because a mind justifies its anger with
 * incidents, not with numbers.
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../model/agent.js").Agent} target
 * @param {import("../model/world.js").World} world
 */
function grievanceOf(agent, target, world) {
  const hurts = recall(agent.memory, {
    tick: world.clock.tick,
    aboutId: target.id,
    kinds: ["conflict", "betrayal", "gossip"],
    limit: 2,
    config: world.config
  });
  if (hurts.length) return hurts[0].text;
  const edge = edgeToward(agent, target.id);
  if (edge.resentment >= 50) return `Something ${target.name} did that was never properly answered for.`;
  return `A long accumulation of small things with ${target.name}.`;
}
