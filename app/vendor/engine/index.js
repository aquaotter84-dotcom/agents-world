/**
 * Agents World — the simulation engine's public surface.
 *
 * Everything below is pure: no network, no timers, no filesystem, no globals.
 * A world advances only when someone calls `step`. That property is what lets
 * the same engine run headless on a server, inside a test harness at thousands
 * of ticks a second, and — later — directly inside the phone app, with the
 * phone owning its own copy of the world.
 *
 * The intended loop, from the outside:
 *
 *   const world = createWorld({ seed: 1 });
 *   const report = step(world);                 // advances one tick
 *   for (const moment of report.moments) {      // at most `maxPerTick`
 *     const answer = await askAModel(moment);   // your language model
 *     resolveMoment(world, moment.id, answer);
 *   }
 *
 * Anything not answered within `moments.maxPendingTicks` is decided by the
 * engine itself, so a slow or absent model can never stall the world.
 */

/* ---- construction and persistence ---- */
export { createWorld, SEED_CAST, worldStats, agentById, agentByName, regionById, regionName, livingAgents, agentsIn, regionOccupancy, secretsKnownBy, privateSecretsHeld, weaponisableSecrets, secretsAbout, secretTextFor, secretClaimFor } from "./model/world.js";
export { createCharter, normalizeCharter, RULE_KINDS, RULE_KIND_LIST, moveInfluence, ruleStrength, isEnacted, influenceWord, precedentFor } from "./model/charter.js";
export { createWant, normalizeWant, WANT_METERS, WANT_LABELS, meterWord, lastKeeperMovement, wantLog, wantValues, wantVerdict } from "./model/want.js";
export { createMourning, normalizeMourning, pendingFunerals, recentMemorials, buriedMemorials, funeralFor, memorialFor, FUNERAL_CAP, MEMORIAL_CAP } from "./model/mourning.js";
export { createDivine, normalizeDivine, INTERVENTION_KINDS, INTERVENTION_CAP, liveInterventions, markedInterventions, interventionById, liveOmenForRegion, liveBlessingForAgent, liveBlessingForWork, recordIntervention } from "./model/divine.js";
export { ruleOnPetition, resolveDilemma, actOnWhisper, settleCharter, describeRule } from "./systems/charter.js";
export { settleWant, wantReading, shiftWant, keeperAct, noteAsk, quietState, wantSummary } from "./systems/want.js";
export { settleMourning, callFuneral, mournDeparture, deedsOf } from "./systems/mourning.js";
export { settleDivine, performIntervention, canIntervene, interventionOptions, interventionOption, recentInterventions, liveSigns, interventionFor, resolveTarget, INTERVENTION_INFO } from "./systems/divine.js";
export { APPROACH_METHODS, availableMethods, validateApproach, resolveApproach, proposalEligible } from "./decision/proposals.js";
export { petitionableRules, petitionEligible, validatePetition, whisperable, whisperEligible, openDilemma, dilemmaChoices } from "./decision/petitions.js";
export { serializeWorld, deserializeWorld, forkWorld } from "./snapshot.js";

/* ---- advancement ---- */
export { step, resolveMoment, expireMoments, runTicks, describeWorld, sanitize, buildCognitionMoment } from "./simulation.js";

/* ---- model layer ---- */
export {
  CLASSES,
  ARCHETYPES,
  DRIVE_KEYS,
  NEED_KEYS,
  levelFromXp,
  xpForLevel,
  levelProgress,
  moodWord,
  pressingNeed,
  stateLine,
  standingWord,
  temperamentOverlap,
  needGain,
  classOf,
  driveBase,
  createCognitionState
} from "./model/agent.js";
export { recall, recentTraces, feelingsAbout, memoryStats } from "./model/memory.js";
export {
  describeRelation,
  relationPhrase,
  bondsOf,
  rivalsOf,
  fearedOf,
  factions,
  edgeToward,
  neutralEdge,
  feudStage,
  FEUD_STAGES
} from "./model/relationships.js";
export { recentEvents, publicEvents, eventsInvolving } from "./model/events.js";
export { regionPath, regionDistance, nextStepToward } from "./model/regions.js";

/* ---- decision layer ---- */
export { generateIntents, chooseIntent, WEIGHTS } from "./decision/intents.js";
export { isMomentWorthy, buildMoment } from "./decision/moments.js";
export { recallingSecretBurden, weighSecret, strongestBurden, unburdenPressure } from "./decision/burden.js";
export { phrase, momentLine } from "./decision/prose.js";

/* ---- systems ---- */
export { applyEffects } from "./systems/effects.js";
export { resolveIntent, socialEncounter, chooseDefaultOption } from "./systems/act.js";
export { socialTemperature, currentFactions } from "./systems/social.js";
export { settleTurnover, arrive, depart, isProtected } from "./systems/turnover.js";
export { mutateClaim, tellWithMutation } from "./systems/rumour.js";
export { activeRitual, settleRituals } from "./systems/rituals.js";
export { trackFeuds } from "./systems/vendetta.js";
export { KEEPER_ROLES, roleById } from "./chat.js";
export { applyChatInfluence, scoreSentiment, sentimentKind, detectDirective, settleChat } from "./systems/chat-influence.js";
export { preoccupations, memoryLoad } from "./systems/memory.js";

/* ---- configuration and content ---- */
export { DEFAULT_CONFIG, makeConfig, clamp } from "./config.js";
export { SECRET_TEMPLATES, REGIONS, BACKSTORIES, GOAL_IDEAS, WANDERERS } from "./content.js";
export { createRng, weightedPick } from "./rng.js";
export { describeClock, isNight, phaseOf } from "./clock.js";
