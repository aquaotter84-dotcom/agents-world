/**
 * The headless runner.
 *
 * This is the piece that turns the engine into a world that lives while you are
 * not looking. It owns the clock, the model budget and the save file; the engine
 * owns everything about what actually happens. For deployments where one process
 * should both live the world *and* serve the app, see `server/service.js`.
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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeWorld } from "../engine/index.js";
import { Llm } from "./llm.js";
import { createMomentWorker } from "./moment-worker.js";
import { createRunner } from "./run-loop.js";
import { loadOrCreateWorld, isNumeric } from "./world-file.js";

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
const SAVE_PATH = resolve(ROOT, String(args.save || process.env.AGENTS_WORLD_SAVE || "data/world.json"));
const SAVE_EVERY = Number(args["save-every"] ?? 5);
const FRESH = Boolean(args.fresh);
const QUIET = Boolean(args.quiet);

const log = QUIET ? (/** @type {any[]} */ ..._parts) => {} : (/** @type {any[]} */ ...parts) => console.log(...parts);

/* ------------------------------------------------------------------ *
 * World setup
 * ------------------------------------------------------------------ */

const llm = new Llm({ apiKey: OFFLINE ? "" : API_KEY, model: MODEL, log: msg => console.log(`  [api] ${msg}`) });
const { world, resumed } = loadOrCreateWorld({
  savePath: SAVE_PATH,
  seed: isNumeric(SEED) ? Number(SEED) : SEED,
  fresh: FRESH,
  log: msg => console.error(msg)
});

const runner = createRunner({
  world,
  momentWorker: createMomentWorker({
    world,
    llm,
    log,
    onResolved: () => runner.save()
  }),
  savePath: SAVE_PATH,
  tickSeconds: TICK_SECONDS,
  saveEvery: SAVE_EVERY,
  maxTicks: MAX_TICKS,
  log,
  llm,
  onTick: report => {
    if (report.collapsed.length) log(`  ${report.collapsed.join(", ")} collapsed from exhaustion.`);
    if (report.moments.length) log(`tick ${report.tick} — ${report.moments.length} moment(s) offered to the model`);
    else if (report.events.length) log(`tick ${report.tick} — ${report.events[0].text}`);
  }
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
 * Signals
 * ------------------------------------------------------------------ */

// A signal can arrive while the loop is asleep between ticks, and waiting out
// the rest of a tick interval before exiting is no way to stop a service. The
// world is always consistent between steps (step is synchronous), so saving
// right here and exiting is safe.
const onStop = () => {
  log("\nStopping. Saving…");
  runner.stop();
  process.exit(0);
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

runner.start().then(ran => {
  log("");
  log(describeWorld(world));
  log(`Ran ${ran} tick(s). ${JSON.stringify(llm.stats())}`);
  log(`Saved to ${SAVE_PATH}`);
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

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
