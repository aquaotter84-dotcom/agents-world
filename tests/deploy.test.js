/**
 * Phase D, fourth idea, the part that has to hold on somebody else's machine:
 * the always-on world.
 *
 * Two claims. First, that one process is enough — `server/service.js` lives the
 * world *and* serves the app the keeper watches it through, on one port, so a
 * host has one thing to run and one thing to keep alive. Second, that the image
 * the README tells a keeper to deploy is the same thing this test starts, so
 * the documented path cannot drift away from the working one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Wait for a line on a stream, or give up. @param {import("node:stream").Readable} stream @param {RegExp} pattern */
function waitForLine(stream, pattern, timeoutMs = 10000) {
  return new Promise((res, rej) => {
    let buffer = "";
    const timer = setTimeout(() => rej(new Error("timed out waiting for " + pattern)), timeoutMs);
    stream.on("data", (/** @type {Buffer} */ chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        res(match);
      }
    });
    stream.on("error", rej);
  });
}

test("one process lives the world and serves the keeper's window onto it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-service-"));
  const save = join(dir, "world.json");
  // Port 0: the OS picks one, and the service says which — exactly what a host
  // that assigns a port through the environment does.
  const child = spawn(process.execPath, [
    "server/service.js", "--offline", "--fresh", "--tick-seconds", "0.05",
    "--port", "0", "--host", "127.0.0.1", "--save", save
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  try {
    const listening = await waitForLine(/** @type {any} */ (child.stdout), /http:\/\/127\.0\.0\.1:(\d+)/);
    const base = "http://127.0.0.1:" + listening[1];

    // The keeper's window is served from the same process that is living the
    // world: opening the deployed URL is the whole client story.
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="world-canvas"/, "the app is served, not a placeholder");
    assert.match(html, /id="record-pane"/, "including the record the digest is read in");

    const first = await (await fetch(base + "/api/world")).json();
    assert.ok(first.clock.tick >= 0);
    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.running, true, "a save written seconds ago is a running world");
    assert.equal(status.tick, first.clock.tick);

    // The world moves without a browser, a tab, or a keeper anywhere near it —
    // which is the entire point of running it somewhere else.
    await new Promise(r => setTimeout(r, 400));
    const later = await (await fetch(base + "/api/world")).json();
    assert.ok(later.clock.tick > first.clock.tick,
      `the world should tick while serving (${first.clock.tick} → ${later.clock.tick})`);

    // And the save on disk is the same world the app was shown, whole.
    const stored = JSON.parse(await readFile(save, "utf8"));
    assert.ok(stored.agents.length >= 9, "a whole world, not a fragment");
    assert.ok(stored.clock.tick <= later.clock.tick, "the file trails the live world by at most a save interval");
  } finally {
    child.kill("SIGTERM");
    await new Promise(r => child.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("the image the README points at runs the same service, on the platform's port", async () => {
  const dockerfile = await readFile(resolve(ROOT, "deploy/Dockerfile"), "utf8");
  assert.match(dockerfile, /CMD \["node", "server\/service\.js"\]/,
    "the container's whole job is the one service process");
  assert.match(dockerfile, /PORT=4321/, "and it listens on the port a host hands it");
  assert.match(dockerfile, /AGENTS_WORLD_SAVE=\/data\/world\.json/,
    "with the world on a volume, because that file is the world");

  const compose = await readFile(resolve(ROOT, "deploy/docker-compose.yml"), "utf8");
  assert.match(compose, /agents-world-data:\/data/, "the compose file mounts the same volume");
  assert.match(compose, /restart: unless-stopped/, "and brings the world back up by itself");

  // npm run serve is the documented local equivalent of the deployed service.
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.serve, "node server/service.js");
});
