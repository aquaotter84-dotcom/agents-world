/**
 * Petitions and whispers: how a mind asks the world to change, and how it tells
 * the keeper something it would not say aloud.
 *
 * A petition is not a wish. The engine will only put one in front of the keeper
 * if there is something in the world that actually justifies asking — real
 * sabotage on the books, a real debt outstanding, a real feud at the point
 * where it ends badly. A mind that has nothing to point at does not get to
 * legislate from mood.
 *
 * As with proposals, the model supplies words and a kind; the engine supplies
 * feasibility, cost, and every consequence.
 */

import { RULE_KINDS, RULE_KIND_LIST, precedentFor, isEnacted } from "../model/charter.js";
import { contextFor } from "./moments.js";
import { agentById, livingAgents, regionName } from "../model/world.js";
import { feudStage } from "../model/relationships.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../model/charter.js").Petition} Petition
 */

/**
 * The fact in the world that would justify each kind of rule. If the predicate
 * does not hold, the rule cannot be petitioned for — there is nothing to point
 * at.
 *
 * @type {Record<string, (world: World, agent: Agent) => string|null>}
 */
const BASES = {
  no_undermining: (world) =>
    world.project && world.project.interferenceCount > 0
      ? `Wall work has been damaged ${world.project.interferenceCount} time${world.project.interferenceCount === 1 ? "" : "s"}.`
      : null,
  wall_first: (world) => {
    const project = world.project;
    if (!project || project.status !== "active") return null;
    const hands = Object.values(project.contributors).filter(r => r.work > 0 || r.help > 0).length;
    return hands >= 2 ? `${hands} minds have worked on the wall and it is only ${Math.round(project.progress)}% raised.` : null;
  },
  quiet_hours: (world) => {
    const hot = hottestFeud(world);
    return hot ? `${hot.a.name} and ${hot.b.name} are ${hot.stage} and it is getting worse.` : null;
  },
  debts_honoured: (world) => {
    for (const agent of livingAgents(world)) {
      for (const [otherId, edge] of Object.entries(agent.relations)) {
        if ((edge?.debts ?? 0) > 0 && agentById(world, otherId)) {
          return `${agent.name} is owed a favour that has gone unrepaid.`;
        }
      }
    }
    return null;
  },
  say_it_plainly: (world) => {
    const hidden = world.secrets.filter(s => !s.isPublic);
    return hidden.length ? `${hidden.length} thing${hidden.length === 1 ? "" : "s"} known to some and not others.` : null;
  },
  share_the_fire: (world, agent) => {
    const here = livingAgents(world).filter(a => a.regionId === agent.regionId).length;
    return here >= 2 ? `${here} minds are in ${regionName(world, agent.regionId)} together and keep to themselves.` : null;
  },
  open_houses: (world) => {
    const crowded = world.regions.find(r => livingAgents(world).filter(a => a.regionId === r.id).length >= 3);
    return crowded ? `${crowded.name} is crowded and nobody in it knows anybody.` : null;
  },
  mourn_the_gone: (world) => {
    const down = livingAgents(world).filter(a => !a.awake);
    return down.length ? `${down.length} mind${down.length === 1 ? " has" : "s have"} dropped out of the world from exhaustion.` : null;
  }
};

/**
 * The worst feud in the world, if any has reached rivalry or worse.
 * @param {World} world
 */
function hottestFeud(world) {
  let best = null;
  const seen = new Set();
  for (const agent of livingAgents(world)) {
    for (const [otherId, edge] of Object.entries(agent.relations)) {
      const other = agentById(world, otherId);
      if (!other || other.retired) continue;
      const key = [agent.id, other.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const stage = feudStage(edge, other.relations[agent.id], world.config);
      if (!stage) continue;
      const heat = Math.max(edge?.resentment ?? 0, other.relations[agent.id]?.resentment ?? 0);
      if (!best || heat > best.heat) best = { a: agent, b: other, stage, heat };
    }
  }
  return best && (best.stage === "rivalry" || best.stage === "vendetta") ? best : null;
}

/**
 * The rule kinds this mind could honestly petition for right now.
 * @param {World} world
 * @param {Agent} agent
 * @returns {{ruleKind: string, basis: string}[]}
 */
export function petitionableRules(world, agent) {
  const charter = world.charter;
  /** @type {{ruleKind: string, basis: string}[]} */
  const out = [];
  for (const ruleKind of RULE_KIND_LIST) {
    if (isEnacted(charter, ruleKind)) continue;
    const basis = BASES[ruleKind] ? BASES[ruleKind](world, agent) : null;
    if (basis) out.push({ ruleKind, basis });
  }
  return out;
}

/**
 * Whether this mind gets to petition on this tick.
 * @param {World} world
 * @param {Agent} agent
 * @param {number} tick
 */
export function petitionEligible(world, agent, tick) {
  const cfg = world.config.charter;
  if (!cfg.enabled) return false;
  if (tick < (agent.petition?.nextTick ?? 0)) return false;
  const open = world.charter.petitions.filter(p => p.status === "open").length;
  if (open >= cfg.maxOpenPetitions) return false;
  return petitionableRules(world, agent).length > 0;
}

/**
 * Build the moment in which a mind asks the keeper to change how the world runs.
 * @param {World} world
 * @param {Agent} agent
 * @returns {import("../model/world.js").Moment}
 */
export function buildPetitionMoment(world, agent) {
  const tick = world.clock.tick;
  const ctx = contextFor(world, agent, null);
  const options = petitionableRules(world, agent);
  /** @type {any} */ (ctx).petitionable = options.map(o => ({
    ruleKind: o.ruleKind,
    name: RULE_KINDS[/** @type {keyof typeof RULE_KINDS} */ (o.ruleKind)].name,
    kind: RULE_KINDS[/** @type {keyof typeof RULE_KINDS} */ (o.ruleKind)].kind,
    gloss: RULE_KINDS[/** @type {keyof typeof RULE_KINDS} */ (o.ruleKind)].gloss,
    basis: o.basis
  }));

  return {
    id: world.nextId("mo"),
    tick,
    kind: "petition",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.7,
    question:
      `${ctx.agentName} wants the keeper to change how this world runs. ` +
      `Pick one of the changes they could honestly ask for, and write the petition in their own words.`,
    context: ctx,
    options: [],
    resolved: false,
    source: "charter"
  };
}

/** @typedef {{ok: boolean, reason: string, ruleKind: string, kind: string, basis: string, cost: number}} PetitionCheck */

/**
 * Validate a proposed petition. The model chooses a kind of change; the engine
 * decides whether there is anything in the world to justify it.
 * @param {World} world
 * @param {Agent} agent
 * @param {Record<string, any>} answer
 * @returns {PetitionCheck}
 */
export function validatePetition(world, agent, answer) {
  const raw = String(answer?.ruleKind ?? answer?.rule ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  /** @param {string} reason @param {string} [ruleKind] */
  const refuse = (reason, ruleKind = raw) => ({ ok: false, reason, ruleKind, kind: "tradition", basis: "", cost: 0 });

  if (!raw) return refuse("No rule kind was proposed.");
  if (!(raw in RULE_KINDS)) return refuse(`"${raw}" is not a change this world can legislate.`);

  const spec = RULE_KINDS[/** @type {keyof typeof RULE_KINDS} */ (raw)];
  if (isEnacted(world.charter, raw)) return refuse("That is already how the world runs.");

  const basis = BASES[raw] ? BASES[raw](world, agent) : null;
  if (!basis) return refuse("There is nothing in the world that justifies asking for that.");

  return { ok: true, reason: "The keeper may rule on this.", ruleKind: raw, kind: spec.kind, basis, cost: spec.cost };
}

/**
 * Whether this mind has something worth whispering, and what.
 * @param {World} world
 * @param {Agent} agent
 * @returns {{aboutId: string|null, subject: string}|null}
 */
export function whisperable(world, agent) {
  // A secret this mind holds and the world does not.
  const held = world.secrets.find(
    s => !s.isPublic && s.holders[agent.id] !== undefined && Object.keys(s.holders).length < Math.max(2, livingAgents(world).length - 1)
  );
  if (held) {
    const aboutId = held.aboutId && held.aboutId !== agent.id ? held.aboutId : null;
    return { aboutId, subject: `Something they know about ${aboutId ? agentById(world, aboutId)?.name || "another mind" : "somebody"} that nobody else does.` };
  }
  // Or a grudge they have not acted on.
  for (const [otherId, edge] of Object.entries(agent.relations)) {
    const other = agentById(world, otherId);
    if (!other || other.retired) continue;
    if ((edge?.resentment ?? 0) >= world.config.projects.interferenceResentmentFloor) {
      return { aboutId: other.id, subject: `What they have not let go of about ${other.name}.` };
    }
  }
  return null;
}

/**
 * Whether this mind whispers to the keeper on this tick.
 * @param {World} world
 * @param {Agent} agent
 * @param {number} tick
 */
export function whisperEligible(world, agent, tick) {
  const cfg = world.config.charter;
  if (!cfg.enabled || !cfg.whispersEnabled) return false;
  if (tick < (agent.whisper?.nextTick ?? 0)) return false;
  if (world.charter.whispers.filter(w => !w.actedOn).length >= cfg.maxOpenWhispers) return false;
  return whisperable(world, agent) !== null;
}

/**
 * Build the moment in which a mind tells the keeper something privately.
 * @param {World} world
 * @param {Agent} agent
 * @returns {import("../model/world.js").Moment}
 */
export function buildWhisperMoment(world, agent) {
  const tick = world.clock.tick;
  const subject = whisperable(world, agent);
  const ctx = contextFor(world, agent, subject?.aboutId ?? null);
  /** @type {any} */ (ctx).whisperSubject = subject?.subject ?? "";

  return {
    id: world.nextId("mo"),
    tick,
    kind: "whisper",
    agentId: agent.id,
    participants: subject?.aboutId ? [agent.id, subject.aboutId] : [agent.id],
    significance: 0.66,
    question:
      `${ctx.agentName} wants to tell the keeper something they would not say in the room. ` +
      `Write what they whisper, in their own words. The keeper will decide whether to act on it.`,
    context: ctx,
    options: [],
    resolved: false,
    source: "charter"
  };
}

/**
 * Whether the world has a dilemma worth putting to the keeper this tick.
 * @param {World} world
 * @param {number} tick
 * @returns {{kind: string, text: string, partyIds: string[]}|null}
 */
export function openDilemma(world, tick) {
  const cfg = world.config.charter;
  if (!cfg.enabled) return null;
  if (tick < (world.charter.nextDilemmaTick ?? 0)) return null;
  if (world.charter.dilemmas.some(d => d.status === "open")) return null;

  // Two minds who both raised the wall, now at the point of ending each other.
  const feud = hottestFeud(world);
  if (feud && feud.stage === "vendetta") {
    const project = world.project;
    const both = project && Object.values(project.contributors).length >= 2;
    if (both) {
      return {
        kind: "feud",
        text: `${feud.a.name} and ${feud.b.name} both helped raise the North Wall, and now they are a vendetta. The work cannot go on with them in the same place.`,
        partyIds: [feud.a.id, feud.b.id]
      };
    }
    return {
      kind: "feud",
      text: `${feud.a.name} and ${feud.b.name} have come to the end of what they will put up with from each other.`,
      partyIds: [feud.a.id, feud.b.id]
    };
  }

  // Or the wall stalls with everyone watching.
  const project = world.project;
  if (project && project.status === "active" && project.progress > 0 && project.progress < 100) {
    const stagnant = world.clock.tick - (project.lastWorkTick ?? 0) > cfg.dilemmaStagnantTicks;
    if (stagnant) {
      return {
        kind: "scarcity",
        text: `The North Wall has sat at ${Math.round(project.progress)}% for days. Nobody is lifting anything.`,
        partyIds: []
      };
    }
  }
  return null;
}

/**
 * The rulings the keeper may make on a dilemma, with what each costs and does.
 * @param {World} world
 * @param {import("../model/charter.js").Dilemma} dilemma
 */
export function dilemmaChoices(world, dilemma) {
  const cfg = world.config.charter;
  if (dilemma.kind === "feud") {
    return [
      { id: "separate", label: "Send them to different ends of the world", cost: cfg.dilemmaCost },
      { id: "mediate", label: "Make them sit down together", cost: cfg.dilemmaCost + 4 },
      { id: "condemn", label: "Condemn the worse of them publicly", cost: Math.round(cfg.dilemmaCost / 2) },
      { id: "let_it_ride", label: "Let it run its course", cost: 0 }
    ];
  }
  return [
    { id: "rally", label: "Call the world to the wall", cost: cfg.dilemmaCost },
    { id: "shame", label: "Name the ones who are not lifting", cost: Math.round(cfg.dilemmaCost / 2) },
    { id: "let_it_ride", label: "Let the wall wait", cost: 0 }
  ];
}

/**
 * Which precedent, if any, a new petition leans on.
 * @param {World} world
 * @param {string} ruleKind
 */
export function leaningOn(world, ruleKind) {
  return precedentFor(world.charter, ruleKind);
}
