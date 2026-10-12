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
- **Death matters.** A death is not a quiet despawn. Word goes round, the world gathers — the minds who knew them best, and the neighbours, actually walk to the region and stand at the grave — and the map shows it: a gathering mark with a candle while it is still coming, a cairn afterwards. What the dead carried passes on: their deepest quarrels go to the closest bond as real resentment inside the feud system, so a grudge can be buried and stand up in someone else, while a mind nobody loved takes their quarrels with them and the record says so. Every loss gets a memorial at the top of the Record's Chronicle tab — what they did here, who stood at the grave, which of their fights is still walking around — and the keeper's legacy meter reads the graves. Departures are written down the same way, including the keeper's own Retire button.
- **Gods don't chat.** The keeper never speaks to the world: there is no voice from the clouds and no message bubble, because chat stays what it always was — a private conversation with one mind. What the *world* experiences of the keeper is three interventions, all paid for out of influence, all drawn on the board and all touchable: a **blessing** (5) on a mind or on the work on the wall, and the hands under it go further for two days; an **omen** (7) over a region, which cools every quarrel in it while it hangs and makes an argument much harder to choose; and an **apparition** (12) at a dilemma, where the keeper stands between two minds and says nothing at all — they put down more than any ruling has ever made them put down, and no law is written, because nothing was said. Prices are the strategy: a day kept pays 4 influence, so a blessing is a day's income and an apparition is three days of keeping. Each leaves a mark where it landed — a ring over the region, a halo on the mind, a pillar where the keeper stood — that lingers, dimmed, after it stops biting, and every one of them is tappable and written into the charter's record with the meters it moved.
- **Admin speed presets** (Chill / Normal / Brisk / Frantic), plus One tick, A day and A week buttons for fast-forwarding a world.
- **The keeper's want.** Harmony, prosperity and legacy: three meters that are the keeper's own score, read off the world's real condition (mutual bonds, feud stages, lonely minds, wall progress, favours repaid, laws and roles still standing, the weight of the chronicle) and moved by every act the keeper takes. Each movement is written into a ledger with its cause, so a meter that is falling always has a sentence next to it saying why. The meters sit on the World screen, ring the top-right corner of the map as three arcs under a crown — tap the crown for the ledger — and carry the one lose condition: a world that stops asking for anything (no petitions, no whispers, no dilemmas) drains harmony, and a quiet world is a dying world.

### Gods don't chat — the three things a keeper can do without a word

The one rule this phase is built on: nothing the keeper does may arrive as a sentence. Chat already exists, and it is private — one mind, one thread, no witness. What the world can notice has to be an event.

| act | aim | price | what it does |
| --- | --- | --- | --- |
| Blessing | a mind, or the work on the wall | 5 | lifts that mind's needs and standing now, and while the light holds (48 ticks) their hands — or every hand on the wall — get 35% further on the North Wall |
| Omen | a region | 7 | a sign hanging over a place for 72 ticks: meaning up and mood cooled for the people standing under it, resentment between every quarrelling pair in it cooling each tick, their fear of each other up, and a 30-point cut to any decision to confront |
| Apparition | a dilemma already on the table | 12 | the keeper stands there and says nothing: both parties' resentment drops 30, both of them remember it, the dilemma closes — and **no precedent is written**, because nothing was said |

The pricing is the strategy. Influence comes back at 4 a day, a ruling pays 3, and the wall standing pays 25 — so a keeper who wants to appear at a dilemma has to have been keeping the world for three days without spending, and a keeper who blesses every day will not have anything saved for the omen that a feud is going to need. Every act is validated before it lands: the price is checked against real influence, the target has to exist, a region already under a sign refuses with *"A sign already hangs over the Lantern District."*, a lit mind with *"Juno is already carrying your light."*, an act on cooldown with *"34 more ticks before you can do that again."*, and an empty purse with *"That costs 12 influence and you have 11."* Nothing is hidden: an act the world cannot currently honour is shown disabled with the reason on it.

Where it lives: the keeper's hand on the World screen quotes all three, the price and where each is aimed right now; holding the board aims them (hold a mind to bless it, a region to set a sign over it, a dilemma to appear at it) through the same radial menu the other keeper moves use; and the charter record keeps every sign with its day, its cost, what it did and the meters it moved. Every one moves harmony, prosperity or legacy through the same ledger as a ruling — an apparition is the single biggest movement of legacy available to a keeper, and an omen is the only thing in the world that argues with a grievance from above.

None of it is scripted: the engine validates and applies, the mind's own decision system reads the omen when it weighs up a confrontation, and the wall's own work system reads the blessing. A keeper cannot make anyone stop hating anyone. They can only make it harder, and pay for it.

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

### The approach grammar, measured

Proposal-based minds are the one place a model's voice could be swallowed silently: the old build answered a wall of `ENGINE FALLBACK`s, every proposal refused as "not in the engine's safe action grammar", so the model never actually steered anything. The fix had to be *demonstrable*, so it is measured rather than asserted.

`npm run audit:proposals` (or `node tools/proposal-audit.mjs --seed 4711 --days 10`) runs a seeded world for ten world days and answers every proposal the engine offers, in the exact shape the prompt asks for, through the real prompt → parse → resolve pipeline. It answers four temperaments: a compliant model, a compliant model whose reply lands two ticks late (as it does in the app), a freehand model that buries the token in its prose with no `METHOD` line, and a misbehaving model that always proposes the unresolvable. Observed on seed 4711:

| model | accepted | refused | refused by |
| --- | --- | --- | --- |
| compliant, reply same tick | 95/96 (99.0%) | 1 | "There is no one here for that." (company left) |
| compliant, reply 2 ticks late | 93/96 (96.9%) | 3 | the world moved: region, company |
| freehand, no METHOD line | 93/96 (96.9%) | 3 | the world moved — zero parse losses |
| misbehaving ("summon a storm") | 0/87 (0.0%) | 87 | "not one of the approaches" — every one in the record |

Why the old failure mode is unreachable now: the prompt offers exactly the subset of the grammar the engine can resolve from where the mind is standing, so a model that names an offered approach cannot be refused by the grammar or the parser — and the parser rescues reworded replies by stem. The refusals that do happen are honest: the world moved between the ask and the act (the mind's region changed, its company walked off), and each one is written into the record with its reason while the engine's fallback move keeps the mind acting. No invisible rejection loops. The rates are deterministic for a given seed, and `tests/proposal-acceptance.test.js` pins them, including the invariant that every proposal — accepted or refused — reaches the event record with a verdict and a reason.

## Layout

- `engine/` — the simulation: pure, deterministic, no I/O, no wall clock (including the keeper's own systems: `want`, `charter`, `mourning`, `divine`)
- `server/` — the headless runner (`npm start`), the model client, the prompt builder
- `app/` — vanilla web app, no build step (`index.html`, `styles.css`, `app.js`); the engine is vendored into `app/vendor/` by `tools/sync-vendor.sh`, which CI runs before every build
- `tools/` — `serve.mjs` (dev server: `npm run dev`, `--sync` to re-vendor), `story.mjs` (print a day from an offline world), `proposal-audit.mjs` (the seeded proposal-acceptance audit), `sync-vendor.sh`
- `tests/` — `npm test`. Engine behaviour (balance, determinism, the world's voice, proposal acceptance rates) plus `app-ui.test.js`, which boots the real `app/index.html` against the real vendored engine in jsdom, clicks the real buttons, and asserts that a world with no model in it still reads as a story
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
