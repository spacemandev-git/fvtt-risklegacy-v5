/**
 * A bot's own turn (BOTS.md §5): situation, cards, scars, recruit, placement, attacks/expansions, follow-up moves,
 * maneuver and end of turn. Judgments come from Jev (or the code's neutral judgments in heuristic mode); the
 * combination and the final call are here, in code.
 *
 * Requests per turn: situation (1) + placement (1, also pre-asks attack values) + attack values (0–4, only for targets
 * the earlier requests didn't cover) + maneuver exposure (0–1). Missile/scar stakes are asked only for battles where
 * the code already sees a material swing.
 */
import * as rules from "../../../rules/_module.mjs";
import {
  DECISIVE, HQ_DANGER_LEVELS, NOUL, READ, VALUE_LEVELS, exposureQuestions, situationQuestions, targetValueQuestions
} from "../../jev/questions.mjs";
import { cardValueOf, bestTrade, coinsOf, codeValueLevel, frontsOf, movePlans, reasonOf, scorePlan, starCards, tagsOf } from "../candidates.mjs";
import {
  PRIMER, factionKeys, factionsBlock, frontFacts, hqBlock, targetFacts
} from "../context.mjs";
import { codeLeader, garrisonFor, hqDanger, recruitForecast, standings, threatTo } from "../features.mjs";
import { attackOdds, pathOdds } from "../odds.mjs";
import { ask, choiceProbs, noulOf, pickChoice, readScore, scoreOf } from "../judge.mjs";
import { gainOf, profileOf } from "../profiles.mjs";
import { argmax, clamp, factionName, opponents, plural, round, softmaxPick, starsText, turnMemo, why } from "../util.mjs";
import { chooseStartingTerritory } from "./setup.mjs";

const levelFromP = p => (p < 0.1 ? 0 : (p < 0.35 ? 1 : (p < 0.7 ? 2 : 3)));
const valueLabel = lv => (lv >= DECISIVE.fromCode ? DECISIVE.label : VALUE_LEVELS[Math.max(0, Math.min(VALUE_LEVELS.length - 1, Math.round(lv)))].label);

/** The bot's own summary line for Jev states. */
function youBlock(ctx, list, extra = {}) {
  const s = list.find(x => x.id === ctx.me);
  return { faction: factionName(ctx, ctx.me), red_stars: starsText(s?.stars ?? rules.redStarTotal(ctx.state, ctx.me)), ...extra };
}

/** Depth of the standings sent to Jev for this profile. */
const depthOf = profile => ({ self: "self", standings: "standings", full: "full" })[profile.context] ?? "standings";

/* -------------------------------------------- */
/*  Situation                                   */
/* -------------------------------------------- */

/** Card options for the hard bot's card maths (keys of `card_options`), or null when there is nothing to weigh. */
/** The smallest card trade (in troops) a bot considers: below this, the cards are worth more toward a Red Star. */
const MIN_TRADE_TROOPS = 4;

function cardOptions(ctx, list, hqNeed) {
  const hand = ctx.view?.hand ?? [];
  const me = list.find(x => x.id === ctx.me);
  if ( !me || hand.length < 2 ) return null;
  const name = factionName(ctx, ctx.me);
  const opts = {};
  const sets = Math.min(Math.floor(hand.length / 4), me.toWin);
  if ( sets >= 1 ) {
    opts.buy_red_stars = {
      action: `buy ${plural(sets, "Red Star")} now with ${plural(sets * 4, "card")}`,
      afterwards: `${name} would have ${starsText(me.stars + sets)}; ${plural(hand.length - (sets * 4), "card")} left`
    };
  }
  const trade = bestTrade(ctx.state, ctx.me, hand);
  // A trade worth fewer than MIN_TRADE_TROOPS isn't offered: it throws away most of a Red Star (4 cards) for a few troops.
  if ( trade && (trade.troops >= MIN_TRADE_TROOPS) && rules.checkTrade(ctx.state, ctx.me, trade.coins, { ignoreTurn: true }).ok ) {
    opts.trade_for_troops = {
      action: `trade cards worth ${plural(trade.coins, "coin")} for ${plural(trade.troops, "troop")} this turn`,
      afterwards: `${plural(hand.length - trade.ids.length, "card")} left`,
      ...(hqNeed > 0 ? { note: `${poss(name)} HQ needs about ${plural(hqNeed, "more defender")} to be safe` } : {})
    };
  }
  opts.keep_cards = {
    action: `keep all ${plural(hand.length, "card")} (${plural(coinsOf(hand), "coin")})`,
    afterwards: `a bigger trade or a Red Star later; if ${name} is knocked out, the conqueror takes the cards`
  };
  return Object.keys(opts).length >= 2 ? opts : null;
}
const poss = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Turn-level judgments shared by later decisions (BOTS.md §5). */
export async function assessSituation(ctx) {
  const profile = profileOf(ctx);
  const { me } = ctx;
  const list = standings(ctx);
  const code = codeLeader(list);
  const full = profile.context === "full";
  const dangers = hqDanger(ctx, me, { withCards: full, depth: full ? 2 : 1 });
  dangers.sort((a, b) => (b.worst - a.worst) || (Number(b.own) - Number(a.own)));
  const main = dangers[0] ?? null;
  const hqNeed = main ? Math.max(0, garrisonFor(ctx, main.territory, profile.hqSafeP ?? 0.35, 30, { withCards: full }) - main.defenders) : 0;
  const keys = factionKeys(ctx, list);
  const threatList = (profile.askThreats && main) ? main.threats.filter(t => t.p >= 0.05).slice(0, 3) : [];
  const cards = profile.cards === "maths" ? cardOptions(ctx, list, hqNeed) : null;

  const jevState = { how_to_win: PRIMER.stars, factions: factionsBlock(ctx, list, keys, depthOf(profile)) };
  if ( main ) jevState.your_hq = hqBlock(ctx, main);
  if ( cards ) jevState.card_options = cards;
  const questions = situationQuestions({
    me: factionName(ctx, me),
    factions: list.map(s => ({ key: keys[s.id], name: s.name })),
    threatKeys: threatList.map(t => ({ key: keys[t.faction], name: factionName(ctx, t.faction) })),
    hasHq: !!main, reversed: profile.reversedChoices,
    cardOptions: cards ? Object.keys(cards).map(key => ({ key })) : null
  });
  const answers = await ask(ctx, "situation", jevState, questions);

  // Leader: Jev's Choice (averaged with the reversed order for the hard bot), else the code ranking.
  const keyList = list.map(s => keys[s.id]);
  const byKey = Object.fromEntries(list.map(s => [keys[s.id], s.id]));
  let probs = choiceProbs(answers, "leader", keyList);
  if ( !probs ) {
    const w = list.map(s => Math.exp(1.6 * s.closeness));
    const total = w.reduce((a, b) => a + b, 0);
    probs = Object.fromEntries(list.map((s, i) => [keys[s.id], w[i] / total]));
  }
  const leaderKey = answers ? pickChoice(probs, keyList, profile, ctx.random) : keys[code.leader];
  const leader = byKey[leaderKey] ?? code.leader;
  const leaderProbs = Object.fromEntries(list.map(s => [s.id, round(probs[keys[s.id]] ?? 0, 3)]));

  // HQ danger: Jev's Score, else the code band of the worst capture chance.
  const codeDanger = main ? levelFromP(main.worst) : 0;
  const danger = scoreOf(answers, "hq_danger", HQ_DANGER_LEVELS.length, codeDanger);
  const dangerLevel = main ? readScore(danger, profile, ctx.random) : 0;

  const threats = {};
  for ( const o of list ) {
    if ( o.id === me ) continue;
    const t = main?.threats.find(x => x.faction === o.id);
    threats[o.id] = round(noulOf(answers, `attacks_hq_${keys[o.id]}`, t?.p ?? 0), 3);
  }

  let cardJudgment = null;
  if ( cards ) {
    const ck = Object.keys(cards);
    // Heuristic prior: troops when the HQ is in real danger and the trade covers a good part of the need, else the star.
    const trade = bestTrade(ctx.state, me, ctx.view?.hand ?? []);
    const covers = trade && hqNeed > 0 && codeDanger >= READ.dangerRealChance && trade.troops >= Math.min(hqNeed, 10);
    const prior = { buy_red_stars: 0.6, trade_for_troops: covers ? 0.75 : 0.15, keep_cards: 0.1 };
    const cp = choiceProbs(answers, "cards", ck) ?? Object.fromEntries(ck.map(k => [k, prior[k] ?? 0.1]));
    cardJudgment = { choice: ck[argmax(ck.map(k => cp[k]))], probs: cp };
  }

  const result = {
    leader, leaderP: round(leaderProbs[leader] ?? 0, 3), leaderProbs, threats,
    hqDanger: round(main ? (profile.temperature > 0 ? dangerLevel : danger.expected) : 0, 2),
    hqDangerLevel: Math.round(dangerLevel), hq: main?.territory ?? null, hqWorst: round(main?.worst ?? 0, 3), hqNeed,
    threatsJudged: !!answers && threatList.length > 0,
    cards: cardJudgment,
    stars: Object.fromEntries(list.map(s => [s.id, s.stars])),
    why: why("situation", {
      faction: leader, chance: round(leaderProbs[leader] ?? 0, 2), label: factionName(ctx, leader),
      value: HQ_DANGER_LEVELS[Math.round(dangerLevel)]?.label ?? "safe", territory: main?.territory ?? null,
      ...(answers ? {} : { heuristic: true })
    })
  };
  turnMemo(ctx).situation = result;
  return result;
}

/** ctx.situation, or a code-only one (no Jev request) when the driver didn't pass it. */
async function situationOf(ctx) {
  if ( ctx.situation ) return ctx.situation;
  const memo = turnMemo(ctx);
  if ( memo.situation ) return memo.situation;
  return assessSituation({ ...ctx, ask: null });
}

/* -------------------------------------------- */
/*  Step 1: Red Stars and scar cards            */
/* -------------------------------------------- */

/** Start of turn: Red Star purchase (4 resource cards). Called again while it returns cards. */
export async function planStartOfTurn(ctx) {
  const profile = profileOf(ctx);
  const hand = ctx.view?.hand ?? [];
  if ( hand.length < 4 ) return { buyRedStars: null, why: why("holdCards", { count: hand.length }) };
  const stars = rules.redStarTotal(ctx.state, ctx.me);
  const ids = starCards(hand);
  // Code rule (no Jev): a purchase that wins the war is always made.
  if ( stars + Math.floor(hand.length / 4) >= 4 ) return { buyRedStars: ids, why: why("buyStarWin", { count: stars + 1 }) };
  const sit = await situationOf(ctx);
  switch ( profile.cards ) {
    case "alwaysBuy":
      return { buyRedStars: ids, why: why("buyStar", { count: stars + 1 }) };
    case "buy": {
      const trade = bestTrade(ctx.state, ctx.me, hand);
      if ( (sit.hqDangerLevel >= READ.dangerRealChance) && (sit.hqNeed > 0) && trade && (trade.troops >= Math.min(sit.hqNeed, 4)) ) {
        return { buyRedStars: null, why: why("holdCards", { label: "trade for troops to defend the HQ", territory: sit.hq }) };
      }
      return { buyRedStars: ids, why: why("buyStar", { count: stars + 1 }) };
    }
    default: {
      const choice = sit.cards?.choice ?? "buy_red_stars";
      if ( choice === "buy_red_stars" ) {
        return { buyRedStars: ids, why: why("buyStar", { count: stars + 1, chance: round(sit.cards?.probs?.buy_red_stars ?? 1, 2) }) };
      }
      return { buyRedStars: null, why: why("holdCards", { label: choice === "trade_for_troops" ? "trade for troops" : "keep cards", chance: round(sit.cards?.probs?.[choice] ?? 0, 2) }) };
    }
  }
}

const WEAKNESSES = new Set(["cautious", "primitive", "purist", "short_sighted", "unpopular"]);

/**
 * Start-of-turn scar cards. Decided in code (no Jev): Mercenary (+1 troop per turn to the controller) goes on the bot's
 * own HQ, where it will keep benefiting; Bio-hazard (−1 per turn) and weakness scars go to the leader. The easy bot
 * never plays scars; the normal bot only the Mercenary on its HQ.
 * @returns {{plays:{cardId:string, territory?:string, faction?:string}[], why}}
 */
export async function planScars(ctx, { cards = [], targets = [] } = {}) {
  const profile = profileOf(ctx);
  if ( profile.scars === "never" || !cards.length ) return { plays: [], why: why("holdScars") };
  const { state, me } = ctx;
  const sit = await situationOf(ctx);
  const legal = new Set(targets);
  const plays = [];
  const used = new Set();
  const ownHq = Object.values(state.territories).find(t => t.hq === me && t.owner === me && !t.scar);
  for ( const card of cards ) {
    const scar = String(card.scar ?? "").toLowerCase();
    if ( scar === "mercenary" && ownHq && legal.has(ownHq.id) && !used.has(ownHq.id) ) {
      plays.push({ cardId: card.id, territory: ownHq.id });
      used.add(ownHq.id);
      continue;
    }
    if ( profile.scars !== "strategic" ) continue;
    const leader = sit.leader && sit.leader !== me ? sit.leader : null;
    if ( !leader ) continue;
    if ( scar === "biohazard" ) {
      const lf = state.factions[leader];
      const spots = (lf?.territories ?? []).filter(id => legal.has(id) && !used.has(id))
        .sort((a, b) => (Number(!!state.territories[b].hq) - Number(!!state.territories[a].hq)) || (state.territories[b].troops - state.territories[a].troops));
      if ( spots[0] ) { plays.push({ cardId: card.id, territory: spots[0] }); used.add(spots[0]); }
    }
    else if ( WEAKNESSES.has(scar) || card.target === "faction" ) {
      plays.push({ cardId: card.id, faction: leader });
    }
  }
  if ( !plays.length ) return { plays, why: why("holdScars") };
  const first = plays[0];
  return { plays, why: why("playScar", { territory: first.territory ?? null, faction: first.faction ?? null, count: plays.length, label: cards.find(c => c.id === first.cardId)?.name }) };
}

/* -------------------------------------------- */
/*  Step 2: recruit / join, then placement      */
/* -------------------------------------------- */

/** Step 2: Join the War (when knocked out) or recruit, plus an optional card trade for troops. */
export async function planRecruit(ctx, { mustJoin = false, legalJoin = [] } = {}) {
  if ( mustJoin ) {
    const r = await chooseStartingTerritory(ctx, { legal: legalJoin, joining: true });
    return { join: r.territory, why: r.why };
  }
  const profile = profileOf(ctx);
  const hand = ctx.view?.hand ?? [];
  const trade = hand.length >= 1 ? bestTrade(ctx.state, ctx.me, hand) : null;
  const recruit = recruitForecast(ctx.state, ctx.me);
  let doTrade = false;
  if ( trade && profile.trade !== "never" ) {
    const sit = await situationOf(ctx);
    // A danger trade must buy enough troops to matter, and with 3+ cards (close to a Red Star) the HQ must really be
    // likely to fall. Without this the hard bot, which reads its HQ danger worst-case, spent every hand on 2-4 troops
    // and never reached a Red Star.
    const enough = trade.troops >= Math.max(MIN_TRADE_TROOPS, Math.min(sit.hqNeed, 10));
    const closeToStar = hand.length >= 3;
    const danger = (sit.hqDangerLevel >= READ.dangerRealChance) && (sit.hqNeed > 0) && enough && (!closeToStar || (sit.hqWorst ?? 0) >= 0.5);
    if ( profile.trade === "hqDanger" ) doTrade = danger;
    else doTrade = danger || (sit.cards?.choice === "trade_for_troops")
      // Card maths: a full 10-coin trade (30 troops) is always worth taking when no Red Star is buyable with these cards.
      || (trade.coins >= 10 && hand.length < 4);
  }
  if ( doTrade && rules.checkTrade(ctx.state, ctx.me, trade.coins, { ignoreTurn: true }).ok ) {
    return { recruit: true, tradeForTroops: trade.ids, why: why("tradeTroops", { count: trade.troops, label: `${trade.coins} coins` }) };
  }
  return { recruit: true, tradeForTroops: null, why: why("recruit", { count: recruit }) };
}

/** Ask Jev the value of taking each target in `plans` (by end territory) not yet judged this turn; store in the memo. */
async function judgeTargets(ctx, profile, plans, list, extraState = {}, extraQuestions = {}, purpose = "attack values") {
  const memo = turnMemo(ctx);
  const sit = memo.situation ?? ctx.situation ?? null;
  const ends = [];
  const seen = new Set();
  for ( const p of plans ) {
    const sig = `${p.end}|${tagsOf(p.endFx)}`;
    if ( seen.has(p.end) ) continue;
    seen.add(p.end);
    if ( memo.values[p.end]?.sig === sig ) continue;
    ends.push({ plan: p, sig });
    if ( ends.length >= profile.candidates ) break;
  }
  const questionsCount = Object.keys(extraQuestions).length;
  if ( !ends.length && !questionsCount ) return null;
  const targets = Object.fromEntries(ends.map(e => [e.plan.end, targetFacts(ctx, e.plan, list)]));
  const jevState = {
    you: youBlock(ctx, list),
    ...(profile.context !== "self" ? { factions: factionsBlock(ctx, list, factionKeys(ctx, list), depthOf(profile)) } : {}),
    ...(ends.length ? { rules: PRIMER.cards, targets } : {}),
    ...extraState
  };
  const questions = { ...targetValueQuestions({ me: factionName(ctx, ctx.me), keys: ends.map(e => e.plan.end) }), ...extraQuestions };
  const answers = await ask(ctx, purpose, jevState, questions);
  for ( const e of ends ) {
    const code = codeValueLevel(ctx, e.plan.endFx, sit);
    // Decisive takes are code's call (questions.mjs DECISIVE); Jev rates the rest on levels 0–3.
    const decisive = code >= DECISIVE.fromCode;
    const s = scoreOf(answers, `value_${e.plan.end}`, VALUE_LEVELS.length, Math.min(code, VALUE_LEVELS.length - 1));
    // Between two decisive takes, Jev's rating still breaks the tie.
    const expected = decisive ? Math.min(DECISIVE.level, code + (0.05 * s.expected)) : s.expected;
    memo.values[e.plan.end] = { sig: e.sig, expected, probs: decisive ? null : s.probs, code, fromJev: s.fromJev, decisive };
  }
  return answers;
}

/** The value level the bot uses for a plan's end (Jev, sampled for the easy bot; else the code level). */
function planLevel(ctx, profile, plan, sit) {
  const memo = turnMemo(ctx);
  const v = memo.values[plan.end];
  const sig = `${plan.end}|${tagsOf(plan.endFx)}`;
  if ( v && v.sig === sig ) {
    if ( profile.temperature > 0 && v.probs ) return readScore({ expected: v.expected, probs: v.probs }, profile, ctx.random);
    return v.expected;
  }
  return codeValueLevel(ctx, plan.endFx, sit);
}

/** HQ garrisons to keep this turn: territory → troops. */
function garrisons(ctx, profile, sit) {
  const keep = {};
  const p = profile.attack.hqGarrisonP ?? ((profile.hqSafeP && sit.hqDangerLevel >= READ.dangerRealChance) ? profile.hqSafeP : null);
  if ( !p ) return keep;
  const full = profile.context === "full";
  for ( const id of ctx.state.factions[ctx.me]?.hqs ?? [] ) keep[id] = garrisonFor(ctx, id, p, 25, { withCards: full });
  return keep;
}

/**
 * Troops always left in each HQ the bot holds (its own and captured ones): the profile's floor. A hard floor rather
 * than a penalty, because the HQ-risk penalty below only sees threats that can strike next turn: with every enemy two
 * steps away it reads zero, and the bot used to march its whole army out on turn 1 and never come back.
 */
function hqKeep(ctx, profile) {
  const floor = profile.attack.hqFloor ?? 1;
  if ( floor <= 1 ) return {};
  return Object.fromEntries((ctx.state.factions[ctx.me]?.hqs ?? []).map(id => [id, floor]));
}

/**
 * Penalty (troop-equivalents) for attacking out of an HQ: the extra chance an opponent captures it next turn once the
 * attack has thinned it, times what the HQ is worth. Replaces a hard garrison rule so that a leader-stopping attack
 * can still go out of the HQ when it is worth the risk.
 */
function hqRiskOf(ctx, profile, sit) {
  const { state, me } = ctx;
  const full = profile.context === "full";
  const enemies = opponents(state, me).filter(o => o.territories?.length);
  const intent = fid => (sit?.threatsJudged ? 0.5 + (0.5 * (sit.threats?.[fid] ?? 1)) : 1);
  const cache = new Map();
  const worst = (id, extra) => {
    const key = `${id}|${extra}`;
    if ( !cache.has(key) ) cache.set(key, Math.max(0, ...enemies.map(o => threatTo(ctx, o.id, id, { extra, withCards: full }).p * intent(o.id))));
    return cache.get(key);
  };
  const stake = gainOf(profile, enemies.some(o => rules.redStarTotal(state, o.id) >= 3) ? 4 : 3);
  return plan => {
    const from = state.territories[plan.from];
    if ( !from?.hq || from.owner !== me || plan.endFx.winNow ) return 0;
    const A = from.troops;
    const left = Math.max(1, Math.round(plan.left ?? A));
    const afterWin = plan.chain ? 1 : Math.max(1, left - Math.min(3, left - 1));
    const afterFail = Math.max(1, Math.round(A - plan.eLoss));
    const after = Math.round((plan.P * afterWin) + ((1 - plan.P) * afterFail));
    if ( after >= A ) return 0;
    return Math.max(0, worst(plan.from, after - A) - worst(plan.from, 0)) * stake;
  };
}

/** Where to put the reserve. @returns {{placements:{territory:string, count:number}[], why}} */
export async function planPlacement(ctx, { reserve } = {}) {
  const profile = profileOf(ctx);
  const { state, me } = ctx;
  reserve = Math.max(0, Math.floor(reserve ?? state.factions[me]?.reserve ?? 0));
  const legal = (state.factions[me]?.territories ?? []).filter(id => rules.checkPlacement(state, me, id, 1, { ignoreTurn: true }).ok);
  if ( !reserve || !legal.length ) return { placements: [], why: why("stageAttack", { count: 0 }) };
  const sit = await situationOf(ctx);
  const memo = turnMemo(ctx);
  const list = standings(ctx);
  let fronts = frontsOf(ctx, { withCards: profile.context === "full" }).filter(f => legal.includes(f.id));
  if ( !fronts.length ) fronts = legal.map(id => ({ id, troops: state.territories[id].troops, enemies: [], empties: [], threat: { p: 0 }, loses: { hq: false, continents: [] }, needScore: 0 }));

  // Staging: what each front could do with the whole reserve (top fronts by contact with enemies/empty land).
  const contact = f => f.enemies.length * 2 + f.empties.length + (f.threat.p * 3);
  const topFronts = [...fronts].sort((a, b) => contact(b) - contact(a)).slice(0, 6);
  const staged = {};
  const allPlans = [];
  for ( const f of topFronts ) {
    const plans = movePlans(ctx, profile, { extra: { [f.id]: reserve }, from: f.id, ignoreTurn: true, situation: sit });
    staged[f.id] = plans;
    allPlans.push(...plans);
  }
  allPlans.sort((a, b) => b.utility - a.utility);

  // One request: target values (reused by nextMove) + exposure of the most threatened fronts.
  const expFronts = profile.askExposure ? fronts.filter(f => f.threat.p >= 0.05 || f.loses.hq).slice(0, 4) : [];
  const extraState = expFronts.length ? { fronts: Object.fromEntries(expFronts.map(f => [f.id, frontFacts(ctx, f)])) } : {};
  const extraQuestions = expFronts.length ? exposureQuestions({ me: factionName(ctx, me), keys: expFronts.map(f => f.id) }) : {};
  const answers = await judgeTargets(ctx, profile, allPlans, list, { ...extraState, you: youBlock(ctx, list, { troops_to_place: reserve }) }, extraQuestions, "placement");
  for ( const f of expFronts ) memo.exposure[f.id] = noulOf(answers, `attacked_${f.id}`, f.threat.p);

  // Up to two attack plans per front, valued with the judged levels.
  const frontPlans = {};
  for ( const f of topFronts ) {
    const ps = staged[f.id].filter(p => p.kind === "attack");
    for ( const p of ps ) p.level = planLevel(ctx, profile, p, sit);
    frontPlans[f.id] = ps.sort((a, b) => scorePlan(ctx, profile, b, sit, b.level) - scorePlan(ctx, profile, a, sit, a.level)).slice(0, 2);
  }

  // Code rule (no Jev): a staged move that wins the war now gets the whole reserve.
  const winner = Object.values(frontPlans).flat().filter(p => p.endFx.winNow && p.P >= profile.attack.winNowMin).sort((a, b) => b.P - a.P)[0];
  if ( winner ) {
    memo.stage = { from: winner.from, to: winner.to, end: winner.end, path: winner.path };
    return {
      placements: [{ territory: winner.from, count: reserve }],
      why: why("stageAttack", { territory: winner.from, count: reserve, to: winner.end, chance: round(winner.P, 2), label: "a move that wins the war", ...(answers ? {} : { heuristic: true }) })
    };
  }

  const { entries, stagePlan } = allocateReserve(ctx, profile, sit, { reserve, legal, fronts, topFronts, frontPlans, judged: !!answers });
  const main = [...entries].sort((a, b) => b.count - a.count)[0];
  memo.stage = stagePlan ? { from: stagePlan.from, to: stagePlan.to, end: stagePlan.end, path: stagePlan.path } : null;
  return {
    placements: entries.map(({ territory, count }) => ({ territory, count })),
    why: why(main?.reason ?? "stageAttack", {
      territory: main?.territory, count: main?.count,
      ...(stagePlan && main?.reason === "stageAttack" ? { to: stagePlan.end, chance: round(stagePlan.P, 2) } : {}),
      ...(answers ? {} : { heuristic: true })
    })
  };
}

/**
 * Split the reserve greedily, a chunk at a time, to whichever use gains the most troop-equivalents:
 *  - stage an attack: P(conquer) × gain(value) − expected losses, with the extra troops;
 *  - defend the HQ: lower chance an opponent captures it next turn × what the HQ is worth;
 *  - defend an exposed border: lower chance of losing it × what it holds (continent, city, a card for them).
 * Easy: one pile on a top-2 front (sampled). Normal: the best staging front, + HQ when in danger. Hard: all uses.
 */
function allocateReserve(ctx, profile, sit, { reserve, legal, fronts, topFronts, frontPlans, judged }) {
  const { state, me, lookup } = ctx;
  const memo = turnMemo(ctx);
  const activeEvents = ctx.view?.activeEvents?.map(e => e.id);
  const full = profile.context === "full";
  const cache = new Map();
  const once = (key, fn) => { if ( !cache.has(key) ) cache.set(key, fn()); return cache.get(key); };

  const stageValue = (plan, k) => once(`s|${plan.path.join(">")}|${k}`, () => {
    const A = state.territories[plan.from].troops + k;
    let P;
    let eLoss;
    if ( plan.chain ) {
      const r = pathOdds(state, me, plan.path, { lookup, activeEvents, A0: A });
      const committed = A - 1;
      const remaining = (r.pReach * (r.expectedTroops + (plan.path.length - 2))) + ((1 - r.pReach) * Math.max(1, committed * 0.3));
      P = r.pReach;
      eLoss = Math.max(0, committed - remaining);
    }
    else {
      const r = attackOdds(state, me, plan.from, plan.to, { lookup, A, activeEvents });
      P = r.pConquer;
      eLoss = r.eAttackerLosses;
    }
    return { u: Math.max(0, (P * (gainOf(profile, plan.level) + cardValueOf(profile, plan))) - (profile.attack.lossWeight * eLoss)), P };
  });
  const frontStage = (id, k) => Math.max(0, ...(frontPlans[id] ?? []).map(p => stageValue(p, k).u));

  // Staging fronts ranked by what the whole reserve would let them do.
  const staging = topFronts.filter(f => (frontPlans[f.id] ?? []).length)
    .sort((a, b) => frontStage(b.id, reserve) - frontStage(a.id, reserve));
  const options = [];

  if ( profile.placement === "pile" ) {
    const pick = staging.slice(0, 2);
    const id = pick.length
      ? pick[Math.max(0, softmaxPick(pick.map(f => frontStage(f.id, reserve)), profile.temperature, ctx.random, 3))].id
      : (fronts[0]?.id ?? legal[0]);
    const plan = (frontPlans[id] ?? [])[0] ?? null;
    return { entries: [{ territory: id, count: reserve, reason: plan ? "stageAttack" : "defendBorder" }], stagePlan: plan };
  }

  for ( const f of staging.slice(0, profile.placement === "split" ? 3 : 1) ) {
    if ( frontStage(f.id, reserve) > 0 ) options.push({ territory: f.id, reason: "stageAttack", value: k => frontStage(f.id, k) });
  }

  // HQ defence.
  const hqId = sit.hq && legal.includes(sit.hq) ? sit.hq : null;
  const enemies = opponents(state, me).filter(o => o.territories?.length);
  if ( hqId && enemies.length ) {
    const hqExposed = memo.exposure[hqId];
    const inDanger = sit.hqDangerLevel >= READ.dangerRealChance || (hqExposed ?? 0) >= NOUL.yes;
    if ( profile.placement === "split" ? sit.hqWorst > 0.02 : inDanger ) {
      const intent = fid => (sit.threatsJudged ? 0.5 + (0.5 * (sit.threats?.[fid] ?? 1)) : 1);
      const stake = gainOf(profile, enemies.some(o => rules.redStarTotal(state, o.id) >= 3) ? 4 : 3);
      const threat = k => once(`h|${k}`, () => Math.max(0, ...enemies.map(o =>
        threatTo(ctx, o.id, hqId, { extra: k, withCards: full, depth: full ? 2 : 1 }).p * intent(o.id))));
      options.push({ territory: hqId, reason: "defendHq", value: k => -threat(k) * stake });
    }
  }

  // Exposed borders (hard always; normal only when it has nothing to stage).
  if ( profile.placement === "split" || !options.some(o => o.reason === "stageAttack") ) {
    const exposed = fronts.filter(f => f.id !== hqId && f.threat.p >= 0.1 && f.threat.faction).slice(0, profile.placement === "split" ? 4 : 2);
    for ( const f of exposed ) {
      const noul = memo.exposure[f.id];
      const intent = noul === undefined ? 0.8 : 0.4 + (0.6 * noul);
      const t = state.territories[f.id];
      const level = f.loses.continents.length
        ? 2 + Math.min(1, f.loses.continents.reduce((n, c) => n + (state.continents[c]?.value ?? 0), 0) / 5)
        : (t.population ? 1.3 : 1);
      const stake = gainOf(profile, level);
      const threat = k => once(`b|${f.id}|${k}`, () => threatTo(ctx, f.threat.faction, f.id, { extra: k, withCards: full }).p);
      options.push({ territory: f.id, reason: "defendBorder", value: k => -threat(k) * intent * stake });
    }
  }

  // Ratio-greedy with lookahead: capture chances are S-shaped, so one chunk may move nothing while ten would; each
  // step gives the option with the best average gain per troop the amount that achieves it.
  const cautious = rules.hasPower(state, me, "cautious");
  const alloc = new Map();
  const gains = new Map();
  const chunk = Math.max(1, Math.ceil(reserve / 12));
  let left = reserve;
  while ( left > 0 && options.length ) {
    let best = null;
    for ( const o of options ) {
      if ( cautious && !alloc.has(o.territory) && alloc.size >= 2 ) continue;
      const k0 = alloc.get(o.territory) ?? 0;
      const v0 = o.value(k0);
      for ( let k = Math.min(chunk, left); k <= left; k = (k + chunk > left && k < left) ? left : k + chunk ) {
        const g = o.value(k0 + k) - v0;
        const ratio = g / k;
        if ( g > 0.05 && (!best || ratio > best.ratio + 1e-9) ) best = { o, k, g, ratio };
        if ( k === left ) break;
      }
    }
    if ( !best || best.ratio < 0.02 ) break;
    alloc.set(best.o.territory, (alloc.get(best.o.territory) ?? 0) + best.k);
    const gk = `${best.o.territory}|${best.o.reason}`;
    gains.set(gk, (gains.get(gk) ?? 0) + best.g);
    left -= best.k;
  }
  if ( left > 0 ) {
    // Nothing gains more: pile the rest where it is most useful next turn.
    const id = [...alloc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? staging[0]?.id ?? hqId ?? fronts[0]?.id ?? legal[0];
    alloc.set(id, (alloc.get(id) ?? 0) + left);
  }
  const reasonAt = id => {
    let best = null;
    for ( const [k, g] of gains ) if ( k.startsWith(`${id}|`) && (!best || g > best[1]) ) best = [k.split("|")[1], g];
    return best?.[0] ?? (frontPlans[id]?.length ? "stageAttack" : (id === hqId ? "defendHq" : "defendBorder"));
  };
  const entries = [...alloc.entries()].filter(([, n]) => n > 0).map(([territory, count]) => ({ territory, count, reason: reasonAt(territory) }));
  const stageEntry = entries.filter(e => e.reason === "stageAttack").sort((a, b) => b.count - a.count)[0];
  const stagePlan = stageEntry ? [...(frontPlans[stageEntry.territory] ?? [])].sort((a, b) => stageValue(b, stageEntry.count).u - stageValue(a, stageEntry.count).u)[0] : null;
  if ( stagePlan ) stagePlan.P = stageValue(stagePlan, stageEntry.count).P;
  return { entries, stagePlan, judged };
}

/* -------------------------------------------- */
/*  Step 3: attacks and expansions              */
/* -------------------------------------------- */

/** The next attack or expansion, or stop. Called after every battle/expansion. */
export async function nextMove(ctx) {
  const profile = profileOf(ctx);
  const { state, me } = ctx;
  const gate = rules.checkTurnAction(state, me, "attack");
  if ( !gate.ok ) return { type: "stop", why: why("stopEnough") };
  const sit = await situationOf(ctx);
  const memo = turnMemo(ctx);
  const log = state.turn?.log ?? {};
  const conquered = log.conquered ?? 0;
  const list = standings(ctx);

  // Easy: often stops after its first conquest, and attacks at most a few targets.
  if ( profile.attack.stopAfterConquest > 0 && conquered >= 1 ) {
    memo.easyStop ??= ctx.random() < profile.attack.stopAfterConquest;
    if ( memo.easyStop ) return { type: "stop", why: why("stopEnough", { count: conquered }) };
  }
  const targetsSoFar = Math.max(memo.attacked.size, conquered);

  const keep = hqKeep(ctx, profile);
  let plans = movePlans(ctx, profile, { keep, situation: sit });
  const expanded = log.expanded ?? 0;
  plans = plans.filter(p => {
    if ( p.kind !== "expand" ) return true;
    if ( expanded >= profile.expand.max ) return false;
    const src = state.territories[p.from];
    const frontline = (src.neighbors ?? []).some(n => state.territories[n]?.owner && state.territories[n].owner !== me);
    return !frontline || src.troops >= profile.expand.minSource || p.endFx.hq;
  });
  if ( !plans.length ) return { type: "stop", why: why("stopEnough", { count: conquered }) };

  // Code rule (no Jev): a move that wins the war now with good odds is always taken (HQ floors don't apply).
  const winPool = Object.keys(keep).length ? movePlans(ctx, profile, { situation: sit, chains: false }) : plans;
  const win = winPool.filter(p => p.endFx.winNow && !p.chain).sort((a, b) => b.P - a.P)[0];
  if ( win && win.P >= profile.attack.winNowMin ) return moveOf(ctx, win, "winNow", sit);

  // Jev: the value of the top candidates not judged yet this turn (bounded number of requests per turn). Candidates
  // that can't pass the odds floor are not worth a question.
  const floorOf = lv => ((profile.attack.minChanceHigh !== undefined && lv >= READ.valueBig) ? profile.attack.minChanceHigh : profile.attack.minChance);
  const ranked = plans.filter(p => p.kind === "expand" || p.P >= floorOf(p.codeLevel) * 0.8)
    .slice(0, profile.candidates * 2);
  const poorBefore = plans.length - ranked.length;
  if ( ranked.length && memo.valueAsks < profile.maxValueRequests ) {
    const before = Object.keys(memo.values).length;
    const answers = await judgeTargets(ctx, profile, ranked.slice(0, profile.candidates), list);
    if ( answers && Object.keys(memo.values).length > before ) memo.valueAsks++;
  }
  const hqRisk = profile.id === "easy" ? () => 0 : hqRiskOf(ctx, profile, sit);

  // Combine in code: utility = P × gain(value) − losses − exposure; filters per profile.
  let poorOdds = poorBefore;
  let defend = 0;
  const viable = [];
  for ( const p of ranked ) {
    const lv = planLevel(ctx, profile, p, sit);
    p.level = lv;
    scorePlan(ctx, profile, p, sit, lv);
    p.hqRisk = hqRisk(p);
    p.utility -= p.hqRisk;
    if ( p.kind === "attack" ) {
      if ( p.P < floorOf(lv) ) { poorOdds++; continue; }
      if ( !memo.attacked.has(p.to) && targetsSoFar >= profile.attack.maxTargets ) continue;
    }
    // Keep fighting the battle already started unless something clearly better appears.
    if ( memo.current && memo.current.to === p.to && memo.current.from === p.from ) p.utility += 0.5;
    if ( p.utility < profile.attack.minUtility ) {
      if ( p.hqRisk > 0 && p.utility + p.hqRisk >= profile.attack.minUtility ) defend++;
      else if ( p.kind === "attack" && p.P < 0.5 ) poorOdds++;
      continue;
    }
    viable.push(p);
  }
  if ( !viable.length ) {
    const reason = defend ? "stopDefend" : (poorOdds ? "stopOddsPoor" : "stopEnough");
    memo.current = null;
    return { type: "stop", why: why(reason, { count: conquered }) };
  }
  const i = softmaxPick(viable.map(p => p.utility), profile.temperature, ctx.random, 2);
  const pick = viable[Math.max(0, i)];
  return moveOf(ctx, pick, reasonOf(pick.endFx, sit), sit);
}

/** The decision object for a plan's first step. */
function moveOf(ctx, plan, reason, sit) {
  const memo = turnMemo(ctx);
  const lv = plan.level ?? planLevel(ctx, profileOf(ctx), plan, sit);
  const data = {
    from: plan.from, to: plan.to, chance: round(plan.P, 2), value: valueLabel(lv),
    ...(plan.chain ? { label: `toward ${ctx.state.territories[plan.end]?.name ?? plan.end}`, territory: plan.end } : {}),
    ...(plan.endFx.hq ? { faction: plan.endFx.hq } : (plan.defender ? { faction: plan.defender } : {}))
  };
  memo.plan = plan.chain ? { path: plan.path, end: plan.end } : null;
  if ( plan.kind === "attack" ) {
    memo.attacked.add(plan.to);
    memo.current = { from: plan.from, to: plan.to };
    return { type: "attack", from: plan.from, to: plan.to, dice: plan.dice, why: why(reason, { ...data, dice: plan.dice }) };
  }
  memo.current = null;
  return { type: "expand", from: plan.from, to: plan.to, count: plan.count, why: why(reason, { ...data, count: plan.count }) };
}

/**
 * Extra troops to move into a territory just conquered or expanded into. Decided in code (no Jev): move forward when
 * the new territory faces the enemy and the old one doesn't, split by pressure when both do, keep HQ garrisons.
 */
export async function moveIn(ctx, { from, to, min = 0, max = 0 } = {}) {
  const profile = profileOf(ctx);
  const { state, me } = ctx;
  if ( max <= min ) return { count: min, why: why("holdBack", { from, to, count: min }) };
  const memo = turnMemo(ctx);
  const sit = memo.situation ?? ctx.situation ?? null;
  const pressure = id => (state.territories[id]?.neighbors ?? []).filter(n => n !== from && n !== to)
    .map(n => state.territories[n]).filter(n => n && n.owner !== me)
    .reduce((s, n) => s + (n.owner ? n.troops + 1 : 0.5), 0);
  const fromP = pressure(from);
  const toP = pressure(to);
  let count;
  const pressOn = memo.plan?.path?.includes(to) && memo.plan.end !== to;
  if ( pressOn || (toP > 0 && fromP === 0) ) count = max;
  else if ( toP === 0 && fromP > 0 ) count = min;
  else if ( toP === 0 && fromP === 0 ) count = Math.round((min + max) / 2);
  else count = Math.round(min + ((max - min) * (toP / (toP + fromP))));
  // Keep an HQ garrison in the territory we came from.
  const fromT = state.territories[from];
  if ( fromT?.hq && fromT.owner === me && sit ) {
    const keep = Math.max(profile.attack.hqFloor ?? 1,
      garrisons(ctx, profile, sit)[from] ?? (sit.hqDangerLevel >= READ.dangerRealChance ? Math.ceil(fromT.troops / 2) : 1));
    const movable = Math.max(0, fromT.troops - keep);
    count = Math.min(count, Math.max(min, movable));
  }
  count = clamp(count, min, max);
  return { count, why: why(count > min ? "pressOn" : "holdBack", { from, to, count }) };
}

/* -------------------------------------------- */
/*  Step 4: maneuver                            */
/* -------------------------------------------- */

/** The one maneuver of the turn, or null. */
export async function planManeuver(ctx) {
  const profile = profileOf(ctx);
  if ( profile.maneuver === "never" ) return null;
  const { state, me } = ctx;
  const gate = rules.checkTurnAction(state, me, "maneuver");
  if ( !gate.ok && state.turn ) return null;
  const sit = await situationOf(ctx);
  const memo = turnMemo(ctx);
  const full = profile.context === "full";
  const fronts = frontsOf(ctx, { withCards: full });
  const owned = state.factions[me]?.territories ?? [];
  if ( owned.length < 2 ) return null;
  const keep = garrisons(ctx, profile, sit);
  for ( const [id, n] of Object.entries(hqKeep(ctx, profile)) ) keep[id] = Math.max(n, keep[id] ?? 1);

  // Troops each territory can spare: interior ones all but one; frontier ones what exceeds their own need.
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

  // Exposure judgments for the top destinations (one request).
  const dests = fronts.filter(f => f.threat.p >= 0.05 || f.loses.hq).slice(0, 4);
  if ( profile.askExposure && dests.length ) {
    const list = standings(ctx);
    const answers = await ask(ctx, "maneuver", {
      you: youBlock(ctx, list),
      ...(profile.context !== "self" ? { factions: factionsBlock(ctx, list, factionKeys(ctx, list), depthOf(profile)) } : {}),
      fronts: Object.fromEntries(dests.map(f => [f.id, frontFacts(ctx, f)]))
    }, exposureQuestions({ me: factionName(ctx, me), keys: dests.map(f => f.id) }));
    for ( const f of dests ) memo.exposure[f.id] = noulOf(answers, `attacked_${f.id}`, f.threat.p);
  }

  let best = null;
  const consider = (from, to, count, score, reason) => {
    if ( count < 1 || from === to ) return;
    if ( !rules.checkManeuver(state, me, from, to, count, { ignoreTurn: true }).ok ) return;
    if ( !best || score > best.score ) best = { from, to, count, score, reason };
  };
  for ( const f of fronts ) {
    const exposure = memo.exposure[f.id] ?? f.threat.p;
    const stake = (f.loses.hq ? 3 : 0) + f.loses.continents.length + ((f.population ?? state.territories[f.id].population) ? 0.5 : 0);
    const hq = !!state.territories[f.id].hq && profile.maneuver === "reinforce";
    for ( const src of owned ) {
      if ( src === f.id || !spare[src] ) continue;
      const n = spare[src];
      const weight = (exposure * (1 + stake)) + (hq ? 0.5 : 0) + (isInterior(src) ? 0.3 : 0) + (f.enemies.length ? 0.2 : 0);
      const reason = state.territories[f.id].hq === me ? "reinforceHq" : (exposure >= NOUL.yes ? "defendBorder" : "consolidate");
      consider(src, f.id, n, weight * Math.min(n, 12), reason);
    }
  }
  if ( !best || best.score < 0.5 ) return null;
  return { from: best.from, to: best.to, count: best.count, why: why(best.reason, { from: best.from, to: best.to, count: best.count, territory: best.to }) };
}

/* -------------------------------------------- */
/*  Step 5: end of turn                         */
/* -------------------------------------------- */

/**
 * End of turn. Decided in code (no Jev): a completable mission is always taken (a permanent Red Star beats a card);
 * otherwise the card worth the most coins, ties broken by Khan Industries' free troop, then by denying the leader.
 * @returns {{draw, completeMission, powers, why}}
 */
export async function planEndOfTurn(ctx, { drawOptions = null, missionStatus = null } = {}) {
  const { state, me } = ctx;
  const ms = missionStatus ?? ctx.view?.missionStatus ?? null;
  // Only a mission the code verifies: "manual" missions are claims a bot can't back up (the driver checks the same).
  if ( ms && ms.canComplete && (ms.status === "complete") ) {
    return { draw: null, completeMission: true, powers: {}, why: why("completeMission", { count: ms.reward ?? 1, label: ctx.view?.mission?.name }) };
  }
  const opts = drawOptions ?? ctx.view?.drawOptions ?? null;
  if ( !opts?.canDraw ) return { draw: null, completeMission: false, powers: {}, why: why("noDraw") };
  const row = opts.row ?? ctx.view?.row ?? [];
  const ids = opts.territoryCardIds ?? [];
  const khan2 = rules.hasPower(state, me, "khan_2");
  if ( ids.length ) {
    const cards = ids.map(id => {
      const r = row.find(x => x.cardId === id) ?? {};
      return { id, territory: r.territory, coins: r.value ?? r.coins ?? 1, slot: r.slot ?? 0 };
    });
    const score = c => (c.coins * 10) + ((khan2 && state.territories[c.territory]?.owner === me) ? 5 : 0) + (c.slot / 10);
    cards.sort((a, b) => score(b) - score(a));
    const pick = cards[0];
    const powers = (khan2 && state.territories[pick.territory]?.owner === me) ? { khan_2: true } : {};
    return { draw: { cardId: pick.id }, completeMission: false, powers, why: why("drawCard", { territory: pick.territory, count: pick.coins }) };
  }
  if ( opts.coinAllowed ) return { draw: { coin: true }, completeMission: false, powers: {}, why: why("drawCoin") };
  return { draw: null, completeMission: false, powers: {}, why: why("noDraw") };
}

