/* Pure reply sanitizer for model-backed chat and thoughts.
 *
 * Reasoning-style models sometimes leak their scaffolding: planning
 * ("We need to respond as..."), cross-talk from other minds, or — the
 * worst case — echoing the system prompt back almost verbatim, so the
 * keeper sees the instructions instead of the mind. This module strips
 * the scaffolding; null means misfire and the caller shows a soft
 * fallback instead of the raw text.
 *
 * No dependencies, no DOM: safe to unit-test in node and to import
 * from the app module.
 */

/* Sentence-level planning/meta patterns. */
const META = /\bwe (need|must|should|will|shall|have to|are to)\b|provide (one|a) (short|vivid) sentence|example:|in third person|never break character|stay in character|narrat\w* (your|my) reasoning|\bas an ai\b|(never|no) mention.{0,30}\bai\b|(the )?user (says|might|wants)|this is a prompt|comply with policy|disallowed content|it'?s (safe|permissible)/i;

/* Scaffolding phrases the app itself puts into prompts. A reply carrying
 * two or more of them is the model echoing its instructions, not answering. */
const ECHO_MARKERS = [
  "where you are:",
  "what you are working on:",
  "live state:",
  "temperament:",
  "never mention you are ai",
  "output only the reply",
  "no preamble, no planning",
  "never narrate your reasoning",
  "reply with only",
  "your current private thought",
];

/** True when the text reads like the system prompt echoed back.
 * @param {unknown} text */
export function looksLikePromptEcho(text) {
  const lower = String(text || "").toLowerCase();
  let hits = 0;
  for (const marker of ECHO_MARKERS) {
    if (lower.includes(marker) && ++hits >= 2) return true;
  }
  return false;
}

/**
 * @param {string} text raw model output
 * @param {{id: string, name: string}} agent the mind being voiced
 * @param {{id: string, name: string}[]} agents other living minds, for cross-talk detection
 * @returns {string|null} the cleaned reply, or null on misfire
 */
export function cleanReply(text, agent, agents = []) {
  let t = String(text || "").trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!t) return null;
  if (looksLikePromptEcho(t)) return null; // the prompt itself, echoed
  const sents = t.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const kept = sents.filter(s => !META.test(s));
  if (kept.length * 2 < sents.length) return null; // mostly planning — misfire
  t = (kept.length ? kept : sents).join(" ").trim();
  const quoted = t.match(/["“]([^"”]{12,220})["”]/);
  if (quoted) t = quoted[1].trim();
  if (META.test(t)) return null;
  const other = agents.find(m => m.id !== agent.id && new RegExp("\\b" + m.name + "\\b", "i").test(t));
  const self = new RegExp("\\b" + agent.name + "\\b", "i").test(t);
  if (other && !self) return null;
  return t || null;
}
