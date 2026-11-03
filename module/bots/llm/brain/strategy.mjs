/**
 * Warlord staff work (BOTS-LLM.md §11): code-side strategy for the chat Warlord, so that the model chooses between
 * options that code has already valued, and can't pick a clearly bad one.
 *  - the Red Star race: each rival's chance to win on its next turn (cards that buy the last stars, or the HQ capture
 *    that brings the last star), and how each option changes it;
 *  - the HQ risk of attacking out of the HQ (the Jev Warlord's penalty, which the chat menus lacked);
 *  - a net value per option (troop-equivalents: the shared code pre-score − HQ risk + the race swing);
 *  - the safe conquest that earns the turn's resource card.
 * Pure: no Foundry globals. Public information only (hand counts and coins are public, BOTS.md §4.2).
 */
import * as rules from "../../../rules/_module.mjs";
import { handOf, stateAfterTaking, threatTo } from "../../brain/features.mjs";
import { gainOf } from "../../brain/profiles.mjs";
import { factionName, opponents, territoryName } from "../../brain/util.mjs";

const STARS_TO_WIN = 4;
const CARDS_PER_STAR = 4;
const possessive = n => (/s$/i.test(n) ? `${n}'` : `${n}'s`);

/** Rival win chances under this are not worth a fact or a menu swing. */
export const RACE_MIN = 0.1;
/** A rival this likely to win next turn makes stopping it the turn's first job (sanity layer). */
export const RACE_ALARM = 0.5;
/** A swing in a rival's win chance at least this big counts as "stops it". */
export const STOP_MIN = 0.15;
/** HQ danger (capture chance next turn) that triggers the placement / maneuver guard, and the level it aims for. */
export const HQ_ALARM = 0.45;
export const HQ_SAFE = 0.3;
/** The safe card conquest: odds and expected losses. */
export const CARD_MIN_P = 0.75;
export const CARD_MAX_LOSS = 2;

/**
 * The chance a faction wins on its next turn, from this state.
 *  - "cards": its hand buys the Red Stars it lacks (certain, unless it is knocked out first and loses the cards);
 *  - "hq": one more star from capturing an HQ (the best capture chance next turn, its recruits and, when it can't
 *    buy a star, a trade of its hand included); two stars short needs two captures (a rough product).
 * @returns {{p:number, how:"won"|"cards"|"hq"|null, stars:number, buy:number, need:number, best:object|null}}
 */
export function winChanceNextTurn(ctx, fid, state = ctx.state) {
  const f = state.factions?.[fid];
  const none = { p: 0, how: null, stars: 0, buy: 0, need: STARS_TO_WIN, best: null };
  if ( !f || !(f.territories?.length) ) return none;
  const stars = rules.redStarTotal(state, fid);
  if ( stars >= STARS_TO_WIN ) return { ...none, p: 1, how: "won", stars, need: 0 };
  const buy = Math.floor(handOf(ctx, fid).count / CARDS_PER_STAR);
  if ( stars + buy >= STARS_TO_WIN ) return { ...none, p: 1, how: "cards", stars, buy, need: 0 };
  const need = STARS_TO_WIN - stars - buy;
  if ( need > 2 ) return { ...none, stars, buy, need };
  const sctx = state === ctx.state ? ctx : { ...ctx, state };
  const hits = [];
  for ( const t of Object.values(state.territories ?? {}) ) {
    if ( !t.hq || !t.owner || t.owner === fid ) continue;
    const r = threatTo(sctx, fid, t.id, { withCards: buy === 0, depth: 2 });
    if ( r.p > 0.005 ) hits.push({ p: r.p, target: t.id, owner: t.owner, from: r.from, via: r.via, attackers: r.attackers });
  }
  hits.sort((a, b) => b.p - a.p);
  const p = need === 1 ? (hits[0]?.p ?? 0) : ((hits[0]?.p ?? 0) * (hits[1]?.p ?? 0) * 0.5);
  return { p, how: p > 0 ? "hq" : null, stars, buy, need, best: hits[0] ?? null };
}

/** Rivals with a real chance to win on their next turn, likeliest first. */
export function raceThreats(ctx, state = ctx.state) {
  return opponents(state, ctx.me)
    .map(o => ({ fid: o.id, ...winChanceNextTurn(ctx, o.id, state) }))
    .filter(r => r.p >= RACE_MIN)
    .sort((a, b) => b.p - a.p);
}

/**
 * The board after a plan succeeds: every hop of its path taken, the end held by the troops that would move in, the
 * source thinned by the expected losses.
 */
export function stateAfterPlan(ctx, plan) {
  const { me } = ctx;
  const path = plan.path ?? [plan.from, plan.to];
  let s = ctx.state;
  const left = Math.max(2, Math.round(plan.left ?? 2));
  for ( let i = 1; i < path.length; i++ ) {
    const last = i === path.length - 1;
    let moved;
    if ( plan.chain ) moved = last ? Math.max(1, left - 1) : 1;
    else if ( plan.kind === "expand" ) moved = Math.max(1, (plan.count ?? 1) - (plan.cost ?? 0));
    else moved = Math.max(1, Math.min(3, left - 1));
    s = stateAfterTaking(s, me, path[i - 1], path[i], moved);
  }
  if ( !plan.chain && plan.kind === "attack" ) {
    // The source also lost the expected attackers.
    const src = s.territories[plan.from]?.pieces?.[me];
    if ( src ) {
      src.troops = Math.max(1, src.troops - Math.round(plan.eLoss ?? 0));
      rules.deriveState(s);
    }
  }
  return s;
}

/** The worst capture chance next turn of a territory the bot holds, with `extra` defenders (may be negative). */
export function worstThreat(ctx, id, extra = 0, { depth = 1 } = {}) {
  const enemies = opponents(ctx.state, ctx.me).filter(o => o.territories?.length);
  let best = { p: 0, faction: null };
  for ( const o of enemies ) {
    const r = threatTo(ctx, o.id, id, { extra, withCards: true, depth });
    if ( r.p > best.p ) best = { p: r.p, faction: o.id, attackers: r.attackers };
  }
  return best;
}

/**
 * HQ risk of a plan that attacks out of one of the bot's HQs (the Jev Warlord's hqRiskOf, BOTS.md §5.4): the HQ's
 * capture chance next turn before and after, given the troops the attack is expected to leave there.
 * @returns {{id:string, before:number, after:number}|null}
 */
export function hqExposure(ctx, plan, cache = new Map()) {
  const { state, me } = ctx;
  const from = state.territories[plan.from];
  if ( !from?.hq || from.owner !== me || plan.endFx?.winNow ) return null;
  const A = from.troops;
  const left = Math.max(1, Math.round(plan.left ?? A));
  const afterWin = plan.chain ? 1 : Math.max(1, left - Math.min(3, left - 1));
  const afterFail = Math.max(1, Math.round(A - (plan.eLoss ?? 0)));
  const after = Math.round((plan.P * afterWin) + ((1 - plan.P) * afterFail));
  const at = extra => {
    const k = `${plan.from}|${extra}`;
    if ( !cache.has(k) ) cache.set(k, worstThreat(ctx, plan.from, extra).p);
    return cache.get(k);
  };
  return { id: plan.from, before: at(0), after: after >= A ? at(0) : at(after - A) };
}

/**
 * Value every plan for the Warlord menu, in place: `plan.staff = {value, hq, race:[{fid, name, before, after}], big}`.
 * value = the shared code pre-score (odds × gain + the turn's card − losses − exposure)
 *       − HQ risk (rise in the HQ's capture chance × what an HQ is worth)
 *       + P × (fall in each threatening rival's chance to win next turn) × what stopping a win is worth.
 * @param {object} ctx
 * @param {object} jp       the Jev profile ranking this level (gain table)
 * @param {object[]} plans  from movePlans (already scored)
 * @param {object} [o]      {threats: raceThreats(ctx) (computed when absent)}
 */
export function assessPlans(ctx, jp, plans, { threats = null } = {}) {
  const { state } = ctx;
  threats ??= raceThreats(ctx);
  const rivalsOnThree = opponents(state, ctx.me).some(o => rules.redStarTotal(state, o.id) >= 3);
  const hqStake = gainOf(jp, rivalsOnThree ? 4 : 3);
  const winStake = gainOf(jp, 3.5);
  const cache = new Map();
  const watch = threats.filter(t => t.p >= RACE_MIN && t.how !== "won").slice(0, 2);
  for ( const plan of plans ) {
    const hq = hqExposure(ctx, plan, cache);
    const race = [];
    if ( watch.length ) {
      let after = null;
      for ( const t of watch ) {
        after ??= stateAfterPlan(ctx, plan);
        const p = winChanceNextTurn(ctx, t.fid, after).p;
        if ( Math.abs(t.p - p) >= 0.05 ) race.push({ fid: t.fid, name: factionName(ctx, t.fid), before: t.p, after: p });
      }
    }
    const hqCost = hq ? Math.max(0, hq.after - hq.before) * hqStake : 0;
    const raceGain = race.reduce((n, r) => n + (plan.P * (r.before - r.after) * winStake), 0);
    const value = (plan.utility ?? 0) - hqCost + raceGain;
    const stops = race.some(r => plan.P * (r.before - r.after) >= STOP_MIN * 0.5 && r.before - r.after >= STOP_MIN);
    const big = stops || (plan.codeLevel ?? 0) >= 3 || !!plan.endFx?.hq || !!plan.endFx?.knockOut;
    plan.staff = { value, hq: hq && (hq.after - hq.before >= 0.03) ? hq : null, race, stops, big };
  }
  return plans;
}

/**
 * Race facts for the prompt (Warlord): one line per rival that may win on its next turn, with what stops it.
 * @returns {string[]}
 */
export function raceLines(ctx, threats = raceThreats(ctx)) {
  const { state } = ctx;
  const out = [];
  for ( const t of threats.slice(0, 3) ) {
    const name = factionName(ctx, t.fid);
    const pctText = `${Math.round(t.p * 100)}%`;
    if ( t.how === "cards" ) {
      out.push(`${name} can buy the Red Stars it lacks with its cards and win on its next turn: only knocking it out this turn stops that (you would take its cards).`);
    }
    else if ( t.how === "hq" && t.best ) {
      const target = state.territories[t.best.target];
      const owner = t.best.owner === ctx.me ? "your" : possessive(factionName(ctx, t.best.owner));
      const hqName = `${owner} ${target?.hq === t.best.owner ? "HQ" : "captured HQ"} in ${territoryName(state, t.best.target)}`;
      const via = t.best.via ? ` through ${territoryName(state, t.best.via)}` : "";
      const need = t.need === 1 ? "one Red Star short" : "two Red Stars short";
      out.push(`${name} is ${need} and could win on its next turn (${pctText}): its best shot is ${hqName}, from ${territoryName(state, t.best.from)}${via} with about ${t.best.attackers} troops. Hitting that stack, taking a star from it, or reinforcing the target lowers it.`);
    }
  }
  return out;
}

/**
 * The safe conquest that earns the turn's resource card (Warlord sanity layer): no conquest yet this turn, high odds,
 * low expected losses, positive value, not out of an HQ it would endanger.
 * @param {object[]} plans  assessed plans (legalPlans + assessPlans)
 * @returns {object|null}
 */
export function cardConquest(ctx, plans) {
  if ( (ctx.state.turn?.log?.conquered ?? 0) > 0 ) return null;
  return plans.filter(p => p.kind === "attack" && !p.chain && p.endFx?.earnsCard && p.P >= CARD_MIN_P
    && (p.eLoss ?? 0) <= CARD_MAX_LOSS && (p.staff?.value ?? p.utility ?? 0) > 0 && !p.staff?.hq)
    .sort((a, b) => (b.staff?.value ?? b.utility) - (a.staff?.value ?? a.utility))[0] ?? null;
}
