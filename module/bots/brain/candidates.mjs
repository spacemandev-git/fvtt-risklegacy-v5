/**
 * Legal candidates with code pre-scores (BOTS.md §5.1 step 1): attack/expand plans (1 step, or 2–3-step chains for
 * the hard bot), placement fronts, maneuvers and starting territories. Utilities are in troop-equivalents.
 */
import * as rules from "../../rules/_module.mjs";
import { attackOdds, battleOdds, pathOdds } from "./odds.mjs";
import {
  borderInfo, continentStatus, distancesFrom, handOf, stateAfterTaking, takeEffects, threatTo, withExtraTroops
} from "./features.mjs";
import { gainOf } from "./profiles.mjs";
import { clamp, opponents } from "./util.mjs";

/* -------------------------------------------- */
/*  Code value of taking a territory            */
/* -------------------------------------------- */

/**
 * The code's own value level (0..4, the VALUE_LEVELS scale) for taking a territory, from computed facts. Used as the
 * neutral judgment in heuristic mode and to pre-rank candidates before asking Jev.
 * @param {object} ctx
 * @param {object} fx         takeEffects()
 * @param {object} [situation]
 */
export function codeValueLevel(ctx, fx, situation = null) {
  const leader = situation?.leader ?? null;
  const starsOf = fid => rules.redStarTotal(ctx.state, fid);
  let v = 0.4;
  if ( fx.earnsCard ) v = Math.max(v, 1.2);
  if ( fx.recruitDelta > 0 ) v += Math.min(0.6, 0.3 * fx.recruitDelta);
  if ( fx.population ) v += Math.min(0.6, 0.2 * fx.population);
  if ( fx.missionProgress ) v += 0.4;
  if ( fx.defender && (fx.defender === leader) ) v += 0.3;
  if ( fx.breaks.length ) v = Math.max(v, 2 + (fx.breaks.some(b => b.faction === leader) ? 0.4 : 0));
  if ( fx.completes.length ) {
    const bonus = fx.completes.reduce((n, c) => n + (ctx.state.continents[c]?.value ?? 0), 0);
    v = Math.max(v, 2 + Math.min(0.8, bonus / 8));
  }
  if ( fx.hq ) v = Math.max(v, 3 + ((fx.defender && fx.defender === leader) ? 0.3 : 0));
  if ( fx.knockOut ) v = Math.max(v, 3 + Math.min(0.5, fx.cardsGained / 8));
  if ( fx.completesMission ) v = Math.max(v, 3);
  if ( fx.defender && fx.hq && starsOf(fx.defender) >= 3 ) v = Math.max(v, 3.8);   // stops a rival about to win
  if ( fx.defender && (starsOf(fx.defender) >= 3) && fx.breaks.length ) v = Math.max(v, 3.2);
  if ( fx.winNow ) v = 4;
  return clamp(v, 0, 4);
}

/** Tags that summarise a take (for `why` reasons and the memo key). */
export function tagsOf(fx) {
  const t = [];
  if ( fx.winNow ) t.push("winNow");
  if ( fx.hq ) t.push("hq");
  if ( fx.knockOut ) t.push("knockOut");
  if ( fx.completes.length ) t.push(`completes:${fx.completes.join("+")}`);
  if ( fx.breaks.length ) t.push(`breaks:${fx.breaks.map(b => b.continent).join("+")}`);
  if ( fx.completesMission ) t.push("mission");
  // Not the card: whether this conquest earns the turn's card depends on the order of moves, not on the target.
  return t.join(",");
}

/** The `why` reason for taking a territory with these facts (BOTS.md §5.3). */
export function reasonOf(fx, situation = null) {
  if ( fx.winNow ) return "winNow";
  if ( fx.hq ) return "hqCapture";
  if ( fx.knockOut ) return "knockOut";
  if ( fx.completesMission ) return "missionProgress";
  if ( fx.completes.length ) return "completeContinent";
  if ( fx.breaks.length ) return "breakContinent";
  if ( fx.defender && situation?.leader && fx.defender === situation.leader && situation.leader !== undefined ) return "weakenLeader";
  if ( fx.earnsCard ) return "cardConquest";
  if ( fx.missionProgress ) return "missionProgress";
  if ( !fx.defender ) return "expand";
  return "opportunity";
}

/* -------------------------------------------- */
/*  Attack / expand plans                       */
/* -------------------------------------------- */

/**
 * Every legal attack and expansion this turn, plus (hard) chains of 2–3 steps toward an HQ, a continent or a
 * knock-out. Each plan's first step is the move to make now.
 *
 * @param {object} ctx
 * @param {object} profile
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.extra]     troops added per territory (placement what-if)
 * @param {Record<string, number>} [opts.keep]      troops to keep per territory (HQ garrison), default 1
 * @param {boolean} [opts.ignoreTurn]               legality without the turn gate (placement planning)
 * @param {object} [opts.situation]
 * @returns {object[]} plans {kind, from, to, path, end, dice, count, P, eLoss, fx, endFx, codeLevel, utility}
 */
export function movePlans(ctx, profile, opts = {}) {
  const { me, lookup } = ctx;
  const extra = opts.extra ?? {};
  const state = Object.keys(extra).length
    ? Object.entries(extra).reduce((s, [id, n]) => withExtraTroops(s, id, n), ctx.state) : ctx.state;
  const keep = opts.keep ?? {};
  const excluded = ctx.excluded ?? new Set();
  const protectedIds = state.turn?.log?.protected ?? [];
  const activeEvents = ctx.view?.activeEvents?.map(e => e.id);
  const sctx = state === ctx.state ? ctx : { ...ctx, state };
  const plans = [];
  const owned = state.factions?.[me]?.territories ?? [];
  const ignoreTurn = !!opts.ignoreTurn;

  const only = opts.from ? new Set([].concat(opts.from)) : null;
  for ( const from of owned ) {
    if ( only && !only.has(from) ) continue;
    const A = state.territories[from].troops;
    const k = Math.max(1, keep[from] ?? 1);
    if ( A - k < 1 ) continue;
    for ( const to of state.territories[from].neighbors ?? [] ) {
      const t = state.territories[to];
      if ( !t || t.owner === me ) continue;
      if ( t.owner ) {
        if ( protectedIds.includes(to) || excluded.has(`attack:${from}>${to}`) || A < 2 ) continue;
        const dice = Math.min(3, A - 1);
        if ( !rules.checkAttack(state, me, from, to, dice, { ignoreTurn }).ok ) continue;
        const odds = attackOdds(state, me, from, to, { lookup, activeEvents, stopAt: k });
        const fx = takeEffects(sctx, from, to, { moved: Math.max(1, Math.min(3, A - 1)) });
        plans.push({
          kind: "attack", from, to, path: [from, to], end: to, dice, P: odds.pConquer, eLoss: odds.eAttackerLosses,
          left: odds.leftOnConquest, fx, endFx: fx, defender: t.owner
        });
      }
      else {
        if ( excluded.has(`expand:${from}>${to}`) ) continue;
        const { cost } = rules.expandCost(state, me, to, A - k);
        const count = cost + 1;
        if ( count > A - k ) continue;
        if ( !rules.checkExpand(state, me, from, to, count, { ignoreTurn }).ok ) continue;
        const fx = takeEffects(sctx, from, to, { moved: 1 });
        plans.push({
          kind: "expand", from, to, path: [from, to], end: to, count, cost, P: 1, eLoss: cost, left: A - count,
          fx, endFx: fx, defender: null
        });
      }
    }
  }
  if ( profile.chains && (opts.chains ?? true) ) plans.push(...chainPlans(sctx, profile, { keep, ignoreTurn, activeEvents, excluded, protectedIds, only }));
  for ( const p of plans ) scorePlan(ctx, profile, p, opts.situation);
  plans.sort((a, b) => b.utility - a.utility);
  return plans;
}

/**
 * The resource card the turn's first conquest earns, in troop-equivalents (profile `attack.cardValue`). A code-known
 * reward kept apart from Jev's value judgment: 4 cards buy a Red Star, so a card is worth about a quarter of what an
 * HQ is. Without it the normal bot turtled: Jev rates a plain conquest "a small edge", which never paid for the
 * expected losses, so it went turns without a conquest, a card or a star.
 */
export function cardValueOf(profile, plan) {
  return plan.endFx?.earnsCard ? (profile.attack.cardValue ?? 0) : 0;
}

/** Code pre-score of a plan (troop-equivalents), using the code value level. */
export function scorePlan(ctx, profile, plan, situation, level = null) {
  plan.codeLevel ??= codeValueLevel(ctx, plan.endFx, situation);
  const lv = level ?? plan.codeLevel;
  const gain = gainOf(profile, lv);
  // A territory taken next to a big enemy stack will likely be lost again (and hand them a card).
  const moved = plan.kind === "expand" ? 1 : Math.max(1, Math.min(3, (plan.left ?? 2) - 1));
  const exposure = plan.endFx.exposure > moved + 1 && lv < 3 ? Math.min(2, 0.12 * (plan.endFx.exposure - moved)) : 0;
  const thin = plan.kind === "expand" ? 0.3 : 0;
  // A one-troop expansion next to an enemy stack is a free conquest, and a resource card, for that rival: about what a
  // small edge is worth to us, so only expansions worth more than that (or safe ones) go ahead. The easy bot ignores it.
  const gift = (plan.kind === "expand") && profile.expand.giftCost && (lv < 3) && (plan.endFx.exposure >= moved + 2) ? gainOf(profile, 1) : 0;
  plan.utility = (plan.P * (gain + cardValueOf(profile, plan))) - (profile.attack.lossWeight * plan.eLoss) - Math.max(exposure, gift) - thin;
  return plan.utility;
}

/** Hard bot: 2–3-step paths from strong stacks to a valuable end. */
function chainPlans(ctx, profile, { keep, ignoreTurn, activeEvents, excluded, protectedIds, only }) {
  const { state, me, lookup } = ctx;
  const out = [];
  const depth = profile.chainDepth ?? 3;
  const owned = new Set(state.factions?.[me]?.territories ?? []);
  const sources = [...owned].filter(id => (!only || only.has(id)) && (state.territories[id].troops - Math.max(1, keep[id] ?? 1) >= 4));
  sources.sort((a, b) => state.territories[b].troops - state.territories[a].troops);
  const valuableEnd = (path) => {
    const end = state.territories[path.at(-1)];
    if ( end.hq && end.owner !== me ) return true;
    // completes a continent: every other territory of it is owned or on the path
    const c = state.continents[end.continent];
    if ( c && c.territories.every(id => owned.has(id) || path.includes(id)) ) return true;
    // knocks a faction out: all of its territories are on the path
    if ( end.owner ) {
      const theirs = state.factions[end.owner]?.territories ?? [];
      if ( theirs.length && theirs.every(id => path.includes(id)) ) return true;
    }
    return false;
  };
  for ( const from of sources.slice(0, 4) ) {
    const A0 = state.territories[from].troops - Math.max(1, keep[from] ?? 1) + 1;
    const paths = [];
    const walk = (path) => {
      if ( path.length >= 3 && valuableEnd(path) ) paths.push(path.slice());
      if ( path.length >= depth + 1 ) return;
      for ( const n of state.territories[path.at(-1)].neighbors ?? [] ) {
        if ( owned.has(n) || path.includes(n) ) continue;
        if ( state.territories[n].owner && protectedIds.includes(n) ) continue;
        path.push(n);
        walk(path);
        path.pop();
      }
    };
    for ( const f of state.territories[from].neighbors ?? [] ) {
      if ( owned.has(f) ) continue;
      const key = state.territories[f].owner ? `attack:${from}>${f}` : `expand:${from}>${f}`;
      if ( excluded.has(key) || (state.territories[f].owner && protectedIds.includes(f)) ) continue;
      walk([from, f]);
    }
    for ( const path of paths ) {
      const r = pathOdds(state, me, path, { lookup, activeEvents, A0, stopAt: 1 });
      if ( r.pReach < 0.05 ) continue;
      // The end's facts once the intermediate steps are taken.
      let s = state;
      for ( let i = 1; i < path.length - 1; i++ ) s = stateAfterTaking(s, me, path[i - 1], path[i], 1);
      const endFx = takeEffects(ctx, path.at(-2), path.at(-1), { state: s, moved: 1 });
      const fx = takeEffects(ctx, from, path[1], { moved: 1 });
      const first = state.territories[path[1]];
      const committed = A0 - 1;
      const remaining = (r.pReach * (r.expectedTroops + (path.length - 2))) + ((1 - r.pReach) * Math.max(1, committed * 0.3));
      const plan = {
        kind: first.owner ? "attack" : "expand", from, to: path[1], path, end: path.at(-1), chain: true,
        dice: Math.min(3, state.territories[from].troops - 1), P: r.pReach, eLoss: Math.max(0, committed - remaining),
        left: r.expectedTroops, fx, endFx, defender: first.owner ?? null
      };
      if ( plan.kind === "expand" ) {
        // A chain carries the whole committed stack forward (moveIn keeps pressing along the path afterwards).
        plan.cost = rules.expandCost(state, me, path[1], committed).cost;
        plan.count = committed;
        if ( !rules.checkExpand(state, me, from, path[1], plan.count, { ignoreTurn }).ok ) continue;
      }
      else if ( !rules.checkAttack(state, me, from, path[1], plan.dice, { ignoreTurn }).ok ) continue;
      out.push(plan);
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Fronts (placement, maneuver)                */
/* -------------------------------------------- */

/**
 * Own territories that touch enemies or empty land, with their danger (code) and what is at stake if lost.
 * @returns {{id, troops, hq:boolean, enemies, empties, threat:{p, faction, from, attackers}, loses:{hq:boolean, continents:string[]}, needScore:number}[]}
 */
export function frontsOf(ctx, opts = {}) {
  const { state, me } = ctx;
  const borders = borderInfo(state, me);
  const out = [];
  for ( const b of Object.values(borders) ) {
    if ( b.interior && !b.hq ) continue;
    let threat = { p: 0, faction: null, from: null, attackers: 0 };
    for ( const o of opponents(state, me) ) {
      if ( !b.enemies.some(e => e.owner === o.id) ) continue;
      const r = threatTo(ctx, o.id, b.id, { withCards: opts.withCards });
      if ( r.p > threat.p ) threat = { ...r, faction: o.id };
    }
    const t = state.territories[b.id];
    const continents = (state.factions[me].continents ?? []).filter(c => state.continents[c]?.territories.includes(b.id));
    const loses = { hq: !!t.hq, continents };
    const stake = (t.hq ? 3 : 0) + continents.reduce((n, c) => n + (state.continents[c]?.value ?? 0) / 3, 0) + (t.population ?? 0) * 0.3;
    out.push({ ...b, threat, loses, needScore: threat.p * (1 + stake) });
  }
  return out.sort((a, b) => b.needScore - a.needScore);
}

/* -------------------------------------------- */
/*  Starting territories                        */
/* -------------------------------------------- */

/**
 * Code pre-score and facts for each legal starting / Join-the-War territory.
 * @returns {{id, pre:number, facts:object}[]} best first
 */
export function startCandidates(ctx, legal, joining = false) {
  const { state, me } = ctx;
  const hqs = Object.values(state.territories).filter(t => t.hq && t.hq !== me).map(t => t.id);
  const conts = continentStatus(state, me);
  const out = [];
  for ( const id of legal ) {
    const t = state.territories[id];
    if ( !t ) continue;
    const dist = distancesFrom(state, id);
    const near = Object.entries(dist).filter(([, d]) => d > 0 && d <= 2).map(([n]) => state.territories[n]);
    const room = near.filter(n => !n.owner && !n.hq).length;
    const emptyAdj = (t.neighbors ?? []).filter(n => !state.territories[n]?.owner && !state.territories[n]?.hq).length;
    const hqDist = hqs.length ? Math.min(...hqs.map(h => dist[h] ?? 9)) : 9;
    const enemyNear = near.filter(n => n.owner && n.owner !== me).reduce((s, n) => s + n.troops, 0);
    const maxAdjEnemy = Math.max(0, ...(t.neighbors ?? []).map(n => state.territories[n]).filter(n => n?.owner && n.owner !== me).map(n => n.troops));
    const c = conts[t.continent];
    const free = c ? c.empty.length / Math.max(1, c.size) : 0;
    const contScore = c ? (c.value / Math.max(1, c.borders.length)) * free : 0;
    const cityNear = near.reduce((s, n) => s + (n.population ?? 0), 0) + (t.population ?? 0);
    // Other continents it touches: a crossroads can be attacked from several directions and is hard to hold.
    const foreign = [...new Set((t.neighbors ?? []).map(n => state.territories[n]?.continent).filter(c => c && c !== t.continent))];
    let pre = (0.3 * room) + (0.6 * emptyAdj) + (1.2 * Math.min(hqDist, 4)) + (2 * contScore) - (0.25 * enemyNear) + (0.3 * cityNear)
      - (0.8 * foreign.length);
    let weakHq = null;
    let danger = null;
    let hqChance = 0;
    if ( joining ) {
      // Rejoining puts 4 troops here: the chance an enemy takes them next turn, and the chance to take a weak HQ next door.
      const troops = rules.joinWarTroops();
      danger = { p: 0, faction: null };
      for ( const o of opponents(state, me) ) {
        if ( !o.territories?.length ) continue;
        const r = threatTo(ctx, o.id, id, { extra: troops, depth: 2 });
        if ( r.p > danger.p ) danger = { p: r.p, faction: o.id };
      }
      const recruit = 3;
      for ( const n of t.neighbors ?? [] ) {
        const nt = state.territories[n];
        if ( nt?.hq && nt.owner && nt.owner !== me && nt.troops <= 4 ) {
          const p = battleOdds({ A: troops + recruit, D: nt.troops }).pConquer;
          if ( p > hqChance ) { hqChance = p; weakHq = n; }
        }
      }
      pre += (6 * hqChance) - (6 * danger.p);
    }
    out.push({
      id, pre,
      facts: { room, emptyAdj, hqDist: hqs.length ? hqDist : null, enemyNear, maxAdjEnemy, continent: t.continent, contScore, cityNear, foreign, weakHq, danger, hqChance }
    });
  }
  return out.sort((a, b) => b.pre - a.pre);
}

/* -------------------------------------------- */
/*  Card maths                                  */
/* -------------------------------------------- */

/**
 * The best set of cards to trade for troops (coin total ≤ 10, alien_collaborator +1).
 * @param {{id, coins}[]} hand
 * @returns {{ids:string[], coins:number, troops:number}|null}
 */
export function bestTrade(state, me, hand) {
  const cards = hand.slice(0, 14);
  const bonus = rules.hasPower(state, me, "alien_collaborator") ? 1 : 0;
  let best = null;
  const n = cards.length;
  for ( let mask = 1; mask < (1 << n); mask++ ) {
    let coins = 0;
    let count = 0;
    for ( let i = 0; i < n; i++ ) if ( mask & (1 << i) ) { coins += cards[i].coins ?? 1; count++; }
    if ( coins > 10 ) continue;
    const troops = rules.troopsForCoins(Math.min(10, coins + bonus));
    if ( !troops ) continue;
    if ( !best || troops > best.troops || (troops === best.troops && (count < best.count || (count === best.count && coins < best.coins))) ) {
      best = { mask, coins, troops, count };
    }
  }
  if ( !best ) return null;
  return { ids: cards.filter((_, i) => best.mask & (1 << i)).map(c => c.id), coins: best.coins, troops: best.troops };
}

/** The 4 cards to spend on a Red Star (lowest coins first, keeping the valuable ones for trades). */
export function starCards(hand) {
  return [...hand].sort((a, b) => (a.coins ?? 1) - (b.coins ?? 1)).slice(0, 4).map(c => c.id);
}

/** Total coins in a hand. */
export const coinsOf = hand => hand.reduce((n, c) => n + (c.coins ?? 1), 0);

export { handOf };
