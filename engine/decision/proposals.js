/**
 * Proposal-based minds.
 *
 * Every mind in the world has a personal goal. Before this module, the engine
 * decided how that goal got worked on: a fixed progress bar, a fixed cost, one
 * sentence of narration. The goal was the mind's, but the *approach* was not.
 *
 * Here the arrangement is the same one the cognition pilot uses, generalised:
 *
 *   1. The model is asked how this mind intends to pursue its goal today, and
 *      it answers in its own words plus one verb from a small grammar.
 *   2. The engine validates that verb against the world as it actually is —
 *      is this possible here, is there anyone to do it with, can they afford it,
 *      do they have a real grievance for the ugly ones.
 *   3. Valid proposals resolve deterministically into real effects: the mind
 *      moves on the map, edges change, the North Wall gains or loses courses,
 *      standing moves. Invalid proposals fall back to the engine's own choice
 *      and the rejection is logged.
 *
 * The model never supplies a number, a delta, or a consequence. It supplies an
 * intention. Everything that follows is the engine's.
 */

import { clamp } from "../config.js";
import { regionById, regionName, agentById } from "../model/world.js";
import { classAptitude } from "../systems/act.js";
import { contextFor } from "./moments.js";
import { phrase } from "./prose.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../systems/effects.js").EffectOp} EffectOp
 */

/**
 * The approach grammar. Each entry is a *kind of effort*, not a script: the
 * engine decides what it costs and what it produces, from this mind's drives,
 * this place, and who is standing in it.
 *
 * `energy`   nominal energy cost before this mind's focus discounts it
 * `base`     multiplier on the ordinary progress a day's work would make
 * `needs`    need deltas the effort itself carries
 * `company`  whether the approach requires another living mind in this region
 * `site`     whether the approach requires standing on the project site
 * `travel`   whether the approach moves the mind somewhere else
 */
/**
 * @typedef {object} MethodSpec
 * @property {number} energy
 * @property {number} base
 * @property {Record<string, number>} needs
 * @property {boolean} [company]
 * @property {boolean} [site]
 * @property {boolean} [travel]
 * @property {string[]} [place]
 * @property {boolean} [grievance]
 */

/** @type {Record<string, MethodSpec>} */
const METHOD_SPECS = {
  focus:        { energy: 6,  base: 1.00, needs: { meaning: 9,  esteem: 3,  connection: -2 } },
  study:        { energy: 7,  base: 1.05, needs: { meaning: 13, esteem: 2,  connection: -2 }, place: ["settlement", "wild"] },
  practice:     { energy: 8,  base: 1.10, needs: { meaning: 8,  esteem: 8,  connection: 2 } },
  recruit:      { energy: 9,  base: 0.70, needs: { meaning: 7,  esteem: 4,  connection: 16 }, company: true },
  consult:      { energy: 5,  base: 0.85, needs: { meaning: 11, esteem: 5,  connection: 10 }, company: true },
  explore:      { energy: 11, base: 0.95, needs: { meaning: 12, esteem: 3,  connection: -1 }, travel: true },
  organise:     { energy: 12, base: 0.60, needs: { meaning: 10, esteem: 7,  connection: 8 }, site: true },
  push_through: { energy: 18, base: 1.70, needs: { meaning: 6,  esteem: 6,  connection: -4 } },
  undermine:    { energy: 10, base: 0.00, needs: { meaning: -4, esteem: -3, connection: -6 }, site: true, grievance: true }
};

/** The methods a model may propose, in the order they are offered to it. */
export const APPROACH_METHODS = Object.keys(METHOD_SPECS);

/**
 * The methods a proposal will actually be validated against in this situation.
 * The prompt shows only these, so a mind is never offered a road that does not
 * exist from where it is standing.
 * @param {World} world
 * @param {Agent} agent
 * @returns {string[]}
 */
export function availableMethods(world, agent) {
  const region = regionById(world, agent.regionId);
  const here = othersHere(world, agent);
  const project = world.project;
  const atSite = Boolean(project && project.status === "active" && project.regionId === agent.regionId);
  const elsewhere = world.regions.some(r => r.id !== agent.regionId);

  return APPROACH_METHODS.filter(method => {
    const spec = METHOD_SPECS[/** @type {keyof typeof METHOD_SPECS} */ (method)];
    if (spec.company && here.length === 0) return false;
    if (spec.site && !atSite) return false;
    if (spec.travel && !elsewhere) return false;
    if (spec.place && !(region && spec.place.includes(region.kind))) return false;
    if (spec.grievance && !sabotageTarget(world, agent)) return false;
    return true;
  });
}

/**
 * Everyone else alive and standing in this mind's region.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Agent[]}
 */
function othersHere(world, agent) {
  return world.agents.filter(a => a.id !== agent.id && !a.retired && a.awake && a.regionId === agent.regionId);
}

/**
 * Read an edge without creating one. Validators must not touch the world, so
 * `edgeToward` — which mints a neutral edge on a miss — is the wrong tool here.
 * @param {Agent} agent
 * @param {string} otherId
 * @param {keyof import("../model/relationships.js").RelationEdge} axis
 */
function edgeValue(agent, otherId, axis) {
  const edge = agent.relations[otherId];
  if (!edge) return axis === "trust" || axis === "familiarity" || axis === "affinity" || axis === "fear" ? 0 : 0;
  return /** @type {number} */ (edge[axis] ?? 0);
}

/**
 * The mind whose wall work this mind has a real grievance against, if any.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Agent|null}
 */
function sabotageTarget(world, agent) {
  const project = world.project;
  if (!project || project.status !== "active" || project.progress <= 0) return null;
  const floor = world.config.projects.interferenceResentmentFloor;
  /** @type {Agent[]} */
  const candidates = [];
  for (const [id, record] of Object.entries(project.contributors)) {
    if (id === agent.id) continue;
    if (!(record.work > 0 || record.help > 0)) continue;
    const other = agentById(world, id);
    if (!other || other.retired) continue;
    if (edgeValue(agent, other.id, "resentment") < floor) continue;
    candidates.push(other);
  }
  candidates.sort((a, b) => edgeValue(agent, b.id, "resentment") - edgeValue(agent, a.id, "resentment"));
  return candidates[0] ?? null;
}

/**
 * The company this mind would most plausibly turn to: the warmest face in the
 * region, falling back to the most familiar.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Agent|null}
 */
function chosenCompany(world, agent) {
  const here = othersHere(world, agent);
  if (!here.length) return null;
  /** @param {Agent} other */
  const score = (other) => edgeValue(agent, other.id, "affinity") + edgeValue(agent, other.id, "familiarity") * 0.5;
  return here.slice().sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * What this approach costs this particular mind, in energy.
 * @param {World} world
 * @param {Agent} agent
 * @param {keyof typeof METHOD_SPECS} method
 */
function energyCost(world, agent, method) {
  const spec = METHOD_SPECS[method];
  const discount = 1.15 - (agent.drives.focus / 100) * 0.3;
  return Math.max(3, Math.round(spec.energy * discount));
}

/** @typedef {{ ok: boolean, reason: string, method: string, targetId: string|null }} ProposalValidation */

/**
 * Validate a proposed approach against the world as it is. This function is
 * deliberately side-effect free: it reads, it judges, it reports.
 *
 * @param {World} world
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @returns {ProposalValidation}
 */
export function validateApproach(world, agent, answer) {
  const raw = String(answer?.method ?? answer?.action ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) {
    return { ok: false, reason: "No approach method was proposed.", method: "", targetId: null };
  }
  if (!(raw in METHOD_SPECS)) {
    return { ok: false, reason: `"${raw}" is not one of the approaches this world can resolve.`, method: raw, targetId: null };
  }
  const method = /** @type {keyof typeof METHOD_SPECS} */ (raw);
  const spec = METHOD_SPECS[method];

  if (!agent.awake || agent.retired) {
    return { ok: false, reason: "The mind is not in a state to carry this out.", method, targetId: null };
  }
  if (!availableMethods(world, agent).includes(method)) {
    return { ok: false, reason: describeUnavailability(world, agent, method), method, targetId: null };
  }

  const cost = energyCost(world, agent, method);
  if (agent.needs.energy < Math.max(world.config.proposals.minEnergy, cost)) {
    return {
      ok: false,
      reason: `That would take about ${cost} energy and ${agent.name} has ${Math.round(agent.needs.energy)}.`,
      method,
      targetId: null
    };
  }

  let targetId = null;
  if (method === "recruit" || method === "consult") {
    const partner = chosenCompany(world, agent);
    if (!partner) {
      return { ok: false, reason: "There is no one here to turn to.", method, targetId: null };
    }
    targetId = partner.id;
  }
  if (method === "undermine") {
    const target = sabotageTarget(world, agent);
    if (!target) {
      return { ok: false, reason: "The engine will not validate sabotage without a real grievance.", method, targetId: null };
    }
    targetId = target.id;
  }

  return { ok: true, reason: "The engine accepted the proposed approach.", method, targetId };
}

/**
 * Say, in the world's own terms, why an approach was not on offer.
 * @param {World} world
 * @param {Agent} agent
 * @param {keyof typeof METHOD_SPECS} method
 */
function describeUnavailability(world, agent, method) {
  const spec = METHOD_SPECS[method];
  const region = regionById(world, agent.regionId);
  if (spec.company) return "There is no one here for that.";
  if (spec.site) return "The North Wall work is not happening where they are standing.";
  if (spec.travel) return "There is nowhere else to go.";
  if (spec.place) return `${region ? region.name : "This place"} is no place for that.`;
  if (spec.grievance) return "There is no wall work here they hold a grudge against.";
  return "That approach is not possible from here.";
}

/**
 * @typedef {object} ApproachResolution
 * @property {EffectOp[]} ops
 * @property {string} text
 * @property {string} eventKind
 * @property {number} significance
 * @property {boolean} quiet
 * @property {boolean} complete
 */

/**
 * Turn a validated approach into deterministic effects.
 *
 * The approach text is the mind's own words and travels into its memory and the
 * world's record — but it never chooses a number. Everything numeric here comes
 * from the method, this mind's drives, and the world's config.
 *
 * @param {World} world
 * @param {Agent} agent
 * @param {string} method
 * @param {string|null} targetId
 * @param {string} approachText
 * @returns {ApproachResolution}
 */
export function resolveApproach(world, agent, method, targetId, approachText) {
  const spec = METHOD_SPECS[/** @type {keyof typeof METHOD_SPECS} */ (method)];
  const cfg = world.config;
  const tick = world.clock.tick;
  const aptitude = classAptitude(agent, "meaning");
  const focusFactor = 0.7 + (agent.drives.focus / 100) * 0.6;
  const cost = energyCost(world, agent, /** @type {keyof typeof METHOD_SPECS} */ (method));

  const gain = method === "undermine" ? 0 : 0.06 * spec.base * focusFactor * aptitude;
  const before = agent.goal.progress;
  const complete = before + gain >= 1 && before < 1;

  /** @type {EffectOp[]} */
  const ops = [];
  const target = targetId ? agentById(world, targetId) : null;

  if (gain > 0) ops.push({ op: "goal_progress", agent: agent.id, amount: gain });
  ops.push({ op: "need", agent: agent.id, deltas: { energy: -cost, ...spec.needs } });

  /* ---- real map effect ---- */
  let movedTo = null;
  if (spec.travel) {
    const elsewhere = world.regions.map(r => r.id).filter(id => id !== agent.regionId);
    // Linked places first: minds walk roads, they do not teleport.
    const here = regionById(world, agent.regionId);
    const linked = here ? here.links.filter(id => elsewhere.includes(id)) : [];
    const pool = linked.length ? linked : elsewhere;
    if (pool.length) {
      movedTo = world.rng.pick(pool);
      ops.push({ op: "move", agent: agent.id, regionId: movedTo });
    }
  }

  /* ---- real social effects ---- */
  if (method === "recruit" && target) {
    ops.push(
      { op: "edge", from: agent.id, to: target.id, deltas: { affinity: 7, trust: 5, familiarity: 6 }, reason: "asked to work together on it" },
      { op: "edge", from: target.id, to: agent.id, deltas: { affinity: 5, trust: 4, familiarity: 6 } },
      { op: "need", agent: target.id, deltas: { connection: 10, meaning: 5 } },
      {
        op: "memory",
        agent: target.id,
        trace: {
          kind: "contact",
          text: `${agent.name} asked me to help with ${agent.goal.text.toLowerCase()}. I said I would think about it.`,
          subjectId: agent.id,
          valence: 0.35,
          salience: 0.55
        }
      }
    );
  }

  if (method === "consult" && target) {
    ops.push(
      { op: "edge", from: agent.id, to: target.id, deltas: { trust: 6, familiarity: 7 } },
      { op: "edge", from: target.id, to: agent.id, deltas: { familiarity: 7 } },
      { op: "need", agent: target.id, deltas: { esteem: 7 } }
    );
    // Being asked is worth something, and sometimes the answer is worth more.
    if (world.rng.chance(0.4)) {
      ops.push(
        { op: "need", agent: agent.id, deltas: { meaning: 6 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "observation",
            text: `${target.name} knew something about it that I did not.`,
            subjectId: target.id,
            valence: 0.5,
            salience: 0.6
          }
        }
      );
    }
  }

  if (method === "practice") {
    // Practising where people can see you is a small public act.
    for (const witness of othersHere(world, agent).slice(0, 3)) {
      ops.push({ op: "edge", from: witness.id, to: agent.id, deltas: { familiarity: 3, affinity: 1 } });
    }
  }

  /* ---- real project effects ---- */
  if (method === "organise" && world.project && world.project.status === "active") {
    const amount = 4 + Math.round((agent.drives.focus / 100) * 6);
    ops.push({ op: "project_work", agent: agent.id, amount });
    ops.push({ op: "standing", agent: agent.id, delta: 2 });
  }

  if (method === "undermine" && target) {
    ops.push({ op: "project_interfere", agent: agent.id, targetId: target.id, amount: 8 });
  }

  /* ---- push_through carries a real risk of coming apart ---- */
  if (method === "push_through") {
    const strain = 0.12 + (1 - agent.drives.focus / 100) * 0.28;
    if (world.rng.chance(strain)) {
      ops.push(
        { op: "goal_progress", agent: agent.id, amount: -0.03 },
        { op: "mood", agent: agent.id, value: "strained", durationTicks: cfg.progression.triumphDurationTicks, reason: "pushed too hard" },
        { op: "need", agent: agent.id, deltas: { energy: -6, esteem: -7 } },
        {
          op: "memory",
          agent: agent.id,
          trace: {
            kind: "act",
            text: `I went at it too hard and it fell apart in my hands.`,
            subjectId: null,
            valence: -0.5,
            salience: 0.6
          }
        }
      );
    }
  }

  /* ---- the mind's own words, remembered ---- */
  ops.push({
    op: "memory",
    agent: agent.id,
    trace: {
      kind: "goal",
      text: approachText
        ? `Working on ${agent.goal.text.toLowerCase()} — ${approachText}`
        : `Another stretch of work on ${agent.goal.text.toLowerCase()}.`,
      subjectId: target ? target.id : null,
      valence: method === "undermine" ? -0.4 : gain > 0.09 ? 0.5 : 0.3,
      salience: method === "undermine" ? 0.7 : 0.45
    }
  });

  ops.push({ op: "xp", agent: agent.id, amount: method === "undermine" ? 8 : Math.round(11 + spec.base * 6) });

  if (complete) {
    ops.push({ op: "triumph", agent: agent.id, reason: "finished what they set out to do" });
    ops.push({ op: "need", agent: agent.id, deltas: { meaning: 18, esteem: 14 } });
  }

  const placeName = regionName(world, movedTo || agent.regionId);
  const text = phrase(world, agent, complete ? "goal_done" : "pursue_goal", {
    goal: agent.goal.text,
    region: placeName
  });

  return {
    ops,
    text,
    eventKind: complete ? "goal" : method === "undermine" ? "project" : "act",
    significance: complete ? 0.75 : method === "undermine" ? 0.6 : method === "organise" ? 0.4 : 0.2,
    quiet: !complete && method !== "undermine" && method !== "organise",
    complete
  };
}

/* ------------------------------------------------------------------ *
 * Building the request
 * ------------------------------------------------------------------ */

/**
 * Build the moment that asks a model how this mind means to pursue its goal.
 *
 * The context carries only what this mind can see, exactly like every other
 * moment — plus the list of approaches that are actually on offer from where it
 * is standing, so it cannot propose a road that does not exist here.
 *
 * @param {World} world
 * @param {Agent} agent
 * @returns {import("../model/world.js").Moment}
 */
export function buildGoalApproachMoment(world, agent) {
  const tick = world.clock.tick;
  const ctx = contextFor(world, agent, null);
  const project = world.project;
  ctx.goalKind = agent.goal.kind;
  ctx.goalProgress = agent.goal.progress;
  ctx.availableMethods = availableMethods(world, agent);
  ctx.atProjectSite = Boolean(project && project.status === "active" && project.regionId === agent.regionId);

  return {
    id: world.nextId("mo"),
    tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question:
      `${ctx.agentName} is working toward: ${agent.goal.text} ` +
      `(about ${Math.round(agent.goal.progress * 100)}% done). ` +
      `How do they approach it today? Name one approach from the list and describe it in your own words.`,
    context: ctx,
    options: [],
    resolved: false,
    source: "pursue_goal"
  };
}

/**
 * Should this mind be offered a model-authored approach on this tick?
 *
 * Deliberately narrow. A proposal costs a model call, so it is spent on minds
 * that are actually working toward something, not on minds that have finished,
 * or that are already running the open-plan cognition pilot.
 *
 * @param {World} world
 * @param {Agent} agent
 * @param {number} tick
 * @returns {boolean}
 */
export function proposalEligible(world, agent, tick) {
  const cfg = world.config.proposals;
  if (!cfg.enabled) return false;
  if (agent.cognition?.enabled) return false;
  if (agent.goal.progress >= cfg.maxGoalProgress) return false;
  if (tick < (agent.proposal?.nextTick ?? 0)) return false;
  const pending = world.pending.filter(m => m.kind === "goal_approach" && m.agentId === agent.id).length;
  if (pending >= cfg.maxPendingPerMind) return false;
  return availableMethods(world, agent).length > 1;
}
