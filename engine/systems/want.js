/**
 * The keeper's want, kept honest.
 *
 * Three things happen here.
 *
 *   1. The world is read. Harmony, prosperity and legacy are *measured* from
 *      the state the engine already keeps — mutual bonds, feud stages, lonely
 *      minds, wall progress, unrepaid favours, enacted laws, roles, chronicle
 *      days — so a meter can never drift away from what is actually true about
 *      the world.
 *
 *   2. The meters follow that reading. Slowly, at a bounded rate per tick, so
 *      a change is visible as a movement rather than a jump, and so a keeper
 *      acting on a bad reading has time to see it work.
 *
 *   3. Silence tells. Every ask — a petition, a whisper, a dilemma — is
 *      recorded, and a world that has stopped asking starts losing harmony.
 *      Kept up long enough, the world falls quiet, which is the one way the
 *      keeper can lose the game they are playing.
 *
 * Nothing here draws from the RNG and nothing here reads a clock: the same
 * world plus the same keeper acts produce the same meters, forever.
 */

import { clamp } from "../config.js";
import { logEvent } from "../model/events.js";
import { livingAgents } from "../model/world.js";
import { feudStage } from "../model/relationships.js";
import {
  WANT_METERS,
  createWant,
  lastKeeperMovement,
  meterWord,
  recordWantMovement,
  wantValues
} from "../model/want.js";

/**
 * @typedef {import("../model/world.js").World} World
 * @typedef {import("../model/want.js").Want} Want
 */

/**
 * The world's actual condition, in three numbers.
 *
 * Every term is a fact the engine already tracks; the weights are in config so
 * they can be argued with. `terms` is returned alongside the meters because a
 * reading nobody can explain is a reading nobody can act on — the panel shows
 * these as "because of: 3 bonds, 1 vendetta, 2 lonely".
 *
 * @param {World} world
 * @returns {{harmony: number, prosperity: number, legacy: number, terms: Record<string, any>}}
 */
export function wantReading(world) {
  const cfg = world.config.want;
  const tick = world.clock.tick;
  const living = livingAgents(world);
  const byId = new Map(living.map(a => [a.id, a]));

  /* ---- harmony: bonds, feuds, loneliness ---- */
  let bonds = 0;
  let rivalries = 0;
  let vendettas = 0;
  const seen = new Set();
  for (const agent of living) {
    for (const [otherId, edge] of Object.entries(agent.relations)) {
      const other = byId.get(otherId);
      if (!other) continue;
      const key = agent.id < otherId ? agent.id + "|" + otherId : otherId + "|" + agent.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const back = other.relations[agent.id];
      if (edge.affinity >= cfg.bondThreshold && (back?.affinity ?? 0) >= cfg.bondThreshold) bonds += 1;
      const stage = feudStage(edge, back, world.config);
      if (stage === "vendetta") vendettas += 1;
      else if (stage === "rivalry") rivalries += 1;
    }
  }
  const lonely = living.filter(a => a.needs.connection < cfg.lonelyThreshold).length;
  const quiet = quietState(world);
  const harmony = clamp(
    cfg.harmonyBase
      + bonds * cfg.harmonyPerBond
      - rivalries * cfg.harmonyPerRivalry
      - vendettas * cfg.harmonyPerVendetta
      - lonely * cfg.harmonyPerLonely
      - quiet.penalty,
    0,
    100
  );

  /* ---- prosperity: the shared work ---- */
  const project = world.project;
  const wall = project ? project.progress : 0;
  const hands = project
    ? Object.values(project.contributors).filter(record => record.work > 0 || record.help > 0).length
    : 0;
  const favours = world.events.filter(e => e.kind === "favour" && tick - e.tick <= cfg.favourWindowTicks).length;
  const interference = project
    ? Object.values(project.contributors).filter(record => tick - (record.lastInterferenceTick ?? -9999) <= cfg.interferenceWindowTicks).length
    : 0;
  const owed = living.reduce(
    (sum, agent) => sum + Object.values(agent.relations).reduce((s, edge) => s + Math.max(0, edge?.debts ?? 0), 0),
    0
  );
  const prosperity = clamp(
    cfg.prosperityBase
      + wall * cfg.prosperityPerWallPoint
      + Math.min(hands, 6) * cfg.prosperityPerHand
      + Math.min(favours, 5) * cfg.prosperityPerFavour
      - interference * cfg.prosperityPerInterference
      - owed * cfg.prosperityPerDebtPoint,
    0,
    100
  );

  /* ---- legacy: what endures ---- */
  const charter = world.charter;
  const rules = Object.values(charter?.active || {}).reduce((sum, n) => sum + n, 0);
  const roles = (charter?.roles || []).filter(role => byId.has(role.holderId)).length;
  const brokenRoles = (charter?.roles || []).filter(role => !byId.has(role.holderId)).length;
  const precedents = charter?.precedents.length ?? 0;
  const legacy = clamp(
    cfg.legacyBase
      + Math.min(rules * cfg.legacyPerRule, cfg.legacyRuleCap)
      + Math.min(roles * cfg.legacyPerRole, cfg.legacyRoleCap)
      - brokenRoles * cfg.legacyPerBrokenRole
      + Math.min(precedents, 10) * cfg.legacyPerPrecedent
      + Math.min(world.chronicle.length, 30) * cfg.legacyPerDay
      + (project && project.status === "complete" ? cfg.legacyForWallRaised : 0),
    0,
    100
  );

  return {
    harmony,
    prosperity,
    legacy,
    terms: { bonds, rivalries, vendettas, lonely, wall, hands, favours, interference, owed, rules, roles, precedents, quiet }
  };
}

/**
 * How long the world has been silent, and what that costs.
 * @param {World} world
 */
export function quietState(world) {
  const cfg = world.config.want;
  const want = world.want;
  const tick = world.clock.tick;
  const since = Math.max(0, tick - (want?.lastAskTick ?? 0));
  const over = Math.max(0, since - cfg.quietAfterTicks);
  return {
    since,
    over,
    draining: over > 0,
    penalty: Math.min(cfg.quietMaxPenalty, over * cfg.quietDecayPerTick)
  };
}

/**
 * Note that the world has asked the keeper for something. Called wherever a
 * petition, whisper or dilemma is recorded — an ask that arrives while the
 * world is fallen is the one thing that can bring it back.
 * @param {World} world
 * @param {string} [what]
 */
export function noteAsk(world, what = "something") {
  const want = world.want;
  if (!want) return null;
  const tick = world.clock.tick;
  want.lastAskTick = tick;
  want.quietTicks = 0;
  want.quietLoggedAt = 0;
  want.asks += 1;
  if (want.fallen) {
    want.fallen = false;
    want.revivals += 1;
    logEvent(world, {
      kind: "want",
      agentId: null,
      text: `The world asks again. ${what[0].toUpperCase() + what.slice(1)} reaches the keeper, and something that had gone still starts moving.`,
      significance: 0.72
    });
    return { revived: true };
  }
  return { revived: false };
}

/**
 * Move the meters, and write down why. This is the single choke point through
 * which every keeper act and every world event touches the keeper's own score,
 * so no movement can happen without a cause attached to it.
 *
 * @param {World} world
 * @param {Partial<Record<"harmony"|"prosperity"|"legacy", number>>} deltas
 * @param {string} cause
 * @param {"keeper"|"world"|"drift"} [by]
 * @returns {{tick: number, cause: string, by: string, deltas: Record<string, number>, values: Record<string, number>}|null}
 */
export function shiftWant(world, deltas, cause, by = "keeper") {
  const want = world.want;
  if (!want || !world.config.want.enabled) return null;
  /** @type {Record<string, number>} */
  const applied = {};
  for (const meter of WANT_METERS) {
    const delta = Number(deltas[meter]) || 0;
    if (!delta) continue;
    const before = want[meter];
    want[meter] = clamp(before + delta, 0, 100);
    const real = want[meter] - before;
    if (Math.abs(real) >= 0.05) applied[meter] = round2(real);
  }
  if (!Object.keys(applied).length) return null;
  return recordWantMovement(want, {
    tick: world.clock.tick,
    cause,
    by,
    deltas: applied,
    values: wantValues(want)
  });
}

/**
 * A keeper act, in the keeper's ledger. The byline is the act itself, so the
 * panel can say "you enacted Debts are honoured" rather than "value changed".
 * @param {World} world
 * @param {string} cause
 * @param {Partial<Record<"harmony"|"prosperity"|"legacy", number>>} deltas
 */
export function keeperAct(world, cause, deltas) {
  return shiftWant(world, deltas, cause, "keeper");
}

/**
 * Run once per tick, after everything else has happened.
 *
 * Reads the world, walks the meters a step toward that reading, batches the
 * drift into the ledger, and — if nothing has asked the keeper for anything in
 * too long — tells them so, then starts taking harmony apart.
 *
 * @param {World} world
 */
export function settleWant(world) {
  const cfg = world.config.want;
  const want = world.want;
  if (!want || !cfg.enabled) return;

  const tick = world.clock.tick;
  want.tick = tick;

  const quiet = quietState(world);
  want.quietTicks = quiet.since;

  const reading = wantReading(world);
  for (const meter of WANT_METERS) {
    const before = want[meter];
    const target = reading[meter];
    const step = cfg.driftPerTick;
    want[meter] = clamp(
      before < target ? Math.min(target, before + step) : Math.max(target, before - step),
      0,
      100
    );
    const moved = want[meter] - before;
    if (Math.abs(moved) >= 0.0001) want.drift[meter] = (want.drift[meter] || 0) + moved;
  }

  // Drift is recorded in batches: a line per meter per tick would bury the acts
  // that actually moved something.
  if (tick - (want.driftLoggedAt ?? 0) >= cfg.driftLogIntervalTicks) {
    want.driftLoggedAt = tick;
    /** @type {Record<string, number>} */
    const batched = {};
    for (const meter of WANT_METERS) {
      const moved = want.drift[meter] || 0;
      if (Math.abs(moved) >= 0.5) batched[meter] = round2(moved);
      want.drift[meter] = 0;
    }
    if (Object.keys(batched).length) {
      recordWantMovement(want, {
        tick,
        cause: "the world's own condition",
        by: "drift",
        deltas: batched,
        values: wantValues(want)
      });
    }
  }

  // Silence, said out loud. The world says it in its own record, at a steady
  // interval, so a keeper who comes back after a week can see exactly when the
  // quiet started rather than only that it did.
  if (quiet.draining && tick - (want.quietLoggedAt ?? 0) >= cfg.quietLogIntervalTicks) {
    want.quietLoggedAt = tick;
    const days = Math.floor(quiet.since / 48);
    logEvent(world, {
      kind: "want",
      agentId: null,
      text:
        `Nothing has asked the keeper for anything in ${days} day${days === 1 ? "" : "s"}. ` +
        `The world is getting used to deciding things without them, and harmony is draining.`,
      significance: 0.6
    });
  }

  // The lose condition. Not a reset — the world is still there — but the thing
  // the keeper was keeping has gone quiet, and it stays that way until the
  // world finds a reason to ask again.
  if (!want.fallen && want.harmony <= 1 && quiet.over > cfg.fallenGraceTicks) {
    want.fallen = true;
    want.fallenTick = tick;
    logEvent(world, {
      kind: "want",
      agentId: null,
      text:
        "The world has gone quiet. Nobody petitions, nobody whispers, nobody brings the keeper a dilemma — " +
        "and the harmony that held the place together is spent. It will take an ask to bring it back.",
      significance: 0.95
    });
  }
}

/**
 * A compact reading for the screen and for tests: three meters with their
 * words, the last act that moved each, and whether the world is going quiet.
 * @param {World} world
 * @returns {{meters: {key: string, value: number, word: string, delta: number, cause: string|null, by: string|null, tick: number, drift: number}[], quiet: ReturnType<typeof quietState>, fallen: boolean, asks: number, ignored: number, terms: Record<string, any>}}
 */
export function wantSummary(world) {
  const want = world.want || createWant();
  const reading = wantReading(world);
  const quiet = quietState(world);
  const meters = WANT_METERS.map(key => {
    const last = lastKeeperMovement(want, key);
    return {
      key,
      value: round1(want[key]),
      word: meterWord(key, want[key]),
      // The last act that moved this meter, and where the world is currently
      // taking it on its own. Both are shown; neither is guessed at.
      delta: last ? round2(last.deltas[key] || 0) : 0,
      cause: last ? last.cause : null,
      by: last ? last.by : null,
      tick: last ? last.tick : -1,
      drift: round2(want.drift[key] || 0)
    };
  });
  return {
    meters,
    quiet,
    fallen: Boolean(want.fallen),
    asks: want.asks || 0,
    ignored: want.ignored || 0,
    terms: reading.terms
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
/** @param {number} n */
function round1(n) {
  return Math.round(n * 10) / 10;
}
