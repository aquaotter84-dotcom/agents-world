import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  providerById,
  normalizeSettings,
  providerCallOf,
  hostOf
} from "../app/providers.js";

test("provider table is honest: unique ids, https endpoints, one default each", () => {
  const ids = PROVIDERS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PROVIDERS) {
    assert.ok(p.label, p.id);
    assert.ok(p.defaultModel !== undefined, p.id);
    if (!p.customUrl) assert.match(p.url, /^https:\/\//, p.id);
  }
  assert.ok(PROVIDERS.some(p => p.id === "gemini"));
  assert.ok(PROVIDERS.some(p => p.id === "bluesminds"));
  assert.ok(PROVIDERS.some(p => p.customUrl));
});

test("providerById falls back to the first provider on unknown ids", () => {
  assert.equal(providerById("gemini").id, "gemini");
  assert.equal(providerById("nope").id, PROVIDERS[0].id);
  assert.equal(providerById("").id, PROVIDERS[0].id);
});

test("fresh settings default to Gemini with its default model", () => {
  const s = normalizeSettings({});
  assert.equal(s.provider, "gemini");
  assert.equal(s.models.gemini, "gemini-3.5-flash-lite");
  assert.equal(s.tickSeconds, 45);
});

test("legacy flat settings migrate: the old key was always a BluesMinds key", () => {
  const s = normalizeSettings({ apiKey: "sk-old", model: "openai/gpt-oss-20b", tickSeconds: 90 });
  assert.equal(s.provider, "bluesminds");
  assert.equal(s.keys.bluesminds, "sk-old");
  assert.equal(s.models.bluesminds, "openai/gpt-oss-20b");
  assert.equal(s.tickSeconds, 90);
  // …and the Gemini slot stays empty, not copied over.
  assert.equal(s.keys.gemini, "");
});

test("provider-shaped settings survive normalization untouched", () => {
  const s = normalizeSettings({
    provider: "custom",
    keys: { custom: "k" },
    models: { custom: "m" },
    baseUrls: { custom: "https://example.com/v1/chat/completions" }
  });
  assert.equal(s.provider, "custom");
  assert.equal(s.keys.custom, "k");
  assert.equal(s.models.custom, "m");
  assert.equal(s.baseUrls.custom, "https://example.com/v1/chat/completions");
});

test("legacy keys merged into a normalized object still migrate (the real upgrade path)", () => {
  // load() does Object.assign(normalizedDefault, storedFlatSettings)
  const merged = Object.assign(normalizeSettings({}), {
    apiKey: "sk-old", model: "openai/gpt-oss-20b", tickSeconds: 90
  });
  const s = normalizeSettings(merged);
  assert.equal(s.provider, "bluesminds");
  assert.equal(s.keys.bluesminds, "sk-old");
  assert.equal(s.models.bluesminds, "openai/gpt-oss-20b");
});

test("an explicitly chosen provider with its key stays put", () => {
  const s = normalizeSettings({ provider: "gemini", keys: { gemini: "AIKEY" } });
  assert.equal(s.provider, "gemini");
  assert.equal(providerCallOf(s).key, "AIKEY");
});

test("an unknown provider id falls back without losing stored keys", () => {
  const s = normalizeSettings({ provider: "nope", keys: { bluesminds: "sk-old" } });
  assert.equal(s.keys.bluesminds, "sk-old");
  assert.equal(providerCallOf(s).provider.id, "bluesminds");
});

test("providerCallOf resolves the active provider's url, model and key", () => {
  const s = normalizeSettings({ provider: "gemini", keys: { gemini: "  AIKEY " } });
  const call = providerCallOf(s);
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(call.model, "gemini-3.5-flash-lite");
  assert.equal(call.key, "AIKEY");
});

test("providerCallOf throws no-key when the active provider has no key", () => {
  assert.throws(() => providerCallOf(normalizeSettings({})), /no-key/);
});

test("providerCallOf throws no-url when a custom endpoint has no URL", () => {
  const s = normalizeSettings({ provider: "custom", keys: { custom: "k" } });
  assert.throws(() => providerCallOf(s), /no-url/);
});

test("providerCallOf rejects non-http custom URLs", () => {
  const s = normalizeSettings({
    provider: "custom",
    keys: { custom: "k" },
    baseUrls: { custom: "ftp://evil.example/x" }
  });
  assert.throws(() => providerCallOf(s), /bad-url/);
});

test("custom endpoint with key and URL resolves", () => {
  const s = normalizeSettings({
    provider: "custom",
    keys: { custom: "k" },
    models: { custom: "local-model" },
    baseUrls: { custom: "http://localhost:11434/v1/chat/completions/" }
  });
  const call = providerCallOf(s);
  assert.equal(call.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(call.model, "local-model");
});

test("hostOf names the host for the admin note", () => {
  assert.equal(hostOf("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
    "generativelanguage.googleapis.com");
});
