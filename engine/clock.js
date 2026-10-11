/**
 * World time.
 *
 * The simulation advances in discrete ticks. Each tick is a fixed slice of world
 * time, which gives minds a day/night rhythm and gives the world a calendar to
 * hang history on. Nothing here depends on the host clock — the world's sense of
 * time is entirely internal, so a fast-forwarded simulation feels the same as a
 * real-time one.
 */

/**
 * @typedef {object} WorldClock
 * @property {number} tick       Ticks elapsed since the world began.
 * @property {number} minutes    Minutes elapsed since the world began.
 * @property {number} day        World day number, 1-based.
 * @property {number} hour       Hour of the current day, 0-23.
 * @property {string} phase      Human-readable phase: dawn / day / dusk / night / deep night.
 */

const MINUTES_PER_DAY = 24 * 60;

/**
 * Derive calendar fields from elapsed minutes.
 * @param {number} tick
 * @param {number} minutes
 * @returns {WorldClock}
 */
function derive(tick, minutes) {
  const day = Math.floor(minutes / MINUTES_PER_DAY) + 1;
  const hour = Math.floor((minutes % MINUTES_PER_DAY) / 60);
  return { tick, minutes, day, hour, phase: phaseOf(hour) };
}

/**
 * Night and the small hours are their own thing: minds are asleep, and anything
 * that happens then carries a different weight.
 * @param {number} hour
 * @returns {string}
 */
export function phaseOf(hour) {
  if (hour < 5) return "deep night";
  if (hour < 8) return "dawn";
  if (hour < 18) return "day";
  if (hour < 21) return "dusk";
  return "night";
}

/** @returns {WorldClock} */
export function createClock() {
  // Start the world at a civilised hour so the first ticks are legible.
  const startMinutes = 7 * 60;
  return derive(0, startMinutes);
}

/**
 * Advance the clock by one tick. Mutates in place.
 * @param {WorldClock} clock
 * @param {number} minutesPerTick
 * @returns {WorldClock}
 */
export function advance(clock, minutesPerTick) {
  const next = derive(clock.tick + 1, clock.minutes + minutesPerTick);
  clock.tick = next.tick;
  clock.minutes = next.minutes;
  clock.day = next.day;
  clock.hour = next.hour;
  clock.phase = next.phase;
  return clock;
}

/**
 * Is it a time when minds would normally be resting?
 * @param {any} clock
 */
export function isNight(clock) {
  return clock.phase === "night" || clock.phase === "deep night";
}

/**
 * A short human phrase for prompts and the feed: "Day 3, dusk".
 * @param {WorldClock} clock
 */
export function describeClock(clock) {
  return `Day ${clock.day}, ${clock.phase}`;
}
