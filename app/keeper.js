/**
 * The keeper: the player's own progression.
 *
 * The keeper is the person looking after the world. Nothing in the simulation
 * depends on this module; it only records what the keeper has done and turns
 * that into a rank and a set of achievements.
 *
 * Every reward is paid once. The keeper accrues a "mark" the first time they
 * do something (open a mind's dossier, hear a scene, see a day close), and a
 * mark pays its XP exactly once, so there is no farming by reloading or tapping.
 * Ranks and achievements are derived from the marks, not stored separately, so
 * they can never disagree with what actually happened.
 */

/** XP paid for each kind of first-time act. */
export const XP = Object.freeze({
  tab: 5,        // first visit to a screen
  dossier: 8,    // first time reading a mind's dossier
  chat: 10,      // first message to a mind
  chronicle: 4,  // a chronicle entry read
  scene: 3,      // a conversation overheard
  betrayal: 6,   // a betrayal witnessed in the record
  day: 10        // a new day of the world kept
});

/** Ranks, lowest first. A keeper holds the highest rank whose XP they have reached. */
export const RANKS = Object.freeze([
  { xp: 0, title: "Passerby" },
  { xp: 40, title: "Watcher" },
  { xp: 120, title: "Chronicler" },
  { xp: 260, title: "Steward" },
  { xp: 450, title: "Keeper of the Record" },
  { xp: 700, title: "Witness of Ages" }
]);

/**
 * Achievements. `test` gets the tallies and the number of minds in the world.
 * @typedef {{ id: string, title: string, desc: string, test: (t: Tallies) => boolean }} Achievement
 */
/** @type {readonly Achievement[]} */
export const ACHIEVEMENTS = Object.freeze([
  { id: "first-look", title: "First Look", desc: "Read three dossiers.", test: t => t.dossiers >= 3 },
  { id: "met-them-all", title: "Known to Them All", desc: "Read the dossier of every mind in the world.", test: t => t.minds > 0 && t.dossiers >= t.minds },
  { id: "first-word", title: "First Word", desc: "Speak to a mind for the first time.", test: t => t.chats >= 1 },
  { id: "confidant", title: "Confidant", desc: "Have a conversation with five different minds.", test: t => t.chats >= 5 },
  { id: "overheard", title: "Overheard", desc: "Hear five conversations between minds.", test: t => t.scenes >= 5 },
  { id: "witness", title: "Witness", desc: "See a betrayal in the record.", test: t => t.betrayals >= 1 },
  { id: "chronicler", title: "Chronicler", desc: "Read seven entries of the Chronicle.", test: t => t.chronicle >= 7 },
  { id: "every-corner", title: "Every Corner", desc: "Visit every screen of the app.", test: t => t.tabs >= 5 },
  { id: "week-kept", title: "A Week Kept", desc: "See seven days of the world close.", test: t => t.days >= 7 },
  { id: "month-kept", title: "A Month Kept", desc: "See thirty days of the world close.", test: t => t.days >= 30 }
]);

/**
 * @typedef {object} Tallies
 * @property {number} dossiers
 * @property {number} chats
 * @property {number} scenes
 * @property {number} betrayals
 * @property {number} chronicle
 * @property {number} tabs
 * @property {number} days
 * @property {number} minds
 */

/** @returns {{ marks: string[], xp: number }} */
export function emptyKeeper() {
  return { marks: [], xp: 0 };
}

/**
 * Coerce whatever came out of storage into a valid keeper. Bad data becomes a
 * fresh keeper rather than an exception on launch.
 * @param {unknown} raw
 */
export function normalizeKeeper(raw) {
  const k = /** @type {any} */ (raw);
  if (!k || typeof k !== "object" || !Array.isArray(k.marks)) return emptyKeeper();
  const marks = [...new Set(k.marks.filter(/** @param {unknown} m */ m => typeof m === "string"))];
  // XP is derived from the marks, so a corrupt total cannot survive a reload.
  return { marks, xp: marks.reduce((sum, m) => sum + xpFor(m), 0) };
}

/** @param {string} mark */
function xpFor(mark) {
  const kind = mark.split(":")[0];
  return /** @type {Record<string, number>} */ (XP)[kind] || 0;
}

/**
 * Record an act. Returns true if it was new (and so paid XP), false otherwise.
 * @param {{ marks: string[], xp: number }} keeper
 * @param {keyof typeof XP | string} kind
 * @param {string|number} [key]   Identifies the thing done, e.g. a mind's id.
 */
export function award(keeper, kind, key = "") {
  if (!(kind in XP)) return false;
  const mark = kind + ":" + String(key);
  if (keeper.marks.includes(mark)) return false;
  keeper.marks.push(mark);
  keeper.xp += /** @type {Record<string, number>} */ (XP)[kind];
  return true;
}

/**
 * Count the keeper's marks by kind, plus the highest day they have seen close.
 * @param {{ marks: string[] }} keeper
 * @param {number} mindCount
 * @returns {Tallies}
 */
export function tallies(keeper, mindCount) {
  const count = (/** @type {string} */ kind) => keeper.marks.filter((/** @type {string} */ m) => m.startsWith(kind + ":")).length;
  let days = 0;
  for (const m of keeper.marks) {
    if (String(m).startsWith("day:")) days = Math.max(days, Number(String(m).slice(4)) || 0);
  }
  return {
    dossiers: count("dossier"),
    chats: count("chat"),
    scenes: count("scene"),
    betrayals: count("betrayal"),
    chronicle: count("chronicle"),
    tabs: count("tab"),
    days,
    minds: mindCount
  };
}

/**
 * Everything the screen needs: rank, progress to the next rank, and which
 * achievements are unlocked.
 * @param {{ marks: string[], xp: number }} keeper
 * @param {number} mindCount
 */
export function summarize(keeper, mindCount) {
  let rankIndex = 0;
  for (let i = 0; i < RANKS.length; i++) if (keeper.xp >= RANKS[i].xp) rankIndex = i;
  const rank = RANKS[rankIndex];
  const next = RANKS[rankIndex + 1] || null;
  const span = next ? next.xp - rank.xp : 1;
  const progress = next ? Math.min(1, (keeper.xp - rank.xp) / span) : 1;
  const t = tallies(keeper, mindCount);
  const achievements = ACHIEVEMENTS.map(a => ({ id: a.id, title: a.title, desc: a.desc, unlocked: a.test(t) }));
  return {
    xp: keeper.xp,
    rank: rank.title,
    rankIndex,
    next: next ? { title: next.title, xp: next.xp, remaining: next.xp - keeper.xp } : null,
    progress,
    achievements,
    unlocked: achievements.filter(a => a.unlocked).length,
    tallies: t
  };
}
