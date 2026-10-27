/**
 * Unlock conditions of the sealed packages (rulebook p.15).
 *
 * `packTriggers(state, event)` returns the ids of the packs that are not opened yet (`state.campaign.packs`) and whose
 * condition the event satisfies. Events:
 *
 *   {type: "cityFounded", cityType, territory?, minorCities?}   minorcities on the 9th Minor City, worldcapital for the World Capital
 *   {type: "worldCapitalPlaced"}                                worldcapital
 *   {type: "factionEliminated", faction?}                       eliminated
 *   {type: "gameEnded", results: [{faction, result}]}            eliminated if anyone ended Eliminated
 *   {type: "victorSigned", playerId?, signatureCount}           secondwin when someone signs for the 2nd time
 *   {type: "missilesInRoll", count}                             threemissiles at 3 missiles on one roll
 *   {type: "recruit", faction?, total, missiles?}               thirtytroops: about to place 30+ troops holding a missile
 */

/** Minor Cities in the base game. */
export const MINOR_CITY_COUNT = 9;
/** Troops for the Pocket 2 trigger. */
export const THIRTY_TROOPS = 30;
/** Missiles on one roll for the Pocket 1 trigger. */
export const THREE_MISSILES = 3;

/** Minor Cities on the board. */
export function minorCitiesOnBoard(state) {
  return Object.values(state?.territories ?? {}).filter(t => t.city?.type === "minor").length;
}

/**
 * @param {object} state   BoardState (only `campaign.packs`, `territories` and `factions` are read)
 * @param {object} event
 * @returns {string[]} pack ids to open
 */
export function packTriggers(state, event = {}) {
  const opened = state?.campaign?.packs ?? {};
  const out = new Set();
  switch ( event.type ) {
    case "cityFounded": {
      const type = event.cityType === "worldCapital" ? "capital" : event.cityType;
      if ( type === "capital" ) out.add("worldcapital");
      const minors = event.minorCities ?? minorCitiesOnBoard(state);
      if ( (type === "minor") && (minors >= MINOR_CITY_COUNT) ) out.add("minorcities");
      break;
    }
    case "worldCapitalPlaced":
      out.add("worldcapital");
      break;
    case "factionEliminated":
      out.add("eliminated");
      break;
    case "gameEnded":
      if ( (event.results ?? []).some(r => r.result === "eliminated") ) out.add("eliminated");
      break;
    case "victorSigned":
      if ( (event.signatureCount ?? 0) >= 2 ) out.add("secondwin");
      break;
    case "missilesInRoll":
      if ( (event.count ?? 0) >= THREE_MISSILES ) out.add("threemissiles");
      break;
    case "recruit": {
      const missiles = event.missiles ?? state?.factions?.[event.faction]?.missiles ?? 0;
      if ( ((event.total ?? 0) >= THIRTY_TROOPS) && (missiles >= 1) ) out.add("thirtytroops");
      break;
    }
    default: break;
  }
  return [...out].filter(id => !opened[id]);
}
