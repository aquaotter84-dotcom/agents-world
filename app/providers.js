/**
 * Model providers — pure data and resolution. No DOM, no network, no secrets.
 *
 * The app talks to exactly one provider at a time: the keeper picks it in
 * Admin, pastes that provider's key, and the key lives ONLY in localStorage,
 * is never logged, and is sent only to the active provider's endpoint.
 * No key at all? The engine writes the world itself — a key changes the
 * voice, not the world.
 *
 * Every provider speaks the OpenAI chat-completions shape, so "custom" can
 * point at any compatible endpoint (a local server, another gateway) with
 * nothing but a URL.
 */

/** @typedef {{ id: string, label: string, url: string, keyUrl: string, keyHint: string, defaultModel: string, customUrl: boolean }} Provider */

export const PROVIDERS = [
  {
    id: "gemini",
    label: "Google AI Studio",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "Free — a Google account is all it takes.",
    defaultModel: "gemini-2.5-flash",
    customUrl: false
  },
  {
    id: "bluesminds",
    label: "BluesMinds",
    url: "https://api.bluesminds.com/v1/chat/completions",
    keyUrl: "",
    keyHint: "",
    defaultModel: "openai/gpt-oss-20b",
    customUrl: false
  },
  {
    id: "custom",
    label: "Custom endpoint",
    url: "",
    keyUrl: "",
    keyHint: "Any OpenAI-compatible chat-completions URL.",
    defaultModel: "",
    customUrl: true
  }
];

/** @param {string} id */
export function providerById(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

/**
 * Normalize whatever is in storage into the provider shape. Handles the
 * legacy flat shape ({ apiKey, model }) from before providers existed —
 * those keys were always BluesMinds keys, so they stay BluesMinds keys.
 * @param {any} raw
 */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  /** @type {Record<string, string>} */
  const keys = {};
  /** @type {Record<string, string>} */
  const models = {};
  /** @type {Record<string, string>} */
  const baseUrls = {};
  for (const p of PROVIDERS) {
    keys[p.id] = "";
    models[p.id] = p.defaultModel;
  }
  if (s.keys && typeof s.keys === "object") {
    for (const p of PROVIDERS) if (typeof s.keys[p.id] === "string") keys[p.id] = s.keys[p.id];
  }
  if (s.models && typeof s.models === "object") {
    for (const p of PROVIDERS) if (typeof s.models[p.id] === "string") models[p.id] = s.models[p.id];
  }
  if (s.baseUrls && typeof s.baseUrls === "object") {
    for (const p of PROVIDERS) if (p.customUrl && typeof s.baseUrls[p.id] === "string") baseUrls[p.id] = s.baseUrls[p.id];
  }
  // Legacy flat settings ({ apiKey, model }) predate providers entirely —
  // the only provider that ever existed then was BluesMinds. They apply
  // whenever no provider-shaped key is set, even when merged into an object
  // that already carries an (empty) keys map.
  const hasAnyKey = PROVIDERS.some(p => String(keys[p.id] || "").trim());
  if (!hasAnyKey && typeof s.apiKey === "string" && s.apiKey.trim()) {
    keys.bluesminds = s.apiKey;
    if (typeof s.model === "string" && s.model.trim()) models.bluesminds = s.model;
  }
  // Provider choice: explicit when the stored settings named one. Otherwise
  // follow the key — a stored key with no recorded provider is a legacy
  // BluesMinds key — and default to Gemini for a clean slate.
  const named = typeof s.provider === "string" ? providerById(s.provider) : null;
  const namedExplicit = !!named && s.provider === named.id && named.id !== PROVIDERS[0].id;
  let provider = PROVIDERS[0].id;
  if (named && (namedExplicit || String(keys[named.id] || "").trim())) {
    provider = named.id;
  } else {
    const withKey = PROVIDERS.find(p => String(keys[p.id] || "").trim());
    if (withKey) provider = withKey.id;
  }
  return {
    provider,
    keys,
    models,
    baseUrls,
    tickSeconds: Number(s.tickSeconds) || 45,
    serviceUrl: typeof s.serviceUrl === "string" ? s.serviceUrl : "",
    // Let the world set its own pace: brisk while something is live, easy once
    // it settles. On by default — it is what makes the clock fit the story —
    // and off the moment the keeper wants the dial back.
    director: s.director === undefined ? true : !!s.director,
    // A chime and a short buzz when the world has a moment. Off by default:
    // nobody wants an app that makes noise before they have asked it to.
    sound: !!s.sound,
    // Let a model write the notable conversations again in the two minds' own
    // voices. On by default, because it only ever does anything with a key
    // attached — the engine's own lines are the fallback either way.
    retell: s.retell === undefined ? true : !!s.retell,
    // Watch mode: the map, the beats, and nothing to press.
    watching: !!s.watching
  };
}

/**
 * Resolve the active provider into a concrete call. Throws "no-key" when
 * there is nothing to call with, "no-url" when a custom endpoint has no URL.
 * @param {{ provider: string, keys: Record<string,string>, models: Record<string,string>, baseUrls: Record<string,string> }} settings
 */
export function providerCallOf(settings) {
  const p = providerById(settings.provider);
  const key = String((settings.keys && settings.keys[p.id]) || "").trim();
  if (!key) throw new Error("no-key");
  const url = p.customUrl
    ? String((settings.baseUrls && settings.baseUrls[p.id]) || "").trim().replace(/\/+$/, "")
    : p.url;
  if (!url) throw new Error("no-url");
  if (!/^https?:\/\//i.test(url)) throw new Error("bad-url");
  const model = String((settings.models && settings.models[p.id]) || "").trim() || p.defaultModel;
  return { provider: p, url, model, key };
}

/** @param {string} url */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
