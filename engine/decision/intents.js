/**
 * Intent generation: the utility system that decides what a mind wants to do.
 *
 * Every tick, each awake mind scores every plausible action against its needs,
 * its temperament, its relationships, its grudges and its memories, then takes
 * the highest. Nothing here is scripted — a mind that has been humiliated will
 * start producing `confront` and `betray` candidates on its own, because its
 * esteem need is low and its resentment is high.
 *
 * The weights below are the *behavioural personality* of the world. They are not
 * in config because they are not world settings — they are the policy itself,
 * and they should be edited with the tests open.
 */

import { clamp } from "../config.js";
import { isNight } from "../clock.js";
import { rivalsOf, edgeToward, fearedOf, adjustEdge, feudStage } from "../model/relationships.js";
import { regionDistance } from "../model/regions.js";
import { recall } from "../model/memory.js";
import { recallingSecretBurden, strongestBurden } from "./burden.js";
import { activeRitual } from "../systems/rituals.js";

/**
 * @typedef {object} Intent
 * @property {string} kind
 * @property {string|null} targetId
 * @property {number} utility      0..100+. Higher wins.
 * @property {boolean} requiresProximity  Whether the act needs both minds in one place.
 * @property {string[]} reasons    Plain-language drivers, shown in prompts and debug output.
 * @property {Record<string, any>} [payload]
 */

/**
 * How strongly each consideration pulls. Kept as a table so the whole policy can
 * be read at a glance rather than reconstructed from scattered magic numbers.
 */
export const WEIGHTS = {
  /** Need pressure — a mind is pushed hardest by whatever it is shortest of. */
  needEnergy: 62,
  needConnection: 46,
  needEsteem: 40,
  needMeaning: 48,

  /** Temperament — how a mind prefers to solve problems. */
  driveSocial: 20,
  driveCourage: 18,
  driveCreativity: 16,
  driveFocus: 14,

  /** Relationships. */
  bondPull: 22,
  rivalryPush: 34,
  fearBrake: 26,
  debtPull: 12,
  /** Generosity — the pull toward doing someone a favour. */
  favourPull: 16,

  /** Situational. */
  nightRest: 14,
  crowdComfort: 9,
  solitudeRelief: 10,

  /** A floor for the fallback action, so nothing ever scores at zero. */
  observeBase: 14
};

/**
 * Score how hard a need is pressing. Returns 0..1 for the ordinary deficit and
 * an extra 0..1 "urgency" that kicks in below the urgent threshold — the
 * difference between wanting a drink and being desperate for one.
 * @param {import("../model/agent.js").Agent} agent
 * @param {string} key
 * @param {import("../config.js").WorldConfig} config
 */
function needPressure(agent, key, config) {
  const value = agent.needs[/** @type {keyof import("../model/agent.js").NeedSet} */ (key)];
  const deficit = clamp((100 - value) / 100, 0, 1);
  const urgentAt = config.needs.urgentThreshold;
  const urgency = value < urgentAt ? (urgentAt - value) / urgentAt : 0;
  return { deficit, urgency, value };
}

/**
 * Generate and rank every action a mind might take right now.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @returns {Intent[]} Sorted best-first.
 */
export function generateIntents(world, agent) {
  const cfg = world.config;
  const tick = world.clock.tick;
  const rng = world.rng;
  const night = isNight(world.clock);
  const here = world.agents.filter(a => a.id !== agent.id && !a.retired && a.regionId === agent.regionId);
  const byId = new Map(world.agents.map(a => [a.id, a]));

  /**
   * Crowding. Beyond a couple of other minds, a place starts to feel full, and
   * a mind with no strong reason to stay drifts outwards.
   *
   * This is the most important term for keeping the map alive. Without it the
   * world has no equilibrium: everyone accumulates at whichever region is best
   * connected, the other five sit empty, and the simulation quietly becomes a
   * story about one room.
   */
  const crowd = Math.max(0, here.length - 2);

  // Calendar weather: when a ritual is active, minds lean with it. Nobody
  // decides a Gathering Night; everybody feels it.
  const ritualBias = activeRitual(world)?.intentBias || null;

  /** @type {Intent[]} */
  const out = [];

  /**
   * @param {string} kind
   * @param {string|null} targetId
   * @param {number} raw
   * @param {string[]} reasons
   * @param {{requiresProximity?: boolean, payload?: Record<string, any>}} [extra]
   */
  const add = (kind, targetId, raw, reasons, extra) => {
    // A little noise stops the world from falling into visible lockstep, where
    // every mind with the same stats does the same thing forever.
    const jitter = rng.gauss(0, 4);
    out.push({
      kind,
      targetId,
      utility: clamp(raw + jitter, 0, 140),
      requiresProximity: extra?.requiresProximity ?? false,
      reasons,
      payload: extra?.payload
    });
  };

  const energy = needPressure(agent, "energy", cfg);
  const connection = needPressure(agent, "connection", cfg);
  const esteem = needPressure(agent, "esteem", cfg);
  const meaning = needPressure(agent, "meaning", cfg);

  /* ---------- Rest ---------- */
  {
    const reasons = [];
    let score = WEIGHTS.needEnergy * Math.pow(energy.deficit, 0.75);
    if (energy.value < 40) reasons.push("running out of energy");
    if (night) {
      score += WEIGHTS.nightRest;
      reasons.push("it is night");
    }
    if (energy.urgency > 0) {
      score += 45 * energy.urgency;
      reasons.push("too tired to keep going");
    }
    add("rest", null, score, reasons.length ? reasons : ["nothing urgent"], {});
  }

  /* ---------- Seek company ---------- */
  {
    // Spending time with someone is about who is *here*. Walking across the map
    // to find a particular person is a much rarer decision, and without that
    // distinction every mind eventually migrates to whoever is most popular and
    // the whole world ends up standing in one room.
    const hasCompanyHere = here.length > 0;
    if (hasCompanyHere) {
      // Prefer somebody this mind has not just been with. In a room of six, the
      // difference between "talk to my favourite" and "talk to somebody I have
      // not seen all day" is the difference between one pair filling the record
      // and the whole room having a life.
      const rested = here.filter(o => tick - (edgeToward(agent, o.id).lastContactTick ?? -9999) >= cfg.social.pairCooldownTicks);
      const preferred = pickCompanion(world, agent, rested.length ? rested : here, byId);
      if (preferred) {
        const edge = edgeToward(agent, preferred.id);
        const reasons = [];
        let score = WEIGHTS.needConnection * connection.deficit + WEIGHTS.driveSocial * (agent.drives.social / 100);
        score += WEIGHTS.crowdComfort;
        // A crowded room satisfies less than it looks like it will.
        score -= crowd * 6;
        if (connection.value < 40) reasons.push("lonely");
        if (edge.affinity > cfg.relations.allianceThreshold) {
          score += WEIGHTS.bondPull;
          reasons.push(`${preferred.name} is a friend`);
        }
        if (edge.resentment > 20) {
          score -= edge.resentment * 0.35;
          reasons.push(`things are awkward with ${preferred.name}`);
        }
        // You do not have a deep conversation with the same person every half
        // hour. The same pair cooldown that keeps gossip from filling the record
        // applies here: two minds who were just together leave each other, and
        // the day, alone for a while. Without it they lock into one unbroken
        // exchange and nothing else in the world happens to either of them.
        const sinceTogether = tick - (edge.lastContactTick ?? -9999);
        if (sinceTogether < cfg.social.pairCooldownTicks) {
          score -= 40;
          reasons.push(`just spoke with ${preferred.name}`);
        }
        if (connection.urgency > 0) {
          score += 28 * connection.urgency;
          reasons.push("desperate for company");
        }
        // A withdrawn mind avoids crowds even when lonely.
        score -= WEIGHTS.fearBrake * (fearedOf(agent).length > 0 ? 0.4 : 0);
        if (ritualBias === "seek_company") {
          score += 10;
          reasons.push("it is Gathering Night");
        }
        add("seek_company", preferred.id, score, reasons, { requiresProximity: true });
      }
    } else if (connection.value < 50) {
      // Nobody here and it is starting to matter: is there someone worth the walk?
      const candidates = distantContacts(world, agent, byId);
      if (candidates.length) {
        const best = candidates[0];
        const distance = regionDistance(world, agent.regionId, best.agent.regionId);
        if (Number.isFinite(distance) && distance > 0) {
          const reach = 1 / (1 + (distance - 1) * 0.55);
          const reasons = [];
          let base = WEIGHTS.needConnection * connection.deficit + WEIGHTS.driveSocial * (agent.drives.social / 100);
          if (best.edge.affinity > cfg.relations.allianceThreshold) {
            base += WEIGHTS.bondPull;
            reasons.push(`wants to be near ${best.agent.name}`);
          } else {
            reasons.push(`hoping to find ${best.agent.name}`);
          }
          if (connection.urgency > 0) {
            base += 26 * connection.urgency;
            reasons.push("cannot stand being alone much longer");
          }
          add("seek_company", best.agent.id, base * reach, reasons, { requiresProximity: true });
        }
      }
    }
  }

  /* ---------- Confide a secret ---------- */
  {
    const secrets = recallingSecretBurden(world, agent).filter(
      // A secret that was just told needs time to become a burden again.
      b => tick - (b.secret.lastSpreadTick ?? -9999) >= cfg.social.confideCooldownTicks
    );
    const settled = tick - (agent.lastConfideTick ?? -9999) >= cfg.social.confideIntervalTicks;
    if (secrets.length && settled) {
      // Only minds we genuinely trust are even candidates.
      const trusted = here.filter(o => edgeToward(agent, o.id).trust >= cfg.social.confideTrustFloor);
      if (trusted.length) {
        const target = trusted.sort((a, b) => edgeToward(agent, b.id).trust - edgeToward(agent, a.id).trust)[0];
        const burden = strongestBurden(secrets);
        const reasons = [];
        let score = WEIGHTS.needConnection * connection.deficit * 0.55;
        score += 20 * burden.weight;
        if (burden.secret.holders && Object.keys(burden.secret.holders).length === 1) {
          score += 9;
          reasons.push("carrying it alone");
        }
        if (agent.drives.courage > 60) score += 6;
        reasons.push(`${target.name} is someone they trust`);
        if (connection.value < 35) reasons.push("needs to not be alone with this");
        add("confide", target.id, score, reasons, {
          requiresProximity: true,
          payload: { secretId: burden.secret.id }
        });
      }
    }
  }

  /* ---------- Gossip ---------- */
  {
    const target = here.length ? nearestAcquaintance(agent, here, byId) : null;
    if (target) {
      const edge = edgeToward(agent, target.id);

      // Two currencies of gossip. A secret is the potent one. But most talk is
      // simply what a mind thinks about somebody who isn't in the room — and if
      // only secret-holders could gossip, the world would fall almost silent.
      const gossipable = world.secrets.filter(
        s =>
          s.holders[agent.id] !== undefined &&
          s.originatorId !== agent.id &&
          !s.isPublic &&
          s.holders[target.id] === undefined &&
          tick - (s.lastSpreadTick ?? -9999) >= cfg.social.gossipCooldownTicks
      );
      const opinions = recall(agent.memory, {
        tick,
        kinds: ["contact", "conflict", "act"],
        limit: 8,
        config: cfg
      }).filter(
        t =>
          t.subjectId &&
          t.subjectId !== target.id &&
          t.subjectId !== agent.id &&
          t.salience > 0.3 &&
          tick - t.tick <= 30
      );

      const talk = cfg.social.talkScoring;
      // Two minds who spoke an hour ago do not need to speak again. Without
      // this, the pair with the deepest familiarity set the tone of the whole
      // record: every tick, one more line of conversation, and no room left in
      // the day for work or weather or walking somewhere new.
      const sinceTalk = tick - (edge.lastContactTick ?? -9999);
      if (sinceTalk >= cfg.social.pairCooldownTicks && (gossipable.length || opinions.length) && edge.familiarity > 5) {
        const reasons = [];
        // Passing on a secret is the potent version; merely having a view about
        // somebody is the ordinary one, and should not crowd out everything else.
        let score = talk.base + WEIGHTS.driveSocial * (agent.drives.social / 100) * 0.6;
        if (gossipable.length) {
          score += talk.secretBonus + gossipable.length * talk.secretPerSecret;
          reasons.push("has heard something");
        } else {
          score += talk.opinion;
          const aboutName = opinions[0].subjectId ? byId.get(opinions[0].subjectId)?.name : null;
          reasons.push(`has opinions about ${aboutName || "someone"}`);
        }
        if (edge.affinity > 20) {
          score += talk.friendBonus;
          reasons.push(`${target.name} is a friend`);
        }
        if (agent.drives.social > 70) reasons.push("cannot resist telling it");
        add("gossip", target.id, score, reasons, {
          requiresProximity: true,
          payload: gossipable.length
            ? { secretId: rng.pick(gossipable).id }
            : { aboutId: rng.pick(opinions).subjectId }
        });
      }
    }
  }

  /* ---------- Call in a favour ---------- */
  {
    // Being owed is a slow pressure, not an emergency. The grace period after
    // the favour was done and the cooldown after the last call-in keep this
    // from becoming a standing demand; the debt's size decides how loud it is.
    const fcfg = cfg.favours;
    for (const [otherId, edge] of Object.entries(agent.relations)) {
      const other = byId.get(otherId);
      if (!other || other.retired) continue;
      if (edge.debts < fcfg.callInThreshold) continue;
      if (tick - (edge.lastFavourTick ?? -9999) < fcfg.graceTicks) continue;
      if (tick - (edge.lastCallInTick ?? -9999) < fcfg.callInCooldownTicks) continue;
      const reasons = [`${other.name} owes them a favour`];
      let score = fcfg.debtUtilityPull * edge.debts;
      score += WEIGHTS.needEsteem * esteem.deficit * 0.3;
      score += WEIGHTS.driveCourage * (agent.drives.courage / 100) * 0.4;
      score -= WEIGHTS.fearBrake * (edge.fear / 100);
      if (edge.debts >= 40) reasons.push("it is a substantial debt");
      add("call_in", otherId, score, reasons, { requiresProximity: true });
    }
  }

  /* ---------- Confront a rival ---------- */
  {
    const rivals = rivalsOf(agent, cfg);
    for (const rivalId of rivals) {
      const rival = byId.get(rivalId);
      if (!rival) continue;
      const edge = edgeToward(agent, rivalId);
      // One argument at a time. Without this the same two minds re-litigate the
      // same grievance every tick and the world stops moving forward.
      if (tick - (edge.lastConflictTick ?? -9999) < cfg.social.conflictCooldownTicks) continue;
      const reasons = [];
      let score = WEIGHTS.rivalryPush * (edge.resentment / 100);
      // Bravery decides *how* a mind confronts, not whether it has anything to
      // confront about. Scaling this by the grievance is what stops a bold mind
      // from picking fights with people it has no quarrel with.
      score += WEIGHTS.driveCourage * (agent.drives.courage / 100) * 0.7 * (edge.resentment / 100 + 0.12);
      score += WEIGHTS.needEsteem * esteem.deficit * 0.5 * (edge.resentment / 60);
      score -= WEIGHTS.fearBrake * (edge.fear / 100);
      if (edge.resentment >= 55) reasons.push(`still furious with ${rival.name}`);
      if (edge.fear > 40) reasons.push("frightened of them");
      if (esteem.value < 30) reasons.push("needs to be taken seriously again");
      // A vendetta wants settling even when the raw grievance number would not
      // clear the bar on its own.
      const stage = feudStage(edge, edgeToward(rival, agent.id), cfg);
      if (stage === "vendetta") {
        score += cfg.vendetta.confrontBonus;
        reasons.push(`this is a vendetta with ${rival.name}`);
      }
      if (edge.resentment > 25 || stage === "vendetta") add("confront", rivalId, score, reasons, { requiresProximity: false });
    }
  }

  /* ---------- Weaponise a secret ---------- */
  {
    // Ruthlessness: the appetite to use what you know rather than sit on it.
    // A bold, focused mind with little interest in being liked is dangerous
    // even without a specific grievance.
    const ruthlessness = (agent.drives.courage + agent.drives.focus) / 2 - agent.drives.social / 2;
    if (agent.drives.courage > 25) {
      for (const secret of world.secrets) {
        if (secret.holders[agent.id] === undefined) continue;
        if (secret.isPublic || !secret.aboutId || secret.aboutId === agent.id) continue;
        const subject = byId.get(secret.aboutId);
        if (!subject) continue;
        const edge = edgeToward(agent, secret.aboutId);
        // Betrayal does not wait on the argument cooldown — it is what happens
        // *instead* of saying it to their face, and it is often the next step
        // after swallowing a grievance rather than the same beat repeated.
        if (tick - (secret.lastSpreadTick ?? -9999) < cfg.social.gossipCooldownTicks) continue;
        if (edge.trust > cfg.social.betrayalTrustCeiling) continue; // you don't sell out people you believe in
        const provoked = edge.resentment >= cfg.social.betrayalResentmentFloor || edge.affinity <= -10;
        const opportunistic = ruthlessness > 52 && edge.resentment > 8;
        if (!provoked && !opportunistic) continue;
        const reasons = [];
        let score = 40 * (edge.resentment / 100);
        if (opportunistic && !provoked) {
          score += 10;
          reasons.push("will use what they know if it helps");
        }
        score += 18 * (1 - edge.trust / 100);
        score += WEIGHTS.driveCourage * (agent.drives.courage / 100) * 0.4;
        score -= WEIGHTS.fearBrake * (edge.fear / 100) * 0.8;
        score += 10 * (1 - secret.holders[agent.id]); // a garbled version is easier to spill
        // A vendetta sharpens the appetite: using what you know stops being a
        // choice and starts being the point.
        if (feudStage(edge, edgeToward(subject, agent.id), cfg) === "vendetta") {
          score *= cfg.vendetta.betrayalMultiplier;
          reasons.push(`this is a vendetta with ${subject.name}`);
        }
        if (edge.resentment >= 50) reasons.push(`wants ${subject.name} to hurt`);
        if (agent.drives.social < 40) reasons.push("has little to lose socially");
        if (reasons.length) add("betray", secret.aboutId, score, reasons, {
          requiresProximity: false,
          payload: { secretId: secret.id }
        });
      }
    }
  }

  /* ---------- Pursue the goal ---------- */
  {
    const reasons = [];
    let score = WEIGHTS.needMeaning * meaning.deficit;
    score += WEIGHTS.driveFocus * (agent.drives.focus / 100) * 0.8;
    score += 16 * (1 - agent.goal.progress);
    // Work gets done where you belong.
    if (agent.regionId === agent.homeRegionId) score += 7;
    if (meaning.value < 40) reasons.push("needs the work to mean something");
    if (agent.goal.progress < 0.3) reasons.push("barely started on " + shortGoal(agent.goal.text));
    else reasons.push(`deep into ${shortGoal(agent.goal.text)}`);
    add("pursue_goal", null, score, reasons, {});
  }

  /* ---------- Explore somewhere new ---------- */
  {
    const reasons = [];
    let score = WEIGHTS.driveCreativity * (agent.drives.creativity / 100) * 0.7;
    score += 11;
    if (agent.archetype === "The Curious") score += 9;
    if (agent.needs.connection < 30) score += 6;
    score += crowd * 7;
    // Wandering is more appealing to a mind with nothing keeping it here, and
    // more appealing still to one that is a long way from where it belongs.
    if (agent.regionId === agent.homeRegionId) score -= 5;
    else score += 6;
    reasons.push(agent.regionId === agent.homeRegionId ? "wants to see what is out there" : "has been away long enough");
    add("explore", null, score, reasons, {});
  }

  /* ---------- Forge a bond ---------- */
  {
    const warm = here
      .map(o => ({ other: o, edge: edgeToward(agent, o.id) }))
      .filter(x => x.edge.affinity > 15 && x.edge.affinity < cfg.relations.allianceThreshold)
      .sort((a, b) => b.edge.affinity - a.edge.affinity);
    if (warm.length) {
      const { other, edge } = warm[0];
      const reasons = [`getting closer to ${other.name}`];
      let score = WEIGHTS.bondPull * (edge.affinity / 100) * 0.8;
      score += WEIGHTS.needConnection * connection.deficit * 0.5;
      if (edge.debts !== 0) score += WEIGHTS.debtPull * Math.min(1, Math.abs(edge.debts) / 60);
      add("forge_bond", other.id, score, reasons, { requiresProximity: true });
    }
  }

  /* ---------- Do someone a favour ---------- */
  {
    // Generosity is aimed, not sprayed: a mind does favours for people it
    // already likes, when it has the energy to spare. The creation cooldown
    // stops one generous mind from indebting the whole region in a day.
    const fcfg = cfg.favours;
    const candidates = here
      .map(o => ({ other: o, edge: edgeToward(agent, o.id) }))
      .filter(x => x.edge.affinity > 15)
      .filter(x => x.edge.resentment < cfg.relations.rivalryThreshold)
      .filter(x => tick - (x.edge.lastFavourTick ?? -9999) >= fcfg.createCooldownTicks)
      .sort((a, b) => b.edge.affinity - a.edge.affinity);
    if (candidates.length && agent.needs.energy > 40) {
      const { other, edge } = candidates[0];
      const reasons = [`likes ${other.name} enough to help`];
      let score = WEIGHTS.favourPull * (edge.affinity / 100);
      score += WEIGHTS.driveSocial * (agent.drives.social / 100) * 0.5;
      score += WEIGHTS.needEsteem * esteem.deficit * 0.3;
      if (agent.needs.energy > 70) {
        score += 8;
        reasons.push("has the energy to spare");
      }
      add("grant_favour", other.id, score, reasons, { requiresProximity: true });
    }
  }

  /* ---------- Withdraw ---------- */
  {
    const fears = fearedOf(agent);
    const reasons = [];
    let score = WEIGHTS.solitudeRelief * (fears.length / Math.max(1, Object.keys(agent.relations).length));
    score += fears.length * 6;
    score += crowd * 5;
    if (agent.needs.esteem < 25) {
      score += 14;
      reasons.push("wants to be somewhere nobody is looking");
    }
    if (fears.length) reasons.push("avoiding someone");
    if (ritualBias === "withdraw") {
      score += 10;
      reasons.push("the world is keeping to itself today");
    }
    if (reasons.length) add("withdraw", null, score, reasons, {});
  }

  /* ---------- Observe: always available, never exciting ---------- */
  add("observe", null,
    WEIGHTS.observeBase + rng.gauss(0, 3) + (ritualBias === "observe" ? 8 : 0),
    ritualBias === "observe" ? ["taking the world in", "it is Quiet Day"] : ["taking the world in"], {});

  out.sort((a, b) => b.utility - a.utility);
  return out;
}

/**
 * Pick the mind in this region this agent would most like to be near.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../model/agent.js").Agent[]} here
 * @param {Map<string, import("../model/agent.js").Agent>} byId
 */
function pickCompanion(world, agent, here, byId) {
  const cfg = world.config;
  if (!here.length) return null;
  return here
    .map(o => ({ o, edge: edgeToward(agent, o.id) }))
    // The room's opinion counts: a well-regarded mind is slightly more magnetic
    // to be around, a notorious one slightly less — independent of private liking.
    .sort((a, b) => companionScore(b.edge, cfg) + (b.o.standing ?? 0) * 0.12 - (companionScore(a.edge, cfg) + (a.o.standing ?? 0) * 0.12))[0].o;
}

/**
 * People this mind would actually travel for, best first. Only genuine
 * attachments qualify — nobody crosses the world for a stranger.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {Map<string, import("../model/agent.js").Agent>} byId
 */
function distantContacts(world, agent, byId) {
  const cfg = world.config;
  /** @type {(x: {agent: import("../model/agent.js").Agent|undefined, edge: import("../model/relationships.js").RelationEdge}) => x is {agent: import("../model/agent.js").Agent, edge: import("../model/relationships.js").RelationEdge}} */
  const isElsewhere = x => Boolean(x.agent && !x.agent.retired && x.agent.regionId !== agent.regionId);
  return Object.entries(agent.relations)
    .map(([id, edge]) => ({ agent: byId.get(id), edge }))
    .filter(isElsewhere)
    .filter(x => x.edge.affinity > 10 || x.edge.resentment > 25 || x.edge.familiarity > 35)
    .sort((a, b) => distantScore(b.edge, cfg) - distantScore(a.edge, cfg))
    .slice(0, 4);
}

/**
 * How worth travelling for a relationship is.
 * @param {import("../model/relationships.js").RelationEdge} edge
 * @param {import("../config.js").WorldConfig} cfg
 */
function distantScore(edge, cfg) {
  return edge.affinity * 0.8 + (edge.affinity >= cfg.relations.allianceThreshold ? 25 : 0) + edge.resentment * 0.5 + edge.familiarity * 0.2;
}
/**
 * @param {import("../model/agent.js").Agent} agent
 */

/**
 * How appealing a co-located mind is to spend time with.
 * @param {import("../model/relationships.js").RelationEdge} edge
 * @param {import("../config.js").WorldConfig} cfg
 */
function companionScore(edge, cfg) {
  return edge.affinity + edge.familiarity * 0.4 + (edge.affinity >= cfg.relations.allianceThreshold ? 30 : 0) - edge.fear * 0.5;
}

/**
 * Someone nearby this mind already knows, best first.
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../model/agent.js").Agent[]} here
 * @param {Map<string, import("../model/agent.js").Agent>} byId
 * @returns {import("../model/agent.js").Agent|null}
 */
function nearestAcquaintance(agent, here, byId) {
  if (!here.length) return null;
  return here
    .map(o => ({ o, edge: edgeToward(agent, o.id) }))
    .sort((a, b) => b.edge.familiarity - a.edge.familiarity)[0].o;
}

/**
 * Trim a goal down to something usable inside a sentence.
 * @param {string} text
 * @returns {string}
 */
function shortGoal(text) {
  return text.length > 44 ? text.slice(0, 41).trim() + "..." : text;
}

/**
 * Which intent did the mind choose? Convenience wrapper for callers that only
 * need the winner.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @returns {{ chosen: Intent|null, ranked: Intent[] }}
 */
export function chooseIntent(world, agent) {
  const ranked = generateIntents(world, agent);
  return { chosen: ranked[0] || null, ranked };
}
