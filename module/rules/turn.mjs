import { PHASE_ORDER } from "../config.mjs";
import { fail, ok } from "./result.mjs";
import { faction, turnLog } from "./state.mjs";
import { hasPower, POWERS } from "./powers.mjs";

/**
 * Turn-step gating (rulebook p.8: the five steps, in order).
 *
 *   1 start     buy Red Stars, play start-of-turn scars
 *   2 recruit   Join the War *or* Recruit Troops (+ trade cards for troops), then place them
 *   3 attack    expand & attack (optional)
 *   4 maneuver  one maneuver (optional); nobody attacks after maneuvering
 *   5 end       end-of-turn scars, mission or resource card, events
 *
 * Smooth auto-advance: when an action belongs to a later step and everything the earlier steps require is done
 * (recruited or joined, no reserve left), the check passes with `data.advance = <phase>` and the caller moves the
 * war to that phase before acting.
 */

/** Actions checked by `checkTurnAction`. */
export const TURN_ACTIONS = Object.freeze([
  "buyRedStars", "trade", "recruit", "join", "place", "expand", "attack", "maneuver", "endTurn"
]);

const idx = phase => PHASE_ORDER.indexOf(phase);
const inStep2OrBefore = phase => idx(phase) <= idx("recruit");

/**
 * Is step 2 done (recruited or joined the war)?
 * @returns {boolean}
 */
export function step2Done(state) {
  const log = turnLog(state);
  return !!(log.recruited || log.joinedWar);
}

/**
 * May the faction take this kind of action now?
 * @param {object} state      BoardState
 * @param {string} factionId
 * @param {string} action     one of TURN_ACTIONS
 * @returns {import("./result.mjs").RuleResult}  `data.advance` = phase to move to first, when auto-advancing
 */
export function checkTurnAction(state, factionId, action) {
  const turn = state?.turn;
  if ( !turn ) return fail("RL.Rules.turn.noWar");
  if ( turn.stage !== "playing" ) return fail("RL.Rules.turn.notPlaying");
  if ( turn.faction !== factionId ) return fail("RL.Rules.turn.notYourTurn");
  const f = faction(state, factionId);
  if ( !f ) return fail("RL.Rules.turn.unknownFaction");
  if ( f.status === "eliminated" ) return fail("RL.Rules.turn.eliminated");

  const log = turnLog(state);
  const phase = turn.phase;
  const owns = (f.territories?.length ?? 0) > 0;
  const reserve = f.reserve ?? 0;
  const done2 = step2Done(state);

  /** Shared gate for actions of steps 3–4 taken while still in steps 1–2. */
  const leaveStep2 = target => {
    if ( !done2 ) return fail(owns ? "RL.Rules.turn.recruitFirst" : "RL.Rules.turn.joinFirst");
    if ( reserve > 0 ) return fail("RL.Rules.turn.placeReserveFirst", { reserve });
    return ok({ advance: target });
  };

  switch ( action ) {
    case "buyRedStars":
      if ( phase !== "start" ) return fail("RL.Rules.stars.onlyAtStart");
      return ok();

    case "trade":
      if ( !inStep2OrBefore(phase) ) return fail("RL.Rules.trade.wrongPhase");
      if ( log.joinedWar ) return fail("RL.Rules.trade.joinedWar");
      if ( !owns ) return fail("RL.Rules.trade.mustJoin");
      if ( log.tradedForTroops ) return fail("RL.Rules.trade.already");
      return ok({ advance: phase === "start" ? "recruit" : null });

    case "recruit":
      if ( !inStep2OrBefore(phase) ) return fail("RL.Rules.recruit.wrongPhase");
      if ( log.recruited ) return fail("RL.Rules.recruit.already");
      if ( log.joinedWar ) return fail("RL.Rules.recruit.joinedWar");
      if ( !owns ) return fail("RL.Rules.recruit.mustJoin");
      return ok({ advance: phase === "start" ? "recruit" : null });

    case "join":
      if ( !inStep2OrBefore(phase) ) return fail("RL.Rules.join.wrongPhase");
      if ( log.joinedWar ) return fail("RL.Rules.join.already");
      if ( log.recruited || owns ) return fail("RL.Rules.join.controlsTerritory");
      return ok({ advance: phase === "start" ? "recruit" : null });

    case "place":
      if ( !inStep2OrBefore(phase) ) return fail("RL.Rules.place.wrongPhase");
      if ( !done2 ) return fail("RL.Rules.place.recruitFirst");
      if ( reserve <= 0 ) return fail("RL.Rules.place.noReserve");
      return ok({ advance: phase === "start" ? "recruit" : null });

    case "expand":
    case "attack":
      if ( phase === "attack" ) {
        if ( log.maneuver?.done && !hasPower(state, factionId, POWERS.saharan1) ) return fail("RL.Rules.attack.afterManeuver");
        return ok({ advance: null });
      }
      if ( inStep2OrBefore(phase) ) return leaveStep2("attack");
      return fail("RL.Rules.attack.afterManeuver");

    case "maneuver": {
      if ( log.maneuver?.done ) return fail("RL.Rules.maneuver.done");
      if ( phase === "end" ) return fail("RL.Rules.maneuver.wrongPhase");
      // Saharan Republic: "You can make your maneuver at any point during your turn." (no phase change)
      if ( hasPower(state, factionId, POWERS.saharan1) ) return ok({ advance: null, anyTime: true });
      if ( phase === "maneuver" ) return ok({ advance: null });
      if ( phase === "attack" ) return ok({ advance: "maneuver" });
      return leaveStep2("maneuver");
    }

    case "endTurn":
      if ( !done2 ) return fail(owns ? "RL.Rules.turn.recruitFirst" : "RL.Rules.turn.joinFirst");
      if ( reserve > 0 ) return fail("RL.Rules.turn.placeReserveFirst", { reserve });
      return ok();

    default:
      return fail("RL.Rules.turn.unknownAction", { action });
  }
}

/**
 * May the turn move to this phase? Only forward, and never past step 2 with troops left to place.
 * @param {object} state
 * @param {string} factionId
 * @param {string} phase  target phase
 * @returns {import("./result.mjs").RuleResult}
 */
export function checkPhaseChange(state, factionId, phase) {
  const turn = state?.turn;
  if ( !turn ) return fail("RL.Rules.turn.noWar");
  if ( turn.stage !== "playing" ) return fail("RL.Rules.turn.notPlaying");
  if ( turn.faction !== factionId ) return fail("RL.Rules.turn.notYourTurn");
  if ( !PHASE_ORDER.includes(phase) ) return fail("RL.Rules.phase.unknown", { phase });
  const from = idx(turn.phase);
  const to = idx(phase);
  if ( to < from ) return fail("RL.Rules.phase.backwards");
  if ( to === from ) return ok({ unchanged: true });
  if ( to > idx("recruit") ) {
    const f = faction(state, factionId);
    const owns = (f?.territories?.length ?? 0) > 0;
    if ( !step2Done(state) ) return fail(owns ? "RL.Rules.turn.recruitFirst" : "RL.Rules.turn.joinFirst");
    if ( (f?.reserve ?? 0) > 0 ) return fail("RL.Rules.turn.placeReserveFirst", { reserve: f.reserve });
  }
  return ok();
}

/** The phase after this one (or null after "end"). */
export function nextPhase(phase) {
  const i = idx(phase);
  return (i >= 0) && (i < PHASE_ORDER.length - 1) ? PHASE_ORDER[i + 1] : null;
}
