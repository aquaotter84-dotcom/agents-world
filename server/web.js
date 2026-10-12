/**
 * The web side of a world: the app, and the read-only endpoints it probes.
 *
 * The app is a static site with no build step, so serving it is most of the
 * job. The rest is `/api/world` and `/api/status`, which is how the app finds
 * out whether a world is already being kept alive without it — by a runner on
 * the same box, or by the hosted service.
 *
 * Used by both `tools/serve.mjs` (the dev server) and `server/service.js` (the
 * one-process always-on world), so there is exactly one answer to "what does
 * this world look like over HTTP".
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

export const MIME = /** @type {Record<string, string>} */ ({
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
});

/** How stale a save has to be before the world counts as not running. */
export const RUNNING_WINDOW_MS = 10 * 60 * 1000;

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

/**
 * @param {string} webDir
 * @param {string} pathname
 * @returns {string|null} Absolute path inside webDir, or null if it escapes.
 */
function resolveTarget(webDir, pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = normalize(decoded).replace(/^(\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const full = resolve(webDir, rel || "index.html");
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return full;
}

/**
 * The service's save file, read-only. A missing file means no service has run
 * here yet, which the app treats as "no background world" rather than an error.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {string} savePath
 */
async function serveService(req, res, pathname, savePath) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }
  try {
    const info = await stat(savePath);
    if (pathname === "/api/status") {
      const saved = JSON.parse(await readFile(savePath, "utf8"));
      const clock = saved.clock || {};
      send(res, 200, MIME[".json"], JSON.stringify({
        running: Date.now() - info.mtimeMs < RUNNING_WINDOW_MS,
        savedAt: info.mtime.toISOString(),
        tick: clock.tick ?? null,
        day: clock.day ?? null
      }));
      return;
    }
    const body = await readFile(savePath);
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
 * A request handler for the app plus its read-only world endpoints.
 * @param {{webDir: string, savePath: string}} opts
 */
export function createWebHandler({ webDir, savePath }) {
  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));

    // The runner keeps the world moving and writes it to the save file. The app
    // asks here whether that world exists and what it looks like.
    if (url.pathname === "/api/world" || url.pathname === "/api/status") {
      return serveService(req, res, url.pathname, savePath);
    }

    const target = resolveTarget(webDir, url.pathname);
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
        // The app reads its state from localStorage; nothing here should be
        // cached while the world is moving underneath it.
        "Cache-Control": "no-store"
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch (err) {
      const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
      send(res, missing ? 404 : 500, "text/plain; charset=utf-8", missing ? "Not found: " + url.pathname : "Server error");
    }
  };
}

/**
 * Start serving a world. Resolves with the server once it is listening, so a
 * caller can log the port it actually got (0 asks the OS for one).
 * @param {{webDir: string, savePath: string, host?: string, port?: number}} opts
 * @returns {Promise<import("node:http").Server>}
 */
export function startWorldServer({ webDir, savePath, host = "0.0.0.0", port = 4321 }) {
  const server = createServer(createWebHandler({ webDir, savePath }));
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.off("error", rej);
      res(server);
    });
  });
}

/** The port a listening server actually bound. @param {import("node:http").Server} server */
export function portOf(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}
