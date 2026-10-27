/**
 * Board features the brain computes in code (BOTS.md §5.1 step 2): Red Star race facts, recruit forecasts,
 * continents, borders, HQ danger, enemy HQs in reach and what a conquest would change. Pure functions of a
 * BotContext / BoardState; only public information (BOTS.md §4.2).
 */
import * as rules from "../../rules/_module.mjs";
import { attackOdds, battleOdds, battleSetup, pathOdds } from "./odds.mjs";
import { aliveFactions, opponents } from "./util.mjs";

const RED_STARS_TO_WIN = 4;
const CARDS_PER_STAR = 4;

const clone = v => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Public hand facts for a faction: count and coin total (view first, then the snapshot). */
export function handOf(ctx, fid) {
  const h = ctx.view?.hands?.[fid] ?? ctx.state?.factions?.[fid]?.hand ?? {};
  return { count: h.count ?? 0, coins: h.coins ?? 0 };
}

/** Recruit forecast (board part: territories, population, continents, extras; cards not included). */
export function recruitForecast(state, fid) {
  try { return rules.recruitBreakdown(state, fid, { denied: [] }).total; }
  catch(err) { return 3; }
}

/** Troops a faction could add by trading its whole hand (≤ 10 coins) next turn. */
export function tradePotential(state, fid, coins) {
  const bonus = rules.hasPower(state, fid, "alien_collaborator") ? 1 : 0;
  return rules.troopsForCoins(Math.min(10, Math.max(0, coins) + bonus));
}

/** Shortest path lengths (in steps over neighbours) from a territory. */
export function distancesFrom(state, start) {
  const dist = { [start]: 0 };
  const queue = [start];
  while ( queue.length ) {
    const id = queue.shift();
    for ( const n of state.territories?.[id]?.neighbors ?? [] ) {
      if ( dist[n] !== undefined || !state.territories[n] ) continue;
      dist[n] = dist[id] + 1;
      queue.push(n);
    }
  }
  return dist;
}

/* -------------------------------------------- */
/*  Continents and borders                      */
/* -------------------------------------------- */

/** Per continent, how far a faction is from holding it. */
export function continentStatus(state, fid) {
  const out = {};
  for ( const c of Object.values(state.continents ?? {}) ) {
    const ids = c.territories ?? [];
    const held = ids.filter(id => state.territories[id]?.owner === fid);
    const enemy = ids.filter(id => state.territories[id]?.owner && state.territories[id].owner !== fid);
    const empty = ids.filter(id => !state.territories[id]?.owner);
    const borders = ids.filter(id => (state.territories[id]?.neighbors ?? []).some(n => state.territories[n]?.continent !== c.id));
    out[c.id] = {
      id: c.id, value: Math.max(0, c.value ?? c.bonus ?? 0), size: ids.length, held: held.length,
      missing: [...enemy, ...empty], enemy, empty, complete: held.length === ids.length && ids.length > 0, borders
    };
  }
  return out;
}

/**
 * Border facts for each territory a faction controls.
 * @returns {Record<string, {id, troops, enemies:{id, owner, troops}[], empties:string[], interior:boolean,
 *   maxEnemy:number, enemyTotal:number, hq:boolean}>}
 */
export function borderInfo(state, fid) {
  const out = {};
  for ( const id of state.factions?.[fid]?.territories ?? [] ) {
    const t = state.territories[id];
    const enemies = [];
    const empties = [];
    for ( const n of t.neighbors ?? [] ) {
      const nt = state.territories[n];
      if ( !nt ) continue;
      if ( !nt.owner ) empties.push(n);
      else if ( nt.owner !== fid ) enemies.push({ id: n, owner: nt.owner, troops: nt.troops });
    }
    out[id] = {
      id, troops: t.troops, enemies, empties, interior: !enemies.length && !empties.length,
      maxEnemy: Math.max(0, ...enemies.map(e => e.troops)), enemyTotal: enemies.reduce((n, e) => n + e.troops, 0),
      hq: !!t.hq
    };
  }
  return out;
}

/* -------------------------------------------- */
/*  Threats                                      */
/* -------------------------------------------- */

/**
 * The best chance `enemy` has of conquering `target` on its next turn: its adjacent stacks plus its forecast recruit
 * (all placed on the stack), and (depth 2) a path through one territory it doesn't hold.
 *
 * @param {object} ctx
 * @param {string} enemy
 * @param {string} target
 * @param {object} [opts]  {extra: troops added to the defenders, withCards: include a trade of its hand, depth: 1|2}
 * @returns {{p:number, from:string|null, attackers:number, via:string|null}}
 */
export function threatTo(ctx, enemy, target, opts = {}) {
  const { state, lookup } = ctx;
  const t = state.territories[target];
  if ( !t ) return { p: 0, from: null, attackers: 0, via: null };
  const recruit = recruitForecast(state, enemy) + (opts.withCards ? tradePotential(state, enemy, handOf(ctx, enemy).coins) : 0);
  const D = (t.troops ?? 0) + (opts.extra ?? 0);
  let best = { p: 0, from: null, attackers: 0, via: null };
  const enemyOwned = new Set(state.factions?.[enemy]?.territories ?? []);
  for ( const n of t.neighbors ?? [] ) {
    if ( !enemyOwned.has(n) ) continue;
    const A = (state.territories[n].troops ?? 0) + recruit;
    const r = attackOdds(state, enemy, n, target, { lookup, A, D, activeEvents: ctx.view?.activeEvents?.map(e => e.id) });
    if ( r.pConquer > best.p ) best = { p: r.pConquer, from: n, attackers: A, via: null };
  }
  if ( (opts.depth ?? 1) >= 2 ) {
    for ( const mid of t.neighbors ?? [] ) {
      const mt = state.territories[mid];
      if ( !mt || enemyOwned.has(mid) ) continue;
      for ( const n of mt.neighbors ?? [] ) {
        if ( !enemyOwned.has(n) || n === target ) continue;
        const A = (state.territories[n].troops ?? 0) + recruit;
        if ( A < 4 ) continue;
        const hypo = opts.extra ? withExtraTroops(state, target, opts.extra) : state;
        const r = pathOdds(hypo, enemy, [n, mid, target], { lookup, A0: A });
        if ( r.pReach > best.p ) best = { p: r.pReach, from: n, attackers: A, via: mid };
      }
    }
  }
  return best;
}

/** A copy of the state with extra troops for the owner of a territory (what-if placement). */
export function withExtraTroops(state, id, extra) {
  if ( !extra ) return state;
  const owner = state.territories[id]?.owner;
  if ( !owner ) return state;
  const next = { ...state, territories: { ...state.territories } };
  const t = { ...state.territories[id], pieces: { ...state.territories[id].pieces } };
  t.pieces[owner] = { ...t.pieces[owner], troops: (t.pieces[owner]?.troops ?? 0) + extra };
  t.troops += extra;
  next.territories[id] = t;
  return next;
}

/**
 * Danger to each HQ a faction controls: per opponent, the chance it captures the HQ on its next turn.
 * @returns {{territory, defenders, fortified, own:boolean, threats:{faction, p, from, attackers, via}[], worst:number, worstFaction:string|null}[]}
 */
export function hqDanger(ctx, fid = ctx.me, opts = {}) {
  const { state } = ctx;
  const out = [];
  for ( const id of state.factions?.[fid]?.hqs ?? [] ) {
    const t = state.territories[id];
    const threats = [];
    for ( const o of opponents(state, fid) ) {
      if ( !o.territories?.length ) continue;
      const r = threatTo(ctx, o.id, id, opts);
      if ( r.p > 0.005 ) threats.push({ faction: o.id, ...r });
    }
    threats.sort((a, b) => b.p - a.p);
    out.push({
      territory: id, defenders: t.troops, fortified: !!t.fortified, own: t.hq === fid, threats,
      worst: threats[0]?.p ?? 0, worstFaction: threats[0]?.faction ?? null
    });
  }
  return out;
}

/**
 * Extra defenders a territory needs so that no opponent's capture chance next turn exceeds `targetP`.
 * @returns {number} 0.. `cap`
 */
export function defendersNeeded(ctx, territory, targetP, cap = 30, opts = {}) {
  const { state } = ctx;
  const enemies = opponents(state, ctx.me).filter(o => o.territories?.length);
  const worstAt = extra => Math.max(0, ...enemies.map(o => threatTo(ctx, o.id, territory, { ...opts, extra }).p));
  if ( worstAt(0) <= targetP ) return 0;
  let lo = 0;
  let hi = cap;
  if ( worstAt(cap) > targetP ) return cap;
  while ( hi - lo > 1 ) {
    const mid = (lo + hi) >> 1;
    if ( worstAt(mid) > targetP ) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * The smallest garrison (troops in the territory) that keeps every opponent's capture chance next turn at or below
 * `targetP`, capped at `cap`.
 */
export function garrisonFor(ctx, territory, targetP, cap = 30, opts = {}) {
  const t = ctx.state.territories[territory];
  if ( !t ) return 1;
  const enemies = opponents(ctx.state, ctx.me).filter(o => o.territories?.length);
  const worstWith = troops => Math.max(0, ...enemies.map(o => threatTo(ctx, o.id, territory, { ...opts, extra: troops - t.troops }).p));
  if ( worstWith(1) <= targetP ) return 1;
  if ( worstWith(cap) > targetP ) return cap;
  let lo = 1;
  let hi = cap;
  while ( hi - lo > 1 ) {
    const mid = (lo + hi) >> 1;
    if ( worstWith(mid) > targetP ) lo = mid; else hi = mid;
  }
  return hi;
}

/* -------------------------------------------- */
/*  The Red Star race                            */
/* -------------------------------------------- */

/**
 * Plain facts per faction still in the war, plus a code estimate of how close each is to winning.
 * @returns {{id, name, stars, tokens, hqs:string[], toWin, hand:{count, coins}, buyableNext:number, recruit:number,
 *   troops:number, territories:number, continents:string[], missiles:number, status:string, hqCapture:{p, territory, owner}|null,
 *   closeness:number}[]}
 */
export function standings(ctx) {
  const { state } = ctx;
  const out = [];
  for ( const f of aliveFactions(state) ) {
    const stars = rules.redStarTotal(state, f.id);
    const hand = handOf(ctx, f.id);
    const buyableNext = Math.floor(hand.count / CARDS_PER_STAR);
    out.push({
      id: f.id, name: ctx.view?.factionNames?.[f.id] ?? f.name, stars, tokens: f.redStarTokens ?? 0, hqs: [...(f.hqs ?? [])],
      toWin: Math.max(0, RED_STARS_TO_WIN - stars), hand, buyableNext, recruit: recruitForecast(state, f.id),
      troops: f.troops ?? 0, territories: f.territories?.length ?? 0, continents: [...(f.continents ?? [])],
      missiles: f.missiles ?? 0, status: f.status, hqCapture: null, closeness: 0
    });
  }
  // Best HQ capture chance next turn for each faction (any HQ it doesn't control).
  const hqTerritories = Object.values(state.territories).filter(t => t.hq && t.owner);
  for ( const s of out ) {
    let best = null;
    if ( s.territories ) {
      for ( const t of hqTerritories ) {
        if ( t.owner === s.id ) continue;
        const r = threatTo(ctx, s.id, t.id);
        if ( !best || r.p > best.p ) best = { p: r.p, territory: t.id, owner: t.owner };
      }
    }
    s.hqCapture = best;
    const buy = Math.min(s.buyableNext, s.toWin);
    s.closeness = s.stars + (0.9 * buy) + (0.7 * (best?.p ?? 0)) + (s.recruit / 40);
  }
  out.sort((a, b) => b.closeness - a.closeness);
  return out;
}

/** The faction code thinks is closest to winning, with a rough probability. */
export function codeLeader(list) {
  if ( !list.length ) return { leader: null, p: 0 };
  const w = list.map(s => Math.exp(1.6 * s.closeness));
  const total = w.reduce((a, b) => a + b, 0);
  return { leader: list[0].id, p: w[0] / total };
}

/* -------------------------------------------- */
/*  What a move would change                    */
/* -------------------------------------------- */

/** A hypothetical state where `me` has taken `to` (conquest or expansion) with `moved` troops. */
export function stateAfterTaking(state, me, from, to, moved = 1) {
  const next = { ...state, territories: clone(state.territories), factions: clone(state.factions) };
  const t = next.territories[to];
  for ( const p of Object.values(t.pieces ?? {}) ) p.troops = 0;
  t.pieces[me] ??= { troops: 0, hq: false, tokens: [] };
  t.pieces[me].troops = Math.max(1, moved);
  const f = next.territories[from];
  if ( f?.pieces?.[me] ) f.pieces[me].troops = Math.max(1, f.pieces[me].troops - Math.max(1, moved));
  if ( state.turn ) {
    const log = state.turn.log ?? {};
    const flags = log.flags ?? {};
    next.turn = {
      ...state.turn,
      log: {
        ...log, conquered: (log.conquered ?? 0) + (state.territories[to]?.owner ? 1 : 0),
        flags: {
          ...flags,
          conquests: state.territories[to]?.owner
            ? [...(flags.conquests ?? []), { from, to, defender: state.territories[to].owner, city: !!t.city, seaLine: false }]
            : (flags.conquests ?? [])
        }
      }
    };
  }
  return rules.deriveState(next);
}

/**
 * Facts about taking a territory (conquest or expansion), all computed.
 * @returns {{to, defender, winNow, starsBefore, starsAfter, hq:string|null, retakesOwnHq:boolean,
 *   defenderStarsAfter:number|null, knockOut:boolean, cardsGained:number, completes:string[], breaks:{continent, faction}[],
 *   recruitDelta:number, defenderRecruitDelta:number, earnsCard:boolean, population:number, completesMission:boolean,
 *   missionProgress:boolean, exposure:number}}
 */
export function takeEffects(ctx, from, to, { moved = 1, who = ctx.me, state = ctx.state } = {}) {
  const me = who;
  const t = state.territories[to];
  const defender = t.owner && t.owner !== me ? t.owner : null;
  const next = stateAfterTaking(state, me, from, to, moved);
  const starsBefore = rules.redStarTotal(state, me);
  const starsAfter = rules.redStarTotal(next, me);
  const meBefore = state.factions[me];
  const meAfter = next.factions[me];
  const completes = (meAfter?.continents ?? []).filter(c => !(meBefore?.continents ?? []).includes(c));
  const breaks = [];
  for ( const o of opponents(state, me) ) {
    for ( const c of o.continents ?? [] ) {
      if ( !(next.factions[o.id]?.continents ?? []).includes(c) ) breaks.push({ continent: c, faction: o.id });
    }
  }
  const knockOut = !!defender && !(next.factions[defender]?.territories?.length);
  const log = state.turn?.log ?? {};
  const ownTurn = state.turn?.faction === me;
  const eligible = ownTurn ? rules.resourceDrawEligibility(state, me).ok : false;
  const earnsCard = !!defender && ownTurn && !eligible && !log.cardDrawn && !log.missionCompleted;
  const status = me === ctx.me ? (ctx.view?.missionStatus ?? null) : null;
  let completesMission = false;
  let missionProgress = false;
  const check = status?.check ?? null;
  if ( check?.type && status?.status !== "complete" ) {
    const before = rules.missionCheck(state, me, check);
    const after = rules.missionCheck(next, me, check);
    completesMission = before === false && after === true;
    missionProgress = completesMission || (["conquerThisTurn", "conquerContinentThisTurn"].includes(check.type) && !!defender)
      || (["controlTerritoriesWithCities", "controlAllCities"].includes(check.type) && !!t.city);
  }
  // Exposure: the strongest enemy stack next to the new territory (other than the defender's troops just beaten).
  const exposure = Math.max(0, ...(t.neighbors ?? []).map(n => next.territories[n])
    .filter(nt => nt?.owner && nt.owner !== me).map(nt => nt.troops));
  return {
    to, defender, winNow: starsAfter >= RED_STARS_TO_WIN && starsBefore < RED_STARS_TO_WIN, starsBefore, starsAfter,
    hq: t.hq ?? null, retakesOwnHq: t.hq === me,
    defenderStarsAfter: defender ? rules.redStarTotal(next, defender) : null,
    hqOwnerStarsAfter: (t.hq && t.hq !== me && t.owner && t.owner !== me) ? rules.redStarTotal(next, t.owner) : null,
    knockOut, cardsGained: knockOut ? handOf(ctx, defender).count : 0,
    completes, breaks,
    recruitDelta: recruitForecast(next, me) - recruitForecast(state, me),
    defenderRecruitDelta: defender ? recruitForecast(next, defender) - recruitForecast(state, defender) : 0,
    earnsCard, population: t.population ?? 0, completesMission, missionProgress, exposure
  };
}

/** Battle setup re-export for callers that only need sources. */
export { battleSetup, battleOdds };
