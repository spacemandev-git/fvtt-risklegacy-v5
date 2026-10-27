/**
 * Chat-model connection state for the Bot Manager (BOTS-LLM.md §8): the last `checkLLM()` result and the model list
 * from `listModels()`, both cached per client, plus display helpers (short model names, prices, dollars).
 *
 * The API key never passes through here: the UI only asks whether one is set, and any error text shown is scrubbed of
 * the key's value in case a server echoes it back.
 */
import { checkLLM, listModels } from "../llm/client.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";

const FRESH_MS = 10 * 60_000;

/** @type {{state:"unknown"|"checking"|"ok"|"error", ok?:boolean, latencyMs?:number|null, model?:string, keySet?:boolean,
 *   cost?:number, error?:string|null, code?:string, status?:number, url?:string, at?:number}} */
let check = { state: "unknown" };
let checking = null;

/** @type {{state:"unknown"|"loading"|"ok"|"error", list:object[], error:string|null, url:string, at:number}} */
let models = { state: "unknown", list: [], error: null, url: "", at: 0 };
let loading = null;

const listeners = new Set();

const baseUrl = () => String(getSetting(SETTINGS.llmBaseUrl) ?? "");

/** Is an API key saved in this browser? (Never the key itself.) */
export const keySet = () => !!String(getSetting(SETTINGS.llmApiKey) ?? "").trim();

/** Does the base URL point at the local relay's /nous route (which holds the key itself)? */
export const viaRelay = (url = baseUrl()) => /\/nous\/v\d+\/?$/.test(url) || /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

/** Remove the API key's value from text shown to the user. */
export function scrub(text) {
  let s = String(text ?? "");
  const key = String(getSetting(SETTINGS.llmApiKey) ?? "").trim();
  if ( key.length >= 8 ) s = s.split(key).join("••••");
  return s.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer ••••");
}

/** Call `fn()` whenever the check or the model list changes. @returns {Function} unsubscribe */
export function onLLMStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  for ( const fn of listeners ) {
    try {
      fn();
    } catch(err) {
      console.error(err);
    }
  }
}

/** Run a promise with a time limit. */
function within(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/* -------------------------------------------- */
/*  Connection test                             */
/* -------------------------------------------- */

/** The last check (a check of another base URL counts as unknown). */
export function llmStatus() {
  if ( (check.state !== "unknown") && check.url && (check.url !== baseUrl()) ) return { state: "unknown" };
  return check;
}

/** Forget the last check (the URL, key or model changed). */
export function resetLLMStatus() {
  check = { state: "unknown" };
  changed();
}

/**
 * `checkLLM({model})`, once at a time: `GET /models`, then a one-line structured call to the model.
 * @param {{model?: string}} [options]
 */
export async function testLLM({ model } = {}) {
  if ( checking ) return checking;
  model ||= getSetting(SETTINGS.llmModel);
  const url = baseUrl();
  check = { ...check, state: "checking", url, model };
  changed();
  const limit = ((Number(getSetting(SETTINGS.llmTimeout)) || 90) + 15) * 1000;
  const run = checking = (async () => {
    let result;
    try {
      result = await within(checkLLM({ model }), limit, game.i18n.localize("RL.Bots.LLM.timeout"));
    } catch(err) {
      result = { ok: false, error: err?.message ?? String(err), code: err?.code, status: err?.status };
    }
    result ??= { ok: false, error: game.i18n.localize("RL.Bots.LLM.noAnswer") };
    check = {
      state: result.ok ? "ok" : "error", ok: !!result.ok, url, model: result.model || model, at: Date.now(),
      latencyMs: Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs) : null,
      cost: Number(result.cost) || 0,
      keySet: result.keySet ?? keySet(),
      code: result.code ?? result.detail?.code ?? "", status: Number(result.status) || 0,
      error: result.ok ? null : scrub(result.error || game.i18n.localize("RL.Bots.LLM.unknownError"))
    };
    changed();
    return check;
  })();
  try {
    return await run;
  } finally {
    if ( checking === run ) checking = null;
  }
}

/**
 * What a failed check means, in words: the org-policy 403, a refused key, no key, an unreachable server, or the raw
 * message.
 * @returns {{kind: "policy"|"auth"|"noKey"|"network"|"other", text: string}}
 */
export function explainError(result, { model } = {}) {
  const raw = scrub(result?.error ?? "");
  const code = String(result?.code ?? "");
  const status = Number(result?.status) || 0;
  model ||= result?.model || getSetting(SETTINGS.llmModel);
  if ( (code === "model_blocked_by_org_policy") || /model_blocked_by_org_policy|org(ani[sz]ation)?[ _-]?polic/i.test(raw) ) {
    return { kind: "policy", text: game.i18n.format("RL.Bots.LLM.orgPolicy", { model }) };
  }
  if ( (status === 401) || /\b401\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication/i.test(raw) ) {
    return { kind: "auth", text: game.i18n.localize(keySet() ? "RL.Bots.LLM.badKey" : "RL.Bots.LLM.needKey") };
  }
  if ( !keySet() && !viaRelay() && /\b40[13]\b|key/i.test(raw) ) return { kind: "noKey", text: game.i18n.localize("RL.Bots.LLM.needKey") };
  if ( /failed to fetch|networkerror|network error|load failed|ECONNREFUSED|fetch failed/i.test(raw) ) {
    return { kind: "network", text: game.i18n.format("RL.Bots.LLM.network", { url: baseUrl() }) };
  }
  return { kind: "other", text: raw };
}

/* -------------------------------------------- */
/*  Models                                      */
/* -------------------------------------------- */

/** The cached model list for the current base URL. */
export function modelState() {
  if ( models.url && (models.url !== baseUrl()) ) return { state: "unknown", list: [], error: null, url: "", at: 0 };
  return models;
}

/** Forget the model list (the URL or key changed). */
export function resetModels() {
  models = { state: "unknown", list: [], error: null, url: "", at: 0 };
  changed();
}

/**
 * Load the models this key may use (`listModels()`, which caches too), once at a time.
 * @param {{refresh?: boolean}} [options]
 */
export async function loadModels({ refresh = false } = {}) {
  const url = baseUrl();
  if ( loading ) return loading;
  if ( !refresh && (models.url === url) && (models.state === "ok") && (Date.now() - models.at < FRESH_MS) ) return models;
  models = { ...modelState(), state: "loading", url };
  changed();
  const run = loading = (async () => {
    try {
      // throwOnError: a failure shows as an error, not as an empty list
      const list = await within(listModels({ refresh, throwOnError: true }), 30_000, game.i18n.localize("RL.Bots.LLM.timeout"));
      models = { state: "ok", list: Array.isArray(list) ? list.filter(m => m?.id) : [], error: null, url, at: Date.now() };
    } catch(err) {
      models = { state: "error", list: models.list ?? [], error: scrub(err?.message ?? String(err)), url, at: Date.now() };
    }
    changed();
    return models;
  })();
  try {
    return await run;
  } finally {
    if ( loading === run ) loading = null;
  }
}

/* -------------------------------------------- */
/*  Display helpers                             */
/* -------------------------------------------- */

const WORDS = { glm: "GLM", deepseek: "DeepSeek", gpt: "GPT", llama: "Llama", qwen: "Qwen", hermes: "Hermes", kimi: "Kimi" };

/**
 * A short display name for a model: the API's name without its provider prefix ("Z.ai: GLM 5.3" → "GLM 5.3"), else
 * one built from the id ("z-ai/glm-5.3-flash:US" → "GLM 5.3 Flash (US)").
 * @param {string} id
 * @param {{badge?: boolean}} [options]  badge = drop the "(US)"-style suffix
 */
export function modelName(id, { badge = false } = {}) {
  if ( !id ) return "";
  const known = modelState().list.find(m => m.id === id);
  const [base, variant] = String(id).split("/").pop().split(":");
  let name = known?.name ? String(known.name).replace(/^[^:/]{1,40}:\s+/, "").trim() : "";
  if ( !name ) {
    const words = base.split("-").filter(Boolean);
    name = words.map(w => WORDS[w.toLowerCase()] ?? (/^v\d/i.test(w) ? w.toUpperCase() : (w[0].toUpperCase() + w.slice(1)))).join(" ");
  }
  // "z-ai/glm-5.3:US" is a different model from "z-ai/glm-5.3" (one may be blocked), though the API names both "GLM 5.3"
  if ( variant && !variant.startsWith("~") && !name.toLowerCase().includes(variant.toLowerCase()) ) name += ` (${variant})`;
  return badge ? name.replace(/\s*\([^)]*\)\s*$/, "") : name;
}

/** The provider of a model, for grouping: "Z.ai: GLM 5.3" → "Z.ai", else from the id ("z-ai/…" → "Z Ai"). */
function providerOf(m) {
  const named = /^([^:/]{1,40}):\s+/.exec(String(m?.name ?? ""))?.[1];
  if ( named ) return named.trim();
  const id = String(m?.id ?? "");
  if ( !id.includes("/") ) return "";
  return id.split("/")[0].split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** "$0.91" (per million tokens). */
export function perM(n) {
  const v = Number(n);
  if ( !Number.isFinite(v) ) return "";
  return `$${v < 0.1 && v > 0 ? v.toFixed(3).replace(/0$/, "") : v.toFixed(2)}`;
}

/** Dollars for spend and cost: "$0.0042", "$1.25". */
export function usd(n, { precise = false } = {}) {
  const v = Number(n) || 0;
  if ( v === 0 ) return "$0";
  if ( v < 0.0001 ) return "<$0.0001";
  if ( precise || (v < 0.01) ) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * Model options for a select, grouped by provider (the API can list a hundred models): first an ungrouped group with
 * the default entry and `current` when the list doesn't have it, then one group per provider, with prices.
 * @param {string} current          the selected id ("" = the default entry, when `defaultLabel` is given)
 * @param {{defaultLabel?: string, prices?: boolean}} [options]
 * @returns {{label: string, options: {value:string, label:string, selected:boolean}[]}[]}
 */
export function modelOptions(current, { defaultLabel = "", prices = true } = {}) {
  const state = modelState();
  const top = { label: "", options: [] };
  if ( defaultLabel ) top.options.push({ value: "", label: defaultLabel, selected: !current });
  if ( current && !state.list.some(m => m.id === current) ) {
    const label = (state.state === "ok") ? game.i18n.format("RL.Bots.LLM.notListed", { model: current }) : current;
    top.options.push({ value: current, label, selected: true });
  }
  const names = new Map();
  for ( const m of state.list ) {
    const name = modelName(m.id);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const groups = new Map();
  for ( const m of state.list ) {
    let name = modelName(m.id);
    if ( names.get(name) > 1 ) name = `${name} [${m.id}]`;
    const price = prices && (Number.isFinite(m.inPerM) || Number.isFinite(m.outPerM))
      ? game.i18n.format("RL.Bots.LLM.price", { in: perM(m.inPerM), out: perM(m.outPerM) }) : "";
    const group = providerOf(m);
    if ( !groups.has(group) ) groups.set(group, { label: group, options: [] });
    groups.get(group).options.push({ value: m.id, label: price ? `${name} · ${price}` : name, selected: m.id === current });
  }
  return [top, ...groups.values()].filter(g => g.options.length);
}
