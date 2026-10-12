/**
 * Phase A evidence: proposals get accepted, not just rejected more gracefully.
 *
 * The old build's Threads view was a wall of ENGINE FALLBACKs — every
 * model-authored proposal refused as "not in the engine's safe action
 * grammar", so the model's voice never landed in the world. The approach
 * grammar (engine/decision/proposals.js) is supposed to end that.
 *
 * These tests run the acceptance audit (tools/proposal-audit.mjs) over a
 * seeded world for ten world days and assert on what actually happens when a
 * model answers the way its prompt asks:
 *
 *   - a model that names an offered approach is accepted the overwhelming
 *     majority of the time — same-tick and with the reply a couple of ticks
 *     late, as it lands in the app;
 *   - the old rejection ("not one of the approaches" / "No approach method
 *     was proposed") never fires for a model that follows the prompt, even
 *     when it answers freehand and the token only survives as a stem;
 *   - a model that proposes the unresolvable is still refused 100% of the
 *     time — the grammar guards — but every refusal now lands in the record
 *     with its reason, and the engine's fallback move keeps the mind acting;
 *   - nothing is refused invisibly: the event stream carries one proposal
 *     verdict per resolved proposal, and every mind's ledger tallies;
 *   - the run is deterministic, so the reported rate is a reproducible fact,
 *     not a fluke of a lucky seed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../engine/model/world.js";
import { step, resolveMoment } from "../engine/simulation.js";
import { runAudit } from "../tools/proposal-audit.mjs";

const SEED = 4711;
const DAYS = 10;

/** Reasons that would mean the model's approach died in the parser/grammar, not in the world. */
const PARSER_REJECT = /not one of the approaches|No approach method was proposed/i;

test("a model that follows the prompt is accepted almost every time", () => {
  const sameTick = runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 0 });
  assert.ok(sameTick.offered >= 40, `expected a real sample of proposals, got ${sameTick.offered}`);
  assert.ok(
    sameTick.acceptRate >= 0.85,
    `the approach grammar should accept a compliant model's proposals; observed ${(sameTick.acceptRate * 100).toFixed(1)}% accepted over ${sameTick.offered}`
  );
  for (const reason of Object.keys(sameTick.rejectReasons)) {
    assert.ok(
      !PARSER_REJECT.test(reason),
      `a model naming an offered approach must not be refused by the parser or the grammar; seen: "${reason}"`
    );
  }
});

test("acceptance survives the reply arriving ticks late, as it does in the app", () => {
  const late = runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 2 });
  assert.ok(late.offered >= 40, "the delayed run must still offer a real sample");
  assert.ok(
    late.acceptRate >= 0.8,
    `a compliant reply that lands two ticks late should still be accepted most of the time; observed ${(late.acceptRate * 100).toFixed(1)}%`
  );
  for (const reason of Object.keys(late.rejectReasons)) {
    assert.ok(
      !PARSER_REJECT.test(reason),
      `a late reply must not be refused by the parser or the grammar; seen: "${reason}"`
    );
  }
});

test("a freehand reply that names the approach in prose still lands", () => {
  const sloppy = runAudit({ seed: SEED, days: DAYS, temperament: "sloppy", latency: 2 });
  assert.ok(sloppy.offered >= 40, "the sloppy run must still offer a real sample");
  assert.ok(
    sloppy.acceptRate >= 0.8,
    `a reply that buries the token in its sentences should still be accepted most of the time; observed ${(sloppy.acceptRate * 100).toFixed(1)}%`
  );
  for (const reason of Object.keys(sloppy.rejectReasons)) {
    assert.ok(
      !PARSER_REJECT.test(reason),
      `the loose parse must rescue a named approach, not throw it away; seen: "${reason}"`
    );
  }
});

test("an unresolvable proposal is still refused — and every refusal is on the record", () => {
  const run = runAudit({ seed: SEED, days: DAYS, temperament: "misbehaving", latency: 2 });
  assert.ok(run.offered >= 40, "the misbehaving run must still offer a real sample");
  assert.equal(run.accepted, 0, "the grammar must not accept a token the world cannot resolve");
  assert.equal(run.rejected, run.offered, "every unresolvable proposal is refused, not silently dropped");
  for (const [reason, n] of Object.entries(run.rejectReasons)) {
    assert.match(reason, /not one of the approaches/, `the refusal must say the token is outside the grammar, got: "${reason}" (${n}×)`);
  }

  // Every verdict the run produced is in the event stream with its reason and
  // whose call it was — the record a Threads view renders.
  assert.equal(run.proposalEvents.length, run.offered, "one proposal event per resolved proposal");
  for (const event of /** @type {any[]} */ (run.proposalEvents)) {
    assert.equal(event.proposal.accepted, false);
    assert.equal(event.proposal.source, "engine");
    assert.ok(event.proposal.reason && event.proposal.reason.length > 0, "the refusal carries its reason");
  }

  // …and the refusal is not an invisible loop: the engine's fallback move
  // still acts, so a refused mind keeps living.
  for (const agent of run.perAgent) {
    if (agent.count === 0) continue;
    assert.equal(agent.accepted, 0);
    assert.equal(agent.rejected, agent.count);
  }
});

test("nothing is refused invisibly, in any scenario", () => {
  const runs = [
    runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 0 }),
    runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 2 }),
    runAudit({ seed: SEED, days: DAYS, temperament: "sloppy", latency: 2 }),
    runAudit({ seed: SEED, days: DAYS, temperament: "misbehaving", latency: 2 })
  ];
  for (const run of runs) {
    assert.equal(run.invisible, 0, `${run.label}: every proposal — accepted or refused — must reach the record with a verdict and a reason`);
    assert.equal(
      run.proposalEvents.length,
      run.accepted + run.rejected + run.expiredBeforeReply,
      `${run.label}: the record must carry exactly one proposal event per resolved proposal`
    );
  }
});

test("the audit is deterministic: the same seed reports the same rate", () => {
  const a = runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 0 });
  const b = runAudit({ seed: SEED, days: DAYS, temperament: "compliant", latency: 0 });
  assert.deepEqual(
    { accepted: a.accepted, rejected: a.rejected, offered: a.offered, methods: a.acceptedMethods, reasons: a.rejectReasons, agents: a.perAgent },
    { accepted: b.accepted, rejected: b.rejected, offered: b.offered, methods: b.acceptedMethods, reasons: b.rejectReasons, agents: b.perAgent },
    "the accept rate must be a reproducible fact of the seed, not a fluke"
  );
  // And a different seed is a different world: the rate moves a little, which
  // is what makes the number an observation rather than a fixture.
  const c = runAudit({ seed: SEED + 1, days: DAYS, temperament: "compliant", latency: 0 });
  assert.ok(c.offered >= 40, "a neighbouring seed still offers a real sample");
  assert.ok(
    Math.abs(c.acceptRate - a.acceptRate) < 0.25,
    "neighbouring seeds should not swing the accept rate wildly"
  );
});

test("an expired proposal is recorded as an expiry, not as a grammar rejection", () => {
  const world = createWorld({ seed: 7 });
  const agent = world.agents[0];
  agent.awake = true;
  agent.retired = false;
  agent.needs.energy = 90;
  agent.goal = { text: "Keep the north wall standing.", kind: "protect", progress: 0.2, since: 0, priority: 1 };
  agent.cognition.enabled = false;
  agent.proposal.nextTick = 0;

  // Offer the proposal and let it wait out the expiry window unanswered.
  const moment = /** @type {any} */ ({
    id: world.nextId("mo"),
    tick: world.clock.tick,
    kind: "goal_approach",
    agentId: agent.id,
    participants: [agent.id],
    significance: 0.62,
    question: "How do they approach it today?",
    context: { availableMethods: ["focus", "study"] },
    options: [],
    resolved: false
  });
  world.pending.push(moment);
  const limit = world.config.moments.maxPendingTicks;
  for (let i = 0; i < limit + 1; i++) step(world);

  assert.equal(moment.resolved, true, "an unanswered proposal must be answered");
  assert.equal(moment.engineResolved, true);
  assert.equal(moment.approachAccepted, false);
  assert.match(
    String(moment.approachValidation),
    /No answer arrived in time/i,
    "the record must say the answer never arrived — not that the grammar refused it"
  );
  assert.equal(agent.proposal.rejectedCount, 1);
  const last = /** @type {any} */ (agent.proposal.last);
  assert.equal(last.source, "engine");
  assert.match(String(last.text), /No answer arrived in time/i);
  const late = resolveMoment(world, moment.id, { method: "focus", approach: "Better late than never." });
  assert.equal(late.ok, false, "a reply that arrives after the engine answered is discarded");
  assert.equal(agent.proposal.count, 1, "…and it must not resolve the beat again");
});
