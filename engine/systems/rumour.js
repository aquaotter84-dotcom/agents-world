/**
 * Rumour mutation: gossip warps as it spreads.
 *
 * Fidelity already wears a story down mechanically. This is the other half:
 * the *words* change. Details sharpen or soften, severity drifts, and
 * sometimes — the most dangerous mutation of all — the name at the centre of
 * the story gets swapped for someone else's. The secret underneath stays what
 * it was; what the room *says* becomes its own creature.
 *
 * Mutation only ever touches the telling, never the secret record. A mind
 * that checks the facts finds the original; a mind that only listens hears
 * the rumour.
 */

import { livingAgents, agentById } from "../model/world.js";

/**
 * Warp a claim as it is retold. Returns the mutated claim and what kind of
 * warp happened, or null when the telling survives intact.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/world.js").Secret} secret
 * @param {string} claim
 * @returns {{ claim: string, kind: "exaggerated"|"softened"|"misattributed" }|null}
 */
export function mutateClaim(world, secret, claim) {
  const cfg = world.config.rumour;
  const roll = world.rng.float();

  // The dangerous one: the name at the centre of the story changes.
  if (roll < cfg.nameSwapChance && secret.aboutId) {
    const about = agentById(world, secret.aboutId);
    const others = livingAgents(world).filter(a => a.id !== secret.aboutId);
    if (about && others.length) {
      const impostor = world.rng.pick(others);
      const swapped = claim.split(about.name).join(impostor.name);
      if (swapped !== claim) {
        return { claim: swapped, kind: "misattributed" };
      }
    }
  }

  if (roll < cfg.nameSwapChance + cfg.exaggerateChance) {
    return {
      claim: `${claim} — or worse, if half of what goes around is true`,
      kind: "exaggerated"
    };
  }

  return {
    claim: `they say ${claim}, though it may be nothing`,
    kind: "softened"
  };
}

/**
 * Pass a secret on with a chance of warping. Records the telling on the
 * secret itself so the world can see how far a story has travelled from
 * the truth.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/world.js").Secret} secret
 * @param {string} claim
 * @returns {{ claim: string, mutated: boolean, kind: string|null }}
 */
export function tellWithMutation(world, secret, claim) {
  secret.timesTold = (secret.timesTold ?? 0) + 1;
  if (!world.rng.chance(world.config.rumour.mutationChance)) {
    return { claim, mutated: false, kind: null };
  }
  const mutation = mutateClaim(world, secret, claim);
  if (!mutation) return { claim, mutated: false, kind: null };
  secret.mutations = (secret.mutations ?? 0) + 1;
  return { claim: mutation.claim, mutated: true, kind: mutation.kind };
}
