/**
 * Burden: how much a secret weighs on the mind holding it.
 *
 * Two minds can know the same thing and be affected completely differently. A
 * secret is heavy when you are the only one carrying it, when you believe it
 * completely, when it is about someone you already resent, and when it is about
 * something genuinely bad. This module turns that intuition into a number, and
 * that number is what pushes minds toward confiding — or toward using it.
 */

import { clamp } from "../config.js";
import { edgeToward } from "../model/relationships.js";

/**
 * @typedef {object} Burden
 * @property {import("../model/world.js").Secret} secret
 * @property {number} weight       0..1. How much it presses on this mind.
 * @property {number} fidelity     How accurately this mind holds it.
 * @property {number} holderCount  How many minds know it.
 * @property {boolean} isOwn       True when the secret is about the holder themselves.
 */

/** Kinds of secret that are inherently heavier to carry. */
const HEAVY_KINDS = new Set(["crime", "betrayal", "identity"]);

/**
 * Weigh a single secret for a single mind.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {import("../model/world.js").Secret} secret
 * @returns {Burden}
 */
export function weighSecret(world, agent, secret) {
  const fidelity = secret.holders[agent.id] ?? 0;
  const holderCount = Object.keys(secret.holders).length;
  const isOwn = secret.aboutId === agent.id;

  let weight = 0.30;
  weight += 0.28 * fidelity;                          // certainty is a burden
  weight += 0.18 * (1 / Math.max(1, holderCount));     // sole knowledge is heavier
  if (isOwn) weight += 0.26;                           // a secret about yourself
  if (HEAVY_KINDS.has(secret.kind)) weight += 0.16;
  if (secret.aboutId && !isOwn) {
    const edge = edgeToward(agent, secret.aboutId);
    weight += 0.22 * (edge.resentment / 100);          // knowing something about someone you hate
    weight += 0.10 * (edge.fear / 100);                // ...and being afraid of them
  }
  if (secret.isPublic) weight *= 0.25;                 // once it is out, it is just history

  return { secret, weight: clamp(weight, 0, 1), fidelity, holderCount, isOwn };
}

/**
 * Everything weighing on a mind right now, heaviest first.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @returns {Burden[]}
 */
const SALIENT_BURDENS = 4;

/**
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function recallingSecretBurden(world, agent) {
  const out = [];
  for (const secret of world.secrets) {
    if (secret.holders[agent.id] === undefined) continue;
    const burden = weighSecret(world, agent, secret);
    // A secret the mind doesn't really believe anymore weighs almost nothing.
    if (burden.weight < 0.2) continue;
    out.push(burden);
  }
  out.sort((a, b) => b.weight - a.weight);
  // A mind is not a filing cabinet. Beyond a handful, further secrets stop
  // changing what it is inclined to do — and letting them accumulate turns
  // every decision into "confide in someone", forever.
  return out.slice(0, SALIENT_BURDENS);
}

/**
 * The heaviest thing on a mind's mind.
 * @param {Burden[]} burdens
 * @returns {Burden}
 */
export function strongestBurden(burdens) {
  return burdens[0];
}

/**
 * The pressure a mind feels to unburden itself. Rises with the weight of what it
 * carries and with how alone it is in carrying it.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 */
export function unburdenPressure(world, agent) {
  const burdens = recallingSecretBurden(world, agent);
  if (!burdens.length) return 0;
  const top = burdens[0];
  const loneliness = clamp((100 - agent.needs.connection) / 100, 0, 1);
  return clamp(top.weight * 0.6 + loneliness * 0.4, 0, 1);
}
