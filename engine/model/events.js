/**
 * The world's event log — the record of what actually happened.
 *
 * Events are the public history. They differ from memory traces in an important
 * way: an event is *true* (the narrator's account of what occurred), while a
 * memory is what one mind believes, which may be partial, distorted by gossip,
 * or flatly wrong. Keeping them separate is what lets rumours be wrong on
 * purpose.
 */

/**
 * @typedef {object} WorldEvent
 * @property {string} id
 * @property {number} seq
 * @property {number} tick
 * @property {string} kind        act | contact | conflict | confide | gossip | secret | goal | triumph | level | world | death | betrayal | chronicle
 * @property {string|null} agentId
 * @property {string|null} subjectId
 * @property {string} text
 * @property {number} significance  0..1. Higher means it mattered more.
 * @property {string} [regionId]
 * @property {string} [secretId]
 * @property {boolean} [authored]   True when a model wrote the prose rather than the engine.
 */

import { clamp } from "../config.js";

/**
 * Append an event to the world log.
 * @param {import("./world.js").World} world
 * The only fields a caller must supply are the kind of thing that happened and
 * the line describing it — everything else has a sensible default.
 * @param {Pick<WorldEvent, "kind" | "text"> & Partial<Omit<WorldEvent, "id" | "seq" | "tick" | "kind" | "text">> & { tick?: number }} event
 * @returns {WorldEvent}
 */
export function logEvent(world, event) {
  world.seq += 1;
  /** @type {WorldEvent} */
  const full = {
    id: world.nextId("e"),
    seq: world.seq,
    tick: event.tick ?? world.clock.tick,
    kind: event.kind,
    agentId: event.agentId ?? null,
    subjectId: event.subjectId ?? null,
    text: event.text,
    significance: clamp(event.significance ?? 0.3, 0, 1),
    regionId: event.regionId,
    secretId: event.secretId,
    authored: event.authored
  };
  world.events.unshift(full);
  if (world.events.length > world.config.limits.events) {
    world.events.length = world.config.limits.events;
  }
  // The log is a rolling window, so anything wanting the world's whole history
  // needs to count as it happens.
  world.tallies[full.kind] = (world.tallies[full.kind] || 0) + 1;
  return full;
}

/**
 * Most recent events, newest first.
 * @param {import("./world.js").World} world
 * @param {number} n
 */
export function recentEvents(world, n = 8) {
  return world.events.slice(0, n);
}

/**
 * Events the whole world would know about — as opposed to things that happened
 * quietly in a corner. Public knowledge is shared; private moments are not.
 * @param {import("./world.js").World} world
 * @param {number} n
 */
export function publicEvents(world, n = 8) {
  return world.events.filter(e => e.significance >= 0.45).slice(0, n);
}

/**
 * Events involving a particular mind, either as actor or subject.
 * @param {import("../model/world.js").World} world
 * @param {string} agentId
 * @param {number} [n]
 * @returns {import("./world.js").WorldEvent[]}
 */
export function eventsInvolving(world, agentId, n = 6) {
  return world.events.filter(e => e.agentId === agentId || e.subjectId === agentId).slice(0, n);
}
