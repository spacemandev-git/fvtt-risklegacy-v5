import { RED_STARS_TO_WIN } from "../config.mjs";
import { faction } from "./state.mjs";

/**
 * Red Stars and victory (rulebook p.8, p.14).
 *
 * A faction's Red Star total = Red Star tokens in front of the player + every HQ it controls on the board (HQs count
 * for whoever controls the territory they stand in). You win immediately with 4, or when every other faction in the
 * war is eliminated.
 */

/** @returns {number} HQs the faction controls (HQ pieces in territories where it has troops) */
export function hqsControlled(state, factionId) {
  return Object.values(state?.territories ?? {}).filter(t => (t.owner === factionId) && t.hq).length;
}

/** @returns {number} the faction's current Red Star total */
export function redStarTotal(state, factionId) {
  const f = faction(state, factionId);
  if ( !f ) return 0;
  return (f.redStarTokens ?? 0) + hqsControlled(state, factionId);
}

/** Factions taking part in the war. */
const participants = state => Object.values(state?.factions ?? {}).filter(f => f.active);

/**
 * Has someone won?
 * @param {object} state
 * @param {object} [options]
 * @param {string} [options.current]  faction whose turn it is (preferred when several reach 4 at once)
 * @returns {{winner: string, reason: "redStars"|"lastStanding", stars: number}|null}
 */
export function victoryCheck(state, { current = state?.turn?.faction ?? null } = {}) {
  const active = participants(state);
  if ( !active.length ) return null;
  const alive = active.filter(f => f.status !== "eliminated");
  const scored = alive.map(f => ({ id: f.id, seat: f.seat ?? 0, stars: redStarTotal(state, f.id) }))
    .filter(f => f.stars >= RED_STARS_TO_WIN);
  if ( scored.length ) {
    scored.sort((a, b) => (Number(b.id === current) - Number(a.id === current)) || (b.stars - a.stars) || (a.seat - b.seat));
    return { winner: scored[0].id, reason: "redStars", stars: scored[0].stars };
  }
  if ( (active.length >= 2) && (alive.length === 1) ) {
    return { winner: alive[0].id, reason: "lastStanding", stars: redStarTotal(state, alive[0].id) };
  }
  return null;
}

/**
 * Results for the back of the faction cards: the winner Won; a faction with no troops on the board (or eliminated)
 * was Eliminated, "even if you could've Joined the War on your next turn"; everyone else Held On.
 * @param {object} state
 * @param {string|null} winnerId
 * @returns {{faction: string, result: "won"|"heldOn"|"eliminated"}[]} in seat order
 */
export function gameResults(state, winnerId) {
  return participants(state)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
    .map(f => {
      let result = "heldOn";
      if ( f.id === winnerId ) result = "won";
      else if ( (f.status === "eliminated") || ((f.troops ?? 0) <= 0) ) result = "eliminated";
      return { faction: f.id, result };
    });
}

/**
 * Who gets the coin-pile Red Star the first time the coin cards run out: the faction controlling the most
 * territories; nobody on a tie.
 * @returns {string|null}
 */
export function coinPileStarRecipient(state) {
  const alive = participants(state).filter(f => f.status !== "eliminated");
  if ( !alive.length ) return null;
  const counts = alive.map(f => ({ id: f.id, n: f.territories?.length ?? 0 })).sort((a, b) => b.n - a.n);
  if ( (counts.length > 1) && (counts[0].n === counts[1].n) ) return null;
  return counts[0].id;
}
