/**
 * The decision runner (BOTS.md §6.6, BOTS-LLM.md §7): runs one brain function, applies the `bots.onError` policy on a
 * failed call, writes the decision record (with the exact exchanges) and asks the UI to narrate it.
 *
 * Engine dispatch: a bot whose `ctx.bot.engine` is "llm" uses the chat-model brain (llm/brain) with
 * `ctx.chat(purpose, request)` → `askLLM({...request, model}, {purpose, exchanges: record.llm})`, the model being the
 * bot's own or the world default (`bots.llmModel`), behind the per-war spend cap. Every other bot uses the Jev brain with
 * `ctx.ask` as before. `JevError` and `LLMError` are handled alike (policy, GM dialog naming the engine, session
 * heuristic); in heuristic mode `ask`/`chat` are null and the brain uses its built-in judgment.
 */
import * as jevBrain from "../brain/index.mjs";
import * as llmBrain from "../llm/brain/index.mjs";
import { askJev, isJevError } from "../jev/client.mjs";
import { DEFAULT_MODEL, askLLM, isLLMError } from "../llm/client.mjs";
import { addRecord } from "../log.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";
import { botInfo } from "../users.mjs";
import { narrate } from "../ui/_module.mjs";
import { addSpendFrom, checkSpend, llmSpend } from "./spend.mjs";
import { errorPolicy, noteError, plain, setPaused, status, waitIfPaused } from "./util.mjs";

/** "Use built-in judgment for the rest of the session". */
let sessionHeuristic = false;
/** The open error dialog (one at a time; concurrent failures share the GM's answer). */
let dialog = null;

const BRAINS = { jev: jevBrain, llm: llmBrain };

/** Test seam: replace brain functions (e2e with a placeholder brain). Never used in play. */
const overrides = { any: {}, jev: {}, llm: {} };

/**
 * @param {Record<string, Function>} [map]   brain functions by name
 * @param {{engine?: "jev"|"llm"|null}} [options]  only for that engine's bots; without it, the overrides apply to every
 *   bot and all earlier overrides are cleared (the original behaviour)
 */
export function setBrainOverrides(map = {}, { engine = null } = {}) {
  if ( engine && overrides[engine] ) {
    overrides[engine] = { ...(map ?? {}) };
    return;
  }
  overrides.any = { ...(map ?? {}) };
  overrides.jev = {};
  overrides.llm = {};
}

/** The engine of a context's bot: "llm" for chat-model bots, else "jev". */
export const engineOf = ctx => (ctx?.bot?.engine === "llm" ? "llm" : "jev");

/** The brain function by name for an engine (an override first). */
export function brain(name, engine = "jev") {
  const e = engine === "llm" ? "llm" : "jev";
  return overrides[e][name] ?? overrides.any[name] ?? BRAINS[e][name];
}

export const isSessionHeuristic = () => sessionHeuristic;
export function setSessionHeuristic(value) {
  sessionHeuristic = !!value;
}

/** Is the error dialog open? */
export const errorDialogOpen = () => !!dialog;

const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const setting = (key, fallback) => {
  try {
    return getSetting(key) ?? fallback;
  } catch(err) {
    return fallback;
  }
};

/**
 * The model a chat bot uses now: its own, else the world default. Read from the bot user each time, so a model the GM
 * changes in the Bot Manager (e.g. after model_blocked_by_org_policy) applies on Retry.
 */
export function modelOf(ctx) {
  const user = ctx?.bot?.userId ? game.users?.get(ctx.bot.userId) : null;
  const own = user ? botInfo(user)?.model : ctx?.bot?.model;
  if ( ctx?.bot && user ) ctx.bot.model = own ?? null;
  return own || setting(SETTINGS.llmModel, "") || DEFAULT_MODEL;
}

/** Lead line and hint of the error dialog, by engine and error. */
function errorText(err, record) {
  const who = `<b>${esc(record.factionName || record.userName || "")}</b>`;
  const kind = `<b>${esc(record.kind)}</b>`;
  if ( record.engine !== "llm" ) {
    return { title: "RL.Bots.Driver.Error.title", lead: loc("RL.Bots.Driver.Error.lead", { bot: who, kind }), hint: loc("RL.Bots.Driver.Error.hint") };
  }
  let hint;
  if ( err.code === "spend_limit" ) {
    const s = llmSpend();
    hint = loc("RL.Bots.Driver.Error.LLM.hintSpend", { spent: s.usd.toFixed(2), limit: s.limit.toFixed(2) });
  }
  else if ( err.code === "model_blocked_by_org_policy" ) hint = loc("RL.Bots.Driver.Error.LLM.hintBlocked");
  else if ( err.code === "auth" ) hint = loc("RL.Bots.Driver.Error.LLM.hintAuth");
  else if ( err.code === "bad_output" ) hint = loc("RL.Bots.Driver.Error.LLM.hintBadOutput");
  else hint = loc("RL.Bots.Driver.Error.LLM.hint");
  return {
    title: err.code === "spend_limit" ? "RL.Bots.Driver.Error.LLM.titleSpend" : "RL.Bots.Driver.Error.LLM.title",
    lead: loc("RL.Bots.Driver.Error.LLM.lead", { bot: who, kind, model: `<b>${esc(record.model ?? "")}</b>` }),
    hint
  };
}

/**
 * Ask the GM what to do about a failed call.
 * @returns {Promise<"retry"|"heuristic"|"session"|"pause">}
 */
async function askGM(err, record) {
  if ( dialog ) return dialog;
  dialog = (async () => {
    const { DialogV2 } = foundry.applications.api;
    const text = errorText(err, record);
    const content = `<div class="rl-bot-error">
      <div class="rl-callout">
        <p>${text.lead}</p>
        <p class="rl-bot-error__detail"><code style="white-space: pre-wrap; overflow-wrap: anywhere;">${esc(err.message)}</code></p>
      </div>
      <p>${esc(text.hint)}</p>
    </div>`;
    try {
      const choice = await DialogV2.wait({
        window: { title: text.title, icon: "fa-solid fa-robot" },
        classes: ["risklegacy", "rl-bot-error-dialog"],
        position: { width: 580 },
        content,
        buttons: [
          { action: "retry", label: "RL.Bots.Driver.Error.retry", icon: "fa-solid fa-rotate-right", default: true },
          { action: "heuristic", label: "RL.Bots.Driver.Error.heuristic", icon: "fa-solid fa-gears" },
          { action: "session", label: "RL.Bots.Driver.Error.session", icon: "fa-solid fa-gears" },
          { action: "pause", label: "RL.Bots.Driver.Error.pause", icon: "fa-solid fa-pause" }
        ],
        rejectClose: false
      });
      return ["retry", "heuristic", "session", "pause"].includes(choice) ? choice : "pause";
    } catch(e) {
      console.error("risklegacy | bots: error dialog failed", e);
      return "pause";
    }
  })();
  try {
    return await dialog;
  } finally {
    dialog = null;
  }
}

/** `ctx.chat` for one decision: the spend cap, then askLLM with the bot's model, recorded on `record.llm`. */
function chatFor(record, model) {
  return async (purpose, request = {}) => {
    try {
      checkSpend(purpose);
    } catch(err) {
      record.llm.push({
        engine: "llm", purpose, attempt: 0, request: { model, messages: [], schema: null, reasoning: null, max_tokens: 0, temperature: null },
        response: null, ms: 0, error: err.message, status: 0, code: err.code
      });
      throw err;
    }
    const before = record.llm.length;
    try {
      return await askLLM({ ...request, model }, { purpose, exchanges: record.llm });
    } finally {
      await addSpendFrom(record.llm.slice(before));
    }
  };
}

/** The table-talk line of a chat bot's decision, if any. */
const sayOf = decision => {
  const s = decision?.say;
  return (typeof s === "string") && s.trim() ? s.trim() : null;
};

/**
 * Run one decision.
 * @param {object} options
 * @param {string} options.kind              decision kind for the log ("attack", "placement", "faction"...)
 * @param {object} options.ctx               BotContext (its `ask` / `chat` are set here)
 * @param {string} options.fn                brain function name
 * @param {object} [options.args]
 * @param {User} [options.user]              the bot user (for the record and narration)
 * @param {() => object} [options.fallback]  a legal decision when the brain fails outright
 * @param {boolean} [options.quietIfNull]    don't log or narrate a null decision made without a call (e.g. the many
 *                                           "keep my scar card" checks on battles the bot only watches)
 * @returns {Promise<object|null>} the decision
 */
export async function decide({ kind, ctx, fn, args = {}, user = null, fallback = null, quietIfNull = false }) {
  const t0 = Date.now();
  const actor = ctx.me ? game.actors.get(ctx.me) : null;
  const engine = engineOf(ctx);
  const llm = engine === "llm";
  let model = llm ? modelOf(ctx) : null;
  const record = {
    faction: ctx.me ?? "", factionName: actor?.name ?? "", difficulty: ctx.difficulty, kind,
    user: user?.id ?? "", userName: user?.name ?? "", decision: null, jev: [], heuristic: false,
    engine, model, personality: ctx.bot?.personality?.id ?? null, llm: [], say: null, cost: 0
  };
  let heuristic = sessionHeuristic;
  let decision;
  let failure = null;
  for ( let attempt = 0; attempt < 25; attempt++ ) {
    if ( llm && attempt ) record.model = model = modelOf(ctx);
    ctx.ask = (heuristic || llm) ? null : (purpose, request) => askJev(request, { purpose, exchanges: record.jev });
    ctx.chat = (heuristic || !llm) ? null : chatFor(record, model);
    try {
      decision = await brain(fn, engine)(ctx, args);
      failure = null;
      break;
    } catch(err) {
      failure = err;
      if ( isJevError(err) || isLLMError(err) ) {
        noteError(err.message, ctx.me ?? "");
        if ( errorPolicy() === "heuristic" ) {
          heuristic = true;
          continue;
        }
        status.waiting = llm ? "llm" : "jev";
        const choice = await askGM(err, record);
        status.waiting = null;
        if ( choice === "session" ) sessionHeuristic = true;
        if ( (choice === "session") || (choice === "heuristic") ) heuristic = true;
        else if ( choice === "pause" ) {
          await setPaused(true);
          await waitIfPaused();
        }
        continue;
      }
      // A bug in the brain: log it, then try the built-in judgments once.
      console.error(`risklegacy | bots: brain.${fn} failed`, err);
      status.stats.errors += 1;
      noteError(`${fn}: ${err.message}`, ctx.me ?? "");
      record.error = `${fn}: ${err.message}`;
      if ( heuristic ) break;
      heuristic = true;
    }
  }
  if ( failure || (decision === undefined) ) {
    decision = fallback ? fallback() : null;
    record.fallback = true;
  }
  record.decision = plain(decision) ?? null;
  record.heuristic = heuristic;
  record.ms = Date.now() - t0;
  if ( llm ) {
    record.say = sayOf(decision);
    record.cost = Math.round(record.llm.reduce((sum, x) => sum + (Number(x.response?.cost) || 0), 0) * 1e6) / 1e6;
  }
  ctx.ask = null;
  ctx.chat = null;
  ctx.decisionMs = record.ms;
  if ( quietIfNull && (record.decision === null) && !record.jev.length && !record.llm.length && !record.error && !heuristic ) return null;
  try {
    addRecord(record);
  } catch(err) {
    console.error("risklegacy | bots: could not log a decision", err);
  }
  Promise.resolve().then(() => narrate(record)).catch(err => console.warn("risklegacy | bots: narration failed", err));
  return decision ?? null;
}

/** A synchronous, code-only decision (pickName, board geometry): recorded and narrated like the others. */
export function record({ kind, ctx, decision, user = null }) {
  const actor = ctx?.me ? game.actors.get(ctx.me) : null;
  const engine = engineOf(ctx);
  const rec = {
    faction: ctx?.me ?? "", factionName: actor?.name ?? "", difficulty: ctx?.difficulty ?? "normal", kind,
    user: user?.id ?? "", userName: user?.name ?? "", decision: plain(decision) ?? null, jev: [], heuristic: false,
    engine, model: engine === "llm" ? modelOf(ctx) : null, personality: ctx?.bot?.personality?.id ?? null, llm: [],
    say: engine === "llm" ? sayOf(decision) : null, cost: 0, ms: 0
  };
  try {
    addRecord(rec);
  } catch(err) {
    console.error("risklegacy | bots: could not log a decision", err);
  }
  Promise.resolve().then(() => narrate(rec)).catch(err => console.warn("risklegacy | bots: narration failed", err));
  return decision;
}
