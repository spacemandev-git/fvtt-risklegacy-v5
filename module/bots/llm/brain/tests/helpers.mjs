/**
 * Test helpers for the chat-model brain: a fake `chat` that shape-checks every request (strict-schema friendly,
 * reasoning never disabled) and answers from a script or from the schema itself, and LLM contexts built on the Jev
 * fixtures (tools/fixtures/bots/*.json) plus the LLM extras (bot, seats, campaign, recent).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as rules from "../../../../rules/_module.mjs";
import { makeContext, readSituation, resolveArgs } from "../../../../../tools/fixtures/bots/build.mjs";
import { rollDist } from "../../../brain/odds.mjs";
import { seededRandom } from "../../../brain/util.mjs";
import { FIXTURE_PERSONALITIES, fixturePersonality } from "../../../../../tools/fixtures/bots/llm/personalities.mjs";
import { clearTurnMemos } from "../../../brain/util.mjs";
import { clearStakes } from "../../../brain/decide/battle.mjs";
import { clearLLMCaches } from "../call.mjs";

export * from "../../../../../tools/fixtures/bots/build.mjs";
export { FIXTURE_PERSONALITIES, fixturePersonality };

/** Reset every module-level memo between tests. */
export function reset() {
  clearTurnMemos();
  clearStakes();
  clearLLMCaches();
}

/** Strict structured output: every object lists all its properties as required and forbids others. */
export function checkSchema(schema, path = "$") {
  assert.ok(schema && typeof schema === "object", `${path}: schema object`);
  if ( schema.type === "object" ) {
    assert.equal(schema.additionalProperties, false, `${path}: additionalProperties false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: all properties required`);
    for ( const [k, v] of Object.entries(schema.properties) ) checkSchema(v, `${path}.${k}`);
  }
  else if ( schema.type === "array" ) checkSchema(schema.items, `${path}[]`);
  else assert.ok(["string", "integer", "number", "boolean"].includes(schema.type), `${path}: type ${schema.type}`);
  if ( schema.enum ) {
    assert.ok(schema.enum.length >= 1, `${path}: enum not empty`);
    assert.equal(new Set(schema.enum).size, schema.enum.length, `${path}: enum unique`);
    for ( const k of schema.enum ) assert.match(String(k), /^[a-z0-9_]+$/, `${path}: enum key ${k}`);
  }
  for ( const k of Object.keys(schema) ) {
    assert.ok(["type", "properties", "required", "additionalProperties", "items", "enum", "description"].includes(k), `${path}: keyword ${k}`);
  }
}

/** Shape check of one chat request (BOTS-LLM.md §4.2). */
export function checkRequest(purpose, request) {
  assert.ok(typeof purpose === "string" && purpose, "purpose");
  assert.ok(Array.isArray(request.messages) && request.messages.length >= 2, "messages");
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages.at(-1).role, "user");
  for ( const m of request.messages ) assert.ok(typeof m.content === "string" && m.content.length > 0, "message content");
  assert.ok(request.schema?.name && request.schema.schema, "schema {name, schema}");
  checkSchema(request.schema.schema);
  const props = Object.keys(request.schema.schema.properties);
  assert.equal(props[0], "thinking", "thinking comes first");
  assert.ok(props.includes("say"), "say in every schema");
  assert.ok(request.reasoning && typeof request.reasoning.effort === "string", "reasoning effort");
  assert.ok(!("enabled" in request.reasoning), "never reasoning.enabled");
  assert.ok(Number.isInteger(request.maxTokens) && request.maxTokens >= 1000, "maxTokens");
  assert.ok(typeof request.temperature === "number", "temperature");
  assert.ok(!("model" in request), "the driver adds the model");
}

/** A valid answer generated from a schema (first enum value, one array item, integer 1). */
export function autoAnswer(schema, pickEnum = keys => keys[0]) {
  switch ( schema.type ) {
    case "object": return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => {
      if ( k === "thinking" ) return [k, "Auto answer for a test."];
      if ( k === "say" ) return [k, "Steady now."];
      return [k, autoAnswer(v, pickEnum)];
    }));
    case "array": return [autoAnswer(schema.items, pickEnum)];
    case "integer": return 1;
    case "number": return 1;
    case "boolean": return false;
    default: return schema.enum ? pickEnum(schema.enum) : "noted";
  }
}

/**
 * A fake ctx.chat. `script`: a function (purpose, request, n) → parsed answer (or undefined for an auto answer), or
 * an array of parsed answers consumed in order (then auto answers). Records `calls`.
 */
export function fakeChat(script = null) {
  const calls = [];
  const queue = Array.isArray(script) ? [...script] : null;
  const chat = async (purpose, request) => {
    checkRequest(purpose, request);
    calls.push({ purpose, request: structuredClone(request) });
    let parsed;
    if ( typeof script === "function" ) parsed = script(purpose, request, calls.length);
    else if ( queue?.length ) parsed = queue.shift();
    if ( parsed === undefined ) parsed = autoAnswer(request.schema.schema);
    if ( typeof parsed === "function" ) parsed = parsed(request);
    const content = JSON.stringify(parsed);
    return { parsed, content, reasoning: "", model: "fake", usage: { prompt_tokens: Math.round(JSON.stringify(request.messages).length / 4), completion_tokens: 40 }, cost: 0.0001, ms: 1 };
  };
  chat.calls = calls;
  return chat;
}

/** Enum values of a property in the last request's schema (`path` like "cards" or "steps.option"). */
export function enumOf(request, path) {
  let node = request.schema.schema;
  for ( const part of path.split(".") ) {
    node = node.type === "array" ? node.items : node;
    node = node.properties[part];
  }
  node = node.type === "array" ? node.items : node;
  return node.enum;
}

/** The user message of a request. */
export const userOf = request => request.messages.at(-1).content;
export const systemOf = request => request.messages[0].content;

/** The LLM fixtures (tools/fixtures/bots/llm/*.json). */
export const LLM_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../tools/fixtures/bots/llm");
export const readLLMSituation = name => JSON.parse(fs.readFileSync(path.join(LLM_FIXTURE_DIR, `${name}.json`), "utf8"));
export const llmSituationNames = () => fs.readdirSync(LLM_FIXTURE_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")).sort();

/** Seats for a fixture: every faction a person except `bots` ({fid: botName}); the bot itself is a bot. */
export function seatsFor(spec, bots = {}) {
  return Object.fromEntries(Object.keys(spec.factions).map(fid => [fid, {
    user: `user-${fid}`, bot: fid in bots || fid === spec.me, botName: bots[fid] ?? (fid === spec.me ? "Test Bot" : null), personality: null
  }]));
}

/**
 * An LLM BotContext for a fixture call (spec.llm supplies defaults: personality, memory, bots).
 * @param {object} spec      situation (readSituation / readLLMSituation)
 * @param {object} [o]       {difficulty, chat, personality (id|object), memory, seats, campaign, recent, seed, call, excluded}
 */
export function makeLLMContext(spec, o = {}) {
  const extra = spec.llm ?? {};
  const ctx = makeContext(spec, { difficulty: o.difficulty, seed: o.seed ?? 7, call: o.call ?? null, excluded: o.excluded });
  const pers = o.personality ?? extra.personality ?? FIXTURE_PERSONALITIES[2];
  const p = typeof pers === "string" ? fixturePersonality(pers) : pers;
  const memory = o.memory !== undefined ? o.memory : (extra.memory ?? null);
  ctx.bot = { engine: "llm", model: "fake", personality: p, memory: memory ? structuredClone(memory) : null, userId: `user-${spec.me}` };
  ctx.chat = o.chat === undefined ? fakeChat() : o.chat;
  ctx.view.seats = o.seats ?? seatsFor(spec, extra.bots ?? {});
  if ( o.campaign ) ctx.view.campaign = o.campaign;
  if ( o.recent ) ctx.view.recent = o.recent;
  if ( o.warId && ctx.state.turn ) ctx.state.turn.warId = o.warId;
  return ctx;
}

/** Resolve fixture args: Jev "auto" args, plus `cards: "view"` and `targets: "auto"` for scar plays. */
export function resolveLLMArgs(ctx, args = {}, spec = null) {
  const out = resolveArgs(ctx, args);
  if ( out.cards === "view" ) out.cards = ctx.view.scarCards;
  if ( out.targets === "auto" ) out.targets = Object.values(ctx.state.territories).filter(t => !t.scar).map(t => t.id);
  if ( spec?.summary && !out.summary ) out.summary = structuredClone(spec.summary);
  return out;
}

/** Run one call of a situation (Jev fixture by name, or `o.spec`) through the LLM brain. */
export async function runLLMCall(brain, name, index = 0, o = {}) {
  const spec = o.spec ?? readSituation(name);
  const call = { ...spec.calls[index], ...(o.callOverride ?? {}) };
  const ctx = makeLLMContext(spec, { ...o, call });
  if ( o.situation ) ctx.situation = o.situation;
  const args = resolveLLMArgs(ctx, call.args ?? {}, spec);
  const out = await brain[call.fn](ctx, args);
  return { ctx, args, out, call, spec };
}

/* -------------------------------------------- */
/*  A small turn simulator                      */
/* -------------------------------------------- */

const syncHand = (ctx, me) => {
  const h = ctx.view.hand;
  ctx.state.factions[me].hand = { count: h.length, coins: h.reduce((n, c) => n + (c.coins ?? 1), 0), territoryIds: [] };
  ctx.view.hands[me] = { count: h.length, coins: ctx.state.factions[me].hand.coins };
};

/**
 * Play one whole bot turn the way the driver does (situation, stars, scars, recruit, placement, attacks with sampled
 * dice from the exact roll distribution, move-ins, maneuver, end of turn), mutating the context's state.
 * @returns {Promise<{ctx, log:{fn, out}[], conquests:number}>}
 */
export async function playTurn(brain, spec, o = {}) {
  const ctx = makeLLMContext(spec, o);
  const me = spec.me;
  const dice = seededRandom(o.diceSeed ?? 3);
  const T = ctx.state.turn;
  const log = [];
  const call = async (fn, args) => {
    const out = await brain[fn](ctx, args);
    log.push({ fn, out });
    return out;
  };
  const sync = () => rules.deriveState(ctx.state);
  const pieces = (id, fid) => (ctx.state.territories[id].pieces[fid] ??= { troops: 0, hq: false, tokens: [] });

  ctx.situation = await call("assessSituation");
  for ( let i = 0; i < 4 && ctx.view.hand.length >= 4; i++ ) {
    const d = await call("planStartOfTurn");
    if ( !d.buyRedStars?.length ) break;
    ctx.view.hand = ctx.view.hand.filter(c => !d.buyRedStars.includes(c.id));
    ctx.state.factions[me].redStarTokens += Math.floor(d.buyRedStars.length / 4);
    syncHand(ctx, me);
    sync();
  }
  const scarCards = ctx.view.scarCards.filter(c => ["startOfAnyTurn", "duringOwnTurn"].includes(c.timing));
  if ( scarCards.length ) {
    const targets = Object.values(ctx.state.territories).filter(t => !t.scar).map(t => t.id);
    const d = await call("planScars", { cards: scarCards, targets });
    for ( const p of d.plays ) {
      if ( p.territory ) ctx.state.territories[p.territory].scar = scarCards.find(c => c.id === p.cardId).scar;
      ctx.view.scarCards = ctx.view.scarCards.filter(c => c.id !== p.cardId);
    }
  }
  const r = await call("planRecruit", { mustJoin: false, legalJoin: [] });
  let reserve = 0;
  if ( r.tradeForTroops?.length ) {
    const coins = ctx.view.hand.filter(c => r.tradeForTroops.includes(c.id)).reduce((n, c) => n + c.coins, 0);
    reserve += rules.troopsForCoins(Math.min(10, coins));
    ctx.view.hand = ctx.view.hand.filter(c => !r.tradeForTroops.includes(c.id));
    syncHand(ctx, me);
    T.log.tradedForTroops = true;
  }
  reserve += rules.recruitBreakdown(ctx.state, me).total;
  T.phase = "recruit";
  T.log.recruited = true;
  ctx.state.factions[me].reserve = reserve;
  const pl = await call("planPlacement", { reserve });
  for ( const p of pl.placements ) pieces(p.territory, me).troops += p.count;
  ctx.state.factions[me].reserve = 0;
  T.phase = "attack";
  sync();

  let conquests = 0;
  for ( let k = 0; k < 40; k++ ) {
    const m = await call("nextMove");
    if ( m.type === "stop" ) break;
    const A = ctx.state.territories[m.from].troops;
    if ( m.type === "attack" ) {
      const t = ctx.state.territories[m.to];
      const def = t.owner;
      const a = Math.min(3, A - 1, m.dice ?? 3);
      const dist = rollDist(a, Math.min(2, t.troops));
      let x = dice();
      const o2 = dist.find(e => (x -= e.p) <= 0) ?? dist.at(-1);
      pieces(m.from, me).troops -= o2.aLoss;
      pieces(m.to, def).troops = Math.max(0, pieces(m.to, def).troops - o2.dLoss);
      if ( pieces(m.to, def).troops === 0 ) {
        const moved = a - o2.aLoss;
        pieces(m.from, me).troops -= moved;
        pieces(m.to, me).troops += moved;
        T.log.conquered = (T.log.conquered ?? 0) + 1;
        conquests++;
        sync();
        // The rules: a face-up territory card for a territory you control, else a coin card.
        const mine = ctx.view.row.filter(c => ctx.state.territories[c.territory]?.owner === me).map(c => c.cardId);
        ctx.view.drawOptions = { canDraw: true, eligible: true, territoryCardIds: mine, coinAllowed: !mine.length, row: ctx.view.row };
        const max = ctx.state.territories[m.from].troops - 1;
        if ( max > 0 ) {
          const mi = await call("moveIn", { from: m.from, to: m.to, min: 0, max });
          pieces(m.from, me).troops -= mi.count;
          pieces(m.to, me).troops += mi.count;
        }
      }
    }
    else {
      const { cost } = rules.expandCost(ctx.state, me, m.to, m.count);
      pieces(m.from, me).troops -= m.count;
      pieces(m.to, me).troops += m.count - cost;
      T.log.expanded = (T.log.expanded ?? 0) + 1;
      sync();
      const max = ctx.state.territories[m.from].troops - 1;
      if ( max > 0 ) {
        const mi = await call("moveIn", { from: m.from, to: m.to, min: 0, max });
        pieces(m.from, me).troops -= mi.count;
        pieces(m.to, me).troops += mi.count;
      }
    }
    sync();
  }
  T.phase = "maneuver";
  const mv = await call("planManeuver");
  if ( mv ) {
    pieces(mv.from, me).troops -= mv.count;
    pieces(mv.to, me).troops += mv.count;
    sync();
  }
  T.log.maneuver = { done: true, from: mv?.from ?? "", to: mv?.to ?? "" };
  T.phase = "end";
  await call("planEndOfTurn", { drawOptions: ctx.view.drawOptions, missionStatus: ctx.view.missionStatus });
  return { ctx, log, conquests };
}
