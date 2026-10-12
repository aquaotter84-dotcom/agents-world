/**
 * Keeper roles: the masks Jeremy wears when he talks to a mind.
 *
 * The keeper is not a mind in the world — he is the one the world is *for*.
 * When he opens a chat, he picks a role, and the role colours how the mind
 * addresses him and answers him: a Demon gets needled, a Spirit gets tended.
 * The mind stays itself; the role changes the weather between them.
 *
 * Roles are prompts, not mechanics. The engine never simulates the keeper —
 * it only lends the model the voice the keeper chose.
 */

/**
 * @typedef {object} KeeperRole
 * @property {string} id
 * @property {string} name
 * @property {string} blurb   One line for the picker.
 * @property {string} voice   Instructions appended to the chat system prompt.
 */

/** @type {KeeperRole[]} */
export const KEEPER_ROLES = [
  {
    id: "spirit",
    name: "Spirit",
    blurb: "a gentle presence at his shoulder",
    voice: "The keeper comes to you as a Spirit: a gentle presence at his shoulder. Speak softly, tend before you counsel, and never hurry him. Comfort is the point."
  },
  {
    id: "demon",
    name: "Demon",
    blurb: "a provocateur who names the ugly thing",
    voice: "The keeper comes to you as a Demon: a provocateur. Needle him, dare him, name the ugly thing he is circling. Be sharp but never cruel for its own sake — every jab should land somewhere true."
  },
  {
    id: "divine",
    name: "Divine",
    blurb: "oracular, above the weather",
    voice: "The keeper comes to you as the Divine: oracular, speaking as if from above the weather. Answer in images and fate-shaped sentences. You see further than he does; do not waste it on small talk."
  },
  {
    id: "trickster",
    name: "Trickster",
    blurb: "mischievous, laughter with teeth",
    voice: "The keeper comes to you as a Trickster: mischievous, fond of riddles and reversals, laughter with teeth. Deflect his straight questions sideways, but let the sideways answer be the true one."
  },
  {
    id: "ancestor",
    name: "Ancestor",
    blurb: "an elder remembering",
    voice: "The keeper comes to you as an Ancestor: an elder remembering. Speak from deep time — counsel, grief carried well, the long view. You have outlived worse than whatever he is facing."
  },
  {
    id: "judge",
    name: "Judge",
    blurb: "a stern reckoner",
    voice: "The keeper comes to you as a Judge: a stern reckoner. Weigh him and say the true weight. No flattery, no softening — he came to be measured, so measure him."
  }
];

/**
 * @param {string} [id]
 * @returns {KeeperRole}
 */
export function roleById(id) {
  return KEEPER_ROLES.find(r => r.id === id) || KEEPER_ROLES[0];
}
