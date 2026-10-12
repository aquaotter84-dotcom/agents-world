/**
 * The tick loop.
 *
 * This is the piece that decides how fast real time moves, and the only piece
 * that knows about the wall clock at all. The engine emits at most a couple of
 * beats per tick and is happy to run as fast as you can call it; the loop calls
 * it on a schedule, hands the model work off, and saves on the way past.
 *
 * The rule that matters: **a tick never waits on a model call.** The next engine
 * tick starts on time whether or not the network has answered; anything still
 * pending when its window closes is decided by the engine itself. That is why a
 * world can be left running for a week on a small box without a queue growing
 * behind it.
 *
 * Shared by `server/index.js` (the plain runner) and `server/service.js` (the
 * hosted one, which serves the app from the same process).
 */

import { step, describeWorld, worldStats, socialTemperature } from "../engine/index.js";
import { saveWorld } from "./world-file.js";

/**
 * @typedef {object} RunnerOptions
 * @property {import("../engine/model/world.js").World} world
 * @property {{drain: () => Promise<any>}} momentWorker
 * @property {string} savePath
 * @property {number} tickSeconds   Seconds between ticks. 0 means as fast as the engine can go.
 * @property {number} saveEvery     Save every N ticks (the last tick always saves).
 * @property {number} [maxTicks]    Run this many ticks and stop. Default: forever.
 * @property {(msg: string) => void} [log]
 * @property {(report: any) => void} [onTick]  Called after every tick, for anything the host wants to say.
 * @property {{calls: number, stats: () => any}} [llm]  Optional: for the periodic progress line.
 */

/**
 * @param {RunnerOptions} opts
 */
export function createRunner(opts) {
  const log = opts.log || (() => {});
  const maxTicks = opts.maxTicks ?? Infinity;
  const tickSeconds = Math.max(0, opts.tickSeconds);
  let running = true;
  let ticks = 0;

  function save() {
    saveWorld(opts.savePath, opts.world, log);
  }

  function tickOnce() {
    const report = step(opts.world);
    ticks += 1;
    if (opts.onTick) opts.onTick(report);
    // Model work is deliberately not awaited here. Late HTTP replies are
    // discarded by the worker when their moment has expired.
    void opts.momentWorker.drain();
    return report;
  }

  function stop() {
    running = false;
    save();
  }

  async function start() {
    // Write the world straight away, so anything reading the save — the app, a
    // status check — sees a living world from the moment the process starts.
    save();
    const intervalMs = tickSeconds * 1000;
    let nextAt = Date.now();

    while (running && ticks < maxTicks) {
      try {
        tickOnce();
      } catch (err) {
        log(`tick failed: ${err instanceof Error ? err.stack || err.message : err}`);
      }

      if (ticks % opts.saveEvery === 0) save();

      if (maxTicks !== Infinity && ticks % 25 === 0) {
        const s = worldStats(opts.world);
        const temp = socialTemperature(opts.world);
        log(
          `  day ${s.day} · ${s.agents} minds awake · ${s.publicSecrets} secrets out · ` +
            `affection/friction ${temp.ratio.toFixed(2)}` +
            (opts.llm ? ` · ${opts.llm.calls} model calls` : "")
        );
      }

      if (intervalMs === 0) {
        // Yield occasionally so a long fast run stays interruptible.
        if (ticks % 200 === 0) await sleep(0);
      } else {
        nextAt += intervalMs;
        const wait = nextAt - Date.now();
        if (wait > 0) await sleep(wait);
        else nextAt = Date.now(); // fell behind; don't accumulate a backlog
      }
    }

    save();
    return ticks;
  }

  return {
    start,
    stop,
    save,
    tickOnce,
    get world() { return opts.world; },
    get ticks() { return ticks; },
    describe: () => describeWorld(opts.world)
  };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
