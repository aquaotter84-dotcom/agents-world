/**
 * The headless runner.
 *
 * This is the piece that turns the engine into a world that lives while you are
 * not looking. It owns the loop, the clock, the model budget and the save file;
 * the engine owns everything about what actually happens.
 *
 *   node server/index.js              run with the language model (needs a key)
 *   node server/index.js --offline     run the simulation alone, no network
 *   node server/index.js --ticks 500   run a fixed number of ticks and exit
 *
 * A note on pacing. The engine emits at most `moments.maxPerTick` beats per tick
 * and is happy to run as fast as you can call it. The runner is what decides how
 * fast real time moves: one tick every `--tick-seconds`, with the model's answers
 * resolved as they arrive and anything unanswered left to the engine's own
 * judgement. That separation is why the world can be fast-forwarded for a
 * simulation and slowed down for a live one without touching the engine.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorld, step, describeWorld, worldStats, socialTemperature, serializeWorld, deserializeWorld } from "../engine/index.js";
import { Llm } from "./llm.js";
import { createMomentWorker } from "./moment-worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/* ------------------------------------------------------------------ *
 * Arguments and environment
 * ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
const OFFLINE = Boolean(args.offline) || process.env.AGENTS_WORLD_OFFLINE === "1";
const API_KEY = String(args.key || process.env.BLUESMINDS_API_KEY || "");
const MODEL = String(args.model || process.env.BLUESMINDS_MODEL || "openai/gpt-oss-20b");
const SEED = typeof args.seed === "string" || typeof args.seed === "number" ? args.seed : 1;
const TICK_SECONDS = Number(args["tick-seconds"] ?? process.env.TICK_SECONDS ?? 90);
const MAX_TICKS = args.ticks !== undefined ? Number(args.ticks) : Infinity;
const SAVE_PATH = resolve(ROOT, String(args.save || "data/world.json"));
const SAVE_EVERY = Number(args["save-every"] ?? 5);
const FRESH = Boolean(args.fresh);
const QUIET = Boolean(args.quiet);

const log = QUIET ? (/** @type {any[]} */ ..._parts) => {} : (/** @type {any[]} */ ...parts) => console.log(...parts);

/* ------------------------------------------------------------------ *
 * World setup
 * ------------------------------------------------------------------ */

const llm = new Llm({ apiKey: OFFLINE ? "" : API_KEY, model: MODEL, log: msg => console.log(`  [api] ${msg}`) });

/** @type {import("../engine/model/world.js").World} */
let world = /** @type {any} */ (undefined);
let resumed = false;

if (!FRESH && existsSync(SAVE_PATH)) {
  try {
    world = deserializeWorld(readFileSync(SAVE_PATH, "utf8"));
    resumed = true;
  } catch (err) {
    console.error(`Could not read ${SAVE_PATH} (${err instanceof Error ? err.message : err}) — starting a new world.`);
  }
}
if (!world) world = createWorld({ seed: isNumeric(SEED) ? Number(SEED) : SEED });
const momentWorker = createMomentWorker({
  world,
  llm,
  log,
  onResolved: () => save()
});

log(resumed ? `Resumed the world from ${SAVE_PATH}` : `Created a new world (seed ${SEED}).`);
log(describeWorld(world));
log("");
log(OFFLINE || !llm.available
  ? "Running offline: the engine will decide every moment itself. No network calls."
  : `Connected to ${MODEL}. Model moments will be answered live.`);
log(`Tick every ${TICK_SECONDS}s, saving every ${SAVE_EVERY} ticks to ${SAVE_PATH}.`);
log("");

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

let running = true;
let tickCount = 0;

// A signal can arrive while the loop is asleep between ticks, and waiting out
// the rest of a tick interval before exiting is no way to stop a service. The
// world is always consistent between steps (step is synchronous), so saving
// right here and exiting is safe.
const onStop = () => {
  log("\nStopping. Saving…");
  running = false;
  save();
  process.exit(0);
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

function tickOnce() {
  const report = step(world);
  tickCount += 1;

  if (report.collapsed.length) log(`  ${report.collapsed.join(", ")} collapsed from exhaustion.`);
  if (report.moments.length) log(`tick ${report.tick} — ${report.moments.length} moment(s) offered to the model`);
  else if (report.events.length) log(`tick ${report.tick} — ${report.events[0].text}`);

  // Model work is deliberately not awaited here. The next engine tick starts
  // on schedule; pending moments expire and late HTTP replies are discarded.
  void momentWorker.drain();
}

async function main() {
  // Write the world straight away, so anything reading the save (the app, a
  // status check) sees a living world from the moment the service starts.
  save();
  // 0 means "as fast as the engine can go" — used for fast-forwarding a world
  // to give it history, and by the offline simulation runs.
  const intervalMs = Math.max(0, TICK_SECONDS * 1000);
  let nextAt = Date.now();

  while (running && tickCount < MAX_TICKS) {
    try {
      tickOnce();
    } catch (err) {
      console.error(`tick failed: ${err instanceof Error ? err.stack || err.message : err}`);
    }

    if (tickCount % SAVE_EVERY === 0) save();
    if (MAX_TICKS !== Infinity && tickCount % 25 === 0) {
      const s = worldStats(world);
      const temp = socialTemperature(world);
      log(
        `  day ${s.day} · ${s.agents} minds awake · ${s.publicSecrets} secrets out · ` +
          `affection/friction ${temp.ratio.toFixed(2)} · ${llm.calls} model calls`
      );
    }

    if (intervalMs === 0) {
      // Yield occasionally so a long fast run stays interruptible.
      if (tickCount % 200 === 0) await sleep(0);
    } else {
      nextAt += intervalMs;
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      else nextAt = Date.now(); // fell behind; don't accumulate a backlog
    }
  }

  save();
  log("");
  log(describeWorld(world));
  log(`Ran ${tickCount} tick(s). ${JSON.stringify(llm.stats())}`);
  log(`Saved to ${SAVE_PATH}`);
}

/**
 * Write the save atomically: the phone app and the dev server read this file
 * while the runner may be writing it, so a reader must only ever see a whole
 * world, never half of one.
 */
function save() {
  try {
    mkdirSync(dirname(SAVE_PATH), { recursive: true });
    const tmp = SAVE_PATH + ".tmp";
    writeFileSync(tmp, serializeWorld(world), "utf8");
    renameSync(tmp, SAVE_PATH);
  } catch (err) {
    console.error(`could not save: ${err instanceof Error ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** @param {number} ms */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Turn `--key value` and `--flag` into an object. Deliberately tiny: a
 * dependency-free runner is one less thing that can break at three in the
 * morning when the world is supposed to be alive.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** @param {unknown} v */
function isNumeric(v) {
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
