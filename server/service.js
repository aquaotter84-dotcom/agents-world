/**
 * The always-on world, in one process.
 *
 * `server/index.js` lives the world; `tools/serve.mjs` serves the app. On a
 * laptop that is two terminals, which is fine. On a box in a datacentre it is
 * one question — *what do I start?* — and the answer should be a single command
 * that keeps the world ticking **and** serves the keeper's window onto it, on
 * one port, from one process that either runs or does not.
 *
 * That is what this is. The app is served from `app/`, the world is written to
 * `--save`, `/api/world` and `/api/status` are the read-only endpoints the app
 * probes, and the tick loop is the same loop the plain runner uses. Because the
 * app and the API share an origin, opening the deployed URL is enough: the app
 * probes, finds the world, adopts it and shows the clock it did not start.
 *
 *   node server/service.js                    tick every 90s, serve on :4321
 *   node server/service.js --tick-seconds 60  slower or faster days
 *   node server/service.js --offline          no model calls at all
 *   PORT=8080 node server/service.js          the port the platform offers
 *
 * Nothing here assumes a particular host. Railway, Fly, Render, a $5 VPS behind
 * Caddy, a Raspberry Pi on a shelf: they are all "run this command, keep it
 * running, mount one volume for the save file". The tradeoffs are written up in
 * the README under "The always-on world".
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeWorld } from "../engine/index.js";
import { Llm } from "./llm.js";
import { createMomentWorker } from "./moment-worker.js";
import { createRunner } from "./run-loop.js";
import { loadOrCreateWorld, isNumeric } from "./world-file.js";
import { startWorldServer, portOf } from "./web.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WEB_DIR = resolve(ROOT, "app");

/* ------------------------------------------------------------------ *
 * Arguments, environment, world
 * ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
const OFFLINE = Boolean(args.offline) || process.env.AGENTS_WORLD_OFFLINE === "1";
const API_KEY = String(args.key || process.env.BLUESMINDS_API_KEY || "");
const MODEL = String(args.model || process.env.BLUESMINDS_MODEL || "openai/gpt-oss-20b");
const LLM_URL = String(args.url || process.env.LLM_BASE_URL || ""); // any OpenAI-compatible chat-completions endpoint
const SEED = typeof args.seed === "string" || typeof args.seed === "number" ? args.seed : 1;
const TICK_SECONDS = Number(args["tick-seconds"] ?? process.env.TICK_SECONDS ?? 90);
const MAX_TICKS = args.ticks !== undefined ? Number(args.ticks) : Infinity;
const SAVE_PATH = resolve(ROOT, String(args.save || process.env.AGENTS_WORLD_SAVE || "data/world.json"));
const SAVE_EVERY = Number(args["save-every"] ?? 5);
const FRESH = Boolean(args.fresh);
const QUIET = Boolean(args.quiet);
const PORT = Number(args.port ?? process.env.PORT ?? 4321);
const HOST = String(args.host ?? process.env.HOST ?? "0.0.0.0");

const log = QUIET ? (/** @type {any[]} */ ..._parts) => {} : (/** @type {any[]} */ ...parts) => console.log(...parts);

const llm = new Llm({
  apiKey: OFFLINE ? "" : API_KEY,
  model: MODEL,
  url: LLM_URL || undefined,
  log: msg => log(`  [api] ${msg}`)
});
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
    if (report.moments.length) log(`tick ${report.tick} — ${report.moments.length} moment(s) offered to the model`);
  }
});

/* ------------------------------------------------------------------ *
 * Serve, then live
 * ------------------------------------------------------------------ */

const server = await startWorldServer({ webDir: WEB_DIR, savePath: SAVE_PATH, host: HOST, port: PORT });
const bound = portOf(server);

log(resumed ? `Resumed the world from ${SAVE_PATH}` : `Created a new world (seed ${SEED}).`);
log(describeWorld(world));
log("");
log(OFFLINE || !llm.available
  ? "Running offline: the engine will decide every moment itself. No network calls."
  : `Connected to ${MODEL}. Model moments will be answered live.`);
log(`Tick every ${TICK_SECONDS}s, saving every ${SAVE_EVERY} ticks to ${SAVE_PATH}.`);
log(`Serving the app and the world on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${bound}`);
if (HOST === "0.0.0.0") log("  (on a host, this is the URL the keeper opens — the app finds the world at /api/world)");
log("");

let stopping = false;
const onStop = () => {
  if (stopping) return;
  stopping = true;
  log("\nStopping. Saving…");
  runner.stop();
  server.close(() => process.exit(0));
  // A wedged connection must not keep the world from being saved on the way out.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

runner.start().then(ran => {
  log("");
  log(describeWorld(world));
  log(`Ran ${ran} tick(s). ${JSON.stringify(llm.stats())}`);
  log(`Saved to ${SAVE_PATH}`);
  if (MAX_TICKS !== Infinity) {
    // A fixed number of ticks means "do the work and stop" — don't hold the
    // port open afterwards.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
});

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
