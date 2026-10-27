/**
 * Jev transport (owner: bots-driver; BOTS.md §4.3).
 *
 * The bots never call the TypeSafe API directly: the GM's browser posts to the local relay (tools/jev-proxy), which
 * adds the API key. `askJev` adds the model, posts `{model, state, questions}` to `${relayUrl}/v1/systemone`, retries
 * 429 / 5xx / network failures twice (honouring Retry-After), checks that every question was answered and returns the
 * response. Anything else is a `JevError`: **a failed call is an error, never an answer**.
 *
 * No Foundry globals at import time: `createJevClient({fetch, config})` is what the Node tests use; the exported
 * `askJev` / `checkRelay` read the world settings lazily.
 */

export const TIMEOUT_MS = 20_000;
export const RETRIES = 2;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;
const SETTING_SCOPE = "fvtt-risklegacy-v5";

/** A Jev call that failed. `status` 0 = network/timeout; `retryable` = a later attempt may succeed. */
export class JevError extends Error {
  constructor(message, { status = 0, detail = "", retryable = false, purpose = "", attempts = 1 } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
    this.purpose = purpose;
    this.attempts = attempts;
  }
}

/** @returns {boolean} whether an error is a JevError (also across module copies) */
export const isJevError = err => (err instanceof JevError) || (err?.name === "JevError");

/** Relay settings from the world (lazy: only on the GM's client, after init). */
function settingsConfig() {
  const get = key => {
    try {
      return game.settings.get(SETTING_SCOPE, key);
    } catch(err) {
      return undefined;
    }
  };
  return {
    relayUrl: get("bots.relayUrl") || "http://127.0.0.1:30777",
    token: get("bots.relayToken") || "",
    model: get("bots.model") || "jev-latest"
  };
}

/** Seconds or an HTTP date → ms (null if absent/unreadable). */
export function parseRetryAfter(value, now = Date.now()) {
  if ( (value === null) || (value === undefined) || (value === "") ) return null;
  const n = Number(value);
  if ( Number.isFinite(n) ) return Math.max(0, n * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Short readable text from an API error body ({detail: string|object|array}). */
function detailText(body, fallback) {
  const d = body?.detail;
  if ( !d ) return fallback;
  if ( typeof d === "string" ) return d;
  if ( Array.isArray(d) ) return d.map(e => `${(e.loc ?? []).join(".")}: ${e.msg ?? ""}`).join("; ").slice(0, 500);
  try {
    return JSON.stringify(d).slice(0, 500);
  } catch(err) {
    return fallback;
  }
}

/** An AbortSignal that fires on the caller's signal or after `ms`. */
function timeoutSignal(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  const onAbort = () => controller.abort(signal.reason ?? new Error("aborted"));
  if ( signal ) {
    if ( signal.aborted ) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  };
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => {
    clearTimeout(timer);
    reject(new JevError("Jev request aborted", { retryable: false }));
  }, { once: true });
});

/**
 * Build a client. Everything injectable for tests.
 * @param {object} [options]
 * @param {Function} [options.fetch]      fetch implementation
 * @param {() => {relayUrl:string, token:string, model:string}} [options.config]
 * @param {(ms:number, signal?:AbortSignal) => Promise} [options.sleep]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 */
export function createJevClient({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args), config = settingsConfig, sleep = defaultSleep,
  now = () => Date.now(), timeoutMs = TIMEOUT_MS, retries = RETRIES
} = {}) {
  const base = url => String(url ?? "").replace(/\/+$/, "");
  const headers = cfg => {
    const h = { "Content-Type": "application/json", Accept: "application/json" };
    if ( cfg.token ) h["X-RL-Bot-Token"] = cfg.token;
    return h;
  };

  /** One POST; returns {response, status} or throws a JevError (retryable or not). */
  async function postOnce(cfg, body, purpose, signal) {
    const t = timeoutSignal(timeoutMs, signal);
    let res;
    try {
      res = await fetchImpl(`${base(cfg.relayUrl)}/v1/systemone`, {
        method: "POST", headers: headers(cfg), body: JSON.stringify(body), signal: t.signal
      });
    } catch(err) {
      t.done();
      if ( signal?.aborted ) throw new JevError("Jev request aborted", { purpose, retryable: false });
      const timedOut = t.signal.aborted;
      throw new JevError(timedOut ? `Jev relay timed out after ${Math.round(timeoutMs / 1000)} s` : `Jev relay unreachable at ${base(cfg.relayUrl)}: ${err?.message ?? err}`,
        { purpose, retryable: true, detail: err?.message ?? String(err) });
    }
    let text = "";
    try {
      text = await res.text();
    } catch(err) {
      t.done();
      throw new JevError(`Jev relay response could not be read: ${err?.message ?? err}`, { status: res.status, purpose, retryable: true });
    }
    t.done();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch(err) { /* not JSON */ }
    if ( res.ok ) {
      if ( !json || (typeof json !== "object") ) {
        throw new JevError("Jev returned an unreadable response", { status: res.status, purpose, retryable: true, detail: text.slice(0, 300) });
      }
      return json;
    }
    const retryable = (res.status === 429) || (res.status >= 500);
    const error = new JevError(`Jev request failed (HTTP ${res.status}): ${detailText(json, text.slice(0, 300) || res.statusText || "")}`,
      { status: res.status, purpose, retryable, detail: detailText(json, text.slice(0, 300)) });
    error.retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"), now());
    throw error;
  }

  /**
   * Ask Jev one request.
   * @param {{state: object|string, questions: object}} request
   * @param {object} [options]
   * @param {string} [options.purpose]         what it is for (logged)
   * @param {AbortSignal} [options.signal]
   * @param {object[]} [options.exchanges]     the decision record's exchange list: one entry is pushed per call
   * @returns {Promise<{model: string, answers: object, usage: object}>}
   */
  async function askJev(request, { purpose = "", signal, exchanges } = {}) {
    const cfg = config();
    const body = { model: cfg.model, state: request?.state ?? {}, questions: request?.questions ?? {} };
    const names = Object.keys(body.questions);
    const t0 = now();
    const record = (response, error, attempts) => {
      exchanges?.push({ purpose, request: body, response: response ?? null, ms: now() - t0, attempts, ...(error ? { error: error.message, status: error.status ?? 0 } : {}) });
    };
    if ( !names.length ) {
      const err = new JevError("Jev request has no questions", { purpose });
      record(null, err, 0);
      throw err;
    }
    let attempt = 0;
    for ( ;; ) {
      attempt += 1;
      try {
        const response = await postOnce(cfg, body, purpose, signal);
        const answers = response.answers ?? {};
        const missing = names.filter(n => !answers[n]);
        if ( missing.length ) {
          throw new JevError(`Jev did not answer: ${missing.join(", ")}`, { status: 200, purpose, retryable: false, detail: missing.join(", ") });
        }
        record(response, null, attempt);
        return response;
      } catch(err) {
        const error = isJevError(err) ? err : new JevError(err?.message ?? String(err), { purpose });
        error.attempts = attempt;
        if ( !error.retryable || (attempt > retries) || signal?.aborted ) {
          record(null, error, attempt);
          throw error;
        }
        const backoff = error.retryAfterMs ?? ((400 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 100));
        try {
          await sleep(Math.min(MAX_BACKOFF_MS, backoff), signal);
        } catch(abort) {
          record(null, error, attempt);
          throw error;
        }
      }
    }
  }

  /**
   * Is the relay up, and does a one-question request work?
   * @returns {Promise<{ok: boolean, latencyMs: number|null, model: string|null, error: string|null}>}
   */
  async function checkRelay() {
    const cfg = config();
    const t = timeoutSignal(HEALTH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base(cfg.relayUrl)}/health`, { method: "GET", headers: headers(cfg), signal: t.signal });
      if ( !res.ok ) return { ok: false, latencyMs: null, model: null, error: `Relay health check failed (HTTP ${res.status})` };
    } catch(err) {
      return { ok: false, latencyMs: null, model: null, error: `Relay unreachable at ${base(cfg.relayUrl)}: ${err?.message ?? err}` };
    } finally {
      t.done();
    }
    const t0 = now();
    try {
      const response = await askJev({
        state: { message: "Connection test from the Risk Legacy bots." },
        questions: { connected: { type: "noul", instructions: "Is `message` a connection test?" } }
      }, { purpose: "relay.check" });
      return { ok: true, latencyMs: now() - t0, model: response.model ?? cfg.model, error: null };
    } catch(err) {
      return { ok: false, latencyMs: now() - t0, model: null, error: err.message };
    }
  }

  return { askJev, checkRelay };
}

const client = createJevClient();

/** @see createJevClient */
export const askJev = (request, options) => client.askJev(request, options);

/** @see createJevClient */
export const checkRelay = () => client.checkRelay();
