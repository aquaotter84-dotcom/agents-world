/**
 * The language model client.
 *
 * This is the only file in the project that touches the network, and it exists
 * to be patient. The world asks for a handful of decisions per tick; the API
 * will 429 if they arrive in a burst. So every call funnels through one queue
 * with a minimum gap, a shared backoff on rate limits, and a hard timeout —
 * and anything that fails simply doesn't answer, leaving the engine to decide
 * for itself.
 */

const DEFAULT_URL = "https://api.bluesminds.com/v1/chat/completions";

/**
 * @typedef {object} LlmOptions
 * @property {string} apiKey
 * @property {string} [model]
 * @property {string} [url]
 * @property {number} [gapMs]      Minimum spacing between calls.
 * @property {number} [timeoutMs]
 * @property {(msg: string) => void} [log]
 */

export class Llm {
  /** @param {LlmOptions} options */
  constructor(options) {
    this.apiKey = options.apiKey || "";
    this.model = options.model || "openai/gpt-oss-20b";
    this.url = options.url || DEFAULT_URL;
    this.gapMs = options.gapMs ?? 4000;
    this.timeoutMs = options.timeoutMs ?? 45000;
    this.log = options.log || (() => {});
    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
    this.nextAt = 0;
    this.backoffUntil = 0;
    this.calls = 0;
    this.failures = 0;
    this.rateLimits = 0;
  }

  get available() {
    return Boolean(this.apiKey.trim());
  }

  /**
   * Send a chat completion. Serialised against every other call in the process.
   * @param {{role: string, content: string}[]} messages
   * @param {{maxTokens?: number, temperature?: number}} [opts]
   * @returns {Promise<string|null>} The reply, or null if it could not be had.
   */
  async complete(messages, opts = {}) {
    if (!this.available) return null;

    const task = this.queue.then(async () => {
      const now = Date.now();
      if (now < this.backoffUntil) await sleep(this.backoffUntil - now);
      const gap = this.nextAt - Date.now();
      if (gap > 0) await sleep(gap);
      try {
        return await this.once(messages, opts);
      } finally {
        this.nextAt = Date.now() + this.gapMs;
      }
    });

    // A failed call must never break the chain for everyone behind it.
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  /**
   * @param {{role: string, content: string}[]} messages
   * @param {{maxTokens?: number, temperature?: number}} opts
   * @returns {Promise<string|null>}
   */
  async once(messages, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.calls += 1;
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.apiKey.trim()
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: opts.maxTokens ?? 220,
          temperature: opts.temperature ?? 0.9
        }),
        signal: controller.signal
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const wait = Math.max(Number.isNaN(retryAfter) ? 0 : retryAfter * 1000, 30000);
        this.backoffUntil = Date.now() + wait;
        this.rateLimits += 1;
        this.log(`rate limited — holding off for ${Math.round(wait / 1000)}s`);
        return null;
      }
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 160);
        } catch {
          /* body already gone */
        }
        this.failures += 1;
        this.log(`http ${res.status}${detail ? " — " + detail : ""}`);
        return null;
      }

      const body = /** @type {any} */ (await res.json());
      const message = body?.choices?.[0]?.message;
      // Some reasoning models put the text in reasoning_content with content empty.
      const text = message ? String(message.content || message.reasoning_content || "").trim() : "";
      return text || null;
    } catch (err) {
      this.failures += 1;
      this.log(`call failed — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  stats() {
    return { calls: this.calls, failures: this.failures, rateLimits: this.rateLimits };
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
