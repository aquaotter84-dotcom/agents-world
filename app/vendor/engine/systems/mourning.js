/**
 * Death matters.
 *
 * When a mind leaves the story the world is not allowed to move on quietly.
 * This system makes three things happen, all of them visible and all of them
 * consequences rather than prose:
 *
 *   1. A funeral the world attends. News of a death calls a gathering a little
 *      later, at the place the mind lived. The minds who knew them best — and
 *      the neighbours — actually move there for it. It is drawn on the board
 *      and it enters the day's chronicle, and standing at a grave is company
 *      and grief both.
 *
 *   2. Inherited grudges. A real quarrel does not die with the person holding
 *      it: the mind closest to them takes it up, with real resentment written
 *      into the feud system, so the feud the dead had is still there after
 *      them, wearing someone else's face. A mind nobody loved takes their
 *      quarrels with them — which is its own kind of ending.
 *
 *   3. A mourning chronicle. Every mind lost gets one memorial entry: what
 *      they did here, who stood at the grave, what passed on. The legacy meter
 *      reads the graves, so what the world buries is part of what endures.
 *
 * Nothing here is random beyond the decisions already made elsewhere in the
 * tick, and nothing here speaks with a model's voice: a death is the engine's
 * own ceremony.
 */

import { logEvent } from "../model/events.js";
import { feudStage } from "../model/relationships.js";
import { agentById, livingAgents, regionName } from "../model/world.js";
import { funeralFor, recordFuneral, recordMemorial } from "../model/mourning.js";
import { shiftWant } from "./want.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/agent.js").Agent} Agent
 * @typedef {import("../model/mourning.js").Funeral} Funeral
 * @typedef {import("../model/mourning.js").Memorial} Memorial
 */

/** "a, b and c" — a list the way a person would say it. @param {string[]} names */
function nameList(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/**
 * What a mind leaves behind, in one line: the roles the world gave them, the
 * work they put into the wall, the person they became. Read off the same state
 * everything else reads, so a memorial cannot flatter anyone.
 * @param {World} world
 * @param {Agent} agent
 */
export function deedsOf(world, agent) {
  const roles = (world.charter?.roles || []).filter(role => role.holderId === agent.id).map(role => role.name);
  const wall = world.project?.contributors?.[agent.id];
  const parts = [];
  if (roles.length) parts.push(`the world's ${nameList(roles)}`);
  if (wall && (wall.work || wall.help)) parts.push(`laid ${Math.round(wall.work + wall.help)} into the North Wall`);
  if (agent.level) parts.push(`reached level ${agent.level}`);
  return parts.length ? parts.join(", ") : "was here quietly";
}

/**
 * How close a living mind stood to the dead, from their own side of the tie.
 * Bonds pull a mind to the grave; a real grudge keeps it away.
 * @param {Agent} agent
 * @param {Funeral} funeral
 */
function closenessTo(agent, funeral) {
  const edge = agent.relations[funeral.agentId];
  let score = 0;
  if (edge) {
    score += (edge.affinity || 0) * 0.6 + (edge.familiarity || 0) * 0.4 + (edge.trust || 0) * 0.3;
    score -= Math.max(0, edge.resentment || 0) * 0.6;
  }
  if (agent.regionId === funeral.regionId) score += 12;
  return score;
}

/**
 * News of a death, and the gathering it calls. The funeral is not held at once:
 * a world needs a little time to hear, and the keeper needs to be able to see it
 * coming on the board.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Funeral|null}
 */
export function callFuneral(world, agent) {
  const mourning = world.mourning;
  if (!mourning || !world.config.mourning.enabled) return null;
  if (funeralFor(mourning, agent.id)) return null;
  const cfg = world.config.mourning;
  const tick = world.clock.tick;
  /** @type {Funeral} */
  const funeral = {
    id: world.nextId("fun"),
    agentId: agent.id,
    name: agent.name,
    epithet: agent.epithet || "",
    className: agent.class,
    level: agent.level,
    regionId: agent.regionId,
    calledTick: tick,
    holdTick: tick + cfg.callDelayTicks,
    held: false,
    mourners: [],
    heirs: [],
    inherited: [],
    deeds: deedsOf(world, agent)
  };
  recordFuneral(mourning, funeral);
  logEvent(world, {
    kind: "mourning",
    agentId: agent.id,
    text: `${agent.name} is dead. Word goes round the world, and the gathering is called at ${regionName(world, agent.regionId)}.`,
    significance: 0.62,
    regionId: agent.regionId
  });
  return funeral;
}

/**
 * A mind that walked out of the story without dying — the world still keeps
 * their name, and the record still says what they did here.
 * @param {World} world
 * @param {Agent} agent
 * @returns {Memorial|null}
 */
export function mournDeparture(world, agent) {
  const mourning = world.mourning;
  if (!mourning || !world.config.mourning.enabled) return null;
  const tick = world.clock.tick;
  const region = regionName(world, agent.regionId);
  /** @type {Memorial} */
  const memorial = {
    id: world.nextId("mem"),
    agentId: agent.id,
    name: agent.name,
    epithet: agent.epithet || "",
    kind: "departure",
    regionId: agent.regionId,
    tick,
    day: world.clock.day,
    mourners: [],
    heirs: [],
    inherited: [],
    text: `${agent.name} left ${region} on day ${world.clock.day} and did not say where they were going.`,
    deeds: deedsOf(world, agent)
  };
  recordMemorial(mourning, memorial);
  logEvent(world, {
    kind: "mourning",
    agentId: agent.id,
    text: memorial.text + ` They ${memorial.deeds}.`,
    significance: 0.55,
    regionId: agent.regionId
  });
  shiftWant(world, world.config.want.acts.departure, `${agent.name} left the map, and the world keeps their name`, "world");
  return memorial;
}

/**
 * Run once per tick. Holds whatever gathering the world has had time to hear
 * about; the rest live on as pending marks on the board.
 * @param {World} world
 */
export function settleMourning(world) {
  const mourning = world.mourning;
  if (!mourning || !world.config.mourning.enabled) return;
  const tick = world.clock.tick;
  for (const funeral of mourning.funerals) {
    if (funeral.held || tick < funeral.holdTick) continue;
    holdFuneral(world, funeral, tick);
  }
}

/**
 * The gathering itself: who comes, what moves between them, what is passed on.
 * @param {World} world
 * @param {Funeral} funeral
 * @param {number} tick
 */
function holdFuneral(world, funeral, tick) {
  const cfg = world.config.mourning;
  const region = regionName(world, funeral.regionId);
  const ranked = livingAgents(world)
    .map(agent => ({ agent, closeness: closenessTo(agent, funeral) }))
    .sort((x, y) => y.closeness - x.closeness || (x.agent.id < y.agent.id ? -1 : 1));

  // The world attends: everyone above the line, up to the cap — and when
  // nobody stood close, the nearest few still come. A funeral with no one at
  // it is a thing this world does not do.
  const chosen = /** @type {{agent: Agent, closeness: number}[]} */ ([]);
  for (const entry of ranked) {
    if (chosen.length >= cfg.maxMourners) break;
    if (entry.closeness >= cfg.attendThreshold) chosen.push(entry);
  }
  for (const entry of ranked.slice(0, cfg.minMourners)) {
    if (chosen.length < cfg.minMourners && !chosen.includes(entry)) chosen.push(entry);
  }
  const mourners = chosen.map(entry => entry.agent);

  // Heirs: the closest real bonds, in the order of how close they stood. In
  // this world kin are the people you love, so that is who inherits what you
  // cannot carry any further.
  const heirs = ranked
    .filter(entry => (entry.agent.relations[funeral.agentId]?.affinity || 0) >= cfg.heirAffinityMin)
    .slice(0, cfg.maxHeirs)
    .map(entry => entry.agent);

  const dead = agentById(world, funeral.agentId);
  const statements = inheritGrudges(world, funeral, dead, heirs);

  const names = mourners.map(agent => agent.name);
  const gatheringLine = names.length
    ? `They gathered at ${region} for ${funeral.name}: ${nameList(names)} stood with the world while the grave was filled.`
    : `They gathered at ${region} for ${funeral.name}, but there was no one left close enough to stand at the grave.`;
  const inheritLine = statements.length
    ? " " + statements.join(" ")
    : "";

  for (const agent of mourners) {
    world.pendingOps = world.pendingOps || [];
    if (agent.regionId !== funeral.regionId) {
      world.pendingOps.push({ op: "move", agent: agent.id, regionId: funeral.regionId });
    }
    // Standing at a grave is company, and it is heavy. Both are real.
    world.pendingOps.push({ op: "need", agent: agent.id, deltas: { connection: cfg.griefConnection, meaning: -2 } });
    world.pendingOps.push({
      op: "mood",
      agent: agent.id,
      value: "grieving",
      durationTicks: cfg.griefTicks,
      reason: `${funeral.name} was buried`
    });
    world.pendingOps.push({
      op: "memory",
      agent: agent.id,
      trace: {
        kind: "observation",
        text: `I stood at ${funeral.name}'s grave at ${region}. The world came, and it felt like a place for a while.`,
        subjectId: funeral.agentId,
        valence: -0.25,
        salience: 0.8
      }
    });
  }

  /** @type {Memorial} */
  const memorial = {
    id: world.nextId("mem"),
    agentId: funeral.agentId,
    name: funeral.name,
    epithet: funeral.epithet,
    kind: "death",
    regionId: funeral.regionId,
    tick,
    day: world.clock.day,
    mourners: mourners.map(agent => agent.id),
    heirs: heirs.map(agent => agent.id),
    inherited: funeral.inherited,
    text:
      `${funeral.name} was buried at ${region} on day ${world.clock.day}` +
      (names.length ? `, with ${nameList(names)} standing by.` : ", with nobody left to stand by.") +
      ` They ${funeral.deeds}.`,
    deeds: funeral.deeds
  };
  recordMemorial(world.mourning, memorial);

  funeral.held = true;
  funeral.heldTick = tick;
  funeral.mourners = memorial.mourners;
  funeral.heirs = memorial.heirs;

  logEvent(world, {
    kind: "mourning",
    agentId: funeral.agentId,
    text: gatheringLine + inheritLine,
    significance: 0.82,
    regionId: funeral.regionId
  });

  // The world standing together at real cost is harmony, and a grave is
  // legacy. The meters are moved through the same choke point as everything
  // else, so the funeral shows up in the keeper's ledger named.
  shiftWant(world, world.config.want.acts.funeral, `the world buried ${funeral.name}`, "world");
}

/**
 * Pass the dead's quarrels to the living.
 *
 * Only real feuds travel — a rivalry or a vendetta the engine already
 * recognises — and only to a mind who loved them enough to carry it. The
 * resentment is written onto the heir's own edge, so the feud system picks it
 * up like any other and the world's history continues through it.
 * @param {World} world
 * @param {Funeral} funeral
 * @param {Agent|null|undefined} dead
 * @param {Agent[]} heirs
 * @returns {string[]} sentences for the record
 */
function inheritGrudges(world, funeral, dead, heirs) {
  const cfg = world.config.mourning;
  /** @type {string[]} */
  const out = [];
  if (!dead) return out;
  const living = livingAgents(world);
  const byId = new Map(living.map(agent => [agent.id, agent]));

  // What the dead held against the living, strongest first. A mind can have
  // picked up more quarrels than anyone should carry on with, so only the
  // deepest `maxInherit` travel; the rest are the ones a death actually ends.
  /** @type {{other: Agent, passed: number}[]} */
  const candidates = [];
  for (const [otherId, edge] of Object.entries(dead.relations)) {
    const other = byId.get(otherId);
    if (!other) continue;
    const stage = feudStage(edge, other.relations?.[dead.id], world.config);
    if (stage !== "rivalry" && stage !== "vendetta") continue;
    const passed = Math.round((edge.resentment || 0) * cfg.inheritFactor);
    if (passed < cfg.inheritMin) continue;
    candidates.push({ other, passed });
  }
  const grudges = candidates.sort((x, y) => y.passed - x.passed).slice(0, cfg.maxInherit);

  if (!grudges.length) return out;
  if (!heirs.length) {
    const worst = grudges[0];
    out.push(`Nobody took up what ${dead.name} had against ${worst.other.name}; it ended at the grave.`);
    return out;
  }

  // Each quarrel goes to one heir — the closest, then the next — so a grudge
  // lands in one pair of hands rather than being copied out to everybody.
  grudges.forEach((grudge, index) => {
    const heir = heirs[index % heirs.length];
    if (heir.id === grudge.other.id) return;
    world.pendingOps = world.pendingOps || [];
    world.pendingOps.push({
      op: "edge",
      from: heir.id,
      to: grudge.other.id,
      deltas: {
        resentment: grudge.passed,
        fear: Math.round(grudge.passed * cfg.inheritFearFactor),
        familiarity: cfg.inheritFamiliarity
      },
      reason: `${heir.name} took up what ${dead.name} had against ${grudge.other.name}`
    });
    // The quarrel is now a fact about two living minds, so the world says so.
    out.push(`${heir.name} took up ${dead.name}'s quarrel with ${grudge.other.name}.`);
    funeral.inherited.push({ heirId: heir.id, aboutId: grudge.other.id });
    world.pendingOps.push({
      op: "memory",
      agent: heir.id,
      trace: {
        kind: "observation",
        text: `${dead.name} is gone and what they had against ${grudge.other.name} is mine now. It does not feel like a choice.`,
        subjectId: grudge.other.id,
        valence: -0.4,
        salience: 0.9
      }
    });
    world.pendingOps.push({
      op: "memory",
      agent: grudge.other.id,
      trace: {
        kind: "observation",
        text: `${dead.name} is dead, and ${heir.name} has taken their side of it. That is not over.`,
        subjectId: heir.id,
        valence: -0.35,
        salience: 0.8
      }
    });
    logEvent(world, {
      kind: "feud",
      agentId: heir.id,
      subjectId: grudge.other.id,
      text: `${heir.name} takes up ${dead.name}'s quarrel with ${grudge.other.name}. A grudge that was buried is standing up in someone else.`,
      significance: 0.7,
      regionId: heir.regionId
    });
  });

  return out;
}
