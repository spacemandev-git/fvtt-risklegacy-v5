/**
 * Transport for the chat-model bots (owner: bots-llm-core; BOTS-LLM.md §4): an OpenAI-compatible chat-completions API
 * (Nous Portal by default), called from the active GM's browser, either directly (Nous allows browser origins; the key
 * is a client setting, so it stays in that browser) or through the local relay's `/nous/v1` route (no key in Foundry).
 *
 * `askLLM` sends one structured request (`response_format: json_schema`, strict), retries 429 / 5xx / network failures
 * and timeouts twice (honouring Retry-After), gives bad output (cut off, not JSON, a missing key, a value outside an
 * enum) one corrective retry, and returns the parsed answer with its cost. Anything else is an `LLMError`: **a failed
 * call is an error, never an answer**. Every attempt is logged on the caller's `exchanges` list.
 *
 * No Foundry globals at import time: `createLLMClient({fetch, config})` is what the Node tests use; the exported
 * `askLLM` / `checkLLM` / `listModels` read the settings lazily (world settings plus the client-scoped API key).
 */

export const DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash:US";
/** Transport retries (429, 5xx, network errors, timeouts); bad output gets its own single corrective retry. */
export const RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 90_000;
/** How long the model list is cached. */
export const MODELS_TTL_MS = 10 * 60_000;
/** Reasoning text kept on a logged exchange. */
export const REASONING_LOG_CHARS = 4000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 20_000;
const SETTING_SCOPE = "fvtt-risklegacy-v5";

/**
 * A chat-model call that failed. `status` 0 = network/timeout. `code`: "network" | "timeout" | "aborted" |
 * "rate_limited" | "server" | "auth" | "model_blocked_by_org_policy" | "forbidden" | "bad_request" | "not_found" |
 * "http" | "bad_response" | "bad_output" | "no_model" | "bad_request_shape" | "spend_limit" (set by the driver).
 */
export class LLMError extends Error {
  /** @param {string} message @param {{status?:number, code?:string, detail?:any, retryable?:boolean, purpose?:string, attempts?:number}} [data] */
  constructor(message, { status = 0, code = "", detail = null, retryable = false, purpose = "", attempts = 1 } = {}) {
    super(message);
    this.name = "LLMError";
    Object.assign(this, { status, code, detail, retryable, purpose, attempts });
  }
}

/** @returns {boolean} whether an error is an LLMError (also across module copies) */
export const isLLMError = err => (err instanceof LLMError) || (err?.name === "LLMError");

/* -------------------------------------------- */
/*  Settings seam                               */
/* -------------------------------------------- */

/** Settings from Foundry (lazy: only on the GM's client, after init). */
function settingsConfig() {
  const get = key => {
    try {
      return globalThis.game?.settings?.get(SETTING_SCOPE, key);
    } catch(err) {
      return undefined;
    }
  };
  const seconds = Number(get("bots.llmTimeout"));
  return {
    baseUrl: get("bots.llmBaseUrl") || DEFAULT_BASE_URL,
    apiKey: String(get("bots.llmApiKey") ?? "").trim(),
    model: get("bots.llmModel") || DEFAULT_MODEL,
    timeoutMs: Number.isFinite(seconds) && (seconds > 0) ? seconds * 1000 : DEFAULT_TIMEOUT_MS
  };
}

/* -------------------------------------------- */
/*  Pure helpers (exported for tests)           */
/* -------------------------------------------- */

/** Seconds or an HTTP date → ms (null if absent/unreadable). */
export function parseRetryAfter(value, now = Date.now()) {
  if ( (value === null) || (value === undefined) || (value === "") ) return null;
  const n = Number(value);
  if ( Number.isFinite(n) ) return Math.max(0, n * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** `reasoning` as sent: never `{enabled: false}` (GLM 5.3 then fills max_tokens with whitespace, §4.2). */
export function sanitizeReasoning(reasoning) {
  if ( !reasoning || (typeof reasoning !== "object") ) return null;
  const out = { ...reasoning };
  if ( out.enabled === false ) {
    delete out.enabled;
    out.effort ??= "low";
  }
  return Object.keys(out).length ? out : null;
}

/** The POST body for one request. */
export function buildBody(request) {
  const body = {
    model: request.model,
    messages: request.messages,
    max_tokens: Number(request.maxTokens ?? request.max_tokens) || 1500
  };
  if ( Number.isFinite(Number(request.temperature)) && (request.temperature !== null) ) body.temperature = Number(request.temperature);
  if ( request.schema?.schema ) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: String(request.schema.name || "answer").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), strict: true, schema: request.schema.schema }
    };
  }
  const reasoning = sanitizeReasoning(request.reasoning);
  if ( reasoning ) body.reasoning = reasoning;
  if ( Number.isInteger(request.seed) ) body.seed = request.seed;
  return body;
}

/** The message text (a string, or the text parts of a content array). */
export function contentText(message) {
  const c = message?.content;
  if ( typeof c === "string" ) return c;
  if ( Array.isArray(c) ) return c.map(p => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return "";
}

/** The model's reasoning, wherever the provider put it (§4.2), as text. */
export function extractReasoning(message) {
  const r = message?.reasoning ?? message?.reasoning_content ?? message?.provider_specific_fields?.reasoning ?? null;
  if ( (r === null) || (r === undefined) ) return "";
  if ( typeof r === "string" ) return r;
  if ( Array.isArray(r) ) return r.map(x => (typeof x === "string" ? x : (x?.text ?? x?.summary ?? x?.content ?? ""))).join("\n");
  try {
    return JSON.stringify(r);
  } catch(err) {
    return String(r);
  }
}

/**
 * JSON from the answer text: trimmed, without a leading <think> block or a surrounding code fence.
 * @returns {{ok: true, value: any}|{ok: false, reason: string}}
 */
export function parseJSONContent(text) {
  let s = String(text ?? "").trim();
  s = s.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
  const fence = s.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
  if ( fence ) s = fence[1].trim();
  if ( !s ) return { ok: false, reason: "the answer was empty" };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch(err) {
    return { ok: false, reason: `the answer is not valid JSON (${String(err.message).slice(0, 120)})` };
  }
}

const isPlainObject = v => !!v && (typeof v === "object") && !Array.isArray(v);

/** Index of the "}" closing the object that opens at `start` (strings and escapes respected), or -1. */
function closingBrace(s, start) {
  let depth = 0;
  let inString = false;
  for ( let i = start; i < s.length; i++ ) {
    const c = s[i];
    if ( inString ) {
      if ( c === "\\" ) i += 1;
      else if ( c === "\"" ) inString = false;
      continue;
    }
    if ( c === "\"" ) inString = true;
    else if ( c === "{" ) depth += 1;
    else if ( c === "}" ) {
      depth -= 1;
      if ( depth === 0 ) return i;
    }
  }
  return -1;
}

/**
 * A JSON object inside free text (the last one that fits the schema), or null. Some providers file a model's whole
 * answer under `reasoning` and return empty content (seen with DeepSeek V4 Flash when the schema has a "thinking"
 * key); a schema-valid object found there is the model's answer.
 */
export function salvageJSON(text, schema) {
  const s = String(text ?? "");
  let tries = 0;
  for ( let i = s.lastIndexOf("{"); (i >= 0) && (tries < 200); i = i > 0 ? s.lastIndexOf("{", i - 1) : -1 ) {
    tries += 1;
    const end = closingBrace(s, i);
    if ( end < 0 ) continue;
    try {
      const value = JSON.parse(s.slice(i, end + 1));
      if ( isPlainObject(value) && !schemaProblem(value, schema) ) return value;
    } catch(err) { /* not this one */ }
  }
  return null;
}
/**
 * The complete JSON object an answer starts with, when it fits the schema, else null. GLM 5.3 sometimes keeps
 * writing after a finished answer until max_tokens (finish "length"); the object it already closed is its answer.
 */
export function leadingJSON(text, schema) {
  const s = String(text ?? "").replace(/^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "");
  const i = s.indexOf("{");
  if ( (i < 0) || s.slice(0, i).trim() ) return null;
  const end = closingBrace(s, i);
  if ( end < 0 ) return null;
  try {
    const value = JSON.parse(s.slice(i, end + 1));
    return (isPlainObject(value) && !schemaProblem(value, schema)) ? value : null;
  } catch(err) {
    return null;
  }
}

/**
 * The answer written as loose "key: value" lines, for a flat object schema, or null. DeepSeek V4 Flash sometimes files
 * its answer under `reasoning` in that form instead of JSON: `choice:ontario`, `choice("found_a_major_city")`,
 * `steps:["attack_russia_from_southern_europe"]`, even `choiceontario` (probe and e2e, 2026-10-27). The last line per
 * key wins. Every decision field (an enum, a number, a list of enum values) must be found and fit the schema exactly;
 * free-text fields the model left out become "". Anything else (nested objects) can't be read this way.
 */
export function salvageLoose(text, schema) {
  const props = isPlainObject(schema?.properties) ? schema.properties : null;
  if ( !props || (schema.type && (schema.type !== "object")) ) return null;
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim().replace(/^[-*>\s"'`]+/, ""));
  const unquote = v => v.trim().replace(/^\(\s*/, "").replace(/\s*\)\s*[.,;]?$/, "").trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  const out = {};
  for ( const [key, sub] of Object.entries(props) ) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sep = new RegExp(`^["'\`]?${esc}["'\`]?\\s*(?::|=|\\()\\s*(.*)$`, "i");
    const bare = new RegExp(`^${esc}(.+)$`, "i");
    let raw = null;
    for ( const l of lines ) {
      const m = l.match(sep);
      if ( m ) raw = m[1];
      else if ( Array.isArray(sub?.enum) ) {
        const b = l.match(bare);
        if ( b && sub.enum.includes(unquote(b[1])) ) raw = b[1];
      }
    }
    const type = sub?.type;
    if ( raw === null ) {
      if ( (type === "string") && !Array.isArray(sub?.enum) ) {
        out[key] = "";
        continue;
      }
      return null;
    }
    if ( type === "string" ) out[key] = unquote(raw);
    else if ( (type === "integer") || (type === "number") ) {
      const n = Number(unquote(raw));
      if ( !Number.isFinite(n) ) return null;
      out[key] = n;
    }
    else if ( type === "array" ) {
      let list = null;
      const r = unquote(raw.replace(/^\(\s*/, ""));
      try {
        const j = JSON.parse(r.startsWith("[") ? r : `[${r}]`);
        if ( Array.isArray(j) ) list = j;
      } catch(err) {
        list = r.replace(/^\[|\]$/g, "").split(",").map(x => unquote(x)).filter(Boolean);
      }
      if ( !list || list.some(x => typeof x !== "string") ) return null;
      out[key] = list;
    }
    else return null;
  }
  return schemaProblem(out, schema) ? null : out;
}

/** Reasoning efforts from most to least; `lowerEffort` steps one down (null at the bottom). */
const EFFORTS = ["xhigh", "high", "medium", "low", "minimal"];
export function lowerEffort(reasoning) {
  const effort = reasoning?.effort ?? "medium";
  const i = EFFORTS.indexOf(effort);
  if ( (i < 0) || (i >= EFFORTS.length - 1) ) return null;
  return { ...(reasoning ?? {}), effort: EFFORTS[i + 1] };
}

const TYPE_OK = {
  string: v => typeof v === "string",
  number: v => (typeof v === "number") && Number.isFinite(v),
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === "boolean",
  array: v => Array.isArray(v),
  object: v => isPlainObject(v),
  null: v => v === null
};
const show = v => {
  try {
    return JSON.stringify(v)?.slice(0, 80) ?? String(v);
  } catch(err) {
    return String(v);
  }
};

/**
 * Check a value against the subset of JSON Schema that structured outputs use: type, enum, const, required,
 * properties, items, anyOf/oneOf and local $refs. Unknown keywords are ignored.
 * @returns {string|null} the first problem, in words, or null when the value fits
 */
export function schemaProblem(value, schema, { root = schema, path = "" } = {}) {
  if ( !isPlainObject(schema) ) return null;
  const where = path || "the answer";
  if ( typeof schema.$ref === "string" ) {
    const m = schema.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
    const target = m ? root?.[m[1]]?.[m[2]] : null;
    return target ? schemaProblem(value, target, { root, path }) : null;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if ( Array.isArray(alternatives) && alternatives.length ) {
    const problems = alternatives.map(s => schemaProblem(value, s, { root, path }));
    if ( problems.every(p => p) ) return problems[0];
  }
  if ( Array.isArray(schema.enum) && !schema.enum.some(e => e === value) ) {
    const list = schema.enum.slice(0, 12).map(show).join(", ") + (schema.enum.length > 12 ? ", …" : "");
    return `${where} must be one of ${list} (got ${show(value)})`;
  }
  if ( (schema.const !== undefined) && (schema.const !== value) ) return `${where} must be ${show(schema.const)} (got ${show(value)})`;
  const types = schema.type ? [].concat(schema.type) : null;
  if ( types && !types.some(t => TYPE_OK[t]?.(value) ?? true) ) return `${where} must be of type ${types.join(" or ")} (got ${show(value)})`;
  if ( isPlainObject(value) ) {
    for ( const key of schema.required ?? [] ) {
      if ( !(key in value) ) return `the required key "${path ? `${path}.` : ""}${key}" is missing`;
    }
    for ( const [key, sub] of Object.entries(schema.properties ?? {}) ) {
      if ( !(key in value) ) continue;
      const p = schemaProblem(value[key], sub, { root, path: path ? `${path}.${key}` : key });
      if ( p ) return p;
    }
  }
  if ( Array.isArray(value) && isPlainObject(schema.items) ) {
    for ( let i = 0; i < value.length; i++ ) {
      const p = schemaProblem(value[i], schema.items, { root, path: `${path || "answer"}[${i}]` });
      if ( p ) return p;
    }
  }
  return null;
}

/** Readable text and code from an error body: {message, code} (Nous), {error: {message, code}} (OpenAI) or {detail}. */
export function errorInfo(json, text = "") {
  const e = isPlainObject(json?.error) ? json.error : json;
  const message = (typeof e?.message === "string" && e.message) || (typeof json?.error === "string" && json.error)
    || (typeof json?.detail === "string" && json.detail) || String(text ?? "").slice(0, 300);
  const code = (typeof e?.code === "string" && e.code) || (typeof json?.code === "string" && json.code) || "";
  return { message: String(message).slice(0, 500), code };
}

const HTTP_CODES = { 400: "bad_request", 401: "auth", 402: "auth", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

/** An LLMError for an HTTP failure. */
export function httpError(status, json, text, { model = "", purpose = "", retryAfterMs = null } = {}) {
  const { message, code } = errorInfo(json, text);
  const blocked = (code === "model_blocked_by_org_policy") || /model_blocked_by_org_policy/.test(String(text ?? ""));
  if ( blocked ) {
    return new LLMError(`The model "${model}" isn't allowed for this API key's organisation (model_blocked_by_org_policy). Choose another model for this bot in the Bot Manager.`,
      { status, code: "model_blocked_by_org_policy", detail: message, retryable: false, purpose });
  }
  const retryable = (status === 429) || (status >= 500);
  const err = new LLMError(`Chat-model request failed (HTTP ${status}): ${message || "no details"}`,
    { status, code: HTTP_CODES[status] ?? (status >= 500 ? "server" : (code || "http")), detail: message, retryable, purpose });
  err.retryAfterMs = retryAfterMs;
  return err;
}

/** One model entry of GET /models in the shape the Bot Manager shows, or null when it can't answer structurally. */
export function modelEntry(m) {
  if ( !m?.id ) return null;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const outputs = m.architecture?.output_modalities ?? null;
  const modality = String(m.architecture?.modality ?? "");
  const textOut = Array.isArray(outputs) ? outputs.includes("text") : (!modality || /->\s*text/.test(modality));
  const structured = params.includes("response_format") || params.includes("structured_outputs");
  if ( !textOut || !structured ) return null;
  const perM = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1e6 * 10000) / 10000 : null;
  };
  return {
    id: String(m.id),
    name: String(m.name || m.id),
    inPerM: perM(m.pricing?.prompt),
    outPerM: perM(m.pricing?.completion),
    context: Number(m.context_length ?? m.top_provider?.context_length) || 0,
    structured,
    reasoning: params.includes("reasoning") || params.includes("reasoning_effort") || !!m.reasoning
  };
}

/* -------------------------------------------- */
/*  Client                                      */
/* -------------------------------------------- */

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
    reject(new LLMError("Chat-model request aborted", { code: "aborted" }));
  }, { once: true });
});

const CHECK_SCHEMA = {
  name: "connection_check",
  schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }
};

/**
 * Build a client. Everything injectable for tests.
 * @param {object} [options]
 * @param {Function} [options.fetch]
 * @param {() => {baseUrl:string, apiKey:string, model:string, timeoutMs:number}} [options.config]
 * @param {(ms:number, signal?:AbortSignal) => Promise} [options.sleep]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random]   backoff jitter
 * @param {number} [options.retries]
 * @param {number} [options.modelsTtlMs]
 */
export function createLLMClient({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args), config = settingsConfig, sleep = defaultSleep,
  now = () => Date.now(), random = Math.random, retries = RETRIES, modelsTtlMs = MODELS_TTL_MS
} = {}) {
  const base = url => String(url ?? "").trim().replace(/\/+$/, "");
  const headers = (cfg, json = true) => {
    const h = { Accept: "application/json" };
    if ( json ) h["Content-Type"] = "application/json";
    if ( cfg.apiKey ) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  };

  /** One HTTP exchange → parsed JSON body (ok) or a thrown LLMError. */
  async function send(cfg, method, path, { body, purpose, signal, timeoutMs, model }) {
    const t = timeoutSignal(timeoutMs, signal);
    let res;
    try {
      res = await fetchImpl(`${base(cfg.baseUrl)}${path}`, {
        method, headers: headers(cfg, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal: t.signal
      });
    } catch(err) {
      t.done();
      if ( signal?.aborted ) throw new LLMError("Chat-model request aborted", { code: "aborted", purpose });
      if ( t.signal.aborted ) {
        throw new LLMError(`Chat-model request timed out after ${Math.round(timeoutMs / 1000)} s`, { code: "timeout", retryable: true, purpose });
      }
      throw new LLMError(`Chat-model API unreachable at ${base(cfg.baseUrl)}: ${err?.message ?? err}`,
        { code: "network", retryable: true, purpose, detail: err?.message ?? String(err) });
    }
    let text = "";
    try {
      text = await res.text();
    } catch(err) {
      t.done();
      const timedOut = t.signal.aborted && !signal?.aborted;
      throw new LLMError(timedOut ? `Chat-model request timed out after ${Math.round(timeoutMs / 1000)} s` : `Chat-model response could not be read: ${err?.message ?? err}`,
        { status: res.status, code: timedOut ? "timeout" : "network", retryable: true, purpose });
    }
    t.done();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch(err) { /* not JSON */ }
    if ( !res.ok ) {
      throw httpError(res.status, json, text, { model, purpose, retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after"), now()) });
    }
    if ( !isPlainObject(json) ) {
      throw new LLMError("The chat-model API returned an unreadable response", { status: res.status, code: "bad_response", retryable: true, purpose, detail: text.slice(0, 300) });
    }
    // Some gateways report upstream failures with HTTP 200 and an error body.
    if ( json.error && !Array.isArray(json.choices) ) {
      const status = Number(json.error?.code) || Number(json.status) || 502;
      throw httpError(status, json, text, { model, purpose });
    }
    return json;
  }

  const backoffMs = (error, attempt) => Math.min(MAX_BACKOFF_MS, error.retryAfterMs ?? ((1000 * (2 ** (attempt - 1))) + Math.floor(random() * 250)));

  /**
   * One structured chat completion (§4.2).
   * @param {{model:string, messages:object[], schema:{name:string, schema:object}, reasoning?:object|null,
   *   maxTokens?:number, temperature?:number, seed?:number}} request
   * @param {{purpose?:string, exchanges?:object[]|null, signal?:AbortSignal|null}} [options]
   * @returns {Promise<{parsed:any, content:string, reasoning:string, model:string, usage:object, cost:number,
   *   totalCost:number, ms:number, attempts:number, finish:string}>}
   */
  async function askLLM(request, { purpose = "", exchanges = null, signal = null } = {}) {
    const cfg = config();
    const model = request?.model || cfg.model;
    const t0 = now();
    const log = (body, { response = null, error = null, ms = 0, attempt = 1 } = {}) => {
      if ( !Array.isArray(exchanges) ) return;
      const req = {
        model: body.model, messages: body.messages, schema: request?.schema ?? null, reasoning: body.reasoning ?? null,
        max_tokens: body.max_tokens, temperature: body.temperature ?? null
      };
      if ( body.seed !== undefined ) req.seed = body.seed;
      exchanges.push({
        engine: "llm", purpose, attempt, request: req, response, ms,
        ...(error ? { error: error.message, status: error.status ?? 0, code: error.code ?? "" } : {})
      });
    };
    if ( !model || !Array.isArray(request?.messages) || !request.messages.length ) {
      const error = new LLMError(model ? "Chat-model request has no messages" : "No chat model is set (bots.llmModel)",
        { code: model ? "bad_request_shape" : "no_model", purpose });
      log(buildBody({ ...(request ?? {}), model, messages: request?.messages ?? [] }), { error });
      throw error;
    }
    const messages = [...request.messages];
    let reasoningNow = request.reasoning ?? null;
    let transportTries = 0;
    let corrections = 0;
    let lowered = 0;
    let totalCost = 0;
    let attempt = 0;
    for ( ;; ) {
      attempt += 1;
      const body = buildBody({ ...request, reasoning: reasoningNow, model, messages: [...messages] });
      const a0 = now();
      let json;
      try {
        json = await send(cfg, "POST", "/chat/completions", { body, purpose, signal, timeoutMs: cfg.timeoutMs, model });
      } catch(err) {
        const error = isLLMError(err) ? err : new LLMError(err?.message ?? String(err), { code: "network", purpose });
        error.attempts = attempt;
        log(body, { error, ms: now() - a0, attempt });
        transportTries += 1;
        if ( !error.retryable || (transportTries > retries) || signal?.aborted ) throw error;
        try {
          await sleep(backoffMs(error, transportTries), signal);
        } catch(abort) {
          throw error;
        }
        continue;
      }
      const choice = json.choices?.[0] ?? null;
      const message = choice?.message ?? null;
      const content = contentText(message);
      const reasoning = extractReasoning(message);
      const usage = isPlainObject(json.usage) ? json.usage : {};
      const cost = Number(usage.cost);
      const callCost = Number.isFinite(cost) ? cost : 0;
      totalCost += callCost;
      const finish = String(choice?.finish_reason ?? "");
      const response = {
        content, parsed: null, reasoning: reasoning.slice(0, REASONING_LOG_CHARS), usage, cost: callCost, finish,
        model: String(json.model ?? model)
      };
      // Bad output: cut off, refused, not JSON, or outside the schema.
      let problem = null;
      let parsed = null;
      // Cut off after a finished answer: the object it already closed is the answer.
      const early = (finish === "length") && request.schema?.schema ? leadingJSON(content, request.schema.schema) : null;
      if ( early ) {
        parsed = early;
        response.truncatedTail = true;
      }
      else if ( !choice ) problem = "the response has no choices";
      else if ( finish === "length" ) problem = `the answer was cut off at max_tokens (${body.max_tokens})`;
      else if ( message?.refusal ) problem = `the model refused: ${String(message.refusal).slice(0, 200)}`;
      if ( early ) { /* accepted above */ }
      else if ( !problem && request.schema?.schema ) {
        const p = parseJSONContent(content);
        const fromJSON = (!p.ok && !content.trim() && reasoning) ? salvageJSON(reasoning, request.schema.schema) : null;
        const fromLines = (!p.ok && !fromJSON && !content.trim() && reasoning) ? salvageLoose(reasoning, request.schema.schema) : null;
        const salvaged = fromJSON ?? fromLines;
        if ( salvaged ) {
          parsed = salvaged;
          response.salvaged = fromJSON ? "reasoning" : "reasoning-lines";
        }
        else if ( !p.ok ) problem = p.reason;
        else {
          parsed = p.value;
          problem = schemaProblem(parsed, request.schema.schema);
        }
      }
      else if ( !problem ) {
        const p = parseJSONContent(content);
        parsed = p.ok ? p.value : null;
      }
      response.parsed = parsed;
      if ( problem && !content.trim() && reasoning ) problem += " (the model put its reply in its reasoning)";
      if ( problem ) {
        const error = new LLMError(`The chat model's answer was unusable: ${problem}`, {
          status: 200, code: "bad_output", retryable: false, purpose, attempts: attempt, detail: content.slice(0, 500)
        });
        log(body, { response, error, ms: now() - a0, attempt });
        if ( signal?.aborted ) throw error;
        // An empty answer isn't a format error: the reasoning used up max_tokens (ask again with less reasoning), or
        // the provider dropped the reply (ask again unchanged, like a transport failure). Probe 2026-10-27: DeepSeek
        // V4.1 Flash spent all max_tokens reasoning at "low" and answered in 1.2 s at "minimal"; DeepSeek V4 Flash
        // returned finish "stop" with empty content on some calls.
        if ( !content.trim() && choice ) {
          const less = (finish === "length") ? lowerEffort(reasoningNow) : null;
          if ( less && (lowered < 2) ) {
            lowered += 1;
            reasoningNow = less;
            continue;
          }
          if ( (finish !== "length") && (transportTries < retries) ) {
            transportTries += 1;
            continue;
          }
        }
        if ( corrections >= 1 ) throw error;
        corrections += 1;
        messages.push({ role: "assistant", content: content || "" });
        messages.push({ role: "user", content: `That wasn't valid JSON for the schema: ${problem}. Answer again with only the JSON.` });
        continue;
      }
      log(body, { response, ms: now() - a0, attempt });
      return {
        parsed, content, reasoning, model: response.model, usage, cost: callCost, totalCost, ms: now() - t0, attempts: attempt, finish
      };
    }
  }

  /** GET /models (raw list), with the key when set: Nous then lists only the models the organisation allows. */
  async function fetchModels(cfg, signal) {
    const json = await send(cfg, "GET", "/models", { purpose: "llm.models", signal, timeoutMs: LIST_TIMEOUT_MS, model: "" });
    return Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
  }

  let cache = null;
  let lastListError = null;

  /**
   * The models a chat bot can use (text output and structured outputs), cached for 10 minutes. On failure it returns
   * an empty list (or throws with `throwOnError`); the error stays readable through `lastListError()`.
   * @returns {Promise<{id:string, name:string, inPerM:number|null, outPerM:number|null, context:number, structured:boolean, reasoning:boolean}[]>}
   */
  async function listModels({ refresh = false, throwOnError = false, signal = null } = {}) {
    const cfg = config();
    const key = `${base(cfg.baseUrl)}|${cfg.apiKey ? "key" : "nokey"}|${cfg.apiKey.slice(-6)}`;
    if ( !refresh && cache && (cache.key === key) && (now() - cache.at < modelsTtlMs) ) return cache.list.map(m => ({ ...m }));
    try {
      const raw = await fetchModels(cfg, signal);
      const list = raw.map(modelEntry).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
      cache = { key, at: now(), list };
      lastListError = null;
      return list.map(m => ({ ...m }));
    } catch(err) {
      lastListError = isLLMError(err) ? err : new LLMError(err?.message ?? String(err), { code: "network" });
      if ( throwOnError ) throw lastListError;
      return [];
    }
  }

  /**
   * Is the API reachable, and does a one-line structured call to `model` work?
   * @returns {Promise<{ok:boolean, latencyMs:number, model:string, keySet:boolean, error:string|null, code:string, cost:number}>}
   */
  async function checkLLM({ model = null, exchanges = null } = {}) {
    const cfg = config();
    const target = model || cfg.model;
    const out = { ok: false, latencyMs: 0, model: target, keySet: !!cfg.apiKey, error: null, code: "", cost: 0 };
    try {
      await fetchModels(cfg);
    } catch(err) {
      return { ...out, error: err.message, code: err.code ?? "" };
    }
    const t0 = now();
    try {
      const res = await askLLM({
        model: target, schema: CHECK_SCHEMA, reasoning: { effort: "low" }, maxTokens: 1000, temperature: 0,
        messages: [
          { role: "system", content: "You check a connection. Answer only with JSON that fits the schema." },
          { role: "user", content: "Connection test from the Risk Legacy bots: answer {\"ok\": true}." }
        ]
      }, { purpose: "llm.check", exchanges });
      return { ...out, ok: res.parsed?.ok === true, latencyMs: now() - t0, model: res.model || target, cost: res.totalCost,
        error: res.parsed?.ok === true ? null : "The model answered, but not with ok: true" };
    } catch(err) {
      return { ...out, latencyMs: now() - t0, error: err.message, code: err.code ?? "" };
    }
  }

  return { askLLM, checkLLM, listModels, lastListError: () => lastListError, clearModelCache: () => { cache = null; } };
}

const client = createLLMClient();

/**
 * One structured chat completion. See BOTS-LLM.md §4.2 and createLLMClient.
 * @returns {Promise<{parsed:object, content:string, reasoning:string, model:string, usage:object, cost:number, ms:number}>}
 */
export async function askLLM(request, { purpose = "", exchanges = null, signal = null } = {}) {
  return client.askLLM(request, { purpose, exchanges, signal });
}

/** @returns {Promise<{ok:boolean, latencyMs:number, model:string, keySet:boolean, error:string|null}>} */
export async function checkLLM({ model = null } = {}) {
  return client.checkLLM({ model });
}

/** @returns {Promise<{id:string, name:string, inPerM:number, outPerM:number, context:number, structured:boolean, reasoning:boolean}[]>} */
export async function listModels({ refresh = false, throwOnError = false } = {}) {
  return client.listModels({ refresh, throwOnError });
}

/** The last listModels() failure (an LLMError), or null after a success. */
export const lastListError = () => client.lastListError();
