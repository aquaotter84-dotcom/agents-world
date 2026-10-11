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
 * Build the chat messages for a moment.
 * @param {import("../engine/model/world.js").World} world
 * @param {Moment} moment
 * @returns {{messages: {role: string, content: string}[], maxTokens: number}}
 */
export function buildPrompt(world, moment) {
  const agent = agentById(world, moment.agentId);
  if (!agent) return { messages: [], maxTokens: 0 };
  const ctx = moment.context;

  const lines = [];
  lines.push(`You are ${ctx.agentName}, one of nine minds living in a small, cold world.`);
  lines.push(`You are ${agent.personality.toLowerCase()}. ${agent.backstory}`);
  lines.push(`You are ${agent.class.toLowerCase()} by nature: ${flavour(agent.class)}`);
  lines.push("");
  lines.push(`Right now: ${ctx.region}, ${ctx.phase}. ${ctx.regionBlurb}`);
  lines.push(`Your condition: ${ctx.stateLine}`);
  lines.push(`What you are for: ${ctx.goal}`);

  if (ctx.targetName) {
    lines.push("");
    const who = ctx.targetPersonality ? ctx.targetPersonality.toLowerCase() : "hard to read";
    lines.push(`${ctx.targetName} is with you. ${ctx.targetName} is ${who}.`);
    lines.push(`You regard ${ctx.targetName} as ${ctx.relationPhrase}.`);
    if (ctx.targetMood) lines.push(`${ctx.targetName} seems ${ctx.targetMood}.`);
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
 * @returns {{optionId?: string, prose?: string, thought?: string}}
 */
export function parseReply(raw, moment) {
  if (!raw) return {};
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
  return `${agent ? agent.name : "?"} (${moment.kind}${other ? " with " + other.name : ""}) at ${regionName(world, agent ? agent.regionId : "")}`;
}
