/**
 * The background service: the headless runner writes the world, and the dev
 * server hands it to the app. Both run as real processes against a temp file,
 * so these tests never touch the live data/ directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "../engine/model/world.js";
import { step } from "../engine/simulation.js";
import { createMomentWorker } from "../server/moment-worker.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the runner writes a whole, loadable world and leaves no temp file behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-runner-"));
  try {
    const save = join(dir, "world.json");
    await new Promise((/** @type {(v?: any) => void} */ res, rej) => {
      const p = spawn(process.execPath, [
        "server/index.js", "--offline", "--tick-seconds", "0", "--ticks", "12",
        "--fresh", "--quiet", "--save", save
      ], { cwd: ROOT, stdio: "ignore" });
      p.on("exit", code => (code === 0 ? res() : rej(new Error("runner exit " + code))));
    });
    const world = JSON.parse(await readFile(save, "utf8"));
    assert.equal(world.clock.tick, 12);
    assert.ok(world.agents.length >= 9, "the original cast is saved even if the world has already changed");
    await assert.rejects(access(save + ".tmp"), "the atomic save should not leave a .tmp behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the dev server serves the service's world read-only, and reports when there is none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aw-serve-"));
  const save = join(dir, "world.json");
  const port = 4400 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ["tools/serve.mjs", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: ROOT,
    env: { ...process.env, AGENTS_WORLD_SAVE: save },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(base + "/")).ok);

    // No service has written anything yet.
    assert.equal((await fetch(base + "/api/world")).status, 404);

    // A world appears; the endpoint serves it verbatim.
    const payload = JSON.stringify({ seed: 3, clock: { tick: 40, day: 2 }, agents: [] });
    await writeFile(save, payload);
    const got = await fetch(base + "/api/world");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.equal(await got.text(), payload);

    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.tick, 40);
    assert.equal(status.day, 2);
    assert.equal(status.running, true, "a file written just now counts as a running service");

    // Read-only: nothing can be written through the API.
    const post = await fetch(base + "/api/world", { method: "POST", body: "{}" });
    assert.equal(post.status, 405);
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ticks continue during a model request and an expired response is discarded", async () => {
  const world = createWorld({ seed: 819 });
  world.config.moments.significanceFloor = 0;
  const first = step(world).moments[0];
  assert.ok(first, "the test world offers a moment immediately");

  /** @type {((value: string|null) => void)|undefined} */
  let release;
  /** @type {string[]} */
  const lines = [];
  let resolvedByWorker = 0;
  const worker = createMomentWorker({
    world,
    llm: {
      available: true,
      complete: async () => new Promise(resolve => { release = resolve; })
    },
    log: (...parts) => lines.push(parts.join(" ")),
    onResolved: () => { resolvedByWorker += 1; }
  });

  const request = worker.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.draining, true, "the completion is still pending");

  const tickBefore = world.clock.tick;
  step(world);
  assert.equal(world.clock.tick, tickBefore + 1, "a model promise does not hold up the synchronous tick");

  const limit = world.config.moments.maxPendingTicks;
  while (world.clock.tick - first.tick < limit) step(world);
  assert.ok(!world.pending.some(moment => moment.id === first.id), "expiry removed the request");
  assert.ok(world.resolved.some(moment => moment.id === first.id && moment.engineResolved), "the engine took over");
  const seqAfterExpiry = world.seq;

  worker.stop();
  assert.ok(release, "the fake request has a completion hook");
  release("CHOICE: 1\nPROSE: This reply arrived too late.");
  await request;

  assert.equal(world.seq, seqAfterExpiry, "the late prose creates no second event");
  assert.equal(resolvedByWorker, 0, "an expired model answer is never applied");
  assert.ok(lines.some(line => /discarded expired response/.test(line)));
});

/** @param {() => Promise<boolean>} check */
async function waitFor(check, ms = 8000) {
  const until = Date.now() + ms;
  /** @type {any} */
  let lastErr = null;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (err) { lastErr = err; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for the server" + (lastErr ? ": " + lastErr.message : ""));
}
