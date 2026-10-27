/**
 * Area: rules (owner: turn / game logic). ARCHITECTURE.md §5.1.
 *
 * Pure functions of a `BoardState` (module/state/snapshot.mjs): no Foundry runtime access, so everything here runs
 * under `node --test module/rules/tests/`. Every `check*` function returns a RuleResult `{ok, reason, data}`; pass
 * it through `enforce()` (module/state/enforce.mjs) to apply the world's enforcement level.
 *
 * Most checks take an optional last argument `{ignoreTurn: true}` to skip the turn-step gate (whose turn it is,
 * which step) and validate only the board rule.
 */
export * from "./result.mjs";
export {
  territory, faction, turnLog, turnFlags, troopsIn, isOccupied, isMarked, areAdjacent, ownedIds, isFounder,
  deriveState, applyMove, revertMove
} from "./state.mjs";
export {
  POWERS, MISSILE_POWERS, DEFAULT_EFFECTS, hasPower, effectOf, territoryEffects, territoryHas, powerEffects
} from "./powers.mjs";
export { TURN_ACTIONS, checkTurnAction, checkPhaseChange, nextPhase, step2Done } from "./turn.mjs";
export {
  MAX_TRADE_COINS, recruitBreakdown, checkRecruit, troopsForCoins, checkTrade, checkBuyRedStars, joinWarTroops
} from "./recruit.mjs";
export {
  checkStartingTerritory, legalStartingTerritories, checkJoinWar, canJoinWar, checkPlacement, placementTargets,
  hqPlacements, checkMoveHQ
} from "./placement.mjs";
export {
  maxAttackDice, defenderMaxDice, enterLosses, expandCost, checkExpand, checkAttack, connectedThroughOwned,
  checkManeuver, checkAdvance, classifyMove, expandTargets, attackTargets, maneuverTargets
} from "./movement.mjs";
export { hqsControlled, redStarTotal, victoryCheck, gameResults, coinPileStarRecipient } from "./victory.mjs";
export { resourceDrawEligibility, resourceDrawChoices, homelandContinent, missionCheck } from "./cards.mjs";
export { endOfTurnEffects } from "./effects.mjs";
export { MINOR_CITY_COUNT, THIRTY_TROOPS, THREE_MISSILES, minorCitiesOnBoard, packTriggers } from "./packs.mjs";

/** Called in the system's "init" hook. The engine is stateless: nothing to register. */
export function init() {}

/** Called after board definitions and the content catalog are loaded. */
export function ready() {}
