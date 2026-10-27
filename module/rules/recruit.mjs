import { CARDS_PER_RED_STAR, MIN_RECRUIT, STARTING_TROOPS, TROOP_TRADE } from "../config.mjs";
import { fail, ok } from "./result.mjs";
import { faction, turnFlags } from "./state.mjs";
import { hasPower, POWERS } from "./powers.mjs";
import { checkTurnAction } from "./turn.mjs";

/**
 * Recruiting (rulebook p.9): (territories + population) / 3, rounded down, at least 3; plus continent bonuses (the
 * continent's printed bonus + its ±1 mark, and +1 for the player who named it); plus troops from cards.
 */

/** Highest coin total that can be turned in at once. */
export const MAX_TRADE_COINS = 10;

/**
 * @typedef {object} RecruitBreakdown
 * @property {number} territories
 * @property {number} population          0 with the `primitive` weakness
 * @property {boolean} populationIgnored  `primitive`
 * @property {number} sum                 territories + population
 * @property {number} divided             sum / 3, rounded down (up with `balkania_1`)
 * @property {number} base                max(MIN_RECRUIT, divided)
 * @property {boolean} roundedUp          `balkania_1`
 * @property {boolean} minimumApplied     the minimum of 3 was used
 * @property {{id, label, name, value, namerBonus, total, denied}[]} continents
 * @property {number} continentTotal
 * @property {{source: string, troops: number}[]} extras   faction powers adding troops (aliens_knockout)
 * @property {number} extraTotal
 * @property {number} total
 */

/**
 * How many troops the faction recruits this turn (cards not included).
 * @param {object} state      BoardState
 * @param {string} factionId
 * @param {object} [options]
 * @param {string[]} [options.denied]  continents whose bonus is denied this turn (Bad Intel); default from the turn
 * @returns {RecruitBreakdown}
 */
export function recruitBreakdown(state, factionId, { denied } = {}) {
  const f = faction(state, factionId);
  denied ??= turnFlags(state).deniedContinents ?? [];
  const territories = f?.territories?.length ?? 0;
  const populationIgnored = hasPower(state, factionId, POWERS.primitive);
  const population = populationIgnored ? 0 : (f?.population ?? 0);
  const sum = territories + population;
  const roundedUp = hasPower(state, factionId, POWERS.balkania1);
  const divided = roundedUp ? Math.ceil(sum / 3) : Math.floor(sum / 3);
  const base = Math.max(MIN_RECRUIT, divided);

  const continents = [];
  for ( const id of f?.continents ?? [] ) {
    const c = state.continents?.[id];
    if ( !c ) continue;
    const value = Math.max(0, c.value ?? ((c.bonus ?? 0) + (c.modifier ?? 0)));
    const namerBonus = (c.namedById && f.playerId && (c.namedById === f.playerId)) ? 1 : 0;
    const isDenied = denied.includes(id);
    continents.push({
      id, label: c.label ?? id, name: c.name ?? "", value, namerBonus, denied: isDenied,
      total: isDenied ? 0 : value + namerBonus
    });
  }
  const continentTotal = continents.reduce((n, c) => n + c.total, 0);

  const extras = [];
  if ( hasPower(state, factionId, POWERS.aliensKnockout) ) {
    // "2 extra troops if you control Alien Island and 1 extra troop for every Ruin you control."
    const owned = (f?.territories ?? []).map(id => state.territories[id]).filter(Boolean);
    const island = owned.some(t => t.id === "alien_island") ? 2 : 0;
    const ruins = owned.filter(t => t.marks?.includes("ruins")).length;
    if ( island + ruins ) extras.push({ source: POWERS.aliensKnockout, troops: island + ruins });
  }
  const extraTotal = extras.reduce((n, e) => n + e.troops, 0);

  return {
    territories, population, populationIgnored, sum, divided, base, roundedUp,
    minimumApplied: divided < MIN_RECRUIT,
    continents, continentTotal, extras, extraTotal,
    total: base + continentTotal + extraTotal
  };
}

/**
 * May the faction recruit now?
 * @returns {import("./result.mjs").RuleResult}  data.breakdown
 */
export function checkRecruit(state, factionId) {
  const gate = checkTurnAction(state, factionId, "recruit");
  if ( !gate.ok ) return gate;
  return ok({ ...gate.data, breakdown: recruitBreakdown(state, factionId) });
}

/**
 * Troops for a number of resources (coins) turned in, from the board chart.
 * @param {number} coins
 * @returns {number} 0 below 2 or above 10 (not allowed)
 */
export function troopsForCoins(coins) {
  if ( !Number.isInteger(coins) || (coins < 2) || (coins > MAX_TRADE_COINS) ) return 0;
  return TROOP_TRADE[coins] ?? 0;
}

/**
 * May the faction turn in this many resources for troops now, and what do they get?
 * `alien_collaborator`: +1 to the resource total (capped at the chart's 10).
 * @param {object} state
 * @param {string} factionId
 * @param {number} coins      resources on the cards turned in
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurn]  skip the turn-step check
 * @returns {import("./result.mjs").RuleResult}  data {coins, effective, troops, advance}
 */
export function checkTrade(state, factionId, coins, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "trade");
  if ( !gate.ok ) return gate;
  if ( !Number.isInteger(coins) || (coins < 1) ) return fail("RL.Rules.trade.tooFew", { coins });
  if ( coins > MAX_TRADE_COINS ) return fail("RL.Rules.trade.tooMany", { coins, max: MAX_TRADE_COINS });
  const bonus = hasPower(state, factionId, POWERS.alienCollaborator) ? 1 : 0;
  const effective = Math.min(MAX_TRADE_COINS, coins + bonus);
  if ( effective < 2 ) return fail("RL.Rules.trade.tooFew", { coins });
  const f = faction(state, factionId);
  if ( f?.hand && (f.hand.coins < coins) ) return fail("RL.Rules.trade.notEnough", { coins, have: f.hand.coins });
  return ok({ ...gate.data, coins, effective, bonus, troops: troopsForCoins(effective) });
}

/**
 * May the faction turn in this many resource cards for Red Stars now? (4 cards each, any number of times, at the
 * start of the turn.)
 * @returns {import("./result.mjs").RuleResult}  data {stars}
 */
export function checkBuyRedStars(state, factionId, cardCount, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "buyRedStars");
  if ( !gate.ok ) return gate;
  if ( !Number.isInteger(cardCount) || (cardCount < CARDS_PER_RED_STAR) || (cardCount % CARDS_PER_RED_STAR) ) {
    return fail("RL.Rules.stars.multiple", { per: CARDS_PER_RED_STAR, count: cardCount });
  }
  const f = faction(state, factionId);
  if ( f?.hand && (f.hand.count < cardCount) ) return fail("RL.Rules.stars.notEnough", { count: cardCount, have: f.hand.count });
  return ok({ stars: cardCount / CARDS_PER_RED_STAR });
}

/** Troops placed when joining the war: half the starting troops, rounded down (8 → 4). */
export function joinWarTroops(startingTroops = STARTING_TROOPS) {
  return Math.floor(startingTroops / 2);
}
