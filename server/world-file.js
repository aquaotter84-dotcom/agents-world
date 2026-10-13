/**
 * How a world gets to disk and back.
 *
 * Shared by every process that keeps a world alive — the plain runner, the
 * hosted service — because a world that is written by one process and read by
 * another must be written the same way everywhere: atomically, with the temp
 * file renamed over the target, so a reader only ever sees a whole world.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import { createWorld, deserializeWorld, serializeWorld, activateSettlement } from "../engine/index.js";

/**
 * Write the world atomically. Returns false (and complains) rather than
 * throwing: a failed save is not a reason to stop living the world.
 * @param {string} savePath
 * @param {import("../engine/model/world.js").World} world
 * @param {(msg: string) => void} [log]
 */
export function saveWorld(savePath, world, log = msg => console.error(msg)) {
  try {
    mkdirSync(dirname(savePath), { recursive: true });
    const tmp = savePath + ".tmp";
    writeFileSync(tmp, serializeWorld(world), "utf8");
    renameSync(tmp, savePath);
    return true;
  } catch (err) {
    log(`could not save: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * The world this process should be living: the save it finds, or a new one.
 * @param {{savePath: string, seed?: number|string, fresh?: boolean, log?: (msg: string) => void}} opts
 * @returns {{world: import("../engine/model/world.js").World, resumed: boolean}}
 */
export function loadOrCreateWorld({ savePath, seed = 1, fresh = false, log = () => {} }) {
  if (!fresh && existsSync(savePath)) {
    try {
      const world = deserializeWorld(readFileSync(savePath, "utf8"));
      // The hosted world is the game mode too: a save from before the camp
      // existed is founded on load rather than left dormant forever.
      if (!world.config.settlement?.enabled) activateSettlement(world);
      return { world, resumed: true };
    } catch (err) {
      log(`Could not read ${savePath} (${err instanceof Error ? err.message : err}) — starting a new world.`);
    }
  }
  return { world: createWorld({ seed, config: /** @type {any} */ ({ settlement: { enabled: true } }) }), resumed: false };
}

/** @param {unknown} v */
export function isNumeric(v) {
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));
}
