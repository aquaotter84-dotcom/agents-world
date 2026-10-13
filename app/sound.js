/**
 * Sound and haptics — the smallest possible amount of both.
 *
 * A phone in a pocket cannot see the arrival card. This is the part of the app
 * that makes a moment audible when nobody is looking at the screen: one soft
 * chime for a moment the world just had, a different one for a beat, and a short
 * buzz on a device that has a motor. Off by default; one switch in Admin.
 *
 * Three rules it keeps:
 *
 *   1. Nothing is fetched. Every sound is generated — two sine tones and an
 *      envelope — because the app ships as a phone app with no assets, and a
 *      chime that has to download is a chime that arrives late.
 *   2. Nothing plays without a gesture. Browsers refuse to start an AudioContext
 *      until the user has touched the page, so the context is created lazily on
 *      the first gesture anywhere, and `ready()` is honest about it.
 *   3. Nothing here can throw. A device with no WebAudio, no vibrate, or a
 *      suspended context gets silence, not an error in the middle of a tick.
 */

/** How loud the chimes are. Deliberately quiet: this is an app you leave open. */
const VOLUME = 0.055;

/** Tone recipes per kind of event. Frequency in Hz, `gap` in seconds. */
const RECIPES = {
  // A moment (>= 0.85): two notes, rising, with a long tail. Rare enough to
  // deserve it — the engine logs about one every ten minutes of world time.
  moment: [
    { f: 523.25, at: 0, dur: 0.5, gain: 1.0 },
    { f: 783.99, at: 0.16, dur: 0.9, gain: 0.9 }
  ],
  // A beat (>= 0.6): one note, soft.
  beat: [
    { f: 440.0, at: 0, dur: 0.45, gain: 0.7 }
  ],
  // The little settle when the world stops being busy — used by the director
  // when it slows the clock down, so a pace change is felt and not just read.
  settle: [
    { f: 329.63, at: 0, dur: 0.6, gain: 0.5 }
  ]
};

/** Vibration patterns per kind, in milliseconds. */
const BUZZ = {
  moment: [18, 60, 26],
  beat: [14],
  settle: [10]
};

/** @type {AudioContext|null} */
let ctx = null;
let armed = false;
let unlocked = false;

/**
 * Whether sound is on, reading the settings shape the app persists.
 * @param {any} settings
 */
export function isSoundOn(settings) {
  return !!(settings && settings.sound);
}

/**
 * Turn it on or off. Returns the settings object it was given, so callers can
 * keep `save()` in one place.
 * @param {any} settings
 * @param {boolean} on
 */
export function setSoundOn(settings, on) {
  if (settings && typeof settings === "object") settings.sound = !!on;
  if (on) arm();
  return settings;
}

/**
 * Wait for the first gesture, then open the audio context on it. Called from
 * `setSoundOn` and from boot; safe to call many times.
 */
export function arm() {
  if (armed || typeof document === "undefined" || !document.addEventListener) return;
  armed = true;
  const open = () => {
    unlocked = true;
    try {
      const Ctor = /** @type {any} */ (globalThis).AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
      if (Ctor && !ctx) ctx = new Ctor();
      if (ctx && ctx.state === "suspended") ctx.resume();
    } catch (e) { ctx = null; }
    document.removeEventListener("pointerdown", open);
    document.removeEventListener("keydown", open);
  };
  // `pointerdown` first: one listener that covers touch and mouse alike.
  document.addEventListener("pointerdown", open, { once: true });
  document.addEventListener("keydown", open, { once: true });
}

/** Is there a live audio context right now? Honest, for tests and for Admin. */
export function ready() {
  return !!(unlocked && ctx);
}

/** How many tones a kind has — so a test can know the recipes are distinct.
 * @param {string} kind */
export function recipeSize(kind) {
  const recipes = /** @type {Record<string, any[]>} */ (RECIPES);
  return (recipes[kind] || RECIPES.beat).length;
}

/**
 * Play a chime. Silent (and safe) when sound is off, when the page has not been
 * touched yet, or on a device with no WebAudio.
 * @param {"moment"|"beat"|"settle"} kind
 * @param {{settings?: any, force?: boolean}} [opts]
 */
export function chime(kind, opts = {}) {
  const settings = opts.settings;
  const allowed = opts.force || isSoundOn(settings);
  play(kind, allowed, opts.force);
}

/**
 * A short buzz, where the device has one. Same permissions as the chime.
 * @param {"moment"|"beat"|"settle"} kind
 * @param {{settings?: any, force?: boolean}} [opts]
 */
export function buzz(kind, opts = {}) {
  const allowed = opts.force || isSoundOn(opts.settings);
  if (!allowed) return false;
  try {
    const nav = /** @type {any} */ (globalThis).navigator;
    if (!nav || typeof nav.vibrate !== "function") return false;
    return nav.vibrate(BUZZ[kind] || BUZZ.beat);
  } catch (e) { return false; }
}

/**
 * The whole thing: chime and buzz together, at the right volume for the kind.
 * @param {"moment"|"beat"|"settle"} kind
 * @param {{settings?: any, force?: boolean}} [opts]
 */
export function sting(kind, opts = {}) {
  chime(kind, opts);
  buzz(kind, opts);
}

/** @param {"moment"|"beat"|"settle"} kind @param {boolean} allowed @param {boolean|undefined} force */
function play(kind, allowed, force) {
  /** @type {"moment"|"beat"|"settle"} */
  const which = RECIPES[kind] ? kind : "beat";
  if (!allowed) return;
  // A forced play (Admin's own test button) may open the context itself, because
  // it is called from a gesture.
  if (!ctx && force) {
    unlocked = true;
    try {
      const Ctor = /** @type {any} */ (globalThis).AudioContext || /** @type {any} */ (globalThis).webkitAudioContext;
      if (Ctor) ctx = new Ctor();
    } catch (e) { ctx = null; }
  }
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    for (const tone of RECIPES[which]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.f;
      const start = now + tone.at;
      const end = start + tone.dur;
      // A plucked shape rather than a held note: quick in, long out.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(VOLUME * tone.gain, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch (e) { /* silence is a valid outcome */ }
}
