/**
 * Talking to the model: the per-bot system message (cached so it is identical for every call of one bot in one war),
 * one request per decision through `ctx.chat`, strict validation of the answer against the menu (one corrective
 * retry, then LLMError "bad_output"), table-talk (`say`) capping and gating, and the per-turn memo.
 *
 * `ctx.chat` throws LLMError on transport failures: never caught here (BOTS-LLM.md §6.1).
 */
import { LLMError } from "../client.mjs";
import * as LORE from "../lore.mjs";
import { personalityById } from "../personalities.mjs";
import { RATIONALE, correctionMessage, systemMessage } from "../prompts.mjs";
import { ROUTINE_SAYS_PER_TURN, SAY_MAX_CHARS, knobsOf, llmProfileOf } from "../profiles.mjs";

/** Heuristic mode: the driver passes `chat: null` (the GM chose built-in judgment). */
export const isHeuristic = ctx => typeof ctx?.chat !== "function";

/** The personality object (ctx.bot.personality may be the object or, defensively, its id). */
export function personalityOf(ctx) {
  const p = ctx?.bot?.personality ?? null;
  if ( !p ) return null;
  return typeof p === "string" ? personalityById(p) : p;
}

/** The game number used to key per-war caches. */
export const gameOf = ctx => ctx?.view?.campaign?.game ?? ctx?.view?.game ?? ctx?.state?.turn?.game ?? ctx?.state?.campaign?.nextGame ?? 0;

/* -------------------------------------------- */
/*  Per-turn memo                               */
/* -------------------------------------------- */

const MEMOS = new Map();

/**
 * Scratch state for one bot during one turn (whoever's turn it is): the turn plan, the attack plan and its steps, the
 * end-of-turn answer, pending table talk and reactive answers already given. Bounded.
 */
export function memoOf(ctx) {
  const t = ctx.state?.turn ?? {};
  const key = [ctx.bot?.userId ?? "", ctx.me ?? "", t.warId ?? "", ctx.view?.game ?? t.game ?? "", ctx.view?.round ?? "", t.faction ?? ""].join("|");
  let memo = MEMOS.get(key);
  if ( !memo ) {
    memo = { key, plan: null, attack: null, end: null, routineSays: 0, pendingSay: "", pendingThinking: "", reactive: new Map(), situation: null };
    MEMOS.set(key, memo);
    if ( MEMOS.size > 64 ) MEMOS.delete(MEMOS.keys().next().value);
  }
  return memo;
}

/* -------------------------------------------- */
/*  System message                              */
/* -------------------------------------------- */

const SYSTEM = new Map();

/** The memory the level may read in its system message (normal: notes; hard: notes, lessons, past games). */
export function memoryForSystem(memory, profile) {
  if ( !memory || profile.memory === "none" ) return null;
  const notes = typeof memory.notes === "string" ? memory.notes.trim() : "";
  if ( profile.memory === "notes" ) return notes ? { notes } : null;
  const lessons = Array.isArray(memory.lessons) ? memory.lessons.filter(l => typeof l === "string" && l.trim()).slice(0, 6) : [];
  const games = Array.isArray(memory.games) ? memory.games.filter(g => g && typeof g === "object").slice(-5) : [];
  return (notes || lessons.length || games.length) ? { notes, lessons, games } : null;
}

/** The system message for this bot in this war (built once, then reused verbatim). */
export function systemFor(ctx, profile = llmProfileOf(ctx)) {
  const p = personalityOf(ctx);
  const key = [ctx.bot?.userId ?? ctx.me ?? "", gameOf(ctx), profile.id, p?.id ?? ""].join("|");
  let s = SYSTEM.get(key);
  if ( !s ) {
    s = systemMessage({ personality: p, profile, lore: LORE, memory: memoryForSystem(ctx.bot?.memory, profile) });
    SYSTEM.set(key, s);
    if ( SYSTEM.size > 32 ) SYSTEM.delete(SYSTEM.keys().next().value);
  }
  return s;
}

/** Forget every memo and cached system message (tests). */
export function clearLLMCaches() {
  MEMOS.clear();
  SYSTEM.clear();
}

/* -------------------------------------------- */
/*  One decision                                */
/* -------------------------------------------- */

/** A validation failure: the reason is shown to the model in the corrective retry. */
export class InvalidAnswer extends Error {}
export const invalid = reason => { throw new InvalidAnswer(reason); };

function check(res, validate, options = {}) {
  const p = res?.parsed;
  if ( !p || (typeof p !== "object") || Array.isArray(p) ) return { ok: false, reason: "the answer was not a JSON object" };
  try {
    return { ok: true, value: validate(p, options) };
  } catch(err) {
    if ( err instanceof InvalidAnswer ) return { ok: false, reason: err.message };
    throw err;
  }
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
};

/**
 * Ask the model one decision.
 * @param {object} ctx
 * @param {object} o
 * @param {string} o.purpose        log label ("turn plan", "attack plan"...)
 * @param {string} o.user           the user message (prompts.mjs)
 * @param {{name:string, schema:object}} o.schema
 * @param {(parsed:object, options:{retry?:boolean}) => any} o.validate   returns the checked value; calls `invalid(reason)`
 *   on a broken answer (`retry` is true on the corrective retry)
 * @returns {Promise<{value:any, thinking:string, say:string, usage:object|null, cost:number}>}
 */
export async function askModel(ctx, { purpose, user, schema, validate }) {
  const profile = llmProfileOf(ctx);
  const messages = [{ role: "system", content: systemFor(ctx, profile) }, { role: "user", content: user }];
  const reasoning = profile.reasoningFor?.[purpose] ?? profile.reasoning;
  const request = () => ({
    messages: messages.map(m => ({ ...m })), schema, reasoning: { ...reasoning },
    maxTokens: profile.maxTokens, temperature: profile.temperature
  });
  let res = await ctx.chat(purpose, request());
  let v = check(res, validate);
  let cost = Number(res?.cost) || 0;
  if ( !v.ok ) {
    // One corrective retry for answers that are valid JSON but break the menu (askLLM already retried bad JSON).
    messages.push({ role: "assistant", content: String(res?.content ?? JSON.stringify(res?.parsed ?? null)) },
      { role: "user", content: correctionMessage(v.reason) });
    res = await ctx.chat(`${purpose} (retry)`, request());
    cost += Number(res?.cost) || 0;
    v = check(res, validate, { retry: true });
    if ( !v.ok ) {
      throw new LLMError(`The model's ${purpose} broke the menu: ${v.reason}`, {
        code: "bad_output", retryable: false, detail: { purpose, reason: v.reason, content: clip(res?.content, 2000) }
      });
    }
  }
  return { value: v.value, thinking: clip(res.parsed[RATIONALE] ?? res.parsed.thinking, 300), say: String(res.parsed.say ?? ""), usage: res?.usage ?? null, cost };
}

/* -------------------------------------------- */
/*  Table talk                                  */
/* -------------------------------------------- */

/** Letters of scripts other than the table's (Latin), for dropping a `say` in another language. */
const NON_LATIN = /[\u0370-\u03FF\u0400-\u052F\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0FFF\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * A `say` line capped at 160 characters, cut at a sentence boundary (else a word boundary with "…"), unquoted, on
 * one line. Empty when there is nothing to say or the line leaks a menu key (snake_case).
 */
export function capSay(text) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "").trim();
  if ( !s ) return "";
  if ( /\b[a-z0-9]+_[a-z0-9_]+\b/i.test(s) ) return "";
  // Another script than the table's (DeepSeek V4 Flash sometimes answers in Chinese despite the rules): drop it.
  if ( NON_LATIN.test(s) ) return "";
  if ( s.length <= SAY_MAX_CHARS ) return s;
  const head = s.slice(0, SAY_MAX_CHARS);
  let cut = -1;
  for ( const m of head.matchAll(/[.!?…](?=\s|$|["'”’])/g) ) cut = m.index;
  if ( cut >= 15 ) return head.slice(0, cut + 1).trim();
  const sp = head.lastIndexOf(" ", SAY_MAX_CHARS - 2);
  return `${head.slice(0, sp > 40 ? sp : SAY_MAX_CHARS - 1).trim()}…`;
}

/**
 * Whether a line is spoken: key moments (a big attack, an HQ lost or taken, a missile, the end of a game, a faction
 * pick or a reward) always may speak; routine ones are kept with probability `chattiness`, at most
 * ROUTINE_SAYS_PER_TURN per turn.
 */
export function gateSay(ctx, raw, { key = false } = {}) {
  const s = capSay(raw);
  if ( !s ) return "";
  if ( key ) return s;
  const memo = memoOf(ctx);
  if ( memo.routineSays >= ROUTINE_SAYS_PER_TURN ) return "";
  const r = typeof ctx.random === "function" ? ctx.random() : Math.random();
  if ( r >= knobsOf(ctx).chattiness ) return "";
  memo.routineSays += 1;
  return s;
}

/** Attach a pending say/thinking (from a call made earlier in the turn) to a decision, once. */
export function withPending(ctx, decision) {
  const memo = memoOf(ctx);
  if ( !decision || typeof decision !== "object" ) return decision;
  if ( memo.pendingSay ) {
    decision.say = memo.pendingSay;
    memo.pendingSay = "";
  }
  if ( memo.pendingThinking && decision.why ) {
    decision.why.thinking ??= memo.pendingThinking;
    memo.pendingThinking = "";
  }
  return decision;
}
