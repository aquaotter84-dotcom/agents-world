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
 *
 * Repetition is the enemy of a living world. Two things keep it at bay. First,
 * every pool is deep: the busy kinds of act — gossip, working at a goal, walking
 * — carry ten or more variants, not the four they used to. Second, the choice
 * itself remembers. Each pool cycles through its variants before repeating any,
 * so a mind standing in the same place for a week does not say the same sentence
 * twice in a day. That recency memory lives on the world (`proseMemory`), which
 * means it is saved, resumed, and forked along with everything else rather than
 * being hidden state inside this module.
 */

import { weightedPick } from "../rng.js";

/**
 * How many recent picks a pool remembers before it may reuse one. Capped at
 * pool size minus one, so a full cycle is always possible: no variant can be
 * chosen twice until every other variant in its pool has been used.
 */
const RECENT_CEILING = 24;

/**
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {string} kind
 * @param {Record<string, any>} [vars]
 * @param {number} [toneWeight]
 */
export function phrase(world, agent, kind, vars = {}, toneWeight) {
  const variants = TEMPLATES[kind];
  if (!variants || !variants.length) {
    return fill(fallbackLine(agent, vars), { name: agent.name, region: stripThe(vars.region || "") });
  }
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
  const pool = variants.map(v => (typeof v === "string" ? v : v.text));
  let text;
  if (toneWeight) {
    // A weighted pick is a deliberate choice of register, not a coin toss;
    // remembering it would fight the weights.
    const chosen = weightedPick(world.rng, variants, v => (typeof v === "string" ? 1 : v.weight));
    text = typeof chosen === "string" ? chosen : chosen.text;
    remember(world, `phrase:${kind}`, pool, text);
  } else {
    text = pickFresh(world, `phrase:${kind}`, pool);
  }
  return fill(text, ctx);
}

/**
 * Choose a variant that has not been used recently, and remember the choice.
 *
 * The memory is per pool, so a busy pool like gossip does not exhaust the
 * variants belonging to a quiet one. Once a pool has worked through everything
 * it knows, its memory resets and the cycle starts again — which is why a pool
 * with ten variants produces ten different sentences in a row rather than nine
 * and then a coin toss.
 *
 * @param {import("../model/world.js").World} world
 * @param {string} key
 * @param {string[]} pool
 */
export function pickFresh(world, key, pool) {
  const seen = recentList(world, key);
  let fresh = pool.filter(p => !seen.includes(p));
  if (!fresh.length) {
    seen.length = 0;
    fresh = pool;
  }
  const chosen = world.rng.pick(fresh);
  remember(world, key, pool, chosen);
  return chosen;
}

/**
 * @param {import("../model/world.js").World} world
 * @param {string} key
 * @param {string[]} pool
 * @param {string} text
 */
function remember(world, key, pool, text) {
  const seen = recentList(world, key);
  // Weighted picks can land on the same variant twice; only the newest counts.
  const at = seen.indexOf(text);
  if (at !== -1) seen.splice(at, 1);
  seen.push(text);
  const cap = Math.max(1, Math.min(RECENT_CEILING, pool.length - 1));
  while (seen.length > cap) seen.shift();
}

/**
 * @param {import("../model/world.js").World} world
 * @param {string} key
 * @returns {string[]}
 */
function recentList(world, key) {
  if (!world.proseMemory) world.proseMemory = {};
  if (!world.proseMemory[key]) world.proseMemory[key] = [];
  return world.proseMemory[key];
}

/**
 * Engine-written narration for a moment, used when no model answered.
 *
 * Moment options carry a label, but a label is a menu entry — "Say it in front
 * of everyone" is not a sentence about the world. Without these lines an
 * offline world reads as a transcript of decisions rather than a story.
 *
 * Every option in the engine either appears here by `kind:optionId`, or carries
 * its own `prose` on the option itself. The dynamic goal options are the ones
 * that do the latter: their labels are generated from the goal tables, so they
 * cannot be keyed by id.
 * @type {Record<string, string[]>}
 */
const MOMENT_LINES = {
  "confrontation:say_it_publicly": [
    "{name} said it in front of everyone, and did not soften any of it.",
    "{name} chose the crowded hour to say what they had been holding, and the room went quiet.",
    "{name} named what {other} had done, out loud, and let it stand.",
    "{name} put it to {other} with an audience, which is where that kind of thing belongs.",
    "{name} said the unsayable in front of witnesses, and watched what it did to the room."
  ],
  "confrontation:take_them_aside": [
    "{name} took {other} aside and told them plainly what it had cost.",
    "{name} found a moment with {other} away from the others and said the thing.",
    "{name} said it quietly, to {other} alone, which made it worse and better at once.",
    "{name} waited until {other} was alone, and then was not gentle about it.",
    "{name} spoke to {other} in a low voice, and the low voice is what {other} remembered."
  ],
  "confrontation:let_it_go": [
    "{name} decided it was not worth carrying any further, and set it down.",
    "{name} looked at {other} and chose, deliberately, to let it go.",
    "Whatever {name} had been holding against {other}, they stopped holding it.",
    "{name} put the matter down like something heavy and did not pick it up again.",
    "{name} forgave {other}, or at least stopped keeping score."
  ],
  "confrontation:walk_away_seething": [
    "{name} said nothing to {other}, and the nothing sat there all day.",
    "{name} swallowed it again, and added it to the pile.",
    "{name} walked away from {other} without a word, which was its own kind of answer.",
    "{name} kept {other} waiting for an answer that was never coming.",
    "{name} left it unsaid in front of {other}, and it will be heavier next time."
  ],
  "confession:tell_them_everything": [
    "{name} told {other} all of it, and sat there afterwards with nothing left to carry.",
    "{name} said the whole thing out loud, to {other}, for the first time.",
    "{name} handed {other} the thing they had never given anyone.",
    "{name} told {other} the worst of it first, and then the rest, and did not stop.",
    "{name} gave {other} everything they had been keeping, and took the risk of it."
  ],
  "confession:tell_them_part": [
    "{name} gave {other} the shape of it and kept the middle back.",
    "{name} told {other} a version they could live with having told.",
    "{name} said some of it to {other}, and watched to see how it landed.",
    "{name} offered {other} the edge of the truth and waited.",
    "{name} told {other} as much as could be told and no more."
  ],
  "confession:keep_it": [
    "{name} almost told {other}, and did not.",
    "{name} sat with it a while longer and decided it was still theirs.",
    "{name} opened their mouth and closed it, and {other} noticed nothing.",
    "{name} came close enough to telling {other} that they felt the weight of it.",
    "{name} decided that {other} was not the one, and that nobody might be."
  ],
  "betrayal:say_it_out_loud": [
    "{name} said it where everyone could hear, and {other} had no answer prepared.",
    "{name} put what they knew about {other} into the open, and let the room do the rest.",
    "{name} told them all, and did not look away from {other} while doing it.",
    "{name} used what {other} had trusted them with, in front of as many witnesses as possible.",
    "{name} burned it down in public, and the field was level afterwards, which was the point."
  ],
  "betrayal:let_it_slip": [
    "{name} let it slip to one person, in a way that could be denied later.",
    "{name} mentioned it casually to somebody who would not keep it casual.",
    "{name} said a little more than they meant to, to exactly the wrong listener.",
    "{name} let the thing fall out of their mouth and did not chase it.",
    "{name} traded it away in a whisper and called it an accident."
  ],
  "betrayal:sit_on_it": [
    "{name} could have ruined {other} and chose not to, this time.",
    "{name} kept it, and let {other} keep believing nobody knew.",
    "{name} held what they had and watched {other} go about their day.",
    "{name} had the thing in their hand all day and never opened it.",
    "{name} decided against {other}, and told nobody, including themselves."
  ],
  "dialogue:genuine_moment": [
    "{name} and {other} got somewhere real, and both noticed it happening.",
    "{name} told {other} something true, and {other} did not waste it.",
    "The conversation between {name} and {other} went further than either expected.",
    "{name} and {other} stopped performing at each other and said the true thing.",
    "{name} and {other} arrived somewhere neither of them had planned to go."
  ],
  "dialogue:keep_it_light": [
    "{name} and {other} kept it easy, which is sometimes the whole point.",
    "{name} spent an hour with {other} talking about nothing in particular.",
    "{name} and {other} stayed on safe ground and enjoyed themselves anyway.",
    "{name} and {other} made each other laugh and learned nothing.",
    "{name} and {other} passed the {phase} agreeably, on purpose."
  ],
  "dialogue:test_the_water": [
    "{name} asked {other} a few careful questions and learned something.",
    "{name} steered the conversation toward what {other} might be keeping, and watched.",
    "{name} circled what they wanted to know with {other}, and did not ask it directly.",
    "{name} sounded {other} out with a story of their own, and listened carefully to the answer.",
    "{name} asked {other} about someone else and learned something about both of them."
  ],
  "dialogue:open_up": [
    "{name} decided to stop being careful with {other}, and it worked.",
    "{name} let {other} further in than usual.",
    "{name} and {other} moved past politeness and into something else.",
    "{name} told {other} the part they usually leave out, on purpose.",
    "{name} dropped the guard with {other} and could not immediately pick it back up."
  ],
  "reflection:stay_the_course": [
    "{name} looked at the work in front of them and kept at it.",
    "{name} chose the same road again, deliberately.",
    "{name} put the day into it and expected nothing back.",
    "{name} kept their head down and let the {phase} go by.",
    "{name} stayed with it, because staying with it is most of the work.",
    "{name} gave the day to the thing they had already decided to give it to.",
    "{name} stayed the course through {region}, one more day of it.",
    "{name} did not reconsider, which is itself a decision.",
    "{name} worked the way you work when nobody is watching and nobody will.",
    "{name} kept the promise they had made to themselves and told no one about it.",
    "{name} spent {region}'s whole {phase} on the same stubborn thing.",
    "{name} chose the unglamorous option, as they had every day that week."
  ],
  "reflection:just_watch": [
    "{name} let the day happen around them and asked nothing of it.",
    "{name} watched the world go by and kept their own counsel.",
    "{name} took the day off from having intentions.",
    "{name} did nothing in particular, thoroughly.",
    "{name} let {region} do the talking.",
    "{name} sat at the edge of {region} and let the {phase} pass.",
    "{name} had nowhere to be and went there slowly.",
    "{name} kept still, and the world moved without them for once.",
    "{name} spent the {phase} in {region} without deciding anything at all.",
    "{name} watched how other minds solved the day and took notes."
  ],
  // The goal-change options are generated from the goal tables, so their ids are
  // positional rather than named. A mind has three ways of phrasing the same
  // abandonment, which is enough to keep a churning mind from sounding like a
  // stuck record.
  "reflection:new_goal_0": [
    "{name} set down {oldgoal} and took up something else instead: {newgoal}.",
    "{name} let {oldgoal} go, which took longer than admitting it should, and began {newgoal}.",
    "{name} put {oldgoal} aside unfinished and started {newgoal}.",
    "There was a moment in {region} where {name} chose {newgoal} over {oldgoal}."
  ],
  "reflection:new_goal_1": [
    "{name} set down {oldgoal} and took up something else instead: {newgoal}.",
    "{name} gave up {oldgoal} without ceremony and turned to {newgoal}.",
    "{name} decided {oldgoal} had stopped being worth it, and {newgoal} had not.",
    "{name} left {oldgoal} where it lay and began again with {newgoal}."
  ],
  "reflection:new_goal_2": [
    "{name} set down {oldgoal} and took up something else instead: {newgoal}.",
    "What {name} wanted changed somewhere in {region}, from {oldgoal} to {newgoal}.",
    "{name} stopped pretending to care about {oldgoal} and began {newgoal}.",
    "{name} traded one long endeavour for another: {oldgoal} for {newgoal}."
  ]
};

/**
 * Narration for a resolved moment when no model wrote any.
 * @param {import("../model/world.js").World} world
 * @param {import("../model/agent.js").Agent} agent
 * @param {{kind: string, participants: string[], context?: {region?: string}}} moment
 * @param {{id: string, label: string, prose?: string, data?: Record<string, any>}} option
 * @param {(id: string) => any} lookup
 */
export function momentLine(world, agent, moment, option, lookup) {
  const key = `${moment.kind}:${option.id}`;
  const other = moment.participants[1] ? lookup(moment.participants[1]) : null;
  const ctx = {
    name: agent.name,
    title: agent.epithet ? `${agent.name} ${agent.epithet}` : agent.name,
    other: other ? other.name : "someone",
    // Where it happened, as this mind knows it. The context carries the region
    // the moment was built in; by the time the line is written the mind may have
    // moved, so the moment's own context is the honest source.
    region: stripThe(moment.context?.region || ""),
    goal: agent.goal.text,
    // Only the goal-change lines use these, but keeping them in the shared
    // context means a pool line can name the ambition it is leaving behind.
    oldgoal: agent.goal.text,
    newgoal: (option.data && option.data.newGoal) || option.label,
    phase: world.clock.phase,
    day: world.clock.day
  };
  const variants = MOMENT_LINES[key];
  if (variants) {
    return fill(pickFresh(world, `moment:${key}`, variants), ctx);
  }
  // Options that cannot be covered by a fixed line carry their own narration.
  // These are the generated ones — a new goal's label is assembled from the goal
  // tables, so there is no id to key on and the prose has to travel with it.
  const custom = option.prose;
  if (custom) {
    return fill(custom, ctx);
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
    "{name} sat down in {region} and did not get up for a long while.",
    "{name} put their back against a wall in {region} and closed their eyes.",
    "{name} took the weight off their feet and thought about nothing in particular.",
    "{name} lost the {phase} to a nap and did not regret it.",
    "{name} lay down in {region} and let the noise of the world go on without them.",
    "{name} stopped moving long enough for the tiredness to catch up.",
    "{name} slept badly, in the way of someone with something on their mind."
  ],
  rest_night: [
    "{name} slept, as most of {region} did.",
    "The {phase} took {name} under, and nothing was decided until morning.",
    "{name} turned in early in {region}, and the dark did the rest.",
    "{name} slept the {phase} through without dreaming anything they could remember.",
    "{name} was asleep before the last of the light went.",
    "{name} lay awake a while in {region}, and then stopped being awake at all."
  ],
  travel: [
    "{name} left {from} and took the road toward {to}.",
    "{name} set out for {to}, with the {phase} coming on.",
    "{name} walked out of {from} without saying where they were going.",
    "{name} took the long way toward {to}, thinking.",
    "{name} walked the whole way to {to} and arrived no lighter.",
    "{name} went by the old path toward {to}, where the ground is better.",
    "{name} left {from} mid-sentence and had not come back by nightfall.",
    "{name} made for {to} at a pace that suggested they wanted to be there.",
    "{name} crossed from {from} to {to} and did not look behind them once.",
    "{name} went out with the {phase} at their back, meaning to reach {to}."
  ],
  arrive: [
    "{name} came into {region} and looked around for a while.",
    "{name} arrived at {region} with the {phase} settling in.",
    "{name} reached {region} and stopped, because there was something to see.",
    "{name} came to {region} quietly, and was noticed anyway.",
    "{name} walked into {region} as though they had always been coming here.",
    "{name} reached {region} and stood at the edge of it, deciding."
  ],
  observe: [
    "{name} watched {region} from a distance and said nothing about it.",
    "{name} spent the {phase} paying attention to small things in {region}.",
    "{name} stood still in {region} long enough for the world to forget them.",
    "{name} took the measure of {region}, and found it wanting, or did not.",
    "{name} counted things in {region} that nobody else bothers to count.",
    "{name} sat with a thought in {region} and did not share it.",
    "{name} kept to the edge of {region} and watched who came and went.",
    "{name} learned the shape of {region} and told nobody what they had learned.",
    "{name} waited in {region} for something to happen, and nothing did.",
    "{name} paid {region} the kind of attention other minds pay to each other."
  ],
  contact_warm: [
    "{name} and {other} talked for a while in {region}, and it was easy.",
    "{name} found {other} in {region} and the afternoon went somewhere better than expected.",
    "{name} and {other} shared a quiet hour, and neither wanted to be the one to leave.",
    "{other} was glad to see {name}, and said so.",
    "{name} and {other} found the same thing funny at the same moment.",
    "{name} stayed in {region} longer than they meant to, because {other} was there.",
    "{name} and {other} talked until the {phase} was gone.",
    "{other} said something true to {name}, and {name} kept it.",
    "{name} and {other} agreed about something neither of them could name afterwards."
  ],
  contact_neutral: [
    "{name} and {other} crossed paths in {region} and exchanged the usual courtesies.",
    "{name} passed the time with {other}, neither of them saying much worth repeating.",
    "{name} and {other} talked about nothing in particular in {region}.",
    "{other} nodded at {name} in {region}, and that was most of it.",
    "{name} and {other} stood in {region} and watched the same thing happen.",
    "{name} asked {other} about the weather in another place and got an answer.",
    "{name} and {other} spent a while in {region} pleasantly, and that was all."
  ],
  contact_awkward: [
    "{name} and {other} spoke in {region} and both left it slightly worse.",
    "Something unsaid sat between {name} and {other} the whole time.",
    "{name} tried with {other} and did not quite manage it.",
    "{other} answered {name} in one or two words, and the air stayed cold.",
    "{name} found {other} in {region} and wished they had gone the other way.",
    "{other} said one thing and {name} answered a different one.",
    "{name} and {other} filled {region} with words nobody needed."
  ],
  gossip: [
    "{name} leaned in and told {other} something they had no business knowing.",
    "{name} passed a story to {other} in {region}, with a few details moved around for effect.",
    "{name} was not supposed to tell {other} that, and told them anyway.",
    "Whatever {name} said to {other}, it changed how {other} looked at people.",
    "{name} gave {other} news of a third mind, and none of it was kind.",
    "{name} handed it to {other} sideways, the way it is done in {region}.",
    "{name} and {other} put their heads together, which is never about nothing.",
    "{name} traded {other} something that was not theirs to trade.",
    "In {region}, {name} told {other} what they had heard and what they had decided to believe.",
    "{name} made {other} promise not to repeat it, which {other} will."
  ],
  // A retelling is the second sentence of a gossip line: the first sentence has
  // already named the speaker, the listener and the place. These deliberately
  // name nobody, so a line never says "Pim told Cass… Pim told Cass that…", and
  // they carry the claim rather than the fact of the telling.
  spread_loud: [
    "Nothing was left out: {claim}.",
    "Told straight, with every detail still attached: {claim}.",
    "Firsthand, or near enough: {claim}.",
    "The whole of it, unsoftened: {claim}.",
    "Told plainly, with no kind words attached: {claim}."
  ],
  spread_soft: [
    "The details had shifted in the telling, but the shape of it held: {claim}.",
    "A version passed along: {claim}, or near enough.",
    "Told as though it were settled: {claim}.",
    "What was heard was that {claim}, more or less.",
    "It arrived third-hand and confident: {claim}."
  ],
  spread_garbled: [
    "Nobody tells it the same way twice. Half of them say {claim}. The other half say it never happened.",
    "By then it had worn down to this: {claim}, possibly.",
    "It reached them as these things do, in a shape nobody could say the origin of: {claim}, or something near it.",
    "The story had been through several hands by then. As it arrived: {claim}, though that was never confirmed."
  ],
  pursue_goal: [
    "{name} worked at {goal} until the light went.",
    "{name} made a little progress toward {goal}, which is how it always goes.",
    "{name} put the day into {goal} and had something small to show for it.",
    "{name} got further than yesterday on {goal}.",
    "{name} kept at {goal}, the way you keep at a thing that will not be hurried.",
    "{name} did the next piece of {goal} and no more than the next piece.",
    "{name} gave {goal} the hours other minds gave to talking.",
    "{name} worked on {goal} without telling anyone, which is how they prefer it.",
    "{name} chipped away at {goal} and lost track of the {phase} doing it.",
    "{name} spent the {phase} on {goal} and stopped when it stopped making sense."
  ],
  goal_done: [
    "{name} finished it: {goal}",
    "After everything, {name} closed the last of the distance on {goal}",
    "{name} did what they said they would do — {goal}",
    "{name} took the last step of {goal} and stood there a moment.",
    "It was done — {goal}. {name} did not say much about it."
  ],
  explore: [
    "{name} went somewhere new and came back different about it.",
    "{name} found their way to {region} for the first time.",
    "{name} followed a road they had never taken, and it led to {region}.",
    "{name} wanted to see what was out there. {region} is what was out there.",
    "{name} went out past {region} where the map gets vague.",
    "{name} picked a direction nobody else bothers with and followed it.",
    "{name} walked until the landmarks were unfamiliar, which took most of the {phase}.",
    "{name} went looking for the edge of things and found {region} instead."
  ],
  withdraw: [
    "{name} slipped away to {region} so nobody would have to look at them.",
    "{name} wanted to be somewhere with no one in it. {region} would do.",
    "{name} left without a word and spent the {phase} alone.",
    "{name} went quiet, and then went away, in that order.",
    "{name} chose the emptiest part of {region} and stayed there.",
    "{name} stopped answering for a while and nobody came looking.",
    "{name} took themselves off to {region} without leaving a reason behind.",
    "{name} wanted the day to be over and treated it accordingly."
  ],
  bond: [
    "{name} chose to spend the day with {other}, and was glad of it.",
    "{name} did something small and thoughtful for {other}, and did not mention it.",
    "{name} and {other} stayed together well past the {phase}.",
    "{name} told {other} a true thing about themselves.",
    "{name} kept {other} company through the whole {phase} without being asked.",
    "{name} and {other} made a plan together, and meant it.",
    "{name} laughed at {other}'s joke before {other} had finished it."
  ],
  level: [
    "{name} has become someone it would be unwise to underestimate.",
    "Something has been building in {name}, and now it is out.",
    "{name} carries themselves differently than they did a few days ago.",
    "Whatever {name} has been working toward is starting to show.",
    "{name} is harder to surprise than they used to be."
  ],
  mood_bitter: [
    "{name} has been short with everyone in {region}.",
    "{name} is carrying something around and it shows.",
    "{name} laughed at something that was not funny.",
    "{name} answered everything in {region} with one syllable.",
    "{name} was polite to everyone in {region} and meant none of it."
  ],
  collapse: [
    "{name} collapsed where they stood, entirely spent.",
    "{name} could not take another step, and stopped being awake.",
    "{name} ran out of whatever it is that keeps a mind going.",
    "{name} sat down mid-stride, and that was the end of the day's work.",
    "{name}'s eyes closed on their own, and nothing would open them again for a while."
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
