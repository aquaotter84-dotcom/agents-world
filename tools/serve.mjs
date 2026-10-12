/**
 * The local dev server.
 *
 * The phone app is a static site with no build step, so serving it is the whole
 * job: point a web server at `app/` and open it. This exists because `python -m
 * http.server` reports the wrong content type for `.js` on some machines (the
 * browser then refuses the ES module imports) and because editing the engine
 * should not require remembering to re-run the vendor sync by hand.
 *
 *   node tools/serve.mjs                 serve app/ on http://localhost:4321
 *   node tools/serve.mjs --port 8080     pick the port
 *   node tools/serve.mjs --sync          re-vendor engine/ into app/ first
 *
 * Zero dependencies on purpose: a dev server that needs installing is a dev
 * server that is broken on a fresh clone.
 */

import { createServer } from "node:http";
import { readFile, stat, cp, rm, mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = resolve(ROOT, "app");

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.PORT ?? 4321);
const HOST = String(args.host ?? "0.0.0.0");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

if (args.sync) await syncVendor();

const SAVE_PATH = process.env.AGENTS_WORLD_SAVE
  ? resolve(process.env.AGENTS_WORLD_SAVE)
  : resolve(ROOT, "data", "world.json");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));

  // The background service (server/index.js) keeps the world moving and writes
  // it to data/world.json. The app asks here whether that service is running.
  if (url.pathname === "/api/world" || url.pathname === "/api/status") {
    return serveService(req, res, url.pathname);
  }

  const target = resolveTarget(url.pathname);

  if (!target) {
    send(res, 403, "text/plain; charset=utf-8", "Forbidden");
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, "index.html") : target;
    const body = await readFile(file); // small assets; read is simpler than streaming
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
      // The app reads its state from localStorage; nothing here should be cached
      // while the engine is being edited.
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch (err) {
    const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
    send(res, missing ? 404 : 500, "text/plain; charset=utf-8", missing ? "Not found: " + url.pathname : "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Agents World app served from ${WEB_DIR}`);
  console.log(`  http://localhost:${PORT}`);
  if (!args.sync) console.log("  (engine edits need --sync, or run tools/sync-vendor.sh)");
});

/**
 * @param {string} pathname
 * @returns {string|null} Absolute path inside app/, or null if it escapes.
 */
function resolveTarget(pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const full = resolve(WEB_DIR, rel || "index.html");
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + sep)) return null;
  return full;
}

/**
 * The service's save file, read-only. A missing file means no service has run
 * here yet, which the app treats as "no background world" rather than an error.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 */
async function serveService(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }
  try {
    const info = await stat(SAVE_PATH);
    if (pathname === "/api/status") {
      const saved = JSON.parse(await readFile(SAVE_PATH, "utf8"));
      const clock = saved.clock || {};
      send(res, 200, MIME[".json"], JSON.stringify({
        running: Date.now() - info.mtimeMs < 10 * 60 * 1000,
        savedAt: info.mtime.toISOString(),
        tick: clock.tick ?? null,
        day: clock.day ?? null
      }));
      return;
    }
    const body = await readFile(SAVE_PATH);
    res.writeHead(200, {
      "Content-Type": MIME[".json"],
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch (err) {
    const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
    send(res, missing ? 404 : 500, "text/plain; charset=utf-8", missing ? "No background world yet" : "Server error");
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string} text
 */
function send(res, status, type, text) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

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
