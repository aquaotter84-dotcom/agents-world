/**
 * The charter, settled.
 *
 * Three things happen here, and none of them are scripted per mind.
 *
 *   1. Roles emerge. The engine counts what minds have actually been seen doing
 *      — wall work, sabotage, secrets kept, favours owed, scores settled — and
 *      when one mind is far enough ahead of the field, the world starts calling
 *      them something. A role is a fact about behaviour, not an assignment.
 *
 *   2. Enacted rules bite. A tradition or law the keeper enacted has a concrete,
 *      bounded effect on the tick, applied here rather than smeared across the
 *      systems it touches.
 *
 *   3. The keeper's influence moves. Rulings are paid for, days kept pay a
 *      little back, and the world's shared victory — the North Wall standing —
 *      pays the most.
 *
 * Everything is deterministic and offline-safe.
 */

import { clamp } from "../config.js";
import { logEvent } from "../model/events.js";
import { agentById, livingAgents, regionName } from "../model/world.js";
import { adjustEdge } from "../model/relationships.js";
import { remember } from "../model/memory.js";
import { moveInfluence, ruleStrength, isEnacted, RULE_KINDS, precedentFor } from "../model/charter.js";
import { keeperAct, noteAsk } from "./want.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../model/charter.js").Charter} Charter
 */

/**
 * The roles a pattern can earn. Each is a measurement of something the engine
 * already tracks, with the words the world would use for it.
 *
 * @type {{name: string, basis: string, weight: (world: World, agent: Agent) => number}[]}
 */
const ROLE_PATTERNS = [
  {
    name: "Wallwright",
    basis: "more of the wall is theirs than anyone else's",
    weight: (world, agent) => world.project?.contributors[agent.id]?.work ?? 0
  },
  {
    name: "Hand of the Wall",
    basis: "they were the one who kept helping other people's work",
    weight: (world, agent) => world.project?.contributors[agent.id]?.help ?? 0
  },
  {
    name: "Undertow",
    basis: "the wall has gone backwards more often around them than anywhere",
    weight: (world, agent) => world.project?.contributors[agent.id]?.interference ?? 0
  },
  {
    name: "Keeper of Quiet Things",
    basis: "they are holding more that is not said than anybody",
    weight: (world, agent) => world.secrets.filter(s => !s.isPublic && s.holders[agent.id] !== undefined).length * 3
  },
  {
    name: "Owed",
    basis: "more of the world is in their debt than in anyone's",
    weight: (world, agent) =>
      livingAgents(world).reduce((sum, other) => sum + (other.relations[agent.id]?.debts ?? 0), 0)
  },
  {
    name: "Carrying a Grudge",
    basis: "they have not let go of more than anybody else has",
    weight: (world, agent) =>
      Object.values(agent.relations).filter(e => (e?.resentment ?? 0) >= 40).length
  },
  {
    name: "The One They Tell",
    basis: "people keep coming to them rather than to anyone else",
    weight: (world, agent) =>
      livingAgents(world).reduce((sum, other) => sum + (other.relations[agent.id]?.trust ?? 0) / 25, 0)
  }
];

/**
 * Advance the charter by one tick: roles, rules, influence, lapses.
 * @param {World} world
 */
export function settleCharter(world) {
  const charter = world.charter;
  if (!charter) return;
  const cfg = world.config.charter;
  const tick = world.clock.tick;

  if (charter.nextDilemmaTick === undefined) charter.nextDilemmaTick = 0;

  settleRoles(world);
  applyEnactedRules(world);
  lapsePetitions(world);
  regenerateInfluence(world);
}

/**
 * Mint a role when one mind is far enough ahead of the field, and retire roles
 * whose holder has stopped earning them.
 * @param {World} world
 */
function settleRoles(world) {
  const cfg = world.config.charter;
  const charter = world.charter;
  const living = livingAgents(world);
  if (living.length < 2) return;

  for (const pattern of ROLE_PATTERNS) {
    const scored = living
      .map(agent => ({ agent, weight: Math.round(pattern.weight(world, agent)) }))
      .filter(entry => entry.weight >= cfg.roleMinWeight)
      .sort((a, b) => b.weight - a.weight);
    if (scored.length === 0) continue;

    const leader = scored[0];
    const runner = scored[1]?.weight ?? 0;
    const lead = leader.weight - runner;

    const existing = charter.roles.find(r => r.name === pattern.name);
    if (existing) {
      const holder = agentById(world, existing.holderId);
      // The role follows the behaviour. When the holder stops being the one,
      // the world stops calling them that.
      if (!holder || holder.retired || leader.agent.id !== holder.id || lead < Math.max(1, Math.floor(cfg.roleLeadMargin / 2))) {
        if (holder && !holder.retired) {
          logEvent(world, {
            kind: "world",
            agentId: holder.id,
            text: `${holder.name} is not ${pattern.name.toLowerCase()} any more. Nobody says it now.`,
            significance: 0.4,
            regionId: holder.regionId
          });
        }
        charter.roles = charter.roles.filter(r => r.id !== existing.id);
      } else {
        existing.weight = leader.weight;
        continue;
      }
    }

    if (lead < cfg.roleLeadMargin) continue;
    if (charter.roles.length >= cfg.maxRoles) continue;
    if (charter.roles.some(r => r.holderId === leader.agent.id)) continue;

    /** @type {import("../model/charter.js").CharterRole} */
    const role = {
      id: world.nextId("role"),
      name: pattern.name,
      holderId: leader.agent.id,
      basis: pattern.basis,
      tick: world.clock.tick,
      weight: leader.weight
    };
    charter.roles.push(role);
    logEvent(world, {
      kind: "role",
      agentId: leader.agent.id,
      text: `The world has started calling ${leader.agent.name} ${pattern.name} — ${pattern.basis}.`,
      significance: 0.62,
      regionId: leader.agent.regionId,
      role: { id: role.id, name: role.name }
    });
    remember(leader.agent.memory, {
      tick: world.clock.tick,
      kind: "observation",
      text: `People have started calling me ${pattern.name}. I did not ask for the name, but I have earned it.`,
      subjectId: null,
      valence: pattern.name === "Undertow" || pattern.name === "Carrying a Grudge" ? -0.3 : 0.5,
      salience: 0.8
    }, world.nextId);
  }
}

/**
 * The per-tick bite of everything the keeper has enacted.
 * @param {World} world
 */
function applyEnactedRules(world) {
  const charter = world.charter;
  const tick = world.clock.tick;
  const night = world.clock.phase === "night" || world.clock.phase === "deep night";

  if (isEnacted(charter, "share_the_fire")) {
    // Company comes easier where the fire is shared.
    for (const agent of livingAgents(world)) {
      const others = livingAgents(world).filter(a => a.id !== agent.id && a.regionId === agent.regionId);
      if (!others.length) continue;
      agent.needs.connection = clamp(agent.needs.connection + 0.35, 0, 100);
      for (const other of others) {
        const edge = agent.relations[other.id];
        if (edge) adjustEdge(agent, other.id, { familiarity: 0.15 }, tick);
      }
    }
  }

  if (isEnacted(charter, "open_houses")) {
    for (const agent of livingAgents(world)) {
      for (const other of livingAgents(world)) {
        if (other.id === agent.id || other.regionId !== agent.regionId) continue;
        if (!agent.relations[other.id]) continue;
        adjustEdge(agent, other.id, { familiarity: 0.25 }, tick);
      }
    }
  }

  if (isEnacted(charter, "mourn_the_gone")) {
    for (const agent of livingAgents(world)) {
      if (agent.awake) continue;
      // Exhaustion is met with sympathy rather than judgement.
      agent.standing = clamp((agent.standing ?? 0) + 0.05, -100, 100);
    }
  }

  if (isEnacted(charter, "quiet_hours") && night) {
    // Old scores are not settled after dark: grudges cool a little instead.
    for (const agent of livingAgents(world)) {
      for (const edge of Object.values(agent.relations)) {
        if (edge && edge.resentment > 0) edge.resentment = clamp(edge.resentment - 0.2, 0, 100);
      }
    }
  }
}

/**
 * Petitions the keeper never ruled on do not wait forever. A lapsed petition is
 * itself a fact about the world — and a precedent of a sort.
 * @param {World} world
 */
function lapsePetitions(world) {
  const cfg = world.config.charter;
  const charter = world.charter;
  const tick = world.clock.tick;
  for (const petition of charter.petitions) {
    if (petition.status !== "open") continue;
    if (tick - petition.tick < cfg.petitionLapseTicks) continue;
    petition.status = "lapsed";
    // An unanswered ask is the one kind of exchange with no upside: the world
    // asked, got nothing, and learned that asking changes nothing.
    world.want.ignored = (world.want.ignored || 0) + 1;
    keeperAct(world, "you let a petition lapse unanswered", world.config.want.acts.lapse);
    const agent = agentById(world, petition.agentId);
    if (agent) {
      remember(agent.memory, {
        tick,
        kind: "observation",
        text: "I asked the keeper to change something and the moment passed without an answer.",
        subjectId: null,
        valence: -0.25,
        salience: 0.55
      }, world.nextId);
    }
    logEvent(world, {
      kind: "charter",
      agentId: petition.agentId,
      text: `The petition for ${describeRule(petition.ruleKind)} went unanswered and lapsed.`,
      significance: 0.4,
      regionId: agent?.regionId
    });
  }
}

/**
 * The keeper's influence creeps back as the world is kept, but never past the
 * cap and never without the world actually ageing.
 * @param {World} world
 */
function regenerateInfluence(world) {
  const cfg = world.config.charter;
  const charter = world.charter;
  const perDayTicks = Math.max(1, Math.round((24 * 60) / world.config.clock.minutesPerTick));
  const mark = charter.lastInfluenceTick ?? 0;
  if (world.clock.tick - mark < perDayTicks) return;
  charter.lastInfluenceTick = world.clock.tick;
  moveInfluence(charter, cfg.influencePerDay);
}

/**
 * The name of a rule kind, for narration.
 * @param {string} ruleKind
 */
export function describeRule(ruleKind) {
  return RULE_KINDS[/** @type {keyof typeof RULE_KINDS} */ (ruleKind)]?.name ?? ruleKind;
}

/**
 * Record a petition in the charter. Called by the moment resolver once the
 * engine has validated that there is something to ask for.
 * @param {World} world
 * @param {Agent} agent
 * @param {{ruleKind: string, kind: string, basis: string, cost: number}} check
 * @param {string} text
 * @returns {import("../model/charter.js").Petition}
 */
export function recordPetition(world, agent, check, text) {
  const charter = world.charter;
  const prior = precedentFor(charter, check.ruleKind);
  /** @type {import("../model/charter.js").Petition} */
  const petition = {
    id: world.nextId("pet"),
    agentId: agent.id,
    text: text || `A petition for ${describeRule(check.ruleKind)}.`,
    ruleKind: check.ruleKind,
    kind: check.kind,
    tick: world.clock.tick,
    support: countSupport(world, agent, check.ruleKind),
    oppose: 0,
    basis: check.basis,
    precedentId: prior?.id,
    status: "open",
    cost: check.cost
  };
  charter.petitions.push(petition);
  noteAsk(world, "a petition");
  return petition;
}

/**
 * How many minds the engine can count behind a petition. Not opinion — evidence:
 * minds who have personally felt the thing the rule would address.
 * @param {World} world
 * @param {Agent} agent
 * @param {string} ruleKind
 */
function countSupport(world, agent, ruleKind) {
  const living = livingAgents(world);
  switch (ruleKind) {
    case "no_undermining":
    case "wall_first": {
      const project = world.project;
      if (!project) return 0;
      return living.filter(a => {
        const record = project.contributors[a.id];
        return record && (record.work > 0 || record.help > 0);
      }).length;
    }
    case "quiet_hours":
      return living.filter(a => Object.values(a.relations).some(e => (e?.resentment ?? 0) >= 30)).length;
    case "debts_honoured":
      return living.filter(a => Object.values(a.relations).some(e => (e?.debts ?? 0) > 0)).length;
    case "say_it_plainly":
      return living.filter(a => world.secrets.some(s => !s.isPublic && s.holders[a.id] !== undefined)).length;
    case "share_the_fire":
    case "open_houses":
      return living.filter(a => living.some(o => o.id !== a.id && o.regionId === a.regionId)).length;
    case "mourn_the_gone":
      return living.filter(a => !a.awake).length + 1;
    default:
      return 1;
  }
}

/**
 * The keeper rules on a petition. This is the loop that makes play evolve: the
 * ruling becomes a rule with real effects *and* a precedent that later
 * petitions lean on.
 *
 * @param {World} world
 * @param {string} petitionId
 * @param {"enact"|"refuse"} decision
 * @param {string} [note]
 * @returns {{ok: boolean, reason?: string, petition?: import("../model/charter.js").Petition}}
 */
export function ruleOnPetition(world, petitionId, decision, note = "") {
  const charter = world.charter;
  const petition = charter.petitions.find(p => p.id === petitionId);
  if (!petition) return { ok: false, reason: "unknown-or-already-ruled" };
  if (petition.status !== "open") return { ok: false, reason: "already-ruled" };
  if (decision !== "enact" && decision !== "refuse") return { ok: false, reason: "bad-decision" };

  const cfg = world.config.charter;
  const tick = world.clock.tick;
  const agent = agentById(world, petition.agentId);
  const words = String(note || "").trim().slice(0, 240);

  if (decision === "enact") {
    const cost = petition.cost ?? 0;
    if (charter.influence < cost) {
      return { ok: false, reason: `That costs ${cost} influence and you have ${Math.round(charter.influence)}.` };
    }
    moveInfluence(charter, -cost);
    charter.active[petition.ruleKind] = (charter.active[petition.ruleKind] || 0) + 1;
    /** @type {import("../model/charter.js").CharterRule} */
    const rule = {
      id: world.nextId("rule"),
      text: petition.text,
      kind: petition.kind,
      ruleKind: petition.ruleKind,
      proposedBy: petition.agentId,
      proposedTick: petition.tick,
      ruling: "enacted",
      ruledTick: tick,
      rulingNote: words || undefined
    };
    charter.rules.push(rule);
    petition.status = "enacted";
    charter.rulingsMade += 1;
    moveInfluence(charter, cfg.influencePerRuling);

    recordPrecedent(world, petition, "enacted", rule.id);
    keeperAct(world, `you enacted ${describeRule(petition.ruleKind)}`, world.config.want.acts.enact);
    logEvent(world, {
      kind: "charter",
      agentId: petition.agentId,
      text: `The keeper enacted ${petition.kind === "law" ? "a law" : "a tradition"}: ${describeRule(petition.ruleKind)}. ${words ? "“" + words + "”" : ""}`.trim(),
      significance: 0.8,
      regionId: agent?.regionId
    });
    if (agent) {
      agent.standing = clamp((agent.standing ?? 0) + 5, -100, 100);
      remember(agent.memory, {
        tick,
        kind: "act",
        text: `I asked the keeper for something and it became how the world runs. My words, out there.`,
        subjectId: null,
        valence: 0.75,
        salience: 0.9
      }, world.nextId);
    }
  } else {
    petition.status = "refused";
    charter.rulingsMade += 1;
    moveInfluence(charter, cfg.influencePerRuling);
    recordPrecedent(world, petition, "refused");
    keeperAct(world, `you refused the petition for ${describeRule(petition.ruleKind)}`, world.config.want.acts.refuse);
    logEvent(world, {
      kind: "charter",
      agentId: petition.agentId,
      text: `The keeper refused the petition for ${describeRule(petition.ruleKind)}. ${words ? "“" + words + "”" : ""}`.trim(),
      significance: 0.6,
      regionId: agent?.regionId
    });
    if (agent) {
      remember(agent.memory, {
        tick,
        kind: "observation",
        text: `I asked for ${describeRule(petition.ruleKind).toLowerCase()} and the keeper said no.`,
        subjectId: null,
        valence: -0.35,
        salience: 0.7
      }, world.nextId);
    }
  }
  return { ok: true, petition };
}

/**
 * A ruling becomes precedent, so the next petition on the same subject is not
 * heard as if nothing had been decided before.
 * @param {World} world
 * @param {import("../model/charter.js").Petition} petition
 * @param {"enacted"|"refused"} ruling
 * @param {string} [fromRuleId]
 */
function recordPrecedent(world, petition, ruling, fromRuleId) {
  /** @type {import("../model/charter.js").Precedent} */
  const precedent = {
    id: world.nextId("prec"),
    text: `${describeRule(petition.ruleKind)} was ${ruling} after ${agentById(world, petition.agentId)?.name || "a mind"} petitioned for it.`,
    ruleKind: petition.ruleKind,
    ruling,
    tick: world.clock.tick,
    fromRuleId
  };
  world.charter.precedents.push(precedent);
  if (world.charter.precedents.length > 60) world.charter.precedents.shift();
}

/**
 * The keeper settles a dilemma. Each choice is a real, bounded intervention.
 * @param {World} world
 * @param {string} dilemmaId
 * @param {string} choiceId
 * @returns {{ok: boolean, reason?: string}}
 */
export function resolveDilemma(world, dilemmaId, choiceId) {
  const charter = world.charter;
  const dilemma = charter.dilemmas.find(d => d.id === dilemmaId);
  if (!dilemma || dilemma.status !== "open") return { ok: false, reason: "unknown-or-already-resolved" };

  const cfg = world.config.charter;
  const tick = world.clock.tick;
  const cost = cfg.dilemmaCost + (choiceId === "mediate" ? 4 : choiceId === "condemn" || choiceId === "shame" ? -Math.round(cfg.dilemmaCost / 2) : 0);
  const spend = Math.max(0, cost);
  if (charter.influence < spend) {
    return { ok: false, reason: `That costs ${spend} influence and you have ${Math.round(charter.influence)}.` };
  }
  moveInfluence(charter, -spend);
  dilemma.status = "resolved";
  dilemma.resolution = choiceId;
  charter.nextDilemmaTick = tick + cfg.dilemmaIntervalTicks;

  const [aId, bId] = dilemma.partyIds;
  const a = aId ? agentById(world, aId) : null;
  const b = bId ? agentById(world, bId) : null;

  switch (choiceId) {
    case "separate": {
      if (a && b && a.regionId === b.regionId) {
        const elsewhere = world.regions.find(r => r.id !== a.regionId);
        if (elsewhere) b.regionId = elsewhere.id;
      }
      break;
    }
    case "mediate": {
      if (a && b) {
        adjustEdge(a, b.id, { resentment: -22, trust: 6, familiarity: 5 }, tick);
        adjustEdge(b, a.id, { resentment: -22, trust: 6, familiarity: 5 }, tick);
        for (const party of [a, b]) {
          party.needs.connection = clamp(party.needs.connection + 14, 0, 100);
          remember(party.memory, {
            tick,
            kind: "act",
            text: "The keeper made us sit down together. It did not fix it, but it stopped it getting worse.",
            subjectId: party.id === a.id ? b.id : a.id,
            valence: 0.3,
            salience: 0.75
          }, world.nextId);
        }
      }
      break;
    }
    case "condemn": {
      // The one carrying more resentment is the one the room hears about.
      const worse = a && b
        ? ((a.relations[b.id]?.resentment ?? 0) >= (b.relations[a.id]?.resentment ?? 0) ? a : b)
        : (a || b);
      if (worse) {
        worse.standing = clamp((worse.standing ?? 0) - 12, -100, 100);
        worse.needs.esteem = clamp(worse.needs.esteem - 14, 0, 100);
        remember(worse.memory, {
          tick,
          kind: "act",
          text: "The keeper named me as the worse of us, in front of everyone.",
          subjectId: null,
          valence: -0.7,
          salience: 0.9
        }, world.nextId);
      }
      break;
    }
    case "rally": {
      // The world turns toward the wall for a while.
      if (world.flags) world.flags.wallRallyUntil = tick + 48;
      break;
    }
    case "shame": {
      const idle = livingAgents(world).filter(x => !(world.project?.contributors[x.id]?.work > 0));
      for (const x of idle.slice(0, 3)) {
        x.standing = clamp((x.standing ?? 0) - 4, -100, 100);
        x.needs.esteem = clamp(x.needs.esteem - 6, 0, 100);
      }
      break;
    }
    default:
      break;
  }

  const acts = /** @type {Record<string, Record<string, number>>} */ (world.config.want.acts);
  const movement = acts[choiceId];
  if (movement) keeperAct(world, `you chose to ${String(choiceId).replace(/_/g, " ")}`, movement);

  logEvent(world, {
    kind: "charter",
    agentId: aId ?? null,
    text: dilemma.text + ` The keeper chose to ${String(choiceId).replace(/_/g, " ")}.`,
    significance: 0.72,
    regionId: a?.regionId
  });
  return { ok: true };
}

/**
 * The keeper acts on a whisper. Using it costs influence and it moves the world:
 * the thing whispered about stops being only the whisperer's.
 * @param {World} world
 * @param {string} whisperId
 * @returns {{ok: boolean, reason?: string}}
 */
export function actOnWhisper(world, whisperId) {
  const charter = world.charter;
  const whisper = charter.whispers.find(w => w.id === whisperId);
  if (!whisper || whisper.actedOn) return { ok: false, reason: "unknown-or-already-used" };
  const cost = world.config.charter.actOnWhisperCost;
  if (charter.influence < cost) return { ok: false, reason: `Acting on it costs ${cost} influence.` };
  moveInfluence(charter, -cost);
  whisper.actedOn = true;
  keeperAct(world, "you acted on something told to you in private", world.config.want.acts.whisper);

  const teller = agentById(world, whisper.agentId);
  const about = whisper.aboutId ? agentById(world, whisper.aboutId) : null;
  if (about) {
    about.standing = clamp((about.standing ?? 0) - 5, -100, 100);
    logEvent(world, {
      kind: "charter",
      agentId: whisper.agentId,
      subjectId: about.id,
      text: `Something the keeper was told in private about ${about.name} has started to circulate.`,
      significance: 0.66,
      regionId: about.regionId
    });
  }
  if (teller) {
    // Telling on someone is not free, even when the keeper keeps the source quiet.
    teller.needs.esteem = clamp(teller.needs.esteem - 4, 0, 100);
    remember(teller.memory, {
      tick: world.clock.tick,
      kind: "act",
      text: "I told the keeper something about them. It got out anyway, more or less.",
      subjectId: about ? about.id : null,
      valence: -0.2,
      salience: 0.7
    }, world.nextId);
  }
  return { ok: true };
}

/**
 * The North Wall standing is the world's shared win condition. It is recorded
 * here, in the charter, because it is the one thing every mind did together —
 * and it becomes the precedent the world measures everything else against.
 * @param {World} world
 * @param {string[]} contributorIds
 */
export function recordWallRaised(world, contributorIds) {
  const charter = world.charter;
  if (charter.wallRaised) return;
  charter.wallRaised = true;
  charter.wallRaisedTick = world.clock.tick;
  moveInfluence(charter, 25);
  // The shared win is the largest single movement the keeper's meters ever
  // take, because it is the one thing every mind did together.
  keeperAct(world, "the North Wall stands", world.config.want.acts.wall_raised);

  /** @type {import("../model/charter.js").Precedent} */
  const precedent = {
    id: world.nextId("prec"),
    text: `The North Wall was raised by ${contributorIds.length} minds working together. Nothing since has been asked that this did not already answer.`,
    ruleKind: "wall_first",
    ruling: "enacted",
    tick: world.clock.tick
  };
  charter.precedents.push(precedent);
  charter.active.wall_first = (charter.active.wall_first || 0) + 1;

  for (const id of contributorIds) {
    const agent = agentById(world, id);
    if (!agent) continue;
    if (!charter.roles.some(r => r.holderId === agent.id)) {
      charter.roles.push({
        id: world.nextId("role"),
        name: "Of the Wall",
        holderId: agent.id,
        basis: "they were there when it went up",
        tick: world.clock.tick,
        weight: 99
      });
    }
  }

  logEvent(world, {
    kind: "triumph",
    agentId: null,
    text: "The North Wall stands. Every mind in the world is safer for work they did together.",
    significance: 1
  });
}
