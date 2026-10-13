# Making the world worth watching

An audit of what a person actually sees when they open Agents World, what is stopping
it from holding attention, and what to do about it — in order.

Written 2026-10-13 against `main` at `2ce8310`. Everything below is measured, not
guessed: the numbers come from running the real engine offline (`createWorld` + `step`)
for ten world days across several seeds, and from booting the real `app/index.html`
against it in jsdom, which is what `tests/app-ui.test.js` already does. The scripts were
throwaway; the method is not, and the two findings that were fixed are now pinned by
tests so they cannot quietly come back.

---

## 1. The screen was printing the simulation's bookkeeping as news

**This is the big one, and it was 39% of everything.**

A tick of nine minds writes about four lines. Half of them are not things that happened;
they are the engine keeping its own books:

| the line | what it is | per 10 world days |
| --- | --- | --- |
| `Elio's view of Orin changed: affection 0 → 6, trust 40 → 48, familiarity 0 → 8, after a warm meeting.` | a number changing in a table, printed twice (once per direction) | 734 |
| `Cass wanted to petition the keeper, but had nothing in the world to point at.` | a mind that considered asking for something and did not | 168 |
| `Pim proposed a way at scout what lies beyond the lantern district.: No answer arrived in time; the engine made the call.` | the engine narrating its own timeout, once per proposal, in a keyless world every time | 98 |
| `Sei started to tell the keeper something and stopped.` | a mind changing its mind | 68 |

Measured across five seeds × ten world days, these were **39% of the six rows on the
World screen** — four lines in ten that a viewer reads past to find the story, on the one
screen that has to be worth watching. The story was always in there; it was under this.

The tell is that the loudest lines were the least interesting. `relationship` was by far
the most common kind in the log (734 of 2,265) and the single most common sentence in the
world, 142 occurrences, was an affinity delta.

## 2. The drama existed; the screen refused to admit it

Drama density is not the problem. Over ten days:

- **39.5% of ticks** produce something at significance ≥ 0.6 — a beat worth announcing.
- Beats at ≥ 0.5 arrive with a **median gap of 1 tick**, worst case 22.
- The top card churns fine: the headline holds the same line for a median of 1–2 ticks at
  45s/tick, and changes 28–35% of the time between consecutive ticks.

The presentation was flat. The app decided how much room a line got **entirely from its
kind** (`KIND_TONE`, a colour) and never once from its `significance` — the number the
engine has already scored every event with, 0..1, calibrated for exactly this. The
consequence: *"The North Wall stands. Every mind in the world is safer for work they did
together"* (1.00) rendered as the same size card, in the same place, with the same weight
as *"Elio did nothing in particular, thoroughly."* (0.35). A viewer's eye had no way to
find the story except by reading every line.

Everything the world logged, by how much it mattered:

| tier | share of all lines | typical |
| --- | --- | --- |
| moment (≥ 0.85) | **1.0%** | a betrayal, a triumph, a wall finished |
| beat (0.6–0.85) | 10.2% | a confession, a secret going public, a role earned |
| notable (0.4–0.6) | 38.7% | a conversation that changed something |
| texture (< 0.4) | 50.1% | where somebody walked, and slowly |

And the top tier is thin in an interesting way: of 113 moments in ten days, **98 were
betrayals**. The emotional ceiling of the world is currently one event kind.

## 3. The ambient layer outnumbers the story two to one

Of 507 low-significance `act` lines in ten days — about one per tick — the top of the
distribution is pure movement and idleness, drawn from a pool of about seventeen
templates, each repeated 5–12 times:

```
12x  «N» walked the whole way to the «N» and arrived no lighter.
12x  «N» walked out of the «N» without saying where they were going.
10x  «N» did nothing in particular, thoroughly.
10x  «N» took the day off from having intentions.
 6x  «N» crossed from the «N» to the «N» and did not look behind them once.
```

They are lovely sentences. They are also extras walking across the frame, and they are
the *map*, not the story: 507 of them against 266 beats in the same period. Over the whole
log, **2,265 events resolve to 462 distinct sentences** — the world speaks in about four
hundred and fifty different ways, and a viewer who watches for a week will have read most
of them several times. That ceiling is the real long-run watchability limit, and the README
already names it: scenes are composed from templates, and a model could write them instead.

## 4. The best material is behind a door

Threads, dossiers, the charter, the keeper's ledger, the chronicle — the app's deepest
content is all correct and all *pull*. Nothing on the World screen answers the one question
a viewer has: **what story is running right now, and what is about to happen?** The vitals
strip counts feuders and camps, which is a condition, not a story.

---

## What landed: pass one

Five changes, all in the app and its tooling; the engine is untouched and its
determinism is not in question.

**1. The World screen shows the story and counts what it left out** (`app/app.js`, `renderFeed`)
Bookkeeping is filtered out of the World screen's feed — and nowhere else. The Record's
Feed is still every line; the chronicle, the digest, threads and secrets all read the same
log they always did. The count at the bottom of the feed is real rather than decorative:
it is the number of bookkeeping lines the world wrote *since the oldest line shown*.

```
before:  39.0% of the World screen's rows were bookkeeping, 13.5% were beats or better
after:    0.0% bookkeeping, 21.6% beats or better — and one sentence saying how many
          lines that was
```

**2. Weight, not just colour** (`app/app.js`, `app/styles.css`)
Every event card now carries the engine's own reading of it: `.tier-moment`,
`.tier-beat`, `.tier-notable`, `.tier-texture`. A moment is serif, larger, gold-framed and
tagged *a moment*; texture is small and dim. The eye can find the story without reading
for it. The same class list applies in the Record, so the whole app agrees on what mattered.
Moments are 1.0% of lines, so the treatment stays special.

**3. The arrival** (`presentBeats` / `showBeat`, `#beat-banner`)
When a tick lands a beat — significance ≥ 0.6, or anything the keeper did — one card takes
over the top of the World screen, with its scene lines if it has them, and holds for nine
seconds. It will not be interrupted by something smaller; it can be tapped away. This is
the difference between a log and a broadcast. It fires on about 40% of ticks.

**4. A world kept elsewhere had stopped being worth announcing** (found while verifying)
The announcement watermark was the world object, which works for a world this app ticks
locally and silently fails for a hosted one: the service serializes the world on every
poll, so the app sees a new object every ten seconds and reads it as a new world — which
means *nothing a hosted world does is ever announced*. Verified against a live runner (a
world ticking every 12 seconds, polled the way the app does): announcements went from
**0 in 8 polls to 3 in 10**, matching the ~40% of ticks that produce a beat. The watermark
is now a sequence number, which travels inside the save and survives being re-read. Pinned
by *a world kept elsewhere announces its beats as it moves* — confirmed to fail when the
old behaviour is put back.

**5. `npm run story` was broken, and is not** (`tools/story.mjs`)
It crashed on the first moment that was not a choice between options — a cognition plan, a
petition, a whisper, a goal approach — which is most of them. It now resolves those the way
the app does. It also prints the day the way the screen reads it: beats marked (`**` a
moment, `* ` a beat), bookkeeping counted rather than printed, and `--all` for every line.
This is the tool for reading a world as a story, so it should read like one.

Pinned by three tests in `tests/app-ui.test.js`: *the world screen shows the story and
counts the bookkeeping it left out* (which also asserts nothing was deleted from the
record), *a beat takes over the top of the world screen* (which ticks until one does, checks
only beat-or-better interrupts, and that tapping dismisses it), and *a world kept elsewhere
announces its beats as it moves*. 282 tests pass; `tsc --noEmit` is clean, and the vendor
copy of the engine is untouched, so `/api/world` still serves what it served.

---

## What landed: pass two — all seven, and what they cost

Everything below was built in one pass after the audit above, in the order it was ranked.
The engine is *still* untouched: every item is the app reading state the engine already
keeps, or spending its model budget on something new. `app/director.js` holds the pure half
of it (the pulse, the pace, the board, the folding, today's sentence, the replay frames) so
all of it is testable against real engine worlds without a browser; `app/sound.js` holds
the noise. 310 tests pass, `tsc --noEmit` is clean.

| what | what it does | what it cost |
| --- | --- | --- |
| **The director** | reads the world (a vendetta live, a dilemma waiting, a beat in the last three ticks) and runs the clock to match — 30s a tick while something is at war, 180s when nothing has moved in half a day — with the header saying which and why | ~120 lines, one switch in Admin to hand the dial back |
| **Storylines in flight** | three cards answering *what story is running and who should I watch*: the hottest feud (with both resentment numbers), the secret under most pressure, the work on the wall, and first — when there is one — what is waiting on your ruling. Most cards can be followed straight to their thread | ~90 lines, derived entirely from `flags.feudStages`, `secrets`, `charter.dilemmas` and `world.project` |
| **Arrival replay** | a world that ran on plays back as a short film — beats in order, one frame a tick, the map rippling at whoever it happened to — then settles into live at the tap. Covers every way a world runs on: the app closed, a hosted world that ticked between two polls, or any tick on the timeline. A film already playing is never restarted by a smaller catch-up and is never interrupted by live beats (they are not queued up for when it ends either), and a film about another world (a restore, a different host) is stopped rather than played | ~100 lines; the frames come from the record, so nothing is re-enacted |
| **Model-written scenes** | with a key, the notable conversations are offered to the model to write again in the two minds' voices, given the engine's lines as the skeleton. The engine's lines stay in the world; the retelling is drawn over them, marked *✦ retold*, stored beside the world (capped at 60) | ~110 lines, one call a tick at most, and a strict parse: fewer than two attributed lines and the reply is discarded |
| **Sound and haptics** | a two-note rise for a moment, one note for a beat, a low settle when the director slows the world down; a short buzz on a device with a motor | ~140 lines, zero assets — every tone is generated, and the module cannot throw |
| **Watch mode** | the map, the beats and nothing to press: controls, keeper cards and other screens drop away, type and map grow, beats hold for sixteen seconds | ~40 lines of CSS and a flag, remembered between sessions |
| **Ambient folding + timeline + today** | runs of walking fold into one row with the faces on them; a 48-tick strip under the map coloured by each tick's best event, tappable to replay from there; and the day counted in one sentence, weighted so twenty meetings do not lead the line | ~110 lines |

Two things the build itself turned up, both now pinned by tests:

- **A world kept elsewhere announced nothing.** The arrival watermark was the world object,
  and a hosted world comes back off the wire as a new object on every poll — so every poll
  read as a new world and no beat was ever announced. Against a live runner, announcements
  went from 0 in 8 polls to 3 in 10.
- **A replay frame can be boring.** The first build played ticks with nothing in them but
  walking, and a dim line about somebody crossing a region taking over the screen is the
  opposite of the point. `replayFrames` now only frames ticks with something notable in
  them and *counts* the rest.

### What is left

**The one thing that is genuinely unfinished:** the retelling has never been watched with a
real key attached. The parse is strict (lines attributed to the two speakers, at least two
of them, or the reply is thrown away and the engine's lines stand), and the test pins both
the good path and the honest failure — but a prompt written without a model on the other end
is a promise, not a result. That is the first thing to try when a key is available.

**Smaller, still open:** a documentary mode that plays the record of a finished world from
the beginning (the replay machinery plus the chronicle would do most of it); letting the
model retell the *beats* the engine wrote rather than only the conversations; and folding
the retellings into the world backup, which they deliberately are not part of today.

### What I would not do

- **More drama generators.** 39.5% of ticks already produce a beat and the median gap
  between ≥ 0.5 events is one tick. If the world feels slow, that is a delivery problem;
  adding events would make it feel *noisier*, not more alive.
- **A voice from the clouds.** The charter is explicit that the keeper never speaks to the
  world, and it is right. Any "the world reacts to you" feature has to be an event with a
  price and a mark on the board, like the blessing and the omen already are.
- **Deleting the bookkeeping.** It is the record, and the record is what makes the chronicle,
  the digest, the threads and the audit possible. Moving it off the World screen is enough.

---

## The one-line version

The world was already interesting and the screen was hiding it: 39% of what it showed was
the simulation keeping its books, and the 1% that was a genuine moment looked exactly like
everything else. Both are fixed, and so is when you see things — the clock now runs to the
story rather than to a constant — with the board, the replay, the timeline, the sound, the
watch mode and (with a key) the model-written conversations built on top. The world was
never the problem. It was the telling.
