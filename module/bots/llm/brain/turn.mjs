/**
 * A chat-model bot's own turn (BOTS-LLM.md §6.2). Calls per turn: 2–5.
 *  1. Turn plan, at the first of planStartOfTurn / planScars / planRecruit / planPlacement: cards, start-of-turn scars,
 *     Join the War, placement fronts. Cached for the turn; the later functions read it. Recruit totals, trade values
 *     and legality are code's.
 *  2. Attack plan, at the first nextMove: an ordered list of menu options plus `stop_when`. Code runs it step by step,
 *     recomputing the odds before every roll; bounded replans (profile) when a step's odds fall under its floor, a push
 *     stalls, or (keep_going) the plan runs out while good options remain.
 *  3. End of turn, at planManeuver: the maneuver (menu of consolidations) and the card draw; planEndOfTurn reads it.
 * Code-only: winning moves, buying the Red Star that wins, completing a verified mission, moveIn, assessSituation.
 * When there is no real choice no call is made.
 */
import * as rules from "../../../rules/_module.mjs";
import * as jev from "../../brain/index.mjs";
import { bestTrade, movePlans, reasonOf, starCards } from "../../brain/candidates.mjs";
import { recruitForecast } from "../../brain/features.mjs";
import { attackOdds, pathOdds } from "../../brain/odds.mjs";
import { clamp, round, territoryName, why } from "../../brain/util.mjs";
import {
  FACTS, STOP_NOW, STOP_WHEN, attackPlanMessage, attackPlanSchema, endTurnMessage, endTurnSchema, turnPlanMessage, turnPlanSchema
} from "../prompts.mjs";
import { knobsOf, llmProfileOf, moveForwardShare, stepFloor } from "../profiles.mjs";
import { askModel, gateSay, invalid, isHeuristic, memoOf, withPending } from "./call.mjs";
import { bigHitSinceLastTurn, boardFacts } from "./facts.mjs";
import {
  attackMenu, cardMenu, drawMenu, frontMenu, goodOptionsRemain, jevProfileOf, joinMenu, legalPlans, maneuverMenu, scarMenu
} from "./menus.mjs";

const H = ctx => ({ ...ctx, ask: null });
const START_TIMINGS = new Set(["startOfAnyTurn", "duringOwnTurn"]);
const activeEventsOf = ctx => ctx.view?.activeEvents?.map(e => e.id);

/* -------------------------------------------- */
/*  Situation (code only)                       */
/* -------------------------------------------- */

/** Turn-level facts shared by later decisions: the Jev brain's code judgments (no call). */
export async function assessSituation(ctx) {
  const r = await jev.assessSituation(H(ctx));
  if ( isHeuristic(ctx) ) return r;
  // Code judgment by design (no call), not a fallback.
  if ( r?.why ) delete r.why.heuristic;
  memoOf(ctx).situation = r;
  return r;
}

/** ctx.situation, or a code-only one. */
export async function situationOf(ctx) {
  if ( ctx.situation ) return ctx.situation;
  const memo = memoOf(ctx);
  memo.situation ??= await jev.assessSituation(H(ctx));
  return memo.situation;
}

/* -------------------------------------------- */
/*  1. The turn plan                            */
/* -------------------------------------------- */

/** Validate a turn plan against its menus. */
function readTurnPlan(p, m) {
  const out = { card: null, scars: [], join: null, placements: [] };
  if ( m.cards.length ) {
    out.card = m.cards.find(o => o.key === p.cards) ?? invalid(`"cards" must be one of ${m.cards.map(o => o.key).join(", ")}`);
  }
  const spots = new Set();
  for ( const c of m.scars ) {
    const k = p[c.field];
    if ( k === c.keep ) continue;
    const o = c.options.find(x => x.key === k) ?? invalid(`"${c.field}" must be one of ${[...c.options.map(x => x.key), c.keep].join(", ")}`);
    const spot = o.territory ?? `f:${o.faction}`;
    if ( spots.has(spot) ) invalid(`two scars on the same target ("${k}")`);
    spots.add(spot);
    out.scars.push(o);
  }
  if ( m.join.length ) out.join = m.join.find(o => o.key === p.join) ?? invalid(`"join" must be one of ${m.join.map(o => o.key).join(", ")}`);
  if ( m.fronts.length ) {
    const reserve = out.card?.kind === "trade" ? m.tradeReserve : m.reserve;
    if ( !Array.isArray(p.placements) || !p.placements.length ) invalid("\"placements\" needs at least one front");
    if ( p.placements.length > m.maxFronts ) invalid(`at most ${m.maxFronts} fronts in "placements"`);
    const seen = new Set();
    let total = 0;
    for ( const e of p.placements ) {
      const f = m.fronts.find(x => x.key === e?.front) ?? invalid(`unknown front "${e?.front}"`);
      if ( seen.has(f.key) ) invalid(`front "${f.key}" listed twice`);
      seen.add(f.key);
      if ( !Number.isInteger(e.troops) || e.troops < 1 ) invalid(`troops for "${f.key}" must be a whole number of at least 1`);
      total += e.troops;
      out.placements.push({ territory: f.territory, count: e.troops, front: f });
    }
    if ( total > reserve ) invalid(`placements add up to ${total} troops, more than the ${reserve} you will have`);
    out.reserve = reserve;
  }
  return out;
}

/**
 * The turn plan (one call), made at the first start-of-turn decision and cached for the turn.
 * @param {object} ctx
 * @param {{scarCards?:object[], targets?:string[], legalJoin?:string[]}} [extra]  arguments the driver passed
 */
export async function ensureTurnPlan(ctx, extra = {}) {
  const memo = memoOf(ctx);
  if ( memo.plan ) return memo.plan;
  const profile = llmProfileOf(ctx);
  const knobs = knobsOf(ctx);
  const sit = await situationOf(ctx);
  const { state, me } = ctx;
  const f = state.factions[me];
  const log = state.turn?.log ?? {};
  const phase = state.turn?.phase ?? "start";
  const knockedOut = !(f?.territories?.length);
  const startPhase = (phase === "start") && !log.recruited && !log.joinedWar;

  const cm = (startPhase && !knockedOut) ? cardMenu(ctx, profile, knobs, sit) : { options: [], winBuy: null };
  const scarCards = extra.scarCards ?? (startPhase ? (ctx.view?.scarCards ?? []).filter(c => START_TIMINGS.has(c.timing)) : []);
  const scars = knockedOut ? [] : scarMenu(ctx, scarCards, extra.targets ?? null, sit);
  const legalJoin = extra.legalJoin ?? (knockedOut ? rules.legalStartingTerritories(state, me, { joining: true }) : []);
  const join = (knockedOut && !log.joinedWar) ? joinMenu(ctx, profile, legalJoin) : [];
  const reserve = knockedOut ? 0 : (f?.reserve ?? 0) + (log.recruited ? 0 : recruitForecast(state, me));
  const tradeOpt = cm.options.find(o => o.kind === "trade");
  const tradeReserve = tradeOpt ? reserve + tradeOpt.troops : null;
  const fronts = reserve > 0 ? frontMenu(ctx, profile, sit, reserve, tradeReserve) : [];
  const m = { cards: cm.options, scars, join, fronts, reserve, tradeReserve, maxFronts: Math.min(3, fronts.length) };

  const plan = { llm: false, buy: null, bought: false, trade: null, scars: [], join: null, placements: [], placed: false, reserve };
  const real = (m.cards.length >= 2) || scars.length > 0 || join.length >= 2 || fronts.length >= 2;
  if ( !real ) {
    plan.join = join[0]?.territory ?? null;
    if ( fronts[0] ) plan.placements = [{ territory: fronts[0].territory, count: reserve, front: fronts[0] }];
    memo.plan = plan;
    return plan;
  }

  const key = join.length > 0 || bigHitSinceLastTurn(ctx);
  const res = await askModel(ctx, {
    purpose: "turn plan",
    user: turnPlanMessage({ board: boardFacts(ctx, profile, { detail: "turn" }), ...m, key }),
    schema: turnPlanSchema({ cards: m.cards.map(o => o.key), scars, join: join.map(o => o.key), fronts: fronts.map(o => o.key) }),
    validate: p => readTurnPlan(p, m)
  });
  const v = res.value;
  plan.llm = true;
  if ( v.card?.kind === "buy" ) plan.buy = { ids: v.card.ids, stars: v.card.stars };
  if ( v.card?.kind === "trade" ) plan.trade = { ids: v.card.ids, troops: v.card.troops };
  plan.scars = v.scars.map(o => (o.territory ? { cardId: o.cardId, territory: o.territory } : { cardId: o.cardId, faction: o.faction }));
  plan.join = v.join?.territory ?? (join.length === 1 ? join[0].territory : null);
  plan.placements = v.placements;
  if ( v.reserve ) plan.reserve = v.reserve;
  plan.thinking = res.thinking;
  memo.plan = plan;
  memo.pendingSay = gateSay(ctx, res.say, { key: key || !!plan.buy });
  memo.pendingThinking = res.thinking;
  return plan;
}

/** Start of turn: Red Star purchase. Called again while it returns cards. */
export async function planStartOfTurn(ctx) {
  if ( isHeuristic(ctx) ) return jev.planStartOfTurn(H(ctx));
  const { state, me } = ctx;
  const hand = ctx.view?.hand ?? [];
  if ( hand.length < 4 ) return withPending(ctx, { buyRedStars: null, why: why("holdCards", { count: hand.length }) });
  const stars = rules.redStarTotal(state, me);
  // Code rule: a purchase that wins the war is always made.
  if ( stars + Math.floor(hand.length / 4) >= 4 ) {
    const n = Math.max(1, 4 - stars);
    return withPending(ctx, { buyRedStars: [...hand].sort((a, b) => (a.coins ?? 1) - (b.coins ?? 1)).slice(0, n * 4).map(c => c.id), why: why("buyStarWin", { count: 4 }) });
  }
  const plan = await ensureTurnPlan(ctx);
  if ( plan.buy && !plan.bought ) {
    plan.bought = true;
    const have = new Set(hand.map(c => c.id));
    const ids = plan.buy.ids.every(id => have.has(id)) ? plan.buy.ids : (plan.buy.stars >= 2 && hand.length >= 8
      ? [...hand].sort((a, b) => (a.coins ?? 1) - (b.coins ?? 1)).slice(0, 8).map(c => c.id) : starCards(hand));
    return withPending(ctx, { buyRedStars: ids, why: why("buyStar", { count: stars + Math.floor(ids.length / 4) }) });
  }
  return withPending(ctx, { buyRedStars: null, why: why("holdCards", { count: hand.length, ...(plan.trade ? { label: "trade for troops" } : {}) }) });
}

/** Start-of-turn scar cards, from the turn plan (filtered to the cards and targets the game allows now). */
export async function planScars(ctx, { cards = [], targets = [] } = {}) {
  if ( isHeuristic(ctx) ) return jev.planScars(H(ctx), { cards, targets });
  if ( !cards.length ) return withPending(ctx, { plays: [], why: why("holdScars") });
  const plan = await ensureTurnPlan(ctx, { scarCards: cards, targets });
  const ids = new Set(cards.map(c => c.id));
  const legal = new Set(targets ?? []);
  const plays = plan.scars.filter(p => ids.has(p.cardId) && (p.faction || !targets?.length || legal.has(p.territory)));
  if ( !plays.length ) return withPending(ctx, { plays: [], why: why("holdScars") });
  const first = plays[0];
  return withPending(ctx, {
    plays,
    why: why("playScar", { territory: first.territory ?? null, faction: first.faction ?? null, count: plays.length, label: cards.find(c => c.id === first.cardId)?.name })
  });
}

/** Step 2: Join the War (knocked out) or recruit, with the plan's card trade. */
export async function planRecruit(ctx, { mustJoin = false, legalJoin = [] } = {}) {
  if ( isHeuristic(ctx) ) return jev.planRecruit(H(ctx), { mustJoin, legalJoin });
  const { state, me } = ctx;
  if ( mustJoin ) {
    if ( !legalJoin.length ) return withPending(ctx, { join: null, why: why("startPosition", { territory: null }) });
    const plan = await ensureTurnPlan(ctx, { legalJoin });
    const territory = legalJoin.includes(plan.join) ? plan.join : (joinMenu(ctx, llmProfileOf(ctx), legalJoin)[0]?.territory ?? legalJoin[0]);
    return withPending(ctx, { join: territory, why: why("startPosition", { territory }) });
  }
  const plan = await ensureTurnPlan(ctx);
  if ( plan.trade ) {
    const trade = bestTrade(state, me, ctx.view?.hand ?? []);
    if ( trade && rules.checkTrade(state, me, trade.coins, { ignoreTurn: true }).ok ) {
      return withPending(ctx, { recruit: true, tradeForTroops: trade.ids, why: why("tradeTroops", { count: trade.troops, label: `${trade.coins} coins` }) });
    }
  }
  return withPending(ctx, { recruit: true, tradeForTroops: null, why: why("recruit", { count: recruitForecast(state, me) }) });
}

/** Scale planned counts to the actual reserve (largest remainder; extra troops go to the first front). */
function scalePlacements(entries, reserve) {
  const total = entries.reduce((n, e) => n + e.count, 0);
  if ( !total ) return [];
  if ( reserve >= total ) return entries.map((e, i) => ({ ...e, count: e.count + (i === 0 ? reserve - total : 0) }));
  const raw = entries.map(e => (e.count * reserve) / total);
  const out = entries.map((e, i) => ({ ...e, count: Math.floor(raw[i]) }));
  let left = reserve - out.reduce((n, e) => n + e.count, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for ( const [, i] of order ) {
    if ( left <= 0 ) break;
    out[i].count += 1;
    left--;
  }
  return out.filter(e => e.count > 0);
}

/** Where to put the reserve: the plan's fronts, scaled to the real reserve. */
export async function planPlacement(ctx, { reserve } = {}) {
  if ( isHeuristic(ctx) ) return jev.planPlacement(H(ctx), { reserve });
  const { state, me } = ctx;
  reserve = Math.max(0, Math.floor(reserve ?? state.factions[me]?.reserve ?? 0));
  const legal = id => rules.checkPlacement(state, me, id, 1, { ignoreTurn: true }).ok;
  if ( !reserve ) return withPending(ctx, { placements: [], why: why("stageAttack", { count: 0 }) });
  const plan = await ensureTurnPlan(ctx);
  let entries = plan.placed ? [] : plan.placements.filter(e => legal(e.territory));
  if ( !entries.length ) {
    // A second call (some troops were refused), or no plan for placement: everything on the first legal front.
    const id = plan.placements.find(e => legal(e.territory))?.territory ?? (state.factions[me]?.territories ?? []).find(legal);
    if ( !id ) return withPending(ctx, { placements: [], why: why("stageAttack", { count: 0 }) });
    return withPending(ctx, { placements: [{ territory: id, count: reserve }], why: why("stageAttack", { territory: id, count: reserve }) });
  }
  plan.placed = true;
  entries = scalePlacements(entries, reserve);
  const main = [...entries].sort((a, b) => b.count - a.count)[0];
  const f = main.front;
  let reason = "defendBorder";
  if ( f?.isHq && f.threat ) reason = "defendHq";
  else if ( f?.best ) reason = "stageAttack";
  else if ( f?.isHq ) reason = "reinforceHq";
  return withPending(ctx, {
    placements: entries.map(({ territory, count }) => ({ territory, count })),
    why: why(reason, {
      territory: main.territory, count: main.count,
      ...(reason === "stageAttack" && f.best ? { to: f.best.to, chance: round(f.best.P, 2) } : {})
    })
  });
}

/* -------------------------------------------- */
/*  2. The attack plan                          */
/* -------------------------------------------- */

const stop = (reason, count = 0) => ({ type: "stop", why: why(reason, { count }) });

/** Code rule: a move that wins the war now with good odds is always taken (HQ floors don't apply). */
function winNowPlan(ctx, profile, sit) {
  if ( rules.redStarTotal(ctx.state, ctx.me) < 2 ) return null;
  const jp = jevProfileOf(profile);
  const win = movePlans(ctx, jp, { situation: sit, chains: false }).filter(p => p.endFx.winNow).sort((a, b) => b.P - a.P)[0];
  return win && (win.P >= jp.attack.winNowMin) ? win : null;
}

/** The largest keep_at_least accepted. */
const MAX_KEEP = 30;

/** Validate an attack plan against its menu. */
function readAttackPlan(p, options, maxSteps, { retry = false } = {}) {
  // An empty list is usually a slip (GLM 5.3 answered `steps: []` while its own thinking listed attacks), so it gets
  // the corrective retry. Empty again on the retry is a clear "no attacks": stop now rather than error out.
  if ( Array.isArray(p.steps) && !p.steps.length && retry ) return { steps: [], stopWhen: "after_these_steps" };
  if ( !Array.isArray(p.steps) || !p.steps.length ) invalid(`"steps" needs at least one entry; to stop attacking now, give ["${STOP_NOW}"]`);
  const stopAt = p.steps.indexOf(STOP_NOW);
  if ( stopAt >= 0 && stopAt !== p.steps.length - 1 ) invalid(`${STOP_NOW} must be the last step`);
  const list = stopAt >= 0 ? p.steps.slice(0, stopAt) : p.steps;
  if ( list.length > maxSteps ) invalid(`at most ${maxSteps} steps`);
  if ( !STOP_WHEN.includes(p.stop_when) ) invalid(`"stop_when" must be one of ${STOP_WHEN.join(", ")}`);
  const keep = p.keep_at_least ?? 0;
  if ( !Number.isInteger(keep) || keep < 0 || keep > MAX_KEEP ) invalid(`"keep_at_least" must be a whole number from 0 to ${MAX_KEEP}`);
  const seen = new Set();
  const steps = list.map(k => {
    const o = options.find(x => x.key === k) ?? invalid(`unknown option "${k}"`);
    if ( seen.has(o.key) ) invalid(`option "${o.key}" listed twice`);
    seen.add(o.key);
    return { ...o, leave: keep };
  });
  // An explicit stop_now ends the plan there: no extension by keep_going.
  return { steps, stopWhen: stopAt >= 0 ? "after_these_steps" : p.stop_when };
}

/** Ask for a (re)plan. Returns false when the menu is empty (no call). */
async function planAttacks(ctx, profile, knobs, sit, replan = null, options = null) {
  const memo = memoOf(ctx);
  const a = memo.attack;
  options ??= attackMenu(ctx, profile, knobs, sit);
  if ( !options.length ) {
    a.steps = [];
    a.idx = 0;
    return false;
  }
  if ( replan ) a.replans += 1;
  const conquered = ctx.state.turn?.log?.conquered ?? 0;
  const troops = (ctx.state.factions[ctx.me]?.troops ?? 0);
  const sofar = replan ? FACTS.sofar(conquered - a.conquered0, Math.max(0, a.troops0 - troops)) : "";
  const maxSteps = Math.min(options.length, profile.menu);
  const res = await askModel(ctx, {
    purpose: replan ? "replan" : "attack plan",
    user: attackPlanMessage({
      board: boardFacts(ctx, profile, { detail: "attack" }), options, hqFloor: profile.hqFloor, replan, sofar,
      maxSteps, key: options.some(o => o.decisive)
    }),
    schema: attackPlanSchema(options.map(o => o.key)),
    validate: (p, o) => readAttackPlan(p, options, maxSteps, o)
  });
  a.steps = res.value.steps;
  a.idx = 0;
  a.stopWhen = res.value.stopWhen;
  a.planned = true;
  const big = a.steps.some(s => s.decisive || s.plan.endFx.hq || s.plan.endFx.knockOut);
  const say = gateSay(ctx, res.say, { key: big });
  if ( say ) memo.pendingSay = say;
  memo.pendingThinking = res.thinking;
  return true;
}

/** The next hop of a step: the first territory on its path the bot doesn't hold yet. */
function nextHop(ctx, step) {
  const { state, me } = ctx;
  const owned = id => state.territories[id]?.owner === me;
  let i = 1;
  while ( i < step.path.length && owned(step.path[i]) ) i++;
  if ( i >= step.path.length ) return { done: true };
  const from = step.path[i - 1];
  const to = step.path[i];
  const kind = state.territories[to]?.owner ? "attack" : "expand";
  if ( !owned(from) || ctx.excluded?.has(`${kind}:${from}>${to}`) ) return { broken: true };
  return { from, to, i, first: i === 1, last: i === step.path.length - 1 };
}

/** Troops kept in the hop's source: the HQ floor, and the plan's keep_at_least on the first hop. */
function keepAt(ctx, profile, step, hop) {
  const src = ctx.state.territories[hop.from];
  let keep = 1;
  if ( src?.hq && src.owner === ctx.me && !step.plan.endFx.winNow ) keep = Math.max(keep, profile.hqFloor ?? 1);
  // keep_at_least applies where the source has more than that (else the default).
  if ( hop.first && step.leave > 0 && src.troops > step.leave + 1 ) keep = Math.max(keep, step.leave);
  return keep;
}

/** The move for a hop with fresh odds, or null when it can't be made. */
function hopMove(ctx, profile, step, hop) {
  const { state, me, lookup } = ctx;
  const src = state.territories[hop.from];
  const t = state.territories[hop.to];
  const keep = keepAt(ctx, profile, step, hop);
  const movable = src.troops - keep;
  if ( movable < 1 ) return null;
  if ( t.owner && t.owner !== me ) {
    if ( src.troops < 2 ) return null;
    const dice = Math.min(3, src.troops - 1);
    if ( !rules.checkAttack(state, me, hop.from, hop.to, dice).ok ) return null;
    const P = (step.kind === "chain" && !hop.last)
      ? pathOdds(state, me, step.path.slice(hop.i - 1), { lookup, activeEvents: activeEventsOf(ctx), A0: movable + 1, stopAt: 1 }).pReach
      : attackOdds(state, me, hop.from, hop.to, { lookup, activeEvents: activeEventsOf(ctx), stopAt: keep }).pConquer;
    return { type: "attack", from: hop.from, to: hop.to, dice, P };
  }
  const { cost } = rules.expandCost(state, me, hop.to, movable);
  const count = step.kind === "chain" ? movable : Math.min(movable, cost + 1);
  if ( count < cost + 1 || !rules.checkExpand(state, me, hop.from, hop.to, count).ok ) return null;
  return { type: "expand", from: hop.from, to: hop.to, count, P: 1 };
}

/** The decision object for a move. */
function moveDecision(ctx, move, plan, sit, decisive = false) {
  const reason = plan.endFx.winNow ? "winNow" : reasonOf(plan.endFx, sit);
  const end = plan.path.at(-1);
  const data = {
    from: move.from, to: move.to, chance: round(move.P, 2),
    ...(decisive ? { value: "decisive" } : {}),
    ...(end !== move.to ? { label: `toward ${territoryName(ctx.state, end)}`, territory: end } : {}),
    ...(plan.endFx.hq ? { faction: plan.endFx.hq } : (plan.defender ? { faction: plan.defender } : {}))
  };
  if ( move.type === "attack" ) return { type: "attack", from: move.from, to: move.to, dice: move.dice, why: why(reason, { ...data, dice: move.dice }) };
  return { type: "expand", from: move.from, to: move.to, count: move.count, why: why(reason, { ...data, count: move.count }) };
}

/** The next attack or expansion of the plan, or stop. */
export async function nextMove(ctx) {
  if ( isHeuristic(ctx) ) return jev.nextMove(H(ctx));
  const { state, me } = ctx;
  if ( !rules.checkTurnAction(state, me, "attack").ok ) return withPending(ctx, stop("stopEnough"));
  const profile = llmProfileOf(ctx);
  const knobs = knobsOf(ctx);
  const sit = await situationOf(ctx);
  const memo = memoOf(ctx);
  const conquered = state.turn?.log?.conquered ?? 0;

  const win = winNowPlan(ctx, profile, sit);
  if ( win ) {
    const move = win.kind === "attack" ? { type: "attack", from: win.from, to: win.to, dice: win.dice, P: win.P } : { type: "expand", from: win.from, to: win.to, count: win.count, P: 1 };
    return withPending(ctx, moveDecision(ctx, move, win, sit, true));
  }

  let a = memo.attack;
  if ( !a ) {
    a = memo.attack = { steps: [], idx: 0, stopWhen: "after_these_steps", replans: 0, conquered0: conquered, troops0: state.factions[me]?.troops ?? 0, planned: false };
    if ( !await planAttacks(ctx, profile, knobs, sit) ) {
      // Nothing on the menu: every attack is under the odds floor (or there is none at all).
      const anyAttack = legalPlans(ctx, profile, sit, { chains: false }).some(p => p.kind === "attack");
      return withPending(ctx, stop(anyAttack ? "stopOddsPoor" : "stopEnough", conquered));
    }
  }
  for ( let guard = 0; guard < 24; guard++ ) {
    if ( (a.stopWhen === "after_first_conquest") && (conquered > a.conquered0) ) return withPending(ctx, stop("stopEnough", conquered));
    const step = a.steps[a.idx];
    if ( !step ) {
      if ( (a.stopWhen === "keep_going") && (a.replans < profile.replans) ) {
        const options = attackMenu(ctx, profile, knobs, sit);
        if ( options.length && goodOptionsRemain(options) && await planAttacks(ctx, profile, knobs, sit, FACTS.replanDone, options) ) continue;
      }
      return withPending(ctx, stop("stopEnough", conquered));
    }
    const hop = nextHop(ctx, step);
    if ( hop.done ) {
      a.idx += 1;
      continue;
    }
    let move = hop.broken ? null : hopMove(ctx, profile, step, hop);
    const floor = stepFloor(profile, knobs, step.decisive);
    if ( !move || ((move.type === "attack") && (move.P < floor)) ) {
      const why0 = hop.broken ? FACTS.replanBroken(step.toName) : FACTS.replanOdds(territoryName(state, hop.to ?? step.to));
      if ( a.replans < profile.replans ) {
        const options = attackMenu(ctx, profile, knobs, sit);
        if ( options.length && await planAttacks(ctx, profile, knobs, sit, why0, options) ) continue;
      }
      a.idx += 1;
      move = null;
      continue;
    }
    a.current = { from: move.from, to: move.to, step: a.idx };
    return withPending(ctx, moveDecision(ctx, move, step.plan, sit, step.decisive));
  }
  return withPending(ctx, stop("stopEnough", conquered));
}

/**
 * Troops to move into a territory just conquered or expanded into. Code only: press on along a planned push; keep
 * the HQ floor and the plan's keep_at_least; keep troops where a later step attacks from; otherwise follow the
 * pressure on both sides, with the personality's aggression as the default share.
 */
export async function moveIn(ctx, { from, to, min = 0, max = 0 } = {}) {
  if ( isHeuristic(ctx) ) return jev.moveIn(H(ctx), { from, to, min, max });
  const { state, me } = ctx;
  if ( max <= min ) return withPending(ctx, { count: min, why: why("holdBack", { from, to, count: min }) });
  const profile = llmProfileOf(ctx);
  const knobs = knobsOf(ctx);
  const a = memoOf(ctx).attack;
  const fromT = state.territories[from];
  const fromTroops = fromT?.troops ?? (max + 1);
  const step = a?.steps?.[a.idx] ?? null;
  const later = a?.steps?.slice(a.idx + (step?.path?.at(-1) === to ? 1 : 0)) ?? [];

  let keep = 1;
  if ( fromT?.hq && fromT.owner === me ) keep = Math.max(keep, profile.hqFloor ?? 1);
  if ( step && step.from === from && step.leave > 0 ) keep = Math.max(keep, step.leave);
  const pressOn = !!step && step.path.includes(to) && step.path.at(-1) !== to;
  const laterFrom = later.filter(s => s.from === from && s.path[1] !== to);
  const fromNeeded = laterFrom.length > 0;
  const toNeeded = pressOn || later.some(s => s.from === to);
  // What the later steps from `from` need: about twice their defenders plus one each (the rest may move forward).
  const need = laterFrom.reduce((n, s) => n + (2 * (state.territories[s.path[1]]?.troops ?? 1)) + 1, 0);

  const pressure = id => (state.territories[id]?.neighbors ?? []).filter(n => n !== from && n !== to)
    .map(n => state.territories[n]).filter(n => n && n.owner !== me)
    .reduce((s, n) => s + (n.owner ? n.troops + 1 : 0.5), 0);
  let count;
  if ( toNeeded && !fromNeeded ) count = max;
  else if ( fromNeeded && !toNeeded ) count = Math.max(min, fromTroops - keep - need);
  else {
    const fromP = pressure(from);
    const toP = pressure(to);
    const share = moveForwardShare(knobs);
    if ( toP > 0 && fromP === 0 ) count = max;
    else if ( toP === 0 && fromP > 0 ) count = Math.round(min + ((max - min) * share * 0.3));
    else if ( toP === 0 && fromP === 0 ) count = Math.round(min + ((max - min) * share));
    else count = Math.round(min + ((max - min) * ((0.5 * share) + (0.5 * (toP / (toP + fromP))))));
  }
  count = clamp(count, min, Math.max(min, Math.min(max, fromTroops - keep)));
  return withPending(ctx, { count, why: why(count > min ? "pressOn" : "holdBack", { from, to, count }) });
}

/* -------------------------------------------- */
/*  3. End of turn                              */
/* -------------------------------------------- */

/** Validate the end-of-turn answer. */
function readEndTurn(p, maneuvers, draws) {
  let maneuver = null;
  if ( maneuvers.length ) {
    if ( p.maneuver !== "no_maneuver" ) maneuver = maneuvers.find(m => m.key === p.maneuver) ?? invalid(`"maneuver" must be one of ${maneuvers.map(m => m.key).join(", ")} or no_maneuver`);
  }
  let draw = null;
  if ( draws.length ) draw = draws.find(d => d.key === p.draw) ?? invalid(`"draw" must be one of ${draws.map(d => d.key).join(", ")}`);
  return { maneuver, draw };
}

/** The one maneuver of the turn (and, in the same call, the card to draw). */
export async function planManeuver(ctx) {
  if ( isHeuristic(ctx) ) return jev.planManeuver(H(ctx));
  const { state, me } = ctx;
  if ( !rules.checkTurnAction(state, me, "maneuver").ok && state.turn ) return null;
  const memo = memoOf(ctx);
  if ( memo.end ) return memo.end.decision ?? null;
  const profile = llmProfileOf(ctx);
  const sit = await situationOf(ctx);
  const maneuvers = maneuverMenu(ctx, profile, sit);
  if ( !maneuvers.length ) {
    memo.end = { decision: null, draw: null };
    return null;
  }
  const ms = ctx.view?.missionStatus;
  const draws = (ms?.canComplete && ms.status === "complete") ? [] : drawMenu(ctx);
  const res = await askModel(ctx, {
    purpose: "end of turn",
    user: endTurnMessage({ board: boardFacts(ctx, profile, { detail: "end" }), maneuvers, draws }),
    schema: endTurnSchema({ maneuvers: maneuvers.map(m => m.key), draws: draws.map(d => d.key) }),
    validate: p => readEndTurn(p, maneuvers, draws)
  });
  const { maneuver, draw } = res.value;
  const say = gateSay(ctx, res.say);
  memo.end = { decision: null, draw };
  if ( !maneuver ) {
    if ( say ) memo.pendingSay = say;
    memo.pendingThinking = res.thinking;
    return null;
  }
  const reason = state.territories[maneuver.to]?.hq === me ? "reinforceHq" : (maneuver.threat ? "defendBorder" : "consolidate");
  const decision = withPending(ctx, {
    from: maneuver.from, to: maneuver.to, count: maneuver.count,
    why: why(reason, { from: maneuver.from, to: maneuver.to, count: maneuver.count, territory: maneuver.to, thinking: res.thinking })
  });
  if ( say ) decision.say = say;
  memo.end.decision = decision;
  return decision;
}

/**
 * End of turn: a mission the code verifies is always completed (a permanent Red Star beats a card); otherwise the
 * card chosen in the end-of-turn call, else the Jev brain's code pick (the card worth the most coins).
 */
export async function planEndOfTurn(ctx, { drawOptions = null, missionStatus = null } = {}) {
  if ( isHeuristic(ctx) ) return jev.planEndOfTurn(H(ctx), { drawOptions, missionStatus });
  const { state, me } = ctx;
  const ms = missionStatus ?? ctx.view?.missionStatus ?? null;
  const opts = drawOptions ?? ctx.view?.drawOptions ?? null;
  const d = memoOf(ctx).end?.draw ?? null;
  if ( !(ms?.canComplete && ms.status === "complete") && d && opts?.canDraw ) {
    if ( d.coin && opts.coinAllowed ) return withPending(ctx, { draw: { coin: true }, completeMission: false, powers: {}, why: why("drawCoin") });
    if ( d.cardId && (opts.territoryCardIds ?? []).includes(d.cardId) ) {
      const khan2 = rules.hasPower(state, me, "khan_2") && d.owned;
      return withPending(ctx, { draw: { cardId: d.cardId }, completeMission: false, powers: khan2 ? { khan_2: true } : {}, why: why("drawCard", { territory: d.territory, count: d.coins }) });
    }
  }
  const out = await jev.planEndOfTurn(H(ctx), { drawOptions, missionStatus });
  if ( out?.why ) delete out.why.heuristic;
  return withPending(ctx, out);
}
