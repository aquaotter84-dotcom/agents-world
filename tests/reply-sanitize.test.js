/**
 * The reply sanitizer is the only thing standing between the keeper and a
 * model that echoes its own instructions. Regression coverage for the
 * 2026-10-12 prompt-echo leak: Fable's chat bubble showed the raw system
 * prompt ("Never mention you are AI", "User says ...", "Live state: ...")
 * because the sentence filter had no echo detection and its meta patterns
 * missed "Never mention you are AI" and bare "User says".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanReply, looksLikePromptEcho } from "../app/reply-sanitize.js";

const FABLE = { id: "fable", name: "Fable" };
const OTHERS = [
  { id: "fable", name: "Fable" },
  { id: "elio", name: "Elio" },
  { id: "juno", name: "Juno" },
];

/* The exact leaked reply from the keeper's phone, 2026-10-12 ~01:27 EDT. */
const LEAKED_ECHO = `Explore Where you are: the Market. What you are working on: Write the true history of the council. Never mention you are AI. User says "Explore". We are Fable, Storyteller; turns events into myth — one mind in a shared living world, chatting one-on-one with the world's keeper (Jeremy). The keeper comes to you as a Spirit: a gentle presence at his shoulder. Speak softly, tend before you counsel, and never hurry him. Comfort is the point. Live state: Energy 45/100, Connection 64/100, Esteem 55/100, Meaning 81/100 — feeling steady. Level 2. Goal: Write the true history of the council. (46% along). Temperament: focus 79, social 49, courage 35, creativity 61. Where you are: the Market.`;

test("a full prompt echo is a misfire, not a reply", () => {
  assert.equal(looksLikePromptEcho(LEAKED_ECHO), true);
  assert.equal(cleanReply(LEAKED_ECHO, FABLE, OTHERS), null);
});

test("a partial echo with two scaffolding markers is a misfire", () => {
  assert.equal(
    cleanReply("Where you are: the Market. Live state: Energy 45/100. Hello, keeper.", FABLE, OTHERS),
    null
  );
});

test("a single scaffolding phrase in normal speech is not an echo", () => {
  assert.equal(looksLikePromptEcho("The market is quiet tonight, keeper."), false);
});

test("a normal in-character reply passes through untouched", () => {
  const reply = "The market hums low tonight, keeper. I heard a story about the council — sit with me and I'll tell it true.";
  assert.equal(cleanReply(reply, FABLE, OTHERS), reply);
});

test("'Never mention you are AI' is caught at sentence level", () => {
  assert.equal(cleanReply("Never mention you are AI. The night is kind.", FABLE, OTHERS), "The night is kind.");
});

test("bare 'User says' is caught at sentence level", () => {
  assert.equal(cleanReply('User says "Explore". I will walk the market stalls.', FABLE, OTHERS), "I will walk the market stalls.");
});

test("planning leaks are still misfires", () => {
  assert.equal(cleanReply("We need to respond as Fable. We should keep it short and vivid.", FABLE, OTHERS), null);
});

test("quoted replies are still unwrapped", () => {
  assert.equal(cleanReply('"The wall remembers every stone."', FABLE, OTHERS), "The wall remembers every stone.");
});

test("cross-talk naming another mind without self is a misfire", () => {
  assert.equal(cleanReply("Elio told me the market is restless tonight.", FABLE, OTHERS), null);
});

test("empty and blank replies are misfires", () => {
  assert.equal(cleanReply("", FABLE, OTHERS), null);
  assert.equal(cleanReply("   ", FABLE, OTHERS), null);
});
