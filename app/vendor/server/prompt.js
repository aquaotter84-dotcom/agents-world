/**
 * Turning a moment into a question worth asking a model.
 *
 * Two rules shape everything here.
 *
 * First, the prompt contains only what *this* mind knows. The engine resolves
 * one mind's moment at a time, and a mind's private context is assembled from
 * its own memory and its own side of each relationship. One agent's prompt can
 * never leak another agent's secret.
 *
 * Second, the model chooses between options rather than inventing outcomes. It
 * gets the menu, the reasons behind each dish, and the consequences are already
 * the engine's business. That is what keeps a language model in the loop without
 * letting it corrupt the simulation.
 */

import { agentById, regionName } from "../engine/model/world.js";

/**
 * @typedef {import("../engine/model/world.js").Moment} Moment
 */

/**
 * Build a periodic open-plan prompt for one of the two cognition-pilot minds.
 * Context is assembled only from this mind's own memory, beliefs and side of
 * its relationships; the action grammar is bounded, but no intent is preselected.
 * @param {import("../engine/model/world.js").World} world
 * @param {Moment} moment
 */
function buildCognitionPrompt(world, moment) {
  const agent = agentById(world, moment.agentId);
  if (!agent) return { messages: [], maxTokens: 0 };
  const ctx = moment.context;
  const castSize = world.agents.filter(a => !a.retired).length;
  const lines = [
    `You are ${ctx.agentName}, one of ${castSize} minds living in this world.`,
    `You are ${agent.personality.toLowerCase()}. ${agent.backstory}`,
    `You are a ${agent.class.toLowerCase()} by nature: ${flavour(agent.class)}`,
    "",
    `Right now: ${ctx.region}, ${ctx.phase}. ${ctx.regionBlurb}`,
    `Your condition: ${ctx.stateLine}`,
    `Your current goal: ${ctx.goal} (${Math.round((ctx.goalProgress || 0) * 100)}% complete).`,
    "",
    "This is your private, persistent inner record. Beliefs can be mistaken; do not treat them as omniscient facts."
  ];
  if (ctx.memorySummary) lines.push(`Your memory summary: ${ctx.memorySummary}`);
  if (ctx.privatePriorities && ctx.privatePriorities.length) {
    lines.push("Priorities you previously authored:");
    for (const priority of ctx.privatePriorities.slice(0, 3)) lines.push(`  - ${priority}`);
  }
  if (ctx.privateBeliefs && ctx.privateBeliefs.length) {
    lines.push("Private beliefs you currently hold:");
    for (const belief of ctx.privateBeliefs.slice(0, 8)) lines.push(`  - ${belief}`);
  }
  if (ctx.memories && ctx.memories.length) {
    lines.push("Recent memories that belong to you:");
    for (const memory of ctx.memories.slice(0, 6)) lines.push(`  - ${memory}`);
  }
  if (ctx.knownMinds && ctx.knownMinds.length) {
    lines.push("Other living minds (some are elsewhere):");
    for (const other of ctx.knownMinds.slice(0, 14)) {
      lines.push(`  - ${other.name} — ${other.region}; to you, ${other.relation}.`);
    }
  }
  if (ctx.project) {
    lines.push(`Shared work: ${ctx.project.title}, ${ctx.project.status}, ${Math.round(ctx.project.progress)}% complete. Next milestone: ${ctx.project.nextMilestone}.`);
  }
  lines.push(
    "",
    "Choose for yourself. No engine intent has been selected for you, and there is no scene-option menu. Propose a near-term plan and one action token. The engine alone validates targets and applies consequences; never invent effect values.",
    "Allowed ACTION tokens: rest, observe, explore, pursue_goal, withdraw, seek_company, forge_bond, grant_favour, gossip, project_contribute, project_help, project_interfere.",
    "TARGET is the exact name of another living mind for seek_company, forge_bond, grant_favour, gossip, project_help or project_interfere; otherwise write NONE. For gossip, ABOUT is the different mind the opinion concerns. For project_help choose someone already working; for project_interfere there must be a real grievance.",
    "",
    "Reply with these lines only. Keep private updates short; use NONE when you have nothing to add.",
    "PLAN: <one sentence about what you intend and why>",
    "ACTION: <one allowed action token>",
    "TARGET: <exact mind name, or NONE>",
    "ABOUT: <gossip subject's exact mind name, or NONE>",
    "PRIORITY: <one self-authored priority, or NONE>",
    "BELIEF: <one private belief you want to retain, or NONE>",
    "BELIEF_CONFIDENCE: <number from 0 to 1>",
    "BELIEF_ABOUT: <exact mind name the belief concerns, or NONE>",
    "SUMMARY: <a faithful compact update to your private memory summary, or NONE>",
    "THOUGHT: <one short private first-person thought, or NONE>"
  );
  return {
    messages: [
      { role: "system", content: lines.join("\n") },
      { role: "user", content: `What does ${agent.name} choose to do next?` }
    ],
    maxTokens: 340
  };
}

/**
 * Human-readable glosses for the approach grammar, for the prompt only.
 * @type {Record<string, string>}
 */
const APPROACH_GLOSS = {
  focus: "work at it alone, steadily, without asking anyone for anything",
  study: "read, dig, and cross-reference — slower, but it changes what you know",
  practice: "drill the part of it you are worst at, in front of whoever is around",
  recruit: "ask someone here to take it on with you",
  consult: "put it to someone here and see what they know",
  explore: "go somewhere else and work on it from there",
  organise: "turn your own effort into shared work on the North Wall",
  push_through: "go at it flat out, and take the risk that it comes apart",
  undermine: "damage wall work you hold a real grievance against"
};

/**
 * Build the prompt for a mind proposing how it means to pursue its own goal.
 *
 * The model gets the list of approaches the engine can actually resolve from
 * where this mind is standing — never a wider one — and answers with a token
 * plus its own words. It supplies no numbers and no consequences.
 *
 * @param {import("../engine/model/world.js").World} world
 * @param {Moment} moment
 */
function buildGoalApproachPrompt(world, moment) {
  const agent = agentById(world, moment.agentId);
  if (!agent) return { messages: [], maxTokens: 0 };
  const ctx = moment.context;
  const methods = ctx.availableMethods || [];
  const lines = [
    `You are ${ctx.agentName}, one of ${world.agents.filter(a => !a.retired).length} minds living in a small, cold world.`,
    `You are ${agent.personality.toLowerCase()}. ${agent.backstory}`,
    `You are ${agent.class.toLowerCase()} by nature: ${flavour(agent.class)}`,
    "",
    `Right now: ${ctx.region}, ${ctx.phase}. ${ctx.regionBlurb}`,
    `Your condition: ${ctx.stateLine}`,
    `What you are for: ${ctx.goal} — about ${Math.round((ctx.goalProgress || 0) * 100)}% of the way there.`,
    ""
  ];
  if (ctx.memories && ctx.memories.length) {
    lines.push("What you remember about this:");
    for (const memory of ctx.memories.slice(0, 4)) lines.push(`  - ${memory}`);
    lines.push("");
  }
  if (ctx.atProjectSite && ctx.project) {
    lines.push(`The North Wall work is happening right here: ${Math.round(ctx.project.progress)}% built.`);
    lines.push("");
  }
  lines.push(
    moment.question,
    "",
    "Pick ONE approach token from this list — these are the only ones possible from where you stand:",
    methods.map(m => `  - ${m}: ${APPROACH_GLOSS[m] || m}`).join("\n") || "  - focus",
    "",
    "The engine alone decides what your approach costs and what it produces, from your temperament and this place.",
    "Never invent numbers, progress, or consequences. Describe the approach in your own words.",
    "",
    "Answer with exactly two lines and nothing else.",
    "APPROACH: <one or two vivid sentences, third person, about how you go at it today and what it costs you>",
    "METHOD: <exactly one token from the list above>",
    "Optionally add a third line, THOUGHT: <one short first-person sentence you would never say aloud>."
  );
  return {
    messages: [
      { role: "system", content: lines.join("\n") },
      { role: "user", content: `How does ${agent.name} go after it today?` }
    ],
    maxTokens: 220
  };
}

/**
 * Build the chat messages for a moment.
 * @param {import("../engine/model/world.js").World} world
 * @param {Moment} moment
 * @returns {{messages: {role: string, content: string}[], maxTokens: number}}
 */
export function buildPrompt(world, moment) {
  if (moment.kind === "cognition") return buildCognitionPrompt(world, moment);
  if (moment.kind === "goal_approach") return buildGoalApproachPrompt(world, moment);
  const agent = agentById(world, moment.agentId);
  if (!agent) return { messages: [], maxTokens: 0 };
  const ctx = moment.context;

  const lines = [];
  const castSize = world.agents.filter(a => !a.retired).length;
  lines.push(`You are ${ctx.agentName}, one of ${castSize} minds living in a small, cold world.`);
  lines.push(`You are ${agent.personality.toLowerCase()}. ${agent.backstory}`);
  lines.push(`You are ${agent.class.toLowerCase()} by nature: ${flavour(agent.class)}`);
  lines.push("");
  lines.push(`Right now: ${ctx.region}, ${ctx.phase}. ${ctx.regionBlurb}`);
  lines.push(`Your condition: ${ctx.stateLine}`);
  lines.push(`What you are for: ${ctx.goal}`);
  if (ctx.standingWord && ctx.standingWord !== "unknown") {
    lines.push(`What the room thinks of you: ${ctx.standingWord}.`);
  }

  if (ctx.targetName) {
    lines.push("");
    const who = ctx.targetPersonality ? ctx.targetPersonality.toLowerCase() : "hard to read";
    lines.push(ctx.together
      ? `${ctx.targetName} is here with you. ${ctx.targetName} is ${who}.`
      : `${ctx.targetName} is in ${ctx.targetRegion || "another part of the world"}. ${ctx.targetName} is ${who}.`);
    lines.push(`You regard ${ctx.targetName} as ${ctx.relationPhrase}.`);
    if (ctx.targetMood) lines.push(`${ctx.targetName} seems ${ctx.targetMood}.`);
    if (ctx.targetStandingWord && ctx.targetStandingWord !== "unknown") {
      lines.push(`Around here, ${ctx.targetName} is ${ctx.targetStandingWord}.`);
    }
  }

  if (ctx.grievance) {
    lines.push("");
    lines.push(`What you have not let go of: ${ctx.grievance}`);
  }
  if (ctx.secretText) {
    lines.push("");
    lines.push(`The thing you have never said out loud: ${ctx.secretText}`);
  }
  if (ctx.memories && ctx.memories.length) {
    lines.push("");
    lines.push("What you remember about this:");
    for (const memory of ctx.memories.slice(0, 4)) lines.push(`  - ${memory}`);
  }

  lines.push("");
  lines.push(moment.question);
  lines.push("");
  lines.push("Your options:");
  moment.options.forEach((option, index) => {
    lines.push(`  ${index + 1}. ${option.label}`);
  });
  lines.push("");
  lines.push(
    "Answer with exactly two lines and nothing else.\n" +
      "CHOICE: <the number of the option you take>\n" +
      "PROSE: <one or two vivid sentences in third person about what you do, and what it costs or gains you. No preamble, no explanation, no quotes. Never mention that you are an AI.>\n" +
      "Optionally add a third line, THOUGHT: <one short first-person sentence you would never say aloud>."
  );

  return {
    messages: [
      { role: "system", content: lines.join("\n") },
      { role: "user", content: `What does ${agent.name} do?` }
    ],
    maxTokens: 260
  };
}

/**
 * Parse a model's reply into the shape `resolveMoment` expects.
 *
 * Deliberately forgiving: models reformat, number differently, or drop the
 * choice line entirely. Anything unparseable becomes `{}`, which the engine
 * treats as "no answer" and decides for itself.
 *
 * @param {string|null} raw
 * @param {Moment} moment
 * @returns {{optionId?: string, prose?: string, thought?: string, action?: string, target?: string, about?: string, plan?: string, priority?: string, belief?: string, beliefConfidence?: number, beliefAbout?: string, summary?: string, approach?: string, method?: string}}
 */
export function parseReply(raw, moment) {
  if (!raw) return {};
  if (moment.kind === "cognition") return parseCognitionReply(raw);
  if (moment.kind === "goal_approach") return parseApproachReply(raw);
  const text = String(raw).trim();

  /** @type {{optionId?: string, prose?: string, thought?: string}} */
  const out = {};

  const choice = text.match(/^\s*CHOICE\s*[:\-]\s*(\d+)/im);
  if (choice) {
    const index = parseInt(choice[1], 10) - 1;
    if (index >= 0 && index < moment.options.length) out.optionId = moment.options[index].id;
  }
  if (!out.optionId) {
    // No usable choice line: see whether the prose names one of the options.
    const matched = moment.options.find(o => new RegExp(escapeRegex(o.label), "i").test(text));
    if (matched) out.optionId = matched.id;
  }

  const prose = text.match(/^\s*PROSE\s*[:\-]\s*([\s\S]*?)(?=^\s*(?:THOUGHT|CHOICE)\s*[:\-]|$)/im);
  if (prose) out.prose = tidy(prose[1]);
  else {
    // No PROSE line: take any sentence that isn't bookkeeping.
    const body = text
      .split("\n")
      .filter(line => !/^\s*(CHOICE|THOUGHT|PROSE)\s*[:\-]/i.test(line))
      .join(" ")
      .trim();
    if (body) out.prose = tidy(body);
  }

  const thought = text.match(/^\s*THOUGHT\s*[:\-]\s*(.+)$/im);
  if (thought) out.thought = tidy(thought[1]);

  return out;
}

/**
 * Scaffolding and refusals. A model that answers "I can't do that" or starts
 * explaining the prompt has not proposed an approach, and letting that text
 * through would put the scaffolding into the world's record and the mind's own
 * memory — the same leak the app's reply sanitizer exists to catch.
 * @type {RegExp}
 */
const NOT_AN_APPROACH = /\bas an ai\b|\blanguage model\b|\bi (can'?t|cannot|am unable to)\b|\bi'?m (just|only|not able)\b|\bi (need|must|should|will|have to) (to )?(respond|provide|write|generate)\b|\bhere (is|are) (the|your)\b|^\s*(sorry|apologies)\b|\bi don'?t have (a|any) (body|physical)\b|\bin third person\b|\bprovide one (short|vivid) sentence\b|\bnever mention\b/i;

/**
 * Parse a proposal answer: an approach in the mind's own words plus one token
 * from the grammar. If no METHOD line arrives, the prose is scanned for a token
 * so a slightly reworded reply still lands instead of being thrown away.
 * @param {string|null} raw
 * @param {string[]} [offered]
 * @returns {{approach?: string, method?: string, thought?: string}}
 */
export function parseApproachReply(raw, offered) {
  if (!raw) return {};
  const text = String(raw).trim();
  /** @param {string} label */
  const field = label => {
    const match = text.match(new RegExp(`^\\s*${label}\\s*[:\\-]\\s*(.*)$`, "im"));
    return match ? tidy(match[1]) : "";
  };

  /** @type {ReturnType<typeof parseApproachReply>} */
  const out = {};
  const approach = field("APPROACH");
  if (approach && !NOT_AN_APPROACH.test(approach)) out.approach = approach;
  const thought = field("THOUGHT");
  if (thought && !NOT_AN_APPROACH.test(thought)) out.thought = thought;

  let method = field("METHOD").toLowerCase().replace(/[\s-]+/g, "_");
  if (!method) {
    const grammar = offered && offered.length ? offered : Object.keys(APPROACH_GLOSS);
    method = grammar.find(token => new RegExp(`\\b${escapeRegex(token.replace(/_/g, "[ _-]"))}\\b`, "i").test(text)) || "";
  }
  if (method) out.method = method;
  if (!out.approach) {
    const body = text
      .split("\n")
      .filter(line => !/^\s*(APPROACH|METHOD|THOUGHT)\s*[:\-]/i.test(line))
      .join(" ")
      .trim();
    if (body && !NOT_AN_APPROACH.test(body)) out.approach = tidy(body);
  }
  return out;
}

/**
 * Parse a structured open-plan answer. No option number is consulted: the model
 * has already proposed an action from the safe grammar instead of accepting an
 * engine-selected intent.
 * @param {string|null} raw
 * @returns {{action?: string, target?: string, about?: string, plan?: string, priority?: string, belief?: string, beliefConfidence?: number, beliefAbout?: string, summary?: string, thought?: string}}
 */
export function parseCognitionReply(raw) {
  if (!raw) return {};
  const text = String(raw).trim();
  /** @param {string} label */
  const field = label => {
    const match = text.match(new RegExp(`^\\s*${label}\\s*[:\\-]\\s*(.*)$`, "im"));
    return match ? tidy(match[1]) : "";
  };
  /** @type {ReturnType<typeof parseCognitionReply>} */
  const out = {};
  const keys = {
    ACTION: "action", TARGET: "target", ABOUT: "about", PLAN: "plan", PRIORITY: "priority",
    BELIEF: "belief", BELIEF_ABOUT: "beliefAbout", SUMMARY: "summary", THOUGHT: "thought"
  };
  for (const [label, key] of Object.entries(keys)) {
    const value = field(label);
    if (!value) continue;
    /** @type {any} */ (out)[key] = value;
  }
  const rawConfidence = field("BELIEF_CONFIDENCE");
  const confidence = rawConfidence ? Number(rawConfidence) : NaN;
  if (Number.isFinite(confidence)) out.beliefConfidence = Math.max(0, Math.min(1, confidence));
  return out;
}

/** @param {string} s */
function tidy(s) {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/^["“”']+|["“”']+$/g, "")
    .trim()
    .slice(0, 500);
}

/** @param {string} s */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} className */
function flavour(className) {
  switch (className) {
    case "Scholar":
      return "you study the world in order to understand it.";
    case "Warden":
      return "you stand guard over what matters, and you do not leave your post.";
    case "Diplomat":
      return "you hold people together, and you know what everyone wants.";
    case "Maker":
      return "you build things, and you would rather make something than argue.";
    default:
      return "you are still working out what you are.";
  }
}

/**
 * A compact, human-readable rendering of a moment, for logs.
 * @param {import("../engine/model/world.js").World} world
 * @param {import("../engine/model/world.js").Moment} moment
 */
export function describeMoment(world, moment) {
  const agent = agentById(world, moment.agentId);
  const other = moment.participants[1] ? agentById(world, moment.participants[1]) : null;
  const label = moment.kind === "cognition"
    ? "self-authored plan"
    : moment.kind === "goal_approach"
      ? "self-authored approach"
      : moment.kind;
  return `${agent ? agent.name : "?"} (${label}${other ? " with " + other.name : ""}) at ${regionName(world, agent ? agent.regionId : "")}`;
}
