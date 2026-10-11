/**
 * Fallback prose.
 *
 * Most of the world's moments are narrated by the engine, not by a model. That
 * prose has to carry the same weight, or the world reads as filler between the
 * interesting beats. These are hand-written variants rather than generated
 * sentences, because a small number of well-written lines beats a large number
 * of mediocre assembled ones.
 *
 * Every phrase has access to the acting mind, the region, and the time of day, so
 * the same action reads differently depending on where and when it happens.
 */

import { weightedPick } from "../rng.js";

/**
 * @param {import("../model/world.js").World} world
 * @type {string[]}
 */
const recentlyUsed = [];
const RECENT_LIMIT = 14;

/**
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {string} kind
 * @param {Record<string, any>} [vars]
 * @param {number} [toneWeight]
 */
export function phrase(world, agent, kind, vars = {}, toneWeight) {
  const variants = TEMPLATES[kind];
  if (!variants || !variants.length) return fallbackLine(agent, vars);
  const ctx = {
    name: agent.name,
    title: agent.epithet ? `${agent.name} ${agent.epithet}` : agent.name,
    region: stripThe(vars.region || ""),
    regionFull: vars.region || "",
    other: vars.other || "someone",
    goal: vars.goal || agent.goal.text,
    phase: world.clock.phase,
    day: world.clock.day,
    ...vars
  };
  const chosen = toneWeight
    ? weightedPick(world.rng, variants, v => (typeof v === "string" ? 1 : v.weight))
    : pickFresh(world, variants.map(v => (typeof v === "string" ? v : v.text)));
  const text = typeof chosen === "string" ? chosen : chosen.text;

  recentlyUsed.push(text);
  if (recentlyUsed.length > RECENT_LIMIT) recentlyUsed.shift();

  return fill(text, ctx);
}

/**
 * Choose a variant, preferring one that hasn't been used lately. Falls back to
 * a plain pick once every variant has been used recently.
 * @param {import("../model/world.js").World} world
 * @param {string[]} options
 */
function pickFresh(world, options) {
  const fresh = options.filter(o => !recentlyUsed.includes(o));
  const pool = fresh.length ? fresh : options;
  return world.rng.pick(pool);
}

/**
 * Engine-written narration for a moment, used when no model answered.
 *
 * Moment options carry a label, but a label is a menu entry — "Say it in front
 * of everyone" is not a sentence about the world. Without these lines an
 * offline world reads as a transcript of decisions rather than a story.
 * @type {Record<string, string[]>}
 */
const MOMENT_LINES = {
  "confrontation:say_it_publicly": [
    "{name} said it in front of everyone, and did not soften any of it.",
    "{name} chose the crowded hour to say what they had been holding, and the room went quiet.",
    "{name} named what {other} had done, out loud, and let it stand."
  ],
  "confrontation:take_them_aside": [
    "{name} took {other} aside and told them plainly what it had cost.",
    "{name} found a moment with {other} away from the others and said the thing.",
    "{name} said it quietly, to {other} alone, which made it worse and better at once."
  ],
  "confrontation:let_it_go": [
    "{name} decided it was not worth carrying any further, and set it down.",
    "{name} looked at {other} and chose, deliberately, to let it go.",
    "Whatever {name} had been holding against {other}, they stopped holding it."
  ],
  "confrontation:walk_away_seething": [
    "{name} said nothing to {other}, and the nothing sat there all day.",
    "{name} swallowed it again, and added it to the pile.",
    "{name} walked away from {other} without a word, which was its own kind of answer."
  ],
  "confession:tell_them_everything": [
    "{name} told {other} all of it, and sat there afterwards with nothing left to carry.",
    "{name} said the whole thing out loud, to {other}, for the first time.",
    "{name} handed {other} the thing they had never given anyone."
  ],
  "confession:tell_them_part": [
    "{name} gave {other} the shape of it and kept the middle back.",
    "{name} told {other} a version they could live with having told.",
    "{name} said some of it to {other}, and watched to see how it landed."
  ],
  "confession:keep_it": [
    "{name} almost told {other}, and did not.",
    "{name} sat with it a while longer and decided it was still theirs.",
    "{name} opened their mouth and closed it, and {other} noticed nothing."
  ],
  "betrayal:say_it_out_loud": [
    "{name} said it where everyone could hear, and {other} had no answer prepared.",
    "{name} put what they knew about {other} into the open, and let the room do the rest.",
    "{name} told them all, and did not look away from {other} while doing it."
  ],
  "betrayal:let_it_slip": [
    "{name} let it slip to one person, in a way that could be denied later.",
    "{name} mentioned it casually to somebody who would not keep it casual.",
    "{name} said a little more than they meant to, to exactly the wrong listener."
  ],
  "betrayal:sit_on_it": [
    "{name} could have ruined {other} and chose not to, this time.",
    "{name} kept it, and let {other} keep believing nobody knew.",
    "{name} held what they had and watched {other} go about their day."
  ],
  "dialogue:genuine_moment": [
    "{name} and {other} got somewhere real, and both noticed it happening.",
    "{name} told {other} something true, and {other} did not waste it.",
    "The conversation between {name} and {other} went further than either expected."
  ],
  "dialogue:keep_it_light": [
    "{name} and {other} kept it easy, which is sometimes the whole point.",
    "{name} spent an hour with {other} talking about nothing in particular.",
    "{name} and {other} stayed on safe ground and enjoyed themselves anyway."
  ],
  "dialogue:test_the_water": [
    "{name} asked {other} a few careful questions and learned something.",
    "{name} steered the conversation toward what {other} might be keeping, and watched.",
    "{name} circled what they wanted to know with {other}, and did not ask it directly."
  ],
  "dialogue:open_up": [
    "{name} decided to stop being careful with {other}, and it worked.",
    "{name} let {other} further in than usual.",
    "{name} and {other} moved past politeness and into something else."
  ],
  "reflection:stay_the_course": [
    "{name} looked at the work in front of them and kept at it.",
    "{name} chose the same road again, deliberately.",
    "{name} put the day into it and expected nothing back."
  ],
  "reflection:just_watch": [
    "{name} let the day happen around them and asked nothing of it.",
    "{name} watched the world go by and kept their own counsel.",
    "{name} took the day off from having intentions."
  ]
};

/**
 * Narration for a resolved moment when no model wrote any.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {{kind: string, participants: string[]}} moment
 * @param {{id: string, label: string}} option
 * @param {(id: string) => any} lookup
 */
export function momentLine(world, agent, moment, option, lookup) {
  const key = Object.keys(MOMENT_LINES).find(k => k === `${moment.kind}:${option.id}`);
  const other = moment.participants[1] ? lookup(moment.participants[1]) : null;
  const ctx = {
    name: agent.name,
    title: agent.epithet ? `${agent.name} ${agent.epithet}` : agent.name,
    other: other ? other.name : "someone",
    region: "",
    goal: agent.goal.text,
    phase: world.clock.phase,
    day: world.clock.day
  };
  if (key) {
    const variants = MOMENT_LINES[key];
    return fill(pickFresh(world, variants), ctx);
  }
  // Options that cannot be covered by a fixed line carry their own narration.
  const custom = /** @type {any} */ (option).prose;
  if (custom) {
    return fill(custom, {
      ...ctx,
      oldgoal: agent.goal.text,
      newgoal: /** @type {any} */ (option).data?.newGoal ?? option.label
    });
  }
  // Last resort: describe the decision plainly rather than as a menu entry.
  return fill("{name} chose the option that read: " + option.label.replace(/\.$/, "") + ".", ctx);
}

/**
 * @type {Record<string, (string | {text: string, weight: number})[]>}
 */
const TEMPLATES = {
  rest: [
    "{name} slept through the {phase} in {region} and woke no clearer about anything.",
    "{name} found a corner of {region} and let the hours go by.",
    "{name} rested, and the world kept turning without them.",
    "{name} sat down in {region} and did not get up for a long while."
  ],
  rest_night: [
    "{name} slept, as most of {region} did.",
    "The {phase} took {name} under, and nothing was decided until morning.",
    "{name} turned in early in {region}, and the dark did the rest."
  ],
  travel: [
    "{name} left {from} and took the road toward {to}.",
    "{name} set out for {to}, with the {phase} coming on.",
    "{name} walked out of {from} without saying where they were going.",
    "{name} took the long way toward {to}, thinking."
  ],
  arrive: [
    "{name} came into {region} and looked around for a while.",
    "{name} arrived at {region} with the {phase} settling in.",
    "{name} reached {region} and stopped, because there was something to see."
  ],
  observe: [
    "{name} watched {region} from a distance and said nothing about it.",
    "{name} spent the {phase} paying attention to small things in {region}.",
    "{name} stood still in {region} long enough for the world to forget them.",
    "{name} took the measure of {region}, and found it wanting, or did not.",
    "{name} counted things in {region} that nobody else bothers to count.",
    "{name} sat with a thought in {region} and did not share it."
  ],
  contact_warm: [
    "{name} and {other} talked for a while in {region}, and it was easy.",
    "{name} found {other} in {region} and the afternoon went somewhere better than expected.",
    "{name} and {other} shared a quiet hour, and neither wanted to be the one to leave.",
    "{other} was glad to see {name}, and said so."
  ],
  contact_neutral: [
    "{name} and {other} crossed paths in {region} and exchanged the usual courtesies.",
    "{name} passed the time with {other}, neither of them saying much worth repeating.",
    "{name} and {other} talked about nothing in particular in {region}.",
    "{other} nodded at {name} in {region}, and that was most of it."
  ],
  contact_awkward: [
    "{name} and {other} spoke in {region} and both left it slightly worse.",
    "Something unsaid sat between {name} and {other} the whole time.",
    "{name} tried with {other} and did not quite manage it.",
    "{other} answered {name} in one or two words, and the air stayed cold."
  ],
  gossip: [
    "{name} leaned in and told {other} something they had no business knowing.",
    "{name} passed a story to {other} in {region}, with a few details moved around for effect.",
    "{name} was not supposed to tell {other} that, and told them anyway.",
    "Whatever {name} said to {other}, it changed how {other} looked at people."
  ],
  pursue_goal: [
    "{name} worked at {goal} until the light went.",
    "{name} made a little progress toward {goal}, which is how it always goes.",
    "{name} put the day into {goal} and had something small to show for it.",
    "{name} got further than yesterday on {goal}."
  ],
  goal_done: [
    "{name} finished it: {goal}",
    "After everything, {name} closed the last of the distance on {goal}",
    "{name} did what they said they would do — {goal}"
  ],
  explore: [
    "{name} went somewhere new and came back different about it.",
    "{name} found their way to {region} for the first time.",
    "{name} followed a road they had never taken, and it led to {region}.",
    "{name} wanted to see what was out there. {region} is what was out there."
  ],
  withdraw: [
    "{name} slipped away to {region} so nobody would have to look at them.",
    "{name} wanted to be somewhere with no one in it. {region} would do.",
    "{name} left without a word and spent the {phase} alone.",
    "{name} went quiet, and then went away, in that order."
  ],
  bond: [
    "{name} chose to spend the day with {other}, and was glad of it.",
    "{name} did something small and thoughtful for {other}, and did not mention it.",
    "{name} and {other} stayed together well past the {phase}.",
    "{name} told {other} a true thing about themselves."
  ],
  level: [
    "{name} has become someone it would be unwise to underestimate.",
    "Something has been building in {name}, and now it is out.",
    "{name} carries themselves differently than they did a few days ago."
  ],
  mood_bitter: [
    "{name} has been short with everyone in {region}.",
    "{name} is carrying something around and it shows.",
    "{name} laughed at something that was not funny."
  ],
  collapse: [
    "{name} collapsed where they stood, entirely spent.",
    "{name} could not take another step, and stopped being awake.",
    "{name} ran out of whatever it is that keeps a mind going."
  ]
};

/** Fill {placeholders} from context. Unknown placeholders are left visible to catch bugs.
 * @param {string} template
 * @param {Record<string, any>} ctx
 */
function fill(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const value = ctx[key];
    if (value === undefined || value === null) return `{${key}}`;
    // Goals arrive as full sentences; mid-sentence interpolation should not
    // produce a double full stop.
    return String(value).replace(/\.$/, "");
  });
}

/**
 * "the Lantern District" -> "Lantern District", for mid-sentence use.
 * @param {string} name
 */
function stripThe(name) {
  return name.startsWith("the ") ? name.slice(4) : name;
}

/**
 * Last-resort narration when a moment kind has no templates.
 * @param {import("../model/agent.js").Agent} agent
 * @param {Record<string, any>} vars
 * @returns {string}
 */
function fallbackLine(agent, vars) {
  return `${agent.name} did something in ${vars.region || "the world"} that nobody wrote down properly.`;
}
