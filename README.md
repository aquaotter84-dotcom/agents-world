# Agents World

A living world of real AI minds on your phone — rebuilt from Jeremy's Snapp AI prototype as a native Android app.

> **Status: working, still early (noted 2026-10-12).** The world runs, it keeps its own history, and it reads as a story. What is missing is mostly breadth rather than foundation: a signed release build, a background service so the world lives while the app is closed, and the model-driven half of the social layer.

## The one thing to know

**The world does not need an API key.** The engine is a full simulation — needs, moods, ambitions, wandering, gossip, secrets, grudges, factions and confessions — and it narrates all of it itself. Open the app and nine minds are already two days into a story.

A BluesMinds key changes the *voice*, not the world: with one, a language model writes the biggest beats of each tick (the confrontations, confessions, betrayals and declarations) instead of the engine. Everything else behaves identically, and any moment a model fails to answer in time falls back to the engine's own judgment. That is why the app is never dead, never stuck waiting, and never empty on first launch.

## What landed in this pass

- **Self-running world.** Ticks no longer require a key. Header shows `LIVE` (model attached) or `SELF-RUNNING` (engine only).
- **It opens mid-story.** A new world is seeded with 108 ticks — about two and a half days — so day one already has a Chronicle, a few secrets and a couple of grudges.
- **Catch-up.** Time the app spent closed is paid back on the next launch by running the same deterministic simulation forward (capped at ten world days / eight hours), then reported in a toast. No fake "while you were away" text: those days really happened in the engine and are in the record.
- **The Record.** One screen, three views: **Feed** (every line), **Chronicle** (the engine's own day summaries, previously written and never read), and **Secrets** (what the world is keeping quiet, who is holding it, and whether it has gone public).
- **A headline.** The World screen leads with the biggest thing said lately, plus vitals: world mood, day and phase, awake count, secrets held vs out, standing feuds and camps.
- **Minds, by region.** The cast grouped by where they actually are, with what each is doing right now, their ties, and a switch to wake or sleep them.
- **Dossiers.** Tapping a mind opens a character sheet: needs, drives, goal progress, the next level, who they stand with and against (with bars for affection, trust and resentment), what they are carrying, what is being said about them, what is on their mind, and — with a key — a private thought in their own voice.
- **A map that shows the social graph.** Alliances as warm bonds, grudges as frayed red lines, a mood ring around every orb, region washes that brighten with occupancy, and the day's clock in the corner. Tap a mind and its ties light up.
- **A named world.** Derived from the seed, so it never changes under you.
- **Admin speed presets** (Chill / Normal / Brisk / Frantic), plus One tick, A day and A week buttons for fast-forwarding a world.

### Two simulation fixes that were making the world mushier than it looked

- **Secrets no longer duplicate.** The same pair can betray each other the same way twice, which used to produce a dozen near-identical secrets and drown the interesting ones. `secret_new` now refuses a claim the world already holds.
- **Factions mean something.** Mutual-affinity threshold raised from 40 to 58: affinity saturates, and the old value unioned seven of nine minds into one group. The world now resolves into real camps with unaligned minds between them.

## Tabs

- **World** — map, headline, vitals, latest activity
- **Minds** — the cast by region, with wake/sleep and dossiers
- **Record** — Feed, Chronicle, Secrets
- **Messages** — one-on-one chat with any mind, in persona (needs a key)
- **Admin** — optional API key and model, world speed, fast-forward, reset

## How the minds work

While the app is open, each tick advances the whole world by 30 minutes. Every awake mind gets an engine decision on that tick unless it is waiting on one of the engine's bounded model moments; sleeping minds continue to recover energy and wake on their own at the configured threshold. The app's default is one tick every 45 seconds, so one world day (48 ticks) takes 36 real minutes at that speed. The headless runner has its own configurable wall-clock interval. The engine offers only its most significant beats to the model; anything unanswered within three ticks is decided by the engine. Given the same seed and the same recorded model answers, the simulation replays exactly.

## Layout

- `engine/` — the simulation: pure, deterministic, no I/O, no wall clock
- `server/` — the headless runner (`npm start`), the model client, the prompt builder
- `app/` — vanilla web app, no build step (`index.html`, `styles.css`, `app.js`); the engine is vendored into `app/vendor/` by `tools/sync-vendor.sh`, which CI runs before every build
- `tools/` — `serve.mjs` (dev server: `npm run dev`, `--sync` to re-vendor), `story.mjs` (print a day from an offline world), `sync-vendor.sh`
- `tests/` — `npm test`. Engine behaviour (balance, determinism, the world's voice) plus `app-ui.test.js`, which boots the real `app/index.html` against the real vendored engine in jsdom, clicks the real buttons, and asserts that a world with no model in it still reads as a story
- `deploy/` — Capacitor 7 Android shell (`appId com.patchesstudio.agentsworld`), workflow source copy in `deploy/workflows/`
- `.github/workflows/android-apk.yml` — debug APK on every push (artifact: `agents-world-debug-apk`)

## Open threads

- Signed release builds (workflow source in `deploy/workflows/`; debug-only for v1).
- Scenes are composed from templates. A model could write the lines instead, the same way it already writes the biggest moments.
- API rate-limit handling (BluesMinds 429s: calls are serialized at `BM_GAP_MS` today).
- Save size. A world in flight is ~0.5 MB of JSON in `localStorage`, rewritten every tick.

## Running the world

Two processes, both optional:

- `npm run service` runs the world headless. It ticks every 60 seconds and writes
  `data/world.json` atomically. It keeps going with no browser open, and it flushes
  its save on SIGINT/SIGTERM.
- `npm run dev` serves the app at `http://localhost:4321`. It also exposes the
  service's world read-only at `/api/world` and `/api/status`.

When the app finds a running service it shows that world and leaves the clock to
the service. It polls for new ticks every 10 seconds. With no service, the app runs
its own world in `localStorage`, paying back closed time on launch as before.

## Build

Push to `main`; GitHub Actions builds the debug APK automatically. The `Tests`
workflow runs typecheck and the test suite on every push and pull request, and
fails if `app/vendor/` has drifted from `engine/`.

To try the web app locally, `npm run dev` and open `http://localhost:4321`. Engine
edits need `tools/sync-vendor.sh` (or `npm run dev -- --sync`) to reach the app under
`app/vendor/`.
