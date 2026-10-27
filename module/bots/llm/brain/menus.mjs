/**
 * Menus: the legal options for each decision, built from the shared candidate code (brain/candidates.mjs,
 * features.mjs, odds.mjs) with every fact computed (BOTS-LLM.md §6.1, §6.4). Keys are descriptive slugs. Levels trim
 * the menus (§6.3) and the personality's knobs shift them (§5.2): `risk` the odds floor, `aggression` the number of
 * attacks offered, `patience` the smallest card trade offered, `vengeance` the "attacked you" fact.
 */
import * as rules from "../../../rules/_module.mjs";
import { DECISIVE } from "../../jev/questions.mjs";
import {
  bestTrade, codeValueLevel, coinsOf, frontsOf, movePlans, scorePlan, startCandidates, starCards
} from "../../brain/candidates.mjs";
import { takeFacts } from "../../brain/context.mjs";
import { threatTo } from "../../brain/features.mjs";
import { attackOdds } from "../../brain/odds.mjs";
import { PROFILES } from "../../brain/profiles.mjs";
import { continentName, factionName, opponents, slug, territoryName } from "../../brain/util.mjs";
import { FACTS } from "../prompts.mjs";
import { menuSize, minTradeTroops, oddsFloor, DECISIVE_MIN_CHANCE } from "../profiles.mjs";
import { attackersOfMe } from "./facts.mjs";

/** The Jev profile whose code pre-scores rank this level's candidates. */
export const jevProfileOf = profile => PROFILES[profile.jev] ?? PROFILES.normal;

/** Troops always left in each HQ the bot holds (the level's floor; empty when 1). */
export function hqKeep(ctx, profile) {
  if ( (profile.hqFloor ?? 1) <= 1 ) return {};
  return Object.fromEntries((ctx.state.factions[ctx.me]?.hqs ?? []).map(id => [id, profile.hqFloor]));
}

/** Unique keys: suffix _2, _3 on clashes. */
function uniqueKey(seen, base) {
  let k = base;
  for ( let n = 2; seen.has(k); n++ ) k = `${base}_${n}`;
  seen.add(k);
  return k;
}

/** Seeded shuffle (easy menus aren't shown best-first). */
function shuffle(xs, random) {
  const a = [...xs];
  for ( let i = a.length - 1; i > 0; i-- ) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Is a take decisive (code's call, as for the Jev brain): it wins the war, or takes the HQ of a rival on 3 Red Stars. */
export function isDecisive(ctx, fx, sit) {
  return !!fx.winNow || (codeValueLevel(ctx, fx, sit) >= DECISIVE.fromCode);
}

/* -------------------------------------------- */
/*  Attacks and expansions                      */
/* -------------------------------------------- */

/**
 * Plans the bot could start now, with the level's HQ floor kept back, filtered like the Jev brain's (expansion caps,
 * no thin expansions off a front line). Sorted by code utility.
 */
export function legalPlans(ctx, profile, sit, { chains = profile.chains } = {}) {
  const jp = jevProfileOf(profile);
  const { state, me } = ctx;
  const plans = movePlans(ctx, jp, { keep: hqKeep(ctx, profile), situation: sit, chains });
  const expanded = state.turn?.log?.expanded ?? 0;
  return plans.filter(p => {
    if ( p.kind !== "expand" ) return true;
    if ( expanded >= jp.expand.max ) return false;
    const src = state.territories[p.from];
    const frontline = (src.neighbors ?? []).some(n => state.territories[n]?.owner && state.territories[n].owner !== me);
    return !frontline || src.troops >= jp.expand.minSource || p.endFx.hq;
  });
}

/**
 * The attack-plan menu: code candidates trimmed by level and personality.
 *  - easy: the 3 best by code plus 2 others (may be poor), shuffled;
 *  - normal/hard: the best by code utility; none under the odds floor unless decisive; hard adds up to 3 chains.
 * @returns {object[]} options {key, plan, kind, from, to, end, path, P, eLoss, decisive, ... prompt facts}
 */
export function attackMenu(ctx, profile, knobs, sit) {
  const { state } = ctx;
  const random = typeof ctx.random === "function" ? ctx.random : Math.random;
  const plans = legalPlans(ctx, profile, sit);
  const floor = oddsFloor(profile, knobs);
  const n = menuSize(profile, knobs);
  const pool = [];
  const sigs = new Set();
  let chains = 0;
  for ( const p of plans ) {
    p.decisive = isDecisive(ctx, p.endFx, sit);
    if ( p.kind === "attack" || p.chain ) {
      if ( p.P < (p.decisive ? DECISIVE_MIN_CHANCE : floor) ) continue;
    }
    if ( p.chain ) {
      // A push is only worth listing when no direct attack on the same end is at least as likely.
      if ( chains >= (profile.maxChains ?? 0) ) continue;
      if ( plans.some(q => !q.chain && q.end === p.end && q.P >= p.P) ) continue;
      chains++;
    }
    const sig = p.path.join(">");
    if ( sigs.has(sig) ) continue;
    sigs.add(sig);
    pool.push(p);
  }
  let picked;
  if ( profile.preScore === "light" ) {
    const top = pool.slice(0, 3);
    const rest = shuffle(pool.slice(3), random).slice(0, Math.max(0, n - 3));
    picked = shuffle([...top, ...rest], random);
  }
  else picked = pool.slice(0, n);

  const attackedMe = knobs.vengeance >= 0.3 ? attackersOfMe(ctx) : new Set();
  const seen = new Set();
  return picked.map(p => {
    const kind = p.chain ? "chain" : p.kind;
    const end = state.territories[p.end];
    const via = p.path.slice(1, -1);
    const base = kind === "chain" ? `push_to_${p.end}_from_${p.from}`
      : (kind === "expand" ? `expand_into_${p.to}_from_${p.from}` : `attack_${p.to}_from_${p.from}`);
    const defender = end.owner && end.owner !== ctx.me ? end.owner : null;
    return {
      key: uniqueKey(seen, slug(base, "move")), plan: p, kind, from: p.from, to: p.to, end: p.end, path: [...p.path],
      P: p.P, eLoss: p.eLoss, decisive: p.decisive, count: p.count, cost: p.cost,
      fromName: territoryName(state, p.from), fromTroops: state.territories[p.from].troops,
      toName: end.name, via: via.map(id => territoryName(state, id)),
      defender: defender ? factionName(ctx, defender) : null, defenderId: defender, defenders: end.troops,
      hqOf: !defender && end.hq ? factionName(ctx, end.hq) : null,
      consequences: takeFacts(ctx, p.endFx), exposure: p.endFx.exposure,
      attackedMe: !!defender && attackedMe.has(defender)
    };
  });
}

/** Is there an option worth a replan (code: positive utility at the floor, or decisive)? */
export function goodOptionsRemain(options) {
  return options.some(o => o.decisive || ((o.plan.utility ?? 0) > 0.5));
}

/* -------------------------------------------- */
/*  Turn plan: cards, scars, join, fronts       */
/* -------------------------------------------- */

/**
 * Card options at the start of the turn: buy Red Stars, trade for troops, hold. A purchase that wins the war is code's
 * call (returned as `winBuy`, no menu). Trades smaller than the personality's minimum aren't offered unless the HQ
 * needs defenders.
 * @returns {{options:object[], winBuy:string[]|null}}
 */
export function cardMenu(ctx, profile, knobs, sit) {
  const { state, me } = ctx;
  const hand = ctx.view?.hand ?? [];
  const out = { options: [], winBuy: null };
  if ( hand.length < 2 ) return out;
  const stars = rules.redStarTotal(state, me);
  const toWin = Math.max(0, 4 - stars);
  const sets = Math.min(Math.floor(hand.length / 4), toWin);
  if ( sets >= 1 && stars + sets >= 4 ) {
    out.winBuy = [...hand].sort((a, b) => (a.coins ?? 1) - (b.coins ?? 1)).slice(0, sets * 4).map(c => c.id);
    return out;
  }
  if ( sets >= 1 && rules.checkBuyRedStars(state, me, 4, { ignoreTurn: true }).ok ) {
    out.options.push({ key: "buy_red_star", kind: "buy", stars: 1, starsAfter: stars + 1, cards: 4, cardsLeft: hand.length - 4, ids: starCards(hand) });
    if ( sets >= 2 ) {
      const ids = [...hand].sort((a, b) => (a.coins ?? 1) - (b.coins ?? 1)).slice(0, 8).map(c => c.id);
      out.options.push({ key: "buy_two_red_stars", kind: "buy", stars: 2, starsAfter: stars + 2, cards: 8, cardsLeft: hand.length - 8, ids });
    }
  }
  const trade = bestTrade(state, me, hand);
  const hqNeedy = (sit?.hqNeed ?? 0) > 0 && (sit?.hqWorst ?? 0) >= 0.25;
  if ( trade && rules.checkTrade(state, me, trade.coins, { ignoreTurn: true }).ok
    && ((trade.troops >= minTradeTroops(knobs)) || (hqNeedy && trade.troops >= 4)) ) {
    out.options.push({ key: "trade_for_troops", kind: "trade", coins: trade.coins, troops: trade.troops, cardsLeft: hand.length - trade.ids.length, ids: trade.ids });
  }
  out.options.push({ key: "hold_cards", kind: "hold", cards: hand.length, coins: coinsOf(hand), note: FACTS.holdNote });
  if ( out.options.length < 2 ) out.options = [];
  return out;
}

const WEAKNESSES = new Set(["cautious", "primitive", "purist", "short_sighted", "unpopular"]);
const GOOD_FOR_HOLDER = new Set(["mercenary"]);

/**
 * Start-of-turn scar plays, one decision per card: play it on one of its top targets (Mercenary on the bot's own HQ
 * and big stacks; Bio-hazard and other territory scars on the leader's and rivals' HQs and stacks; weaknesses on
 * rivals, leader first), or keep it.
 * @param {object[]} cards       scar cards that may be played now
 * @param {string[]|null} targets legal territory targets (cards.scarTargets()), when the driver passed them
 * @returns {{field:string, cardId:string, card:string, keep:string, options:object[]}[]}
 */
export function scarMenu(ctx, cards, targets, sit) {
  const { state, me } = ctx;
  if ( !cards?.length ) return [];
  const legal = targets ? new Set(targets) : null;
  const ok = id => state.territories[id] && !state.territories[id].scar && (!legal || legal.has(id));
  const leader = sit?.leader && sit.leader !== me ? sit.leader : null;
  const rivals = opponents(state, me).map(o => o.id).sort((a, b) => (b === leader) - (a === leader) || rules.redStarTotal(state, b) - rules.redStarTotal(state, a));
  const bigOf = fid => [...(state.factions[fid]?.territories ?? [])].filter(ok)
    .sort((a, b) => (Number(!!state.territories[b].hq) - Number(!!state.territories[a].hq)) || (state.territories[b].troops - state.territories[a].troops));
  const out = [];
  const fields = new Set();
  const seen = new Set();
  for ( const card of cards ) {
    const scar = String(card.scar ?? "").toLowerCase();
    const name = card.name || scar;
    const text = card.text ? `${name}: ${String(card.text).slice(0, 140)}` : name;
    const options = [];
    if ( WEAKNESSES.has(scar) || card.target === "faction" ) {
      for ( const fid of rivals.slice(0, 3) ) {
        options.push({ key: uniqueKey(seen, slug(`${name}_on_${factionName(ctx, fid)}`)), cardId: card.id, faction: fid, target: factionName(ctx, fid), note: fid === leader ? "the leader" : "" });
      }
    }
    else {
      const spots = GOOD_FOR_HOLDER.has(scar) ? bigOf(me).slice(0, 3) : rivals.flatMap(fid => bigOf(fid).slice(0, 2)).slice(0, 3);
      for ( const id of spots ) {
        const t = state.territories[id];
        const note = t.owner === me ? (t.hq ? FACTS.yourHq : "yours") : `${factionName(ctx, t.owner)}${t.hq ? "'s HQ" : ""}${t.owner === leader ? ", the leader" : ""}`;
        options.push({ key: uniqueKey(seen, slug(`${name}_on_${id}`)), cardId: card.id, territory: id, target: `${t.name} (${t.troops})`, note });
      }
    }
    if ( !options.length ) continue;
    const field = uniqueKey(fields, slug(`scar_${name}`));
    out.push({ field, cardId: card.id, card: text, keep: uniqueKey(seen, slug(`keep_${name}`)), options });
  }
  return out;
}

const possName = n => (/s$/i.test(n) ? `${n}'` : `${n}'s`);

/** Facts for a starting / Join-the-War candidate (from the shared startCandidates pre-score facts). */
function startData(ctx, c, joining) {
  const { state, me } = ctx;
  const t = state.territories[c.id];
  const f = c.facts;
  const cont = state.continents[t.continent];
  const out = {
    key: c.id, territory: c.id, name: t.name,
    continent: cont ? {
      name: continentName(state, cont.id), value: cont.value ?? 0, size: cont.territories.length,
      borders: cont.territories.filter(id => (state.territories[id]?.neighbors ?? []).some(n => state.territories[n]?.continent !== cont.id)).length
    } : null,
    emptyAdj: f.emptyAdj, room: f.room, hqDist: f.hqDist, enemyNear: f.enemyNear, cityNear: f.cityNear,
    foreign: (f.foreign ?? []).map(id => continentName(state, id))
  };
  if ( joining ) {
    out.enemies = (t.neighbors ?? []).map(n => state.territories[n]).filter(n => n?.owner && n.owner !== me)
      .map(n => `${factionName(ctx, n.owner)} in ${n.name}`);
    out.danger = f.danger?.p >= 0.02 ? { p: f.danger.p, faction: factionName(ctx, f.danger.faction) } : null;
    if ( f.weakHq ) out.weakHq = { name: `${possName(factionName(ctx, state.territories[f.weakHq].hq))} HQ in ${state.territories[f.weakHq].name}`, p: f.hqChance };
  }
  return out;
}

/** Join-the-War candidates (knocked out). */
export function joinMenu(ctx, profile, legal) {
  if ( !legal?.length ) return [];
  const all = startCandidates(ctx, legal, true);
  const cands = all.slice(0, profile.starts);
  for ( const c of all.filter(x => x.facts.weakHq && !cands.includes(x)).slice(0, 2) ) cands.push(c);
  return cands.map(c => startData(ctx, c, true));
}

/** Starting-territory candidates (setup). */
export function startMenu(ctx, profile, legal) {
  return startCandidates(ctx, legal, false).slice(0, profile.starts).map(c => startData(ctx, c, false));
}

/**
 * Placement fronts with what the reserve would do there: the best attack it stages (odds and the headline of what the
 * take changes), and how much it lowers the strongest enemy's capture chance next turn.
 * @param {number} reserve         troops to place (forecast)
 * @param {number|null} tradeReserve  reserve if the bot trades cards
 */
export function frontMenu(ctx, profile, sit, reserve, tradeReserve = null) {
  const { state, me } = ctx;
  const jp = jevProfileOf(profile);
  const full = profile.context === "full";
  const legal = (state.factions[me]?.territories ?? []).filter(id => rules.checkPlacement(state, me, id, 1, { ignoreTurn: true }).ok);
  if ( !legal.length ) return [];
  let fronts = frontsOf(ctx, { withCards: full }).filter(f => legal.includes(f.id));
  if ( !fronts.length ) {
    fronts = legal.map(id => ({ id, troops: state.territories[id].troops, enemies: [], empties: [], threat: { p: 0 }, loses: { hq: !!state.territories[id].hq, continents: [] }, needScore: 0 }));
  }
  const keep = hqKeep(ctx, profile);
  const scored = fronts.map(f => {
    const plans = movePlans(ctx, jp, { extra: { [f.id]: reserve }, from: f.id, ignoreTurn: true, situation: sit, chains: false, keep })
      .filter(p => p.kind === "attack");
    for ( const p of plans ) scorePlan(ctx, jp, p, sit);
    plans.sort((a, b) => b.utility - a.utility);
    const best = plans[0] ?? null;
    const contact = (f.enemies.length * 2) + f.empties.length + (f.threat.p * 3);
    return { f, best, rank: Math.max(0, best?.utility ?? 0) + (f.needScore * 6) + (contact * 0.3) + (state.territories[f.id].hq === me ? 2 : 0) };
  }).sort((a, b) => b.rank - a.rank);
  const top = scored.slice(0, profile.fronts);
  // The bot's own HQ is always on the menu when it can be placed on.
  const hqEntry = scored.find(s => state.territories[s.f.id].hq === me);
  if ( hqEntry && !top.includes(hqEntry) ) top[top.length - 1] = hqEntry;

  return top.map(({ f, best }) => {
    const t = state.territories[f.id];
    const holds = [];
    if ( t.hq ) holds.push(t.hq === me ? FACTS.yourHq : FACTS.capturedHq(factionName(ctx, t.hq)));
    for ( const c of f.loses?.continents ?? [] ) holds.push(FACTS.continent(state.continents[c]?.label ?? c, state.continents[c]?.value ?? 0));
    if ( t.population ) holds.push(FACTS.city(t.population));
    const enemies = [...f.enemies].sort((a, b) => b.troops - a.troops).slice(0, 3)
      .map(e => ({ faction: factionName(ctx, e.owner), territory: territoryName(state, e.id), troops: e.troops }));
    let threat = null;
    if ( f.threat?.p >= 0.05 && f.threat.faction ) {
      threat = {
        faction: factionName(ctx, f.threat.faction), attackers: f.threat.attackers, p: f.threat.p,
        pAfter: threatTo(ctx, f.threat.faction, f.id, { extra: reserve, withCards: full }).p,
        ...(tradeReserve ? { pAfterTrade: threatTo(ctx, f.threat.faction, f.id, { extra: tradeReserve, withCards: full }).p } : {})
      };
    }
    let bestOut = null;
    let bestTrade = null;
    if ( best && best.P >= 0.05 ) {
      const end = state.territories[best.to];
      bestOut = {
        to: best.to, toName: end.name, defender: end.owner ? factionName(ctx, end.owner) : null, defenders: end.troops,
        P: best.P, headline: takeFacts(ctx, best.endFx)[0] ?? ""
      };
      if ( tradeReserve ) {
        bestTrade = { P: attackOdds(state, me, f.id, best.to, { lookup: ctx.lookup, A: t.troops + tradeReserve, activeEvents: ctx.view?.activeEvents?.map(e => e.id) }).pConquer };
      }
    }
    return {
      key: f.id, territory: f.id, name: t.name, troops: t.troops, holds, enemies, empties: f.empties?.length ?? 0,
      threat, best: bestOut, bestTrade, isHq: !!t.hq && t.owner === me
    };
  });
}

/* -------------------------------------------- */
/*  End of turn: maneuver and draw              */
/* -------------------------------------------- */

/**
 * Code-made consolidations (the Jev brain's maneuver scoring): for each threatened or HQ front, the best source with
 * troops to spare; at most `profile.maneuvers`, best first.
 */
export function maneuverMenu(ctx, profile, sit) {
  const { state, me } = ctx;
  const full = profile.context === "full";
  const owned = state.factions[me]?.territories ?? [];
  if ( owned.length < 2 ) return [];
  const fronts = frontsOf(ctx, { withCards: full });
  const keep = hqKeep(ctx, profile);
  const isInterior = id => (state.territories[id].neighbors ?? []).every(n => state.territories[n]?.owner === me);
  const spare = {};
  for ( const id of owned ) {
    const t = state.territories[id];
    const k = Math.max(1, keep[id] ?? 1);
    if ( isInterior(id) ) spare[id] = Math.max(0, t.troops - k);
    else {
      const f = fronts.find(x => x.id === id);
      const need = f ? Math.ceil((f.threat.attackers ?? 0) * 0.8) : 0;
      spare[id] = Math.max(0, t.troops - Math.max(k, need, 1));
    }
  }
  const byDest = new Map();
  for ( const f of fronts ) {
    const t = state.territories[f.id];
    const stake = (f.loses.hq ? 3 : 0) + f.loses.continents.length + (t.population ? 0.5 : 0);
    for ( const src of owned ) {
      const n = spare[src];
      if ( src === f.id || !n ) continue;
      if ( !rules.checkManeuver(state, me, src, f.id, n, { ignoreTurn: true }).ok ) continue;
      const weight = (f.threat.p * (1 + stake)) + (t.hq === me ? 0.5 : 0) + (isInterior(src) ? 0.3 : 0) + (f.enemies.length ? 0.2 : 0);
      const score = weight * Math.min(n, 12);
      const cur = byDest.get(f.id);
      if ( !cur || score > cur.score ) byDest.set(f.id, { from: src, to: f.id, count: n, score, f });
    }
  }
  const list = [...byDest.values()].filter(m => m.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, profile.maneuvers);
  const seen = new Set();
  return list.map(m => {
    const to = state.territories[m.to];
    const from = state.territories[m.from];
    let purpose = FACTS.consolidate;
    if ( to.hq === me ) purpose = FACTS.reinforceHq;
    else if ( m.f.threat.faction ) purpose = FACTS.reinforceFront(factionName(ctx, m.f.threat.faction));
    let threat = null;
    if ( m.f.threat.p >= 0.05 && m.f.threat.faction ) {
      threat = { faction: factionName(ctx, m.f.threat.faction), p: m.f.threat.p, pAfter: threatTo(ctx, m.f.threat.faction, m.to, { extra: m.count, withCards: full }).p };
    }
    return {
      key: uniqueKey(seen, slug(`from_${m.from}_to_${m.to}`)), from: m.from, to: m.to, count: m.count,
      fromName: from.name, fromTroops: from.troops, toName: to.name, toTroops: to.troops, purpose, threat,
      leaves: isInterior(m.from) ? "" : FACTS.leavesWeak(from.name, from.troops - m.count)
    };
  });
}

/** Draw options when there's a real choice (two or more different cards, or a card and a coin). */
export function drawMenu(ctx, drawOptions) {
  const { state, me } = ctx;
  const opts = drawOptions ?? ctx.view?.drawOptions ?? null;
  if ( !opts?.canDraw ) return [];
  const row = opts.row ?? ctx.view?.row ?? [];
  const khan2 = rules.hasPower(state, me, "khan_2");
  const seen = new Set();
  const out = (opts.territoryCardIds ?? []).map(id => {
    const r = row.find(x => x.cardId === id) ?? {};
    const owned = state.territories[r.territory]?.owner === me;
    return {
      key: uniqueKey(seen, slug(`card_${r.territory ?? id}`)), cardId: id, territory: r.territory ?? null,
      name: territoryName(state, r.territory) || "territory", coins: r.value ?? r.coins ?? 1,
      note: khan2 && owned ? FACTS.ownTerritoryDraw : "", owned
    };
  });
  if ( opts.coinAllowed ) out.push({ key: "coin", coin: true, coins: 1 });
  if ( out.length < 2 ) return [];
  const sigs = new Set(out.map(o => `${o.coins}|${o.owned ? 1 : 0}|${o.coin ? 1 : 0}`));
  return sigs.size >= 2 ? out : [];
}
