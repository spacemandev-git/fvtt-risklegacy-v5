import { fail, ok } from "./result.mjs";
import { cityType, faction, territory, turnFlags, turnLog } from "./state.mjs";
import { hasPower, POWERS } from "./powers.mjs";

/**
 * Drawing a resource card and completing missions (rulebook pp.12–13).
 */

/**
 * Is the faction entitled to a resource card at the end of this turn?
 *   - conquered at least one territory this turn;
 *   - `balkania_2`: expanded into 4+ territories;
 *   - `resourceful`: expanded into a city territory.
 * Expanding alone never qualifies. One card per turn, and not on a turn a mission is completed.
 * @returns {import("./result.mjs").RuleResult}  data {via: "conquest"|"balkania_2"|"resourceful"}
 */
export function resourceDrawEligibility(state, factionId) {
  const log = turnLog(state);
  if ( !faction(state, factionId) ) return fail("RL.Rules.turn.unknownFaction");
  if ( log.cardDrawn ) return fail("RL.Rules.draw.already");
  if ( log.missionCompleted ) return fail("RL.Rules.draw.missionCompleted");
  if ( (log.conquered ?? 0) >= 1 ) return ok({ via: "conquest" });
  if ( hasPower(state, factionId, POWERS.balkania2) && ((log.expanded ?? 0) >= 4) ) return ok({ via: POWERS.balkania2 });
  if ( hasPower(state, factionId, POWERS.resourceful) && log.expandedIntoCity ) return ok({ via: POWERS.resourceful });
  return fail("RL.Rules.draw.notEligible");
}

/**
 * Which cards may the faction take from the sideboard?
 *   - If it controls one or more territories shown in the row, it must take one of those.
 *   - Otherwise it takes a face-up Coin card, if there are any.
 *   - Otherwise nothing.
 * Extensions: `homeland` (Rules addition F: row cards in the faction's homeland count as controlled),
 * `recon` (missile power: instead of a coin, any face-up territory card), `interference` (card ids that can't be
 * drawn). By default `recon`/`interference` are read from the turn flags.
 *
 * @param {object} state
 * @param {string} factionId
 * @param {{cardId: string, territory: string, slot: number}[]} row
 * @param {object} [options]
 * @param {boolean} [options.coinPileEmpty=false]
 * @param {string|null} [options.homeland]      continent id
 * @param {boolean} [options.anyTerritory]      Recon
 * @param {string[]} [options.excluded]         Interference
 * @returns {{territoryCardIds: string[], coinAllowed: boolean, mustTakeTerritory: boolean, recon: boolean}}
 */
export function resourceDrawChoices(state, factionId, row = [], options = {}) {
  const flags = turnFlags(state);
  const {
    coinPileEmpty = false, homeland = null,
    anyTerritory = !!flags.recon, excluded = flags.interference ?? []
  } = options;
  const cards = (row ?? []).filter(r => r?.cardId && !excluded.includes(r.cardId));
  const mine = cards.filter(r => {
    const t = territory(state, r.territory);
    return (t?.owner === factionId) || (homeland && (t?.continent === homeland));
  });
  if ( mine.length ) {
    return { territoryCardIds: mine.map(r => r.cardId), coinAllowed: false, mustTakeTerritory: true, recon: false };
  }
  if ( anyTerritory && cards.length ) {
    return { territoryCardIds: cards.map(r => r.cardId), coinAllowed: !coinPileEmpty, mustTakeTerritory: false, recon: true };
  }
  return { territoryCardIds: [], coinAllowed: !coinPileEmpty, mustTakeTerritory: false, recon: false };
}

/**
 * A faction's homeland (Rules addition F): the continent that has been its starting location most often (including
 * this game). No homeland on a tie.
 * @param {{startingTerritory: string}[]} history   faction history rows (+ this game's)
 * @param {(territoryId: string) => string} continentOf
 * @returns {string|null}
 */
export function homelandContinent(history = [], continentOf = () => null) {
  const counts = {};
  for ( const row of history ) {
    const c = row?.startingTerritory ? continentOf(row.startingTerritory) : null;
    if ( c ) counts[c] = (counts[c] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if ( !sorted.length || ((sorted.length > 1) && (sorted[0][1] === sorted[1][1])) ) return null;
  return sorted[0][0];
}

/**
 * Evaluate a structured mission check (`mission.system.check`, vocabulary in data/content/README.md) for the faction
 * at the end of its turn. Uses the turn record (`turn.flags.conquests`, `trade`, `knockouts`, `startContinents`).
 * @returns {boolean|null}  null when the check can't be evaluated automatically
 */
export function missionCheck(state, factionId, check) {
  if ( !check?.type ) return null;
  const f = faction(state, factionId);
  if ( !f ) return false;
  const flags = turnFlags(state);
  const count = check.count ?? 1;
  const owned = (f.territories ?? []).map(id => territory(state, id)).filter(Boolean);
  const conquests = flags.conquests ?? [];
  switch ( check.type ) {
    case "all": {
      const results = (check.checks ?? []).map(c => missionCheck(state, factionId, c));
      if ( results.includes(false) ) return false;
      return results.includes(null) ? null : true;
    }
    case "controlContinents": {
      const list = check.when === "startOfTurn" ? (flags.startContinents ?? null) : f.continents;
      return list ? list.length >= count : null;
    }
    case "continentBonusTotal": {
      const total = (f.continents ?? []).reduce((n, id) => {
        const c = state.continents?.[id];
        const bonus = c ? Math.max(0, c.value ?? (c.bonus + (c.modifier ?? 0))) : 0;
        const namer = (c?.namedById && (c.namedById === f.playerId)) ? 1 : 0;
        return n + bonus + namer;
      }, 0);
      return total >= count;
    }
    case "controlTerritoriesWithCities": {
      const type = check.cityType ? cityType(check.cityType) : null;
      return owned.filter(t => t.city && (!type || (t.city.type === type))).length >= count;
    }
    case "controlAllCities": {
      const cities = Object.values(state.territories ?? {}).filter(t => t.city);
      return cities.length > 0 && cities.every(t => t.owner === factionId);
    }
    case "controlAllScarred": {
      const scarred = Object.values(state.territories ?? {}).filter(t => (check.scars ?? []).includes(t.scar));
      return scarred.length > 0 && scarred.every(t => t.owner === factionId);
    }
    case "controlMarked": {
      const marked = Object.values(state.territories ?? {}).filter(t => t.marks?.includes(check.mark));
      return marked.length > 0 && marked.every(t => t.owner === factionId);
    }
    case "conquerThisTurn": {
      let list = conquests;
      if ( check.via === "seaLine" ) list = list.filter(c => c.seaLine);
      if ( check.cities ) list = list.filter(c => c.city);
      return list.length >= count;
    }
    case "conquerContinentThisTurn": {
      const taken = new Set(conquests.map(c => c.to));
      const full = Object.values(state.continents ?? {})
        .filter(c => c.territories?.length && c.territories.every(id => taken.has(id)));
      return full.length >= count;
    }
    case "turnInResources":
      return (flags.trade?.coins ?? 0) >= count;
    case "turnInCards": {
      const cards = (flags.trade?.cards ?? []).filter(c => !check.cardType || (c.type === check.cardType))
        .filter(c => (c.value ?? 0) >= (check.minResourcesEach ?? 0));
      return cards.length >= count;
    }
    case "knockOutPlayer":
      return (flags.knockouts ?? []).some(k => (k.handCount ?? 0) >= (check.minResourceCards ?? 0));
    default:
      return null;
  }
}
