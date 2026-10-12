/**
 * The local dev server.
 *
 * The phone app is a static site with no build step, so serving it is the whole
 * job: point a web server at `app/` and open it. This exists because `python -m
 * http.server` reports the wrong content type for `.js` on some machines (the
 * browser then refuses the ES module imports) and because editing the engine
 * should not require remembering to re-run the vendor sync by hand.
 *
 * The handler itself lives in `server/web.js`, shared with the always-on
 * service — this file is the dev-specific shell around it.
 *
 *   node tools/serve.mjs                 serve app/ on http://localhost:4321
 *   node tools/serve.mjs --port 8080     pick the port
 *   node tools/serve.mjs --sync          re-vendor engine/ into app/ first
 *
 * Zero dependencies on purpose: a dev server that needs installing is a dev
 * server that is broken on a fresh clone.
 */

import { cp, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startWorldServer, portOf } from "../server/web.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = resolve(ROOT, "app");

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.PORT ?? 4321);
const HOST = String(args.host ?? "0.0.0.0");

if (args.sync) await syncVendor();

const SAVE_PATH = process.env.AGENTS_WORLD_SAVE
  ? resolve(process.env.AGENTS_WORLD_SAVE)
  : resolve(ROOT, "data", "world.json");

const server = await startWorldServer({ webDir: WEB_DIR, savePath: SAVE_PATH, host: HOST, port: PORT });
const bound = portOf(server);

console.log(`Agents World app served from ${WEB_DIR}`);
console.log(`  http://localhost:${bound}`);
if (!args.sync) console.log("  (engine edits need --sync, or run tools/sync-vendor.sh)");
console.log("  (the world itself needs `npm run service` — or use `npm run serve` for both)");

/** Mirror tools/sync-vendor.sh: engine/ + server/prompt.js -> app/vendor/. */
async function syncVendor() {
  const vendor = join(WEB_DIR, "vendor");
  await rm(vendor, { recursive: true, force: true });
  await mkdir(join(vendor, "server"), { recursive: true });
  await cp(join(ROOT, "engine"), join(vendor, "engine"), { recursive: true });
  await cp(join(ROOT, "server", "prompt.js"), join(vendor, "server", "prompt.js"));
  console.log("Vendored engine/ and server/prompt.js into app/vendor/");
}

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
