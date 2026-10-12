/**
 * Gods don't chat.
 *
 * The keeper has always had two ways to touch this world: rule on what the
 * world asks (the charter) and talk to one mind in private (chat). Neither is
 * how a god is experienced from inside a story. What a mind actually meets is
 * a light, a sign, and something standing in the room that will not speak.
 *
 * So: three interventions, all priced in the same influence the charter runs
 * on, all aimed at something the world already has, all visible on the board
 * and readable in the record.
 *
 *   blessing    a mind, or the work itself. The gentlest act, and the only one
 *               that touches prosperity directly: a blessed mind's hands go
 *               further on the wall, and a blessing on the work lifts every
 *               hand on it.
 *   omen        a region. It cools every quarrel in that region while it hangs
 *               and makes a confrontation much harder to choose — the keeper's
 *               answer to seeing a feud about to flash.
 *   apparition  a dilemma. The most expensive thing a keeper can do: nobody
 *               hears anything, and nothing is written down as precedent, but
 *               the two of them let go of more than any ruling has ever made
 *               them let go of.
 *
 * Everything here is validated by the engine before it lands: the price is
 * checked against real influence, the target has to exist, and a target that is
 * already carrying a sign is refused with a sentence saying so. Nothing here
 * draws from the RNG, so a keeper's intervention replaying a save lands in
 * exactly the same world.
 */

import { clamp } from "../config.js";
import { logEvent } from "../model/events.js";
import { agentById, livingAgents, regionName } from "../model/world.js";
import { adjustEdge, edgeToward } from "../model/relationships.js";
import { remember } from "../model/memory.js";
import { moveInfluence } from "../model/charter.js";
import {
  interventionById,
  liveBlessingForAgent,
  liveBlessingForWork,
  liveInterventions,
  liveOmenForRegion,
  recordIntervention
} from "../model/divine.js";
import { keeperAct } from "./want.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../model/divine.js").Intervention} Intervention
 */

/**
 * What each intervention is, in the keeper's own words, and what it is aimed
 * at. The UI reads this rather than writing its own copy, so the price on the
 * button and the price the engine charges cannot come apart.
 *
 * @type {Record<"omen"|"blessing"|"apparition", {name: string, verb: string, aim: string, blurb: string, color: string}>}
 */
export const INTERVENTION_INFO = {
  blessing: {
    name: "Blessing",
    verb: "bless",
    aim: "a mind, or the work on the wall",
    blurb: "A light nobody can explain, on one mind or on the wall itself. Their hands get more done while it holds.",
    color: "#f3d9a4"
  },
  omen: {
    name: "Omen",
    verb: "set an omen over",
    aim: "a region",
    blurb: "A sign that hangs over a place. Quarrels in it cool, and almost nobody starts a fight under it.",
    color: "#8fa3bd"
  },
  apparition: {
    name: "Apparition",
    verb: "appear at",
    aim: "a dilemma already on the table",
    blurb: "You stand where they are standing and say nothing at all. No law is written; they simply stop.",
    color: "#c4aaf0"
  }
};

/**
 * The price of one intervention, from config — the engine charges exactly what
 * the panel quotes.
 * @param {{blessingCost: number, omenCost: number, apparitionCost: number}} cfg
 * @param {"omen"|"blessing"|"apparition"} kind
 * @returns {number}
 */
function priceOf(cfg, kind) {
  if (kind === "blessing") return cfg.blessingCost;
  if (kind === "omen") return cfg.omenCost;
  return cfg.apparitionCost;
}

/**
 * The keeper's three interventions, with live prices and whether the world can
 * currently honour them. This is the readout the hand panel and the radial menu
 * both draw from: an intervention the keeper cannot afford or cannot aim is
 * shown disabled with the reason, never hidden.
 *
 * @param {World} world
 * @returns {{kind: "omen"|"blessing"|"apparition", name: string, verb: string, aim: string, blurb: string, color: string, cost: number, enabled: boolean, reason: string, live: number, cooldown: number}[]}
 */
export function interventionOptions(world) {
  const cfg = world.config.divine;
  const divine = world.divine;
  const tick = world.clock.tick;
  const influence = world.charter?.influence ?? 0;
  const openDilemmas = (world.charter?.dilemmas || []).filter(d => d.status === "open").length;
  const kinds = /** @type {("blessing"|"omen"|"apparition")[]} */ (["blessing", "omen", "apparition"]);
  return kinds.map(/** @param {"blessing"|"omen"|"apparition"} kind */ kind => {
    const info = INTERVENTION_INFO[kind];
    const cost = priceOf(cfg, kind);
    const live = liveInterventions(divine, tick, kind).length;
    const ready = tick - ((divine?.lastTick?.[kind] ?? -9999)) >= (cfg.cooldownTicks[kind] || 0);
    const wait = ready ? 0 : (cfg.cooldownTicks[kind] || 0) - (tick - (divine?.lastTick?.[kind] ?? 0));
    // The panel is a budget readout first: what it cannot be afforded is the
    // most useful line to read next to the price.
    let reason = "";
    let enabled = true;
    if (!cfg.enabled) { enabled = false; reason = "The world is not taking signs right now."; }
    else if (influence < cost) { enabled = false; reason = `That costs ${cost} influence and you have ${Math.round(influence)}.`; }
    else if (!ready) { enabled = false; reason = `${wait} more tick${wait === 1 ? "" : "s"} before you can do that again.`; }
    else if (kind === "apparition" && !openDilemmas) { enabled = false; reason = "Nothing is waiting on you to appear at."; }
    return {
      kind,
      name: info.name,
      verb: info.verb,
      aim: info.aim,
      blurb: info.blurb,
      color: info.color,
      cost,
      enabled,
      reason,
      live,
      cooldown: Math.max(0, wait)
    };
  });
}

/**
 * The same readout for one specific act, in one line, for a tooltip or a toast.
 * @param {World} world
 * @param {"omen"|"blessing"|"apparition"} kind
 */
export function interventionOption(world, kind) {
  return interventionOptions(world).find(option => option.kind === kind) || null;
}

/**
 * What the keeper is aiming at, resolved into something the engine can validate
 * and draw: a region for an omen, a mind or the wall for a blessing, an open
 * dilemma for an apparition.
 *
 * @param {World} world
 * @param {"omen"|"blessing"|"apparition"} kind
 * @param {{regionId?: string|null, agentId?: string|null, dilemmaId?: string|null, work?: boolean}|null|undefined} target
 * @returns {{ok: true, regionId: string|null, agentId: string|null, subjectId: string|null, dilemmaId: string|null, target: Intervention["target"]} | {ok: false, reason: string}}
 */
export function resolveTarget(world, kind, target) {
  const t = target || {};
  if (kind === "omen") {
    const regionId = t.regionId || (t.agentId ? agentById(world, t.agentId)?.regionId : null) || world.project?.regionId || null;
    // `regionById` falls back to the first region; an omen must not be set over
    // a place that does not exist just because the argument was wrong.
    if (!regionId || !world.regions.some(r => r.id === regionId)) {
      return { ok: false, reason: "There is no such place to set a sign over." };
    }
    const hanging = liveOmenForRegion(world.divine, world.clock.tick, regionId);
    if (hanging) return { ok: false, reason: `A sign already hangs over ${regionName(world, regionId)}.` };
    return { ok: true, regionId, agentId: t.agentId || null, subjectId: null, dilemmaId: null, target: "region" };
  }

  if (kind === "blessing") {
    if (t.work) {
      const project = world.project;
      if (!project) return { ok: false, reason: "There is no work to bless." };
      if (liveBlessingForWork(world.divine, world.clock.tick)) {
        return { ok: false, reason: "The work is already lit." };
      }
      return { ok: true, regionId: project.regionId, agentId: null, subjectId: null, dilemmaId: null, target: "work" };
    }
    const agent = t.agentId ? agentById(world, t.agentId) : null;
    if (!agent) return { ok: false, reason: "Point it at a mind, or at the work on the wall." };
    if (agent.retired) return { ok: false, reason: `${agent.name} is gone. There is nobody there to bless.` };
    if (liveBlessingForAgent(world.divine, world.clock.tick, agent.id)) {
      return { ok: false, reason: `${agent.name} is already carrying your light.` };
    }
    return { ok: true, regionId: agent.regionId, agentId: agent.id, subjectId: null, dilemmaId: null, target: "mind" };
  }

  // apparition
  const dilemma = t.dilemmaId
    ? (world.charter?.dilemmas || []).find(d => d.id === t.dilemmaId)
    : (world.charter?.dilemmas || []).find(d => d.status === "open");
  if (!dilemma) return { ok: false, reason: "Nothing is waiting on you to appear at." };
  if (dilemma.status !== "open") return { ok: false, reason: "That has already been settled." };
  const [aId, bId] = dilemma.partyIds;
  return {
    ok: true,
    regionId: aId ? agentById(world, aId)?.regionId ?? null : null,
    agentId: aId ?? null,
    subjectId: bId ?? null,
    dilemmaId: dilemma.id,
    target: "dilemma"
  };
}

/**
 * Whether the keeper could do this, right now, to this. Every refusal is a
 * sentence the keeper can read — the same contract the charter's rulings use.
 *
 * @param {World} world
 * @param {"omen"|"blessing"|"apparition"} kind
 * @param {{regionId?: string|null, agentId?: string|null, dilemmaId?: string|null, work?: boolean}|null|undefined} [target]
 * @returns {{ok: boolean, reason?: string, cost: number, resolved?: {regionId: string|null, agentId: string|null, subjectId: string|null, dilemmaId: string|null, target: Intervention["target"]}}}
 */
export function canIntervene(world, kind, target) {
  const cfg = world.config.divine;
  if (!INTERVENTION_INFO[kind]) return { ok: false, reason: "There is no such intervention.", cost: 0 };
  const cost = priceOf(cfg, kind);
  if (!cfg.enabled) return { ok: false, reason: "The world is not taking signs right now.", cost };
  const charter = world.charter;
  if (!charter) return { ok: false, reason: "This world has nothing to spend.", cost };
  // The target is checked before the price and before the cooldown: when the
  // thing the keeper is pointing at cannot take it, that is the more useful
  // sentence — and it stays true however much influence they are holding.
  const resolved = resolveTarget(world, kind, target);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, cost };
  const tick = world.clock.tick;
  const cooldown = cfg.cooldownTicks[kind] || 0;
  const last = world.divine?.lastTick?.[kind];
  if (last !== undefined && tick - last < cooldown) {
    const wait = cooldown - (tick - last);
    return { ok: false, reason: `${wait} more tick${wait === 1 ? "" : "s"} before you can do that again.`, cost };
  }
  if (charter.influence < cost) {
    return { ok: false, reason: `That costs ${cost} influence and you have ${Math.round(charter.influence)}.`, cost };
  }
  const { ok: _ok, ...rest } = resolved;
  return { ok: true, cost, resolved: rest };
}

/**
 * Do it. Influence is spent, the world is changed, the intervention is written
 * down, and the keeper's own meters move with the act that moved them.
 *
 * @param {World} world
 * @param {"omen"|"blessing"|"apparition"} kind
 * @param {{regionId?: string|null, agentId?: string|null, dilemmaId?: string|null, work?: boolean}|null|undefined} [target]
 * @returns {{ok: boolean, reason?: string, intervention?: Intervention}}
 */
export function performIntervention(world, kind, target) {
  const check = canIntervene(world, kind, target);
  if (!check.ok || !check.resolved) return { ok: false, reason: check.reason };
  const cfg = world.config.divine;
  const tick = world.clock.tick;
  const resolved = check.resolved;
  const cost = check.cost;
  moveInfluence(world.charter, -cost);

  const outcome = kind === "blessing"
    ? applyBlessing(world, resolved)
    : kind === "omen"
      ? applyOmen(world, resolved)
      : applyApparition(world, resolved);

  /** @type {Intervention} */
  const intervention = {
    id: world.nextId("sign"),
    kind,
    target: resolved.target,
    agentId: resolved.agentId ?? null,
    subjectId: resolved.subjectId ?? null,
    regionId: resolved.regionId ?? null,
    dilemmaId: resolved.dilemmaId ?? null,
    tick,
    expireTick: kind === "apparition" ? tick : tick + (kind === "omen" ? cfg.omenWindowTicks : cfg.blessingWindowTicks),
    markUntil: tick + (kind === "apparition" ? cfg.markWindowTicks : (kind === "omen" ? cfg.omenWindowTicks : cfg.blessingWindowTicks) + cfg.markWindowTicks),
    cost,
    text: outcome.text,
    effect: outcome.effect
  };
  recordIntervention(world.divine, intervention);

  // The keeper's own score moves with the act, through the one choke point
  // every other keeper act uses, with the act itself as the cause.
  const entry = keeperAct(world, outcome.cause, world.config.want.acts[kind]);
  intervention.values = entry ? [entry.values.harmony, entry.values.prosperity, entry.values.legacy] : [];

  logEvent(world, {
    kind: "divine",
    agentId: intervention.agentId,
    subjectId: intervention.subjectId,
    text: outcome.text,
    significance: outcome.significance,
    regionId: intervention.regionId || undefined
  });
  return { ok: true, intervention };
}

/* ------------------------------------------------------------------ *
 * The three acts
 * ------------------------------------------------------------------ */

/**
 * A blessing on one mind, or on the work on the wall.
 * @param {World} world
 * @param {{regionId: string|null, agentId: string|null, target: Intervention["target"]}} resolved
 */
function applyBlessing(world, resolved) {
  const cfg = world.config.divine;
  const tick = world.clock.tick;
  if (resolved.target === "work") {
    const project = world.project;
    const builders = livingAgents(world).filter(a => {
      const record = project?.contributors?.[a.id];
      return Boolean(record && (record.work > 0 || record.help > 0));
    });
    for (const agent of builders) {
      agent.standing = clamp((agent.standing ?? 0) + 4, -100, 100);
      remember(agent.memory, {
        tick,
        kind: "observation",
        text: "Light lay across the wall all day and my hands were in it. Nothing about the work was any easier, and all of it went better.",
        subjectId: null,
        valence: 0.55,
        salience: 0.75
      }, world.nextId);
    }
    const pct = Math.round(cfg.blessingWorkBonus * 100);
    return {
      cause: "you blessed the work on the North Wall",
      text: "Light lay across the North Wall from morning until it was dark, and nobody could say where it came from. The work went well.",
      effect: `every hand on the wall gets ${pct}% further for the next ${cfg.blessingWindowTicks} ticks.`,
      significance: 0.68
    };
  }

  const agent = agentById(world, /** @type {string} */ (resolved.agentId));
  if (!agent) return { cause: "you blessed a light nobody stood in", text: "A light came and went with nobody in it.", effect: "nothing.", significance: 0.3 };
  const lift = cfg.blessingLift;
  agent.needs.energy = clamp(agent.needs.energy + lift, 0, 100);
  agent.needs.meaning = clamp(agent.needs.meaning + lift, 0, 100);
  agent.needs.esteem = clamp(agent.needs.esteem + lift * 0.6, 0, 100);
  agent.needs.connection = clamp(agent.needs.connection + lift * 0.5, 0, 100);
  agent.standing = clamp((agent.standing ?? 0) + cfg.blessingStanding, -100, 100);
  agent.moodLevel = clamp((agent.moodLevel ?? 50) + cfg.blessingMoodLevel, 0, 100);
  remember(agent.memory, {
    tick,
    kind: "observation",
    text: "Something looked at me for a while today and it was not unkind. I do not know what I did to deserve it, and I would like to do it again.",
    subjectId: null,
    valence: 0.6,
    salience: 0.85
  }, world.nextId);
  return {
    cause: `you blessed ${agent.name} with a light`,
    text: `${agent.name} stood in a light that came from nowhere. Nobody could say where it came from, and everybody noticed.`,
    effect: `${agent.name} carries it: their spirits are up and their work on the wall goes further for ${cfg.blessingWindowTicks} ticks.`,
    significance: 0.68
  };
}

/**
 * A sign over a region. The cooling itself happens per tick in `settleDivine`;
 * this is the moment it appears.
 * @param {World} world
 * @param {{regionId: string|null}} resolved
 */
function applyOmen(world, resolved) {
  const cfg = world.config.divine;
  const tick = world.clock.tick;
  const regionId = /** @type {string} */ (resolved.regionId);
  const name = regionName(world, regionId);
  const here = livingAgents(world).filter(a => a.regionId === regionId);
  for (const agent of here) {
    agent.needs.meaning = clamp(agent.needs.meaning + cfg.omenMeaning, 0, 100);
    agent.moodLevel = clamp((agent.moodLevel ?? 50) + cfg.omenMoodLevel, 0, 100);
    remember(agent.memory, {
      tick,
      kind: "observation",
      text: `There was a sign over ${name} today and it did not blow away. Nobody said what it meant, and everybody walked a little slower.`,
      subjectId: null,
      valence: -0.2,
      salience: 0.8
    }, world.nextId);
  }
  // Being under a sign makes a quarrel feel like something that could be
  // punished. That fright of the other party is a real brake on the decision to
  // confront — and it outlasts the sign itself, the way fear does.
  for (let i = 0; i < here.length; i++) {
    for (let j = i + 1; j < here.length; j++) {
      const a = here[i], b = here[j];
      const heat = Math.max(a.relations[b.id]?.resentment ?? 0, b.relations[a.id]?.resentment ?? 0);
      if (heat <= 0) continue;
      adjustEdge(a, b.id, { fear: cfg.omenFear }, tick);
      adjustEdge(b, a.id, { fear: cfg.omenFear }, tick);
    }
  }
  return {
    cause: `you set an omen over ${name}`,
    text: `A sign hung over ${name} and would not blow away. People kept looking up at it and lowering their voices.`,
    effect: `quarrels in ${name} cool while it hangs, and almost nobody chooses a fight under it — ${cfg.omenWindowTicks} ticks.`,
    significance: 0.74
  };
}

/**
 * The keeper stands at a dilemma. Nothing is said, no law is written, and the
 * two of them put down more than a ruling has ever made anyone put down.
 * @param {World} world
 * @param {{dilemmaId: string|null, agentId: string|null, subjectId: string|null}} resolved
 */
function applyApparition(world, resolved) {
  const cfg = world.config.divine;
  const tick = world.clock.tick;
  const charter = world.charter;
  const dilemma = (charter?.dilemmas || []).find(d => d.id === resolved.dilemmaId);
  const a = resolved.agentId ? agentById(world, resolved.agentId) : null;
  const b = resolved.subjectId ? agentById(world, resolved.subjectId) : null;
  let released = 0;

  for (const party of [a, b]) {
    if (!party) continue;
    const other = party === a ? b : a;
    if (other) {
      const before = edgeToward(party, other.id).resentment;
      adjustEdge(party, other.id, { resentment: cfg.apparitionResentment }, tick);
      released = Math.max(released, before - edgeToward(party, other.id).resentment);
    }
    party.needs.meaning = clamp(party.needs.meaning + cfg.apparitionMeaning, 0, 100);
    party.moodLevel = clamp((party.moodLevel ?? 50) + cfg.apparitionMoodLevel, 0, 100);
    party.standing = clamp((party.standing ?? 0) + cfg.apparitionStanding, -100, 100);
    remember(party.memory, {
      tick,
      kind: "act",
      text: "The keeper stood where we were standing. Nothing was said at all. Everything I was about to do looked small next to it.",
      subjectId: other ? other.id : null,
      valence: 0.4,
      salience: 0.95
    }, world.nextId);
  }

  if (dilemma) {
    dilemma.status = "resolved";
    dilemma.resolution = "apparition";
    dilemma.resolvedTick = tick;
    if (charter) charter.nextDilemmaTick = tick + world.config.charter.dilemmaIntervalTicks;
  }

  const names = [a?.name, b?.name].filter(Boolean);
  const pair = names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] || "two minds");
  return {
    cause: `you appeared where ${pair} were standing`,
    text: `Something stood where ${pair} were standing and said nothing at all. Neither did they. Afterwards neither of them could say what it had been.`,
    effect: `they put down ${Math.round(released)} of what they were carrying, and no law was written — nothing was said.`,
    significance: 0.86
  };
}

/* ------------------------------------------------------------------ *
 * Per-tick bite
 * ------------------------------------------------------------------ */

/**
 * What a live intervention does while it holds. Runs in the tick, after the
 * systems that could have created new quarrels, so an omen cools what this tick
 * actually produced rather than only what existed when it was set.
 *
 * An apparition has no window — it is a moment, not a state — so nothing here
 * touches it.
 *
 * @param {World} world
 */
export function settleDivine(world) {
  const divine = world.divine;
  const cfg = world.config.divine;
  if (!divine || !cfg.enabled) return;
  const tick = world.clock.tick;
  const live = liveInterventions(divine, tick);
  if (!live.length) return;

  const living = livingAgents(world);
  for (const iv of live) {
    if (iv.kind === "omen") {
      const here = living.filter(a => a.regionId === iv.regionId);
      for (let i = 0; i < here.length; i++) {
        for (let j = i + 1; j < here.length; j++) {
          const a = here[i], b = here[j];
          // Only cool quarrels that exist. A sign over a valley does not invent
          // relationships between strangers standing in it.
          if (!a.relations[b.id] || !b.relations[a.id]) continue;
          if (a.relations[b.id].resentment <= 0 && b.relations[a.id].resentment <= 0) continue;
          adjustEdge(a, b.id, { resentment: -cfg.omenCoolPerTick }, tick);
          adjustEdge(b, a.id, { resentment: -cfg.omenCoolPerTick }, tick);
        }
      }
    } else if (iv.kind === "blessing" && iv.target === "mind") {
      const agent = iv.agentId ? agentById(world, iv.agentId) : null;
      if (!agent || agent.retired) continue;
      // Carrying the light, they simply do not tire as fast.
      agent.needs.energy = clamp(agent.needs.energy + 0.15, 0, 100);
    }
  }
}

/**
 * How many interventions of each kind are still biting right now — a one-line
 * readout for the record and the want panel.
 * @param {World} world
 * @returns {{kind: string, count: number}[]}
 */
export function liveSigns(world) {
  const tick = world.clock.tick;
  return /** @type {const} */ (["blessing", "omen", "apparition"]).map(kind => ({
    kind,
    count: liveInterventions(world.divine, tick, kind).length
  }));
}

/**
 * The interventions the record shows, newest first.
 * @param {World} world
 * @param {number} [n]
 */
export function recentInterventions(world, n = 6) {
  return (world.divine?.interventions || []).slice(-n).reverse();
}

/**
 * The intervention behind a board mark id, for a tap that wants to say what it
 * was. Returns null for an id the world no longer keeps.
 * @param {World} world
 * @param {string} id
 */
export function interventionFor(world, id) {
  return interventionById(world.divine, id);
}

/* Re-exported readers, so callers that only need to ask a question do not have
 * to reach into the model layer as well. */
export { liveBlessingForAgent, liveBlessingForWork, liveOmenForRegion };
