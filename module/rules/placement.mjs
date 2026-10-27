import { fail, ok } from "./result.mjs";
import { areAdjacent, faction, isFounder, isMarked, isOccupied, territory, turnFlags } from "./state.mjs";
import { hasPower, POWERS, territoryHas } from "./powers.mjs";
import { checkTurnAction } from "./turn.mjs";

/**
 * Starting territories (rulebook p.7) and troop placement (p.9).
 *
 * A legal starting territory is
 *   - an unoccupied territory with no marks (no scars, cities or pack marks), or
 *   - an unoccupied territory holding a Major City this faction's *player* founded (even with a scar).
 * At the start of the game an HQ cannot be placed adjacent to another faction's HQ (not when joining the war,
 * which places no HQ).
 */

/**
 * Why a territory is or isn't a legal starting territory.
 * @param {object} state
 * @param {string} factionId
 * @param {string} territoryId
 * @param {object} [options]
 * @param {boolean} [options.joining=false]  Join the War (no HQ, so no HQ-adjacency rule)
 * @returns {import("./result.mjs").RuleResult}  data {via: "unmarked"|"majorCity"}
 */
export function checkStartingTerritory(state, factionId, territoryId, { joining = false } = {}) {
  const t = territory(state, territoryId);
  if ( !t ) return fail("RL.Rules.unknownTerritory", { id: territoryId });
  if ( !faction(state, factionId) ) return fail("RL.Rules.turn.unknownFaction");
  const name = t.name ?? territoryId;
  if ( isOccupied(t) ) return fail("RL.Rules.start.occupied", { name });
  let via = "unmarked";
  if ( isMarked(t) ) {
    if ( (t.city?.type === "major") && isFounder(state, factionId, t) ) via = "majorCity";
    else return fail("RL.Rules.start.marked", { name });
  }
  if ( !joining ) {
    const near = (t.neighbors ?? []).map(id => territory(state, id)).find(n => n?.hq && (n.hq !== factionId));
    if ( near ) return fail("RL.Rules.start.adjacentHQ", { name, other: near.name ?? near.id });
  }
  return ok({ via });
}

/**
 * Every legal starting territory for the faction.
 * @param {object} state
 * @param {string} factionId
 * @param {object} [options]
 * @param {boolean} [options.joining=false]
 * @returns {string[]}
 */
export function legalStartingTerritories(state, factionId, { joining = false } = {}) {
  return Object.keys(state?.territories ?? {})
    .filter(id => checkStartingTerritory(state, factionId, id, { joining }).ok);
}

/**
 * May the faction Join the War in this territory now?
 * @returns {import("./result.mjs").RuleResult}
 */
export function checkJoinWar(state, factionId, territoryId, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "join");
  if ( !gate.ok ) return gate;
  const legal = checkStartingTerritory(state, factionId, territoryId, { joining: true });
  if ( !legal.ok ) return legal;
  return ok({ ...gate.data, ...legal.data });
}

/** Can the faction Join the War anywhere? */
export const canJoinWar = (state, factionId) => legalStartingTerritories(state, factionId, { joining: true }).length > 0;

/**
 * May the faction place `count` recruited troops in this territory now?
 *
 * - Only into territories the faction controls (not into the Fallout Zone: `noPlaceTroops`).
 * - `stealthy`: once per turn, some or all of the recruited troops may go into one unmarked, unoccupied territory
 *   ("This is not an expansion").
 * - `cautious`: recruited troops go into no more than 2 territories.
 *
 * @param {object} state
 * @param {string} factionId
 * @param {string} territoryId
 * @param {number} count
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurn]  skip the turn-step and reserve checks
 * @returns {import("./result.mjs").RuleResult}  data {stealthy, advance}
 */
export function checkPlacement(state, factionId, territoryId, count, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "place");
  if ( !gate.ok ) return gate;
  const f = faction(state, factionId);
  const t = territory(state, territoryId);
  if ( !t ) return fail("RL.Rules.unknownTerritory", { id: territoryId });
  if ( !Number.isInteger(count) || (count < 1) ) return fail("RL.Rules.badCount", { count });
  if ( !ignoreTurn && (count > (f?.reserve ?? 0)) ) return fail("RL.Rules.place.tooMany", { count, reserve: f?.reserve ?? 0 });
  const name = t.name ?? territoryId;
  if ( territoryHas(state, territoryId, "noPlaceTroops", factionId) ) return fail("RL.Rules.place.forbidden", { name });

  const flags = turnFlags(state);
  let stealthy = false;
  if ( t.owner !== factionId ) {
    const canSneak = hasPower(state, factionId, POWERS.stealthy) && !flags.stealthy
      && !isOccupied(t) && !isMarked(t);
    if ( !canSneak ) return fail("RL.Rules.place.notControlled", { name });
    stealthy = true;
  }
  if ( hasPower(state, factionId, POWERS.cautious) ) {
    const placed = new Set(flags.placedIn ?? []);
    if ( !placed.has(territoryId) && (placed.size >= 2) ) return fail("RL.Rules.place.cautious", { name });
  }
  return ok({ ...gate.data, stealthy });
}

/**
 * Territories the faction may place recruited troops in right now (for highlighting).
 * @returns {string[]}
 */
export function placementTargets(state, factionId) {
  return Object.keys(state?.territories ?? {}).filter(id => checkPlacement(state, factionId, id, 1).ok);
}

/** Troops placed by HQ-based powers (khan_1: 1, rally: 2): one entry per territory with an HQ the faction controls. */
export function hqPlacements(state, factionId, count = 1) {
  return (faction(state, factionId)?.hqs ?? []).map(id => ({ territory: id, troops: count }));
}

/** Can an HQ move from `from` to `to` (`mobile`: to an adjacent territory you control; HQs cannot share)? */
export function checkMoveHQ(state, factionId, from, to) {
  const a = territory(state, from);
  const b = territory(state, to);
  if ( !a || !b ) return fail("RL.Rules.unknownTerritory", { id: !a ? from : to });
  if ( (a.owner !== factionId) || !a.hq ) return fail("RL.Rules.mobile.noHQ", { name: a.name ?? from });
  if ( b.owner !== factionId ) return fail("RL.Rules.mobile.notControlled", { name: b.name ?? to });
  if ( !areAdjacent(state, from, to) ) return fail("RL.Rules.notAdjacent", { from: a.name ?? from, to: b.name ?? to });
  if ( b.hq ) return fail("RL.Rules.mobile.shared", { name: b.name ?? to });
  return ok({ hqFaction: a.hq });
}
