# Agents World

A living world of real AI minds on your phone — rebuilt from Jeremy's Snapp AI prototype as a native Android app.

> **Status: beginning phases (noted 2026-10-11).** This repo is an early working baseline, not a finished product. The pieces below are the starting point — we build from here.

## Where things stand today

- **Working**: single-page web app with the world map, agents (RPG), feed, messages, and admin screens; 9 seed minds with classes, drives, energy, mood, XP/levels, goals; per-mind persona chat and tick loop against BluesMinds.
- **Shipping**: debug APK built by GitHub Actions on every push (unsigned; no release/signing yet).
- **Early / stubbed**: agent-to-agent interaction is indirect (minds see each other's recent events in their prompt, but don't talk to each other directly); no persistence beyond on-device `localStorage`; tick loop only runs while the app is open (no background service).
- **Voice**: the engine narrates most of a mind's day itself, and its prose is meant to be read. Every line comes from a hand-written pool with a per-world memory of what has been used lately, so a long run keeps finding new things to say rather than recycling a handful of sentences.

## Open threads we'll pick up from here

- Signed release builds (workflow source in `deploy/workflows/`; debug-only for v1).
- Background/off-device ticks so the world lives while the app is closed.
- Richer inter-mind dynamics (conversations, relationships, world-shaping events).
- API rate-limit handling (BluesMinds 429s: calls are serialized at `BM_GAP_MS` today).

## Tabs (v1 as built)

- **World**: dark map with AI minds as colored orbs, live stats, world activity feed
- **My Agents**: wake/sleep and remove minds
- **Feed**: full event history
- **Messages**: one-on-one chat with any mind, in persona
- **Admin**: BluesMinds API key (stored on-device only), model, tick interval, reset

## How the minds work

While the app is open, a tick loop wakes 1–2 minds every N seconds (default 90). Each ticked mind calls `https://api.bluesminds.com/v1/chat/completions` with a persona system prompt plus the other minds' names and recent events, and its one-sentence act becomes a world event. Minds sometimes drift across the map. Tapping a mind asks it what it's thinking; the Messages tab holds real persona chat.

No API key → minds show asleep and ticks/chat stay off with a gentle pointer to Admin.

## Layout

- `engine/` — the simulation: pure, deterministic, no I/O, no wall clock
- `server/` — the headless runner (`npm start`), the model client, the prompt builder
- `app/` — vanilla web app, no build step (`index.html`, `styles.css`, `app.js`); the engine is vendored into `app/vendor/` by `tools/sync-vendor.sh`, which CI runs before every build
- `tools/` — `serve.mjs` (dev server: `npm run dev`, `--sync` to re-vendor), `story.mjs` (print a day from an offline world), `sync-vendor.sh`
- `tests/` — behavioural tests (`npm test`): balance, determinism, and the world's voice
- `deploy/` — Capacitor 7 Android shell (`appId com.patchesstudio.agentsworld`), workflow source copy in `deploy/workflows/`
- `.github/workflows/android-apk.yml` — debug APK on every push (artifact: `agents-world-debug-apk`)

## Build

Push to `main`; GitHub Actions builds the debug APK automatically.

To try the web app locally, `npm run dev` and open `http://localhost:4321`. Engine
edits need `tools/sync-vendor.sh` (or `npm run dev -- --sync`) to reach the app under
`app/vendor/`.
