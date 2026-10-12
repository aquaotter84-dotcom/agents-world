/**
 * A single, background worker for model moments.
 *
 * The world clock must never wait for an HTTP completion. The runner kicks this
 * worker after each synchronous engine step; it consumes pending moments one at
 * a time while ticks continue. Requests are attempted at most once per process.
 * If a moment expires while queued or in flight, its response is discarded.
 */
import { resolveMoment } from "../engine/simulation.js";
import { buildPrompt, parseReply, describeMoment } from "./prompt.js";

/**
 * @typedef {import("../engine/model/world.js").World} World
 * @typedef {import("../engine/model/world.js").Moment} Moment
 */

/**
 * @param {{
 *   world: World,
 *   llm: { available: boolean, complete: (messages: {role: string, content: string}[], options: {maxTokens: number}) => Promise<string|null> },
 *   log?: (...parts: any[]) => void,
 *   onResolved?: (moment: Moment, result: ReturnType<typeof resolveMoment>) => void
 * }} options
 */
export function createMomentWorker({ world, llm, log = () => {}, onResolved = () => {} }) {
  const attempted = new Set();
  let draining = false;
  let stopped = false;

  /**
   * Start or nudge the worker. A call made while a request is in flight is a
   * cheap no-op: the active loop will see newly pending moments when it wakes.
   */
  async function drain() {
    if (draining || stopped || !llm.available) return;
    draining = true;
    try {
      while (!stopped && llm.available) {
        for (const id of attempted) {
          if (!world.pending.some(moment => moment.id === id)) attempted.delete(id);
        }
        const moment = world.pending.find(candidate => !attempted.has(candidate.id));
        if (!moment) break;
        attempted.add(moment.id);

        // A moment may have been removed by expiry before it was selected. The
        // second check after the await is the important one: no stale answer is
        // allowed to mutate state after the engine has taken over.
        if (!world.pending.some(candidate => candidate.id === moment.id)) continue;
        const { messages, maxTokens } = buildPrompt(world, moment);
        if (!messages.length) {
          const result = resolveMoment(world, moment.id, {});
          if (result.ok) onResolved(moment, result);
          continue;
        }

        let raw;
        try {
          raw = await llm.complete(messages, { maxTokens });
        } catch (error) {
          log(`  model request failed for ${describeMoment(world, moment)}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        if (!world.pending.some(candidate => candidate.id === moment.id)) {
          log(`  discarded expired response for ${describeMoment(world, moment)}`);
          continue;
        }

        const answer = parseReply(raw, moment);
        const result = resolveMoment(world, moment.id, answer);
        if (!result.ok) continue;
        const event = result.events[result.events.length - 1];
        log(`  ${describeMoment(world, moment)} → ${event ? event.text : "(resolved)"}`);
        onResolved(moment, result);
      }
    } finally {
      draining = false;
    }
  }

  return {
    drain,
    stop() { stopped = true; },
    get draining() { return draining; }
  };
}
