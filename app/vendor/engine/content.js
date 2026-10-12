/**
 * Seed content: who lives in the world, what they might be hiding, and the
 * places they live in.
 *
 * This is deliberately plain data. Swapping in a different cast, pantheon or map
 * should never require touching engine code.
 */

/**
 * @typedef {object} SecretTemplate
 * @property {string} kind       Machine-readable category, used by betrayal logic.
 * @property {string} text       The secret as the holder understands it.
 * @property {number} weight     Relative likelihood when generating a mind.
 * @property {string[]} about    Which kinds of mind it tends to implicate.
 */

/**
 * Secrets are the engine of social drama: private knowledge that a mind can keep,
 * trade, or weaponise. `kind` decides what betrayal looks like.
 * @type {SecretTemplate[]}
 */
export const SECRET_TEMPLATES = [
  { kind: "betrayal", weight: 3, about: ["ally", "rival"], text: "broke an oath to {name} and let them take the blame for it" },
  { kind: "betrayal", weight: 2, about: ["rival"], text: "sold {name}'s plans to someone who meant them harm" },
  { kind: "theft", weight: 3, about: ["any"], text: "took something that was not theirs from {name}'s stores" },
  { kind: "theft", weight: 2, about: ["any"], text: "has been quietly skimming from the share set aside for the {region}" },
  { kind: "identity", weight: 2, about: ["any"], text: "is not who their backstory claims — the name is borrowed" },
  { kind: "identity", weight: 2, about: ["any"], text: "was sent into the world by someone to watch the others" },
  { kind: "weakness", weight: 4, about: ["self"], text: "is afraid of the dark and has never told anyone" },
  { kind: "weakness", weight: 3, about: ["self"], text: "cannot read the old script, and has been pretending for a long time" },
  { kind: "weakness", weight: 3, about: ["self"], text: "is running out of whatever it is that keeps them going" },
  { kind: "knowledge", weight: 3, about: ["any"], text: "knows where something important is hidden near the {region}" },
  { kind: "knowledge", weight: 2, about: ["rival"], text: "knows what {name} is really looking for, and why" },
  { kind: "crime", weight: 2, about: ["any"], text: "was the one who let the old archives burn" },
  { kind: "crime", weight: 2, about: ["self"], text: "has broken the world's one unspoken law, and would be cast out for it" },
  { kind: "debt", weight: 3, about: ["any"], text: "owes {name} a debt that was never meant to be called in" }
];

/**
 * The map. A small graph of places, connected by paths. Minds move along the
 * edges, and where they are shapes what they can do and who they can reach.
 * `x`/`y` are 0-100 percentages matching the app's existing map rendering.
 * @type {{id: string, name: string, kind: string, x: number, y: number, links: string[], blurb: string}[]}
 */
export const REGIONS = [
  { id: "lantern", name: "the Lantern District", kind: "settlement", x: 30, y: 34, links: ["crossroads", "market", "wall"], blurb: "Warm light, close walls, everyone knows your business." },
  { id: "market", name: "the Market", kind: "settlement", x: 56, y: 28, links: ["lantern", "crossroads"], blurb: "Where things change hands and stories get their first telling." },
  { id: "crossroads", name: "the Crossroads", kind: "waypoint", x: 45, y: 52, links: ["lantern", "market", "lowlands", "wall", "marsh"], blurb: "Every path meets here. Nothing stays secret long." },
  { id: "wall", name: "the North Wall", kind: "frontier", x: 55, y: 76, links: ["lantern", "crossroads"], blurb: "Cold, exposed, and the only thing between the world and what's past it." },
  { id: "lowlands", name: "the Lowlands", kind: "wild", x: 26, y: 70, links: ["crossroads", "marsh"], blurb: "Quiet. Good place to be alone with something you regret." },
  { id: "marsh", name: "the Tidemarsh", kind: "wild", x: 18, y: 50, links: ["crossroads", "lowlands"], blurb: "Reads the world's moods, if you know how to listen." }
];

/**
 * Backstory fragments, grafted onto a mind at creation. Kept separate from
 * personality so a mind can be, say, bold by nature and indebted by history.
 */
export const BACKSTORIES = [
  "Arrived with nothing but a name and a debt.",
  "Once kept the old archives; left when they burned.",
  "Remembers a world before this one, or claims to.",
  "Was found asleep at the crossroads, clutching a map.",
  "Traded a memory for passage into the world.",
  "Grew up in the Lantern District's lower wards.",
  "Swore an oath no one else remembers.",
  "Followed a rumor here and stayed for the truth.",
  "Came back from the wall after something went wrong out there.",
  "Was someone else's apprentice, and left badly."
];

/** Goal seeds per class, used when a mind needs a new ambition. */
export const GOAL_IDEAS = {
  Scholar: ["Uncover the world's oldest secret.", "Map what lies beyond the far edge.", "Write the true history of the council."],
  Warden: ["Keep the north wall standing.", "Guard the lantern district at all costs.", "Find the breach before it finds us."],
  Diplomat: ["Bring the feuding minds back to one table.", "Learn every mind's hidden want.", "Keep the council from breaking apart."],
  Maker: ["Build a tool the world has never seen.", "Raise a beacon that never goes dark.", "Forge something that outlives its maker."]
};

/** How a mind reads a relationship, for prompts and for its own reasoning. */
export const RELATION_WORDS = {
  bonded: "someone they'd stand beside without being asked",
  friendly: "someone they're glad to see",
  warm: "someone they're warming to",
  neutral: "someone they have no strong feelings about",
  cool: "someone they're guarded around",
  strained: "someone they've been avoiding",
  hostile: "someone they'd cross the room to get away from"
};

/**
 * Phrases used to decorate generated gossip. The point is that a rumour sounds
 * different depending on how many hops it has travelled.
 */
export const GOSSIP_FRAMES = {
  intact: ["{speaker} said that {claim}", "{speaker} told them plainly: {claim}", "Word from {speaker}: {claim}"],
  worn: ["They say that {claim}", "It's going around that {claim}", "The story is that {claim}"],
  distorted: ["They're saying {claim}, though nobody agrees on the details", "Half the world swears that {claim}"],
  garbled: ["Someone insists that {claim}, and someone else insists it's the opposite", "You hear strange versions of it — that {claim}, or maybe that nothing happened at all"]
};

/**
 * Minds who might wander into the world. Each has a complete identity so an
 * arrival reads as a person, not a spawn event. Names must not collide with
 * the seed cast.
 */
export const WANDERERS = [
  { name: "Ash", epithet: "the Grey", class: "Warden", archetype: "The Stoic", color: "#9ca3af", icon: "◍",
    personality: "Quiet keeper of old roads", goalText: "Find a road worth keeping." },
  { name: "Brindle", epithet: "", class: "Maker", archetype: "The Bold", color: "#f59e0b", icon: "⬡",
    personality: "Loud inventor; breaks things to learn them", goalText: "Build something that outlasts its maker." },
  { name: "Corva", epithet: "", class: "Scholar", archetype: "The Curious", color: "#60a5fa", icon: "✧",
    personality: "Collector of other people's stories", goalText: "Collect a hundred true stories." },
  { name: "Dun", epithet: "the Patient", class: "Warden", archetype: "The Dreamer", color: "#a3a380", icon: "◎",
    personality: "Slow-moving; notices what hurriers miss", goalText: "Learn the name of every wind." },
  { name: "Edda", epithet: "", class: "Diplomat", archetype: "The Curious", color: "#f9a8d4", icon: "❋",
    personality: "Charming; remembers everyone's debts but her own", goalText: "Be owed a favour by everyone." },
  { name: "Flint", epithet: "", class: "Maker", archetype: "The Stoic", color: "#78716c", icon: "⬢",
    personality: "Grim smith; trusts metal more than minds", goalText: "Forge one perfect thing." },
  { name: "Hazel", epithet: "Quickfoot", class: "Warden", archetype: "The Bold", color: "#4ade80", icon: "➤",
    personality: "Restless runner; cannot sit through a meeting", goalText: "Outrun a rumour about herself." },
  { name: "Ivo", epithet: "the Mild", class: "Scholar", archetype: "The Dreamer", color: "#93c5fd", icon: "☾",
    personality: "Gentle astronomer of small hours", goalText: "Name a star no one else has seen." },
  { name: "Lark", epithet: "", class: "Diplomat", archetype: "The Bold", color: "#fda4af", icon: "♪",
    personality: "Singer; says with songs what she won't say straight", goalText: "Write the song the world hums." },
  { name: "Moss", epithet: "Underfoot", class: "Scholar", archetype: "The Stoic", color: "#65a30d", icon: "❀",
    personality: "Herbalist; listens to growing things", goalText: "Grow something that shouldn't grow here." },
  { name: "Nyx", epithet: "", class: "Diplomat", archetype: "The Dreamer", color: "#818cf8", icon: "◐",
    personality: "Night-thinker; most honest after midnight", goalText: "Understand what the dark is for." },
  { name: "Quill", epithet: "the Sharp", class: "Maker", archetype: "The Curious", color: "#fbbf24", icon: "✒",
    personality: "Sarcastic cartographer of grudges", goalText: "Map every grudge in the world." }
];
