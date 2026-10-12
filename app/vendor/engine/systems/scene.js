/**
 * Scenes: two minds actually trading lines.
 *
 * A meeting used to be a single sentence summarising how it went. A scene is
 * the transcript underneath that sentence: four to five short lines, spoken in
 * turn, where each line is chosen from the speakers' own state — what one of
 * them is working on, a grievance the other one still carries, a specific
 * incident one of them remembers, how warm the meeting turned out to be.
 *
 * Everything here is deterministic. Lines are drawn from the world's seeded
 * random stream, so the same world replays the same conversations, and the
 * transcript is stored on the event so the record can show it verbatim.
 */

import { edgeToward } from "../model/relationships.js";
import { recall } from "../model/memory.js";

/**
 * @typedef {object} SceneLine
 * @property {string} speakerId
 * @property {string} text
 *
 * @typedef {SceneLine[]} Scene
 */

const TONES = /** @type {const} */ (["warm", "neutral", "awkward"]);

/** Openers, by tone. `{other}` is the listener, `{region}` where they met. */
const OPEN = {
  warm: [
    "{other}. I was hoping I'd run into you.",
    "There you are. Sit down, you look like the day has been long.",
    "I wanted to tell you something about {region}, and you're the only one I'd tell."
  ],
  neutral: [
    "{other}. Didn't expect to see you out here.",
    "Quiet in {region} today.",
    "Oh. It's you."
  ],
  awkward: [
    "Of course you're here.",
    "I was about to leave. Go on, say whatever it is.",
    "{other}. So we're doing this now."
  ]
};

/** Replies from the listener, by tone. */
const REPLY = {
  warm: [
    "I'm glad you did. Talk to me.",
    "Long day, yes. But this helps.",
    "Go on, I'm listening."
  ],
  neutral: [
    "Mm. Was there something?",
    "It's been a day. Yours?",
    "Right. Go on, then."
  ],
  awkward: [
    "Don't start.",
    "Say it plainly, then, if you must.",
    "I'd rather not, honestly."
  ]
};

/** Something the speaker is busy with. `{goal}` is their current goal. */
const GOAL_TALK = [
  "I'm still on {goal}. It's eating my days.",
  "Honestly, all I think about is {goal}.",
  "I've been working on {goal}. Slowly."
];

/** Replies to goal talk, by tone. */
const GOAL_REPLY = {
  warm: ["Then I'm glad it's you doing it. Keep at it.", "You'll get there. You always do."],
  neutral: ["Hm. That sounds like a lot.", "Is it going anywhere?"],
  awkward: ["Everyone's busy, {speaker}.", "Nobody asked about your goal."]
};

/** A grievance the speaker still holds against the listener. */
const GRIEVANCE = [
  "I haven't forgotten: \"{memory}\"",
  "You know what you did. \"{memory}\" I still think about it.",
  "Be honest with me about \"{memory}\"."
];

/** Replies to a grievance, by tone. */
const GRIEVANCE_REPLY = {
  warm: ["I know. I'm sorry it cost you.", "That's fair. I should have said so sooner."],
  neutral: ["That was a long time ago.", "I remember it differently."],
  awkward: ["You'd remember it that way.", "Then hold onto it. It's yours to keep."]
};

/** Something the speaker is holding back. Hints, never the secret itself. */
const HOLDING = [
  "There's something I'm carrying that I won't say here.",
  "If you knew what I know about this place, you'd keep your distance too."
];

/** Closings, by tone. */
const CLOSE = {
  warm: ["Same time next week?", "Come find me later, then."],
  neutral: ["Right. I should go.", "Well. That's that."],
  awkward: ["Don't follow me.", "I'm done. Really."]
};

/**
 * @param {string} text
 * @param {Record<string, string>} vars
 */
function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? vars[key] : ""));
}

/**
 * The most recent incident the speaker remembers involving the listener, if
 * it is still sharp enough to bring up.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} speaker
 * @param {import("../model/agent.js").Agent} listener
 */
function sharpGrievance(world, speaker, listener) {
  const found = recall(speaker.memory, {
    tick: world.clock.tick,
    kinds: ["betrayal", "conflict"],
    limit: 4,
    config: world.config,
    rng: world.rng
  }).filter(t => t.subjectId === listener.id && t.valence < -0.3);
  return found[0] || null;
}

/**
 * Compose the exchange between two co-located minds.
 *
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} initiator
 * @param {import("../model/agent.js").Agent} listener
 * @param {number} quality  -1..1, as decided by the encounter.
 * @param {string} regionName
 * @returns {Scene}
 */
export function composeScene(world, initiator, listener, quality, regionName) {
  const rng = world.rng;
  const tone = quality > 0.25 ? TONES[0] : quality < -0.25 ? TONES[2] : TONES[1];
  // Whose grievance is brought up: the listener's, toward the one who came over.
  const grudge = edgeToward(listener, initiator.id);
  const vars = {
    other: listener.name,
    speaker: initiator.name,
    region: regionName,
    goal: midSentence(initiator.goal.text)
  };

  /** @type {Scene} */
  const scene = [];
  const say = (/** @type {string} */ speakerId, /** @type {string} */ text) =>
    scene.push({ speakerId, text: fill(text, vars) });

  say(initiator.id, rng.pick(OPEN[tone]));
  say(listener.id, rng.pick(REPLY[tone]));

  // The middle of the scene depends on what is actually weighing on the pair.
  const grievance = grudge.resentment > 25 ? sharpGrievance(world, listener, initiator) : null;
  if (grievance && rng.chance(0.7)) {
    // The listener is the one holding the grievance here: they bring it up.
    say(listener.id, rng.pick(GRIEVANCE).replace("{memory}", clip(grievance.text)));
    say(initiator.id, rng.pick(GRIEVANCE_REPLY[tone]));
  } else if (initiator.goal && initiator.goal.text) {
    say(initiator.id, rng.pick(GOAL_TALK));
    say(listener.id, rng.pick(GOAL_REPLY[tone]));
  }

  if (tone === "warm" && rng.chance(0.2)) {
    say(initiator.id, rng.pick(HOLDING));
  }

  say(rng.chance(0.5) ? initiator.id : listener.id, rng.pick(CLOSE[tone]));
  return scene;
}

/**
 * A goal is written as a headline ("Build a tool…."); spoken, it sits inside a
 * sentence, so drop the terminal punctuation and lower the first letter.
 */
/** @param {string} text */
function midSentence(text) {
  const bare = String(text || "").trim().replace(/[.!?…]+$/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/** Keep quoted memories short enough to sit on one line. */
/** @param {string} text */
function clip(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 110 ? oneLine.slice(0, 107).trimEnd() + "…" : oneLine;
}
