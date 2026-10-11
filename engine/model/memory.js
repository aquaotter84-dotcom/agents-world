/**
 * Memory: what a mind carries forward.
 *
 * This is the module that separates a simulation from a prompt loop. Without it
 * every tick is a first impression — a mind can't hold a grudge, can't be
 * haunted by something it did, can't recognise a kindness three days later.
 *
 * Traces are not chat logs. Each one stores a *gist*, a valence (was this good
 * or bad for me), and a salience (how much it still matters). Salience decays;
 * when a mind runs out of room, low-salience traces are folded into summaries so
 * that "a quiet stretch of days" survives even when the individual days don't.
 */

import { clamp } from "../config.js";

/**
 * @typedef {object} Trace
 * @property {string} id
 * @property {number} tick
 * @property {string} kind         act | contact | conflict | confide | gossip | secret | goal | triumph | observation | summary | betrayal
 * @property {string} text         The memory as the mind holds it, first person where it matters.
 * @property {string|null} subjectId  Who the memory is chiefly about.
 * @property {number} valence      -1 (wounding) .. 1 (warming)
 * @property {number} salience     0..1, how strongly it persists.
 * @property {string} [secretId]   Set when the memory concerns a held secret.
 * @property {boolean} [consolidated]
 * @property {number} [summaryCount]
 */

/**
 * @typedef {object} Memory
 * @property {Trace[]} traces
 */

/**
 * Room left below the capacity for the traces a single tick will add after
 * consolidation has run.
 */
const HEADROOM = 12;

/** @returns {Memory} */
export function createMemory() {
  return { traces: [] };
}

/**
 * Record a new trace.
 * @param {Memory} memory
 * @param {Omit<Trace, "id"> & { id?: string }} trace
 * @param {(prefix: string) => string} makeId
 * @returns {Trace}
 */
export function remember(memory, trace, makeId) {
  // Spread the caller's trace first, then normalise: the other order lets an
  // out-of-range value from the caller win and the clamp becomes decorative.
  const full = /** @type {Trace} */ (Object.assign(
    {},
    trace,
    {
      id: trace.id || makeId("t"),
      salience: clamp(trace.salience ?? 0.5, 0, 1),
      valence: clamp(trace.valence ?? 0, -1, 1)
    }
  ));
  memory.traces.push(full);
  return full;
}

/**
 * Score how retrievable a trace is right now.
 *
 * Recency uses exponential decay against a half-life, relevance rewards traces
 * about whoever the mind is currently thinking about, and secrets cling harder
 * than ordinary memories — which is exactly how secrets behave in life.
 *
 * @param {Trace} trace
 * @param {object} opts
 * @param {number} opts.tick
 * @param {string|null} [opts.aboutId]
 * @param {number} opts.halfLifeTicks
 * @param {number} opts.relevanceBonus
 * @param {number} opts.secretBonus
 */
export function scoreTrace(trace, opts) {
  const age = Math.max(0, opts.tick - trace.tick);
  const recency = Math.pow(0.5, age / Math.max(1, opts.halfLifeTicks));
  const relevance = opts.aboutId && trace.subjectId === opts.aboutId ? opts.relevanceBonus : 1;
  const secret = trace.secretId ? opts.secretBonus : 1;
  return trace.salience * recency * relevance * secret;
}

/**
 * Retrieve the traces most on a mind's mind.
 * @param {Memory} memory
 * @param {object} opts
 * @param {number} opts.tick
 * @param {string|null} [opts.aboutId]  Focus on memories about one other mind.
 * @param {string[]} [opts.kinds]       Restrict to certain kinds of memory.
 * @param {number} [opts.limit]
 * @param {import("../config.js").WorldConfig} opts.config
 * @param {import("../rng.js").Rng} [opts.rng]   Adds a little fuzz, because recall isn't a database query.
 * @returns {Trace[]}
 */
export function recall(memory, opts) {
  const cfg = opts.config.memory;
  const limit = opts.limit ?? cfg.recall.defaultLimit;
  const rng = opts.rng;

  const scored = [];
  for (const trace of memory.traces) {
    if (opts.kinds && !opts.kinds.includes(trace.kind)) continue;
    if (opts.aboutId === undefined ? false : opts.aboutId && trace.subjectId !== opts.aboutId) continue;
    let score = scoreTrace(trace, {
      tick: opts.tick,
      aboutId: opts.aboutId ?? null,
      halfLifeTicks: cfg.recall.halfLifeTicks,
      relevanceBonus: cfg.recall.relevanceBonus,
      secretBonus: cfg.recall.secretBonus
    });
    if (rng) score *= 0.85 + rng.float() * 0.3;
    scored.push({ trace, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.trace);
}

/**
 * The most recent traces, newest first.
 * @param {import("./memory.js").Memory} memory
 * @param {number} n
 */
export function recentTraces(memory, n) {
  return memory.traces.slice(-n).reverse();
}

/**
 * How a mind feels about someone overall, from accumulated memory rather than
 * from the relationship record. The two can disagree — that gap is interesting,
 * and the decision layer reads both.
 * @param {Memory} memory
 * @param {string} subjectId
 * @param {number} tick
 * @param {import("../config.js").WorldConfig} config
 * @returns {{ valence: number, weight: number }}
 */
export function feelingsAbout(memory, subjectId, tick, config) {
  let sum = 0;
  let weight = 0;
  for (const trace of memory.traces) {
    if (trace.subjectId !== subjectId) continue;
    const w = scoreTrace(trace, {
      tick,
      aboutId: subjectId,
      halfLifeTicks: config.memory.recall.halfLifeTicks,
      relevanceBonus: config.memory.recall.relevanceBonus,
      secretBonus: config.memory.recall.secretBonus
    });
    sum += trace.valence * w;
    weight += w;
  }
  if (weight === 0) return { valence: 0, weight: 0 };
  return { valence: clamp(sum / weight, -1, 1), weight };
}

/**
 * Let salience fade, then fold the overflow into summaries.
 *
 * Consolidation works per-subject so that a summary preserves *who* a stretch of
 * time was about: "Many quiet days spent avoiding Cass" is a usable memory in a
 * way that a generic blur of events is not.
 *
 * @param {Memory} memory
 * @param {object} opts
 * @param {number} opts.tick
 * @param {import("../config.js").WorldConfig} opts.config
 * @param {(prefix: string) => string} opts.makeId
 * @param {number} [opts.capacity]
 */
export function decayAndConsolidate(memory, opts) {
  const cfg = opts.config.memory;
  const capacity = opts.capacity ?? cfg.capacity;

  for (const trace of memory.traces) {
    trace.salience = clamp(trace.salience * cfg.salienceDecayPerTick, 0, 1);
  }

  // Compact down to slightly below capacity rather than exactly to it. A tick
  // adds traces after this runs, so targeting the capacity itself guarantees
  // drifting just past it every tick, and "bounded by the cap" stops being true.
  const target = Math.max(1, capacity - HEADROOM);
  const excess = memory.traces.length - target;
  if (excess <= 0) return { consolidated: 0, forgotten: 0 };

  const byAge = memory.traces.slice().sort((a, b) => a.tick - b.tick);
  const batchSize = Math.max(excess, Math.min(cfg.consolidationBatch, byAge.length - 1));
  const batch = byAge.slice(0, batchSize);
  const batchIds = new Set(batch.map(t => t.id));
  const kept = memory.traces.filter(t => !batchIds.has(t.id));

  /** @type {Map<string, Trace[]>} */
  const groups = new Map();
  for (const trace of batch) {
    const key = trace.subjectId || `kind:${trace.kind}`;
    const list = groups.get(key);
    if (list) list.push(trace);
    else groups.set(key, [trace]);
  }

  let forgotten = 0;
  let consolidated = 0;
  for (const [key, traces] of groups) {
    const peak = Math.max(...traces.map(t => t.salience));
    // Nothing worth keeping: let it go entirely.
    if (peak < cfg.forgetBelow && traces.length <= 2) {
      forgotten += traces.length;
      continue;
    }
    const newest = traces.reduce((a, b) => (a.tick > b.tick ? a : b));
    const meanValence = traces.reduce((s, t) => s + t.valence, 0) / traces.length;
    const subjectId = key.startsWith("kind:") ? null : key;
    kept.push({
      id: opts.makeId("t"),
      tick: newest.tick,
      kind: "summary",
      text: summarizeTraces(traces, subjectId),
      subjectId,
      valence: clamp(meanValence, -1, 1),
      // A summary keeps the gist but loses the force of the original moments.
      salience: clamp(peak * 0.62, 0, 1),
      consolidated: true,
      summaryCount: traces.reduce((s, t) => s + (t.summaryCount || 1), 0)
    });
    consolidated += traces.length;
  }

  kept.sort((a, b) => a.tick - b.tick);
  memory.traces = kept;
  return { consolidated, forgotten };
}

/**
 * Turn a pile of old traces into one sentence a mind could actually recall.
 * @param {Trace[]} traces
 * @param {string|null} subjectId
 */
function summarizeTraces(traces, subjectId) {
  const mean = traces.reduce((s, t) => s + t.valence, 0) / traces.length;
  const span = traces.length;
  const who = subjectId ? "them" : "the world";
  if (mean > 0.25) return `A good stretch with ${who} — ${span} small moments that added up to something warm.`;
  if (mean < -0.25) return `A hard stretch with ${who} — ${span} moments that are still hard to think about.`;
  return `A long, even stretch with ${who}. ${span} moments, none of them decisive.`;
}

/**
 * Rough memory statistics, for the UI and for tests.
 * @param {import("./memory.js").Memory} memory
 */
export function memoryStats(memory) {
  let strongest = null;
  for (const t of memory.traces) {
    if (!strongest || t.salience > strongest.salience) strongest = t;
  }
  return {
    count: memory.traces.length,
    summaries: memory.traces.filter(t => t.consolidated).length,
    strongestSalience: strongest ? strongest.salience : 0
  };
}
