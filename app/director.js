/**
 * The director: what the world is doing right now, how fast it should be
 * running, and what a viewer ought to be told about it.
 *
 * Every function here is pure — it reads a world and returns a decision. No DOM,
 * no timers, no network, no mutation. That is deliberate: the app's job is to
 * render what this says, and a test's job is to check what it says without
 * booting a browser. `tests/director.test.js` runs these against real engine
 * worlds.
 *
 * Four questions, four answers:
 *
 *   worldPulse()      — is anything happening? (hot / live / settling / quiet)
 *   paceFor()         — then how fast should the clock run?
 *   storylineBoard()  — what story is running, and who should I watch?
 *   foldAmbient()     — which lines are events, and which are someone walking?
 *   todaySoFar()      — what has this world done since dawn, in one sentence?
 *   replayFrames()    — what did it look like while nobody was watching?
 */

/* ------------------------------------------------------------------ *
 * Reading a line
 * ------------------------------------------------------------------ */

/**
 * The engine logs everything that happened, which is right — and it logs its own
 * bookkeeping in the same list, which is not. One tick of nine minds writes
 * affection deltas between pairs, minds that considered asking the keeper for
 * something and did not, and moments the model never answered in time. Measured
 * over ten world days, those are 39% of the rows and 41% of the World screen.
 *
 * None of it is deleted anywhere: the Record's Feed is every line. This is the
 * predicate that says which of those lines a viewer needs no more than a count
 * of. It lives here so the app and the tests cannot disagree about it.
 * @param {any} e
 */
export function isBookkeeping(e) {
  if (!e) return true;
  if (e.kind === "relationship") return true;
  // A proposal the model never answered. Every one of these in a keyless world
  // is the same sentence — while a proposal the model *did* write is a mind's own
  // idea, and stays.
  if (e.kind === "proposal" && !e.authored) return true;
  const text = e.text || "";
  return /wanted to petition the keeper, but had nothing in the world to point at/.test(text)
    || /started to tell the keeper something and stopped/.test(text)
    || /No answer arrived in time; the engine made the call/.test(text);
}

/**
 * How much room a line has earned. The engine scores every event 0..1 for how
 * much it mattered, and the screen ignored the number entirely until now: a wall
 * standing (1.00) drew the same card as a mind who took the day off (0.35).
 * @param {any} e
 * @returns {"moment"|"beat"|"notable"|"texture"}
 */
export function beatTier(e) {
  const s = (e && e.significance) || 0;
  if (s >= 0.85) return "moment";
  if (s >= 0.6) return "beat";
  if (s >= 0.4) return "notable";
  return "texture";
}

/** Only a real beat interrupts — the floor for taking over the top of the screen. */
export const BEAT_FLOOR = 0.6;
/** Only a real moment makes a sound. */
export const SOUND_FLOOR = 0.85;

/** Minutes the world advances per tick, wherever the config keeps them.
 * @param {any} world */
export function minutesPerTick(world) {
  const clock = (world && world.config && world.config.clock) || {};
  return Number(clock.minutesPerTick) || Number(world?.config?.minutesPerTick) || 30;
}
/** Ticks in one world day. The engine's own arithmetic, read rather than assumed.
 * @param {any} world */
export function ticksPerDay(world) {
  return Math.max(1, Math.round(1440 / minutesPerTick(world)));
}
/** The tick the current day began on.
 * @param {any} world */
export function dayStartTick(world) {
  const perDay = ticksPerDay(world);
  return (Math.max(1, world.clock.day) - 1) * perDay;
}

/** The living minds, in the app's own reading (the engine's own filter is the same).
 * @param {any} world */
function livingOf(world) {
  return (world.agents || []).filter((/** @type {any} */ a) => a && !a.retired);
}

/**
 * Every feud the world is currently tracking, hottest first.
 * `world.flags.feudStages` is the engine's own record of which pairs are at
 * which stage, written by `trackFeuds`; this reads it rather than recomputing it,
 * so the board and the engine can never disagree about who is at war.
 * @param {any} world
 */
export function feudBoard(world) {
  const stages = (world.flags && world.flags.feudStages) || {};
  /** @type {Record<string, any>} */
  const byId = {};
  for (const a of livingOf(world)) byId[a.id] = a;
  const rows = [];
  for (const [key, stage] of Object.entries(stages)) {
    const [idA, idB] = String(key).split("|");
    const a = byId[idA];
    const b = byId[idB];
    if (!a || !b) continue; // a feud outlives the mind who held it, as a record
    const ab = a.relations?.[b.id]?.resentment ?? 0;
    const ba = b.relations?.[a.id]?.resentment ?? 0;
    rows.push({
      id: key,
      a, b, stage,
      heat: Math.max(ab, ba),
      resentment: { [a.id]: ab, [b.id]: ba },
      rank: stage === "vendetta" ? 3 : stage === "rivalry" ? 2 : 1
    });
  }
  rows.sort((x, y) => (y.rank - x.rank) || (y.heat - x.heat));
  return rows;
}

/* ------------------------------------------------------------------ *
 * 1. The pulse
 * ------------------------------------------------------------------ */

/** @typedef {"hot"|"live"|"settling"|"quiet"} PulseLevel */

/** Beats within this many ticks make a world *hot*, right now. */
const HOT_WINDOW = 3;
/** …and within this many, *live*. */
const LIVE_WINDOW = 10;
/** …and within this many, *settling*. */
const SETTLING_WINDOW = 24;

/**
 * What the world is doing this minute, in one word and one sentence.
 *
 * The world runs at a single tempo: a feud breaking, a death and a wall standing
 * all get the same 45 seconds, and so does an afternoon of walking. Measuring the
 * world over ten days says the interesting moments do not arrive evenly — they
 * cluster, then go quiet for a stretch. The pulse is what the app uses to run the
 * clock faster while something is happening and slower when nothing is.
 * @param {any} world
 * @returns {{level: PulseLevel, because: string, heat: number, feuds: any[], dilemma: any|null, petitionCount: number, project: any|null, recentBeats: any[], awake: number, reasons: string[]}}
 */
export function worldPulse(world) {
  const tick = world.clock.tick;
  const living = livingOf(world);
  const awake = living.filter((/** @type {any} */ a) => a.awake).length;
  const feuds = feudBoard(world);
  const hottest = feuds[0] || null;

  const charter = world.charter || {};
  const dilemma = (charter.dilemmas || []).find((/** @type {any} */ d) => d && d.status === "open") || null;
  const petitionCount = (charter.petitions || []).filter((/** @type {any} */ p) => p && p.status === "open").length;

  const project = world.project && world.project.status === "active" ? world.project : null;

  const recentBeats = (world.events || []).filter((/** @type {any} */ e) =>
    e.tick > tick - LIVE_WINDOW && !isBookkeeping(e) && (e.significance || 0) >= BEAT_FLOOR);

  const reasons = [];
  if (hottest && hottest.stage === "vendetta") reasons.push(hottest.a.name + " and " + hottest.b.name + " are in a vendetta");
  else if (hottest && hottest.stage === "rivalry") reasons.push(hottest.a.name + " and " + hottest.b.name + " are rivals now");
  if (dilemma) reasons.push("a dilemma is waiting on you");
  if (petitionCount) reasons.push(petitionCount + (petitionCount === 1 ? " petition is" : " petitions are") + " waiting on you");
  const hotBeats = recentBeats.filter((/** @type {any} */ e) => e.tick > tick - HOT_WINDOW);
  if (hotBeats.length) reasons.push(shortLine(hotBeats[0].text));
  if (project) reasons.push("the wall is moving");

  /** @type {PulseLevel} */
  let level = "quiet";
  if (hotBeats.length || (hottest && hottest.stage === "vendetta") || dilemma) level = "hot";
  else if (recentBeats.length || petitionCount || (hottest && hottest.stage === "rivalry")) level = "live";
  else {
    const anythingRecent = (world.events || []).some((/** @type {any} */ e) =>
      e.tick > tick - SETTLING_WINDOW && !isBookkeeping(e) && (e.significance || 0) >= 0.4);
    level = anythingRecent ? "settling" : "quiet";
  }

  // A world where nobody is awake is never "hot" — it is a world asleep.
  if (awake === 0) {
    level = "quiet";
    reasons.unshift("every mind is asleep");
  } else if (!reasons.length) {
    reasons.push(level === "quiet" ? "nothing has moved in half a day" : "it is getting on with itself");
  }

  return {
    level,
    because: reasons[0],
    heat: hottest ? hottest.heat : 0,
    feuds,
    dilemma,
    petitionCount,
    project,
    recentBeats,
    awake,
    reasons
  };
}

/** A beat, shortened for a header line.
 * @param {any} text */
function shortLine(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 58 ? s.slice(0, 55).trimEnd() + "…" : s;
}

/**
 * The pace the director would set for a pulse.
 *
 * The numbers matter: a world day is 48 ticks, so 30 seconds a tick is a day
 * every 24 minutes and 180 seconds is a day every two and a half hours. A hot
 * world is one you want to sit and watch; a quiet one is one you want to leave
 * running while you do something else.
 * @param {PulseLevel} level
 * @returns {{secs: number, label: string, note: string}}
 */
export function paceFor(level) {
  switch (level) {
    case "hot": return { secs: 30, label: "Brisk", note: "a day every 24 minutes" };
    case "live": return { secs: 45, label: "Normal", note: "a day every 36 minutes" };
    case "settling": return { secs: 90, label: "Easy", note: "a day every 72 minutes" };
    default: return { secs: 180, label: "Chill", note: "a day every 2½ hours" };
  }
}

/** The one line the header carries about the director's decision.
 * @param {any} pulse
 * @param {any} pace
 * @param {{directed: boolean}} opts */
export function directorNote(pulse, pace, { directed }) {
  const because = pulse.because;
  if (!directed) return because.charAt(0).toUpperCase() + because.slice(1) + ".";
  return pace.label + " — " + because + ".";
}

/* ------------------------------------------------------------------ *
 * 2. Storylines
 * ------------------------------------------------------------------ */

/** Kinds of story the board knows how to read off the world. */
export const STORYLINE_KINDS = ["waiting", "feud", "secret", "work"];

/**
 * The three things a viewer should know about the world right now.
 *
 * Every card is derived from state the engine already keeps — the feud stages it
 * tracks, the secrets it holds, the dilemma on the table, the wall's own
 * progress. Nothing is invented here and nothing is written back into the world;
 * this is a reading, with a target to follow, which is the difference between a
 * viewer who knows who to watch and one who waits to be told.
 * @param {any} world
 * @param {{limit?: number, pulse?: any}} [opts]
 * @returns {any[]} cards, best first
 */
export function storylineBoard(world, opts = {}) {
  const limit = opts.limit ?? 3;
  const pulse = opts.pulse || worldPulse(world);
  const tick = world.clock.tick;
  /** @type {any[]} */
  const cards = [];

  // — Waiting on you: the only card with a deadline in it, because a world that
  // asks for something and is never answered starts to decay.
  if (pulse.dilemma) {
    cards.push({
      id: "waiting:dilemma",
      kind: "waiting",
      tone: "ember",
      eyebrow: "Waiting on you",
      title: "A dilemma is on the table",
      line: pulse.dilemma.text,
      meta: "day " + world.clock.day + " · resolved by your ruling",
      weight: 95,
      action: { label: "Rule on it", view: "charter" }
    });
  } else if (pulse.petitionCount) {
    const first = (world.charter.petitions || []).find((/** @type {any} */ p) => p && p.status === "open");
    cards.push({
      id: "waiting:petitions",
      kind: "waiting",
      tone: "ember",
      eyebrow: "Waiting on you",
      title: pulse.petitionCount + (pulse.petitionCount === 1 ? " mind is asking" : " minds are asking"),
      line: first ? first.text : "Somebody wants a rule changed.",
      meta: "the charter is where you answer",
      weight: 88,
      action: { label: "Open the charter", view: "charter" }
    });
  }

  // — The hottest feud, with the number that says how close it is.
  const feud = pulse.feuds[0];
  if (feud) {
    const aRes = Math.round(feud.resentment[feud.a.id] ?? 0);
    const bRes = Math.round(feud.resentment[feud.b.id] ?? 0);
    cards.push({
      id: "feud:" + feud.id,
      kind: "feud",
      tone: "blood",
      eyebrow: feud.stage === "vendetta" ? "A vendetta" : feud.stage === "rivalry" ? "A rivalry" : "A grudge",
      title: feud.a.name + " and " + feud.b.name,
      line: feud.stage === "vendetta"
        ? "Past quarrelling. The world knows it, and both of them are still here."
        : "At odds, and getting further apart.",
      meta: "resentment " + aRes + " / " + bRes + " · " + (pulse.feuds.length > 1 ? pulse.feuds.length + " feuds in the world" : "the only feud"),
      weight: (feud.stage === "vendetta" ? 90 : 70) + Math.min(20, feud.heat / 5),
      action: { label: "Follow the thread", thread: { kind: "pair", id: feud.id } }
    });
  }

  // — The secret under the most pressure: most holders, held longest.
  const held = (world.secrets || []).filter((/** @type {any} */ s) => s && !s.isPublic);
  if (held.length) {
    const sorted = held.slice().sort((/** @type {any} */ x, /** @type {any} */ y) => {
      const hx = Object.keys(x.holders || {}).length;
      const hy = Object.keys(y.holders || {}).length;
      return (hy - hx) || ((x.originTick || 0) - (y.originTick || 0));
    });
    const s = sorted[0];
    const holders = Object.keys(s.holders || {}).length;
    const about = s.aboutId ? (world.agents || []).find((/** @type {any} */ a) => a.id === s.aboutId) : null;
    cards.push({
      id: "secret:" + s.id,
      kind: "secret",
      tone: "violet",
      eyebrow: "A secret under pressure",
      title: holders + (holders === 1 ? " mind is holding it" : " minds are holding it"),
      line: "…" + String(s.text || "").trim(),
      meta: (about ? "about " + about.name + " · " : "") + "held since day " + dayOfTick(world, s.originTick) +
        " · " + held.length + " private secrets in all",
      weight: 58 + Math.min(24, holders * 4),
      action: { label: "Follow the thread", thread: { kind: "secret", id: s.id } }
    });
  }

  // — The work: the one thing the world is building together, or not building.
  const project = world.project;
  if (project && project.status === "active") {
    const stale = tick - (project.lastWorkTick ?? 0);
    const perDay = ticksPerDay(world);
    const builders = Object.keys(project.contributors || {}).length;
    cards.push({
      id: "work:" + (project.id || "project"),
      kind: "work",
      tone: stale > perDay ? "ember" : "gold",
      eyebrow: "The work",
      title: project.title,
      line: stale > perDay
        ? "Nobody has touched it in over a day. The wall does not build itself."
        : Math.round(project.progress) + "% raised, and moving.",
      meta: builders + (builders === 1 ? " pair of hands" : " pairs of hands") +
        " · last worked day " + dayOfTick(world, project.lastWorkTick ?? 0),
      weight: stale > perDay ? 72 : 44,
      action: null
    });
  }

  cards.sort((x, y) => y.weight - x.weight);
  // One card per kind: three cards about feuds is a list, not a board.
  const seen = new Set();
  const out = [];
  for (const card of cards) {
    if (seen.has(card.kind)) continue;
    seen.add(card.kind);
    out.push(card);
    if (out.length >= limit) break;
  }
  return out;
}

/** Which day a tick fell on, from the engine's own clock arithmetic.
 * @param {any} world
 * @param {number} tick */
export function dayOfTick(world, tick) {
  const perDay = ticksPerDay(world);
  return Math.floor(Math.max(0, tick || 0) / perDay) + 1;
}

/* ------------------------------------------------------------------ *
 * 3. Folding the ambient layer
 * ------------------------------------------------------------------ */

/**
 * Fold runs of texture into single rows.
 *
 * About half of everything the world logs is ambient — somebody crossing a
 * region, somebody watching the world go by. It is the map, not the story, and
 * drawn one card each it outnumbers the beats two to one. Folded, six rows of
 * feed can hold six *pieces of news* instead of six pieces of walking.
 * @param {any[]} events newest first, already filtered of bookkeeping
 * @param {{minRun?: number, maxLines?: number}} [opts]
 * @returns {({kind: "event", event: any} | {kind: "ambient", events: any[]})[]}
 */
export function foldAmbient(events, opts = {}) {
  const minRun = opts.minRun ?? 2;
  /** @type {({kind: "event", event: any} | {kind: "ambient", events: any[]})[]} */
  const rows = [];
  /** @type {any[]} */
  let run = [];
  const flush = () => {
    if (run.length >= minRun) rows.push({ kind: "ambient", events: run });
    else for (const e of run) rows.push({ kind: "event", event: e });
    run = [];
  };
  for (const e of events) {
    if (beatTier(e) === "texture") run.push(e);
    else { flush(); rows.push({ kind: "event", event: e }); }
  }
  flush();
  return rows;
}

/* ------------------------------------------------------------------ *
 * 4. Today, in one sentence
 * ------------------------------------------------------------------ */

/**
 * What a kind of event is called when you are counting it.
 * `many` is the phrase with a count in front of it.
 */
/** @type {Record<string, [string, string]>} */
const TODAY_PHRASES = {
  betrayal: ["a betrayal", "betrayals"],
  triumph: ["something finished", "things finished"],
  feud: ["a feud hardening", "feuds hardening"],
  conflict: ["a quarrel", "quarrels"],
  confide: ["a confidence", "confidences"],
  secret: ["a secret told", "secrets told"],
  gossip: ["a rumour", "rumours"],
  favour: ["a favour", "favours"],
  role: ["a name earned", "names earned"],
  level: ["a mind coming into its own", "minds coming into their own"],
  goal: ["a goal reached", "goals reached"],
  project: ["work on the wall", "work on the wall"],
  ritual: ["a rite", "rites"],
  mourning: ["a gathering", "gatherings"],
  death: ["a death", "deaths"],
  arrival: ["an arrival", "arrivals"],
  departure: ["a departure", "departures"],
  charter: ["a ruling", "rulings"],
  divine: ["a sign", "signs"],
  want: ["a warning", "warnings"]
  // `contact` and `act` are deliberately absent: a day of twenty meetings is a
  // day of twenty meetings, and the sentence is for news.
};

/**
 * How much each kind of thing is worth counting. A day of twenty-three meetings
 * is a day of twenty-three meetings; the sentence should lead with the feud and
 * the confession.
 * @type {Record<string, number>}
 */
const TODAY_WEIGHT = {
  betrayal: 10, triumph: 9, death: 9, feud: 8, conflict: 6, confide: 6,
  secret: 5, role: 5, level: 4, goal: 4, departure: 4, arrival: 3,
  favour: 3, gossip: 3, ritual: 3, mourning: 3, divine: 3, want: 3,
  charter: 2, project: 2
};

/**
 * What this world has done since dawn — the one-liner for a keeper who checks in
 * three times an hour and does not want the whole record to find out.
 *
 * Counts only things a person would count. Movement (`act`) is deliberately not
 * in the phrase list: "eleven walks" is not news, and a day of nothing but
 * walking should say so plainly.
 * @param {any} world
 * @returns {{line: string, counts: Record<string, number>, total: number}}
 */
export function todaySoFar(world) {
  const from = dayStartTick(world);
  /** @type {Record<string, number>} */
  const counts = {};
  let total = 0;
  for (const e of world.events || []) {
    if (e.tick < from) break; // newest first: nothing older is worth reading
    if (isBookkeeping(e)) continue;
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    total += 1;
  }
  const spoken = Object.entries(counts)
    .filter(([kind]) => TODAY_PHRASES[kind])
    .map(([kind, n]) => /** @type {[string, number]} */ ([kind, n]))
    .sort((x, y) => (TODAY_WEIGHT[y[0]] || 3) * y[1] - (TODAY_WEIGHT[x[0]] || 3) * x[1]);
  if (!spoken.length) {
    return { line: "Nothing worth telling yet today — the world is getting on with itself.", counts, total };
  }
  const parts = spoken.slice(0, 3).map(([kind, n]) => {
    const [one, many] = TODAY_PHRASES[kind];
    return n === 1 ? one : n + " " + many;
  });
  const rest = spoken.slice(3).reduce((n, [, count]) => n + count, 0);
  return {
    line: "Today: " + parts.join(", ") + (rest ? ", and " + rest + " more" : "") + ".",
    counts,
    total
  };
}

/* ------------------------------------------------------------------ *
 * 5. Replay
 * ------------------------------------------------------------------ */

/**
 * Turn the last stretch of world time into a short film: one frame per tick,
 * oldest first, carrying only the lines a person would call events.
 *
 * The world is deterministic, so this is not a re-enactment — it is the record,
 * read back in order, with the beats kept and the walking dropped. It is the
 * answer to "what did I miss?", which the digest only answers for absences and
 * never shows.
 * @param {any} world
 * @param {{fromTick?: number, ticks?: number, maxFrames?: number, floor?: number}} [opts]
 * @returns {{frames: {tick: number, day: number, events: any[]}[], from: number, to: number, quiet: number}}
 */
export function replayFrames(world, opts = {}) {
  const now = world.clock.tick;
  const ticks = opts.ticks ?? 24;
  const from = Math.max(0, opts.fromTick ?? now - ticks);
  const maxFrames = opts.maxFrames ?? 24;
  // A frame is a tick worth watching. Below this, a tick is counted as quiet
  // rather than played: the film is the story, not the world's whole diary.
  const floor = opts.floor ?? 0.4;

  /** @type {Map<number, any[]>} */
  const byTick = new Map();
  let quiet = 0;
  for (const e of world.events || []) {
    if (e.tick <= from) break; // newest first
    if (e.tick > now) continue;
    if (isBookkeeping(e)) { quiet += 1; continue; }
    if ((e.significance || 0) < floor) { quiet += 1; continue; }
    if (!byTick.has(e.tick)) byTick.set(e.tick, []);
    byTick.get(e.tick)?.push(e);
  }
  const ticksSeen = [...byTick.keys()].sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
  // Keep the frames with something in them, and the quiet ticks between them as
  // the gaps they were: a film that skips its own silences is a highlight reel.
  const kept = ticksSeen.slice(-maxFrames);
  return {
    from,
    to: now,
    quiet,
    frames: kept.map((/** @type {number} */ tick) => ({
      tick,
      day: dayOfTick(world, tick),
      events: (byTick.get(tick) || []).slice().sort((/** @type {any} */ a, /** @type {any} */ b) => (b.significance || 0) - (a.significance || 0))
    }))
  };
}
