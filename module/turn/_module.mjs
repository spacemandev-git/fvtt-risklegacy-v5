/**
 * Area: turn (owner: turn / game logic). ARCHITECTURE.md §5.2, exposed as `game.risklegacy.turn`.
 *
 * - War lifecycle and every turn step as GM actions "turn.<verb>" (registered in init()), with client wrappers that
 *   resolve to the handler's result or `null` when refused.
 * - `getTurnInfo()` (sync, cached) for the War Room HUD.
 * - `endTurn()` gathers the player's choices on their own client, then runs "turn.end".
 * - Start-of-turn automation runs from RLCombat#_onStartTurn (module/documents/combat.mjs) via `onStartTurn`.
 */
import { SYSTEM_ID } from "../config.mjs";
import { getWar } from "../state/_module.mjs";
import { registerAction } from "../gm/actions.mjs";
import * as rules from "../rules/_module.mjs";
import * as war from "./war.mjs";
import * as steps from "./actions.mjs";
import { INVALIDATING_HOOKS, invalidate } from "./info.mjs";
import { serialize, snapshot } from "./util.mjs";

export { getTurnInfo } from "./info.mjs";
export {
  createWar, beginPlacement, placeStartingForces, beginPlay, setPhase, advancePhase, buyRedStars, tradeForTroops,
  recruit, joinWar, placeReserve, expand, maneuver, advance, moveHQ, attack, recordConquest, protect, usePower, endWar,
  eliminate, endTurn, choose, confirm, chooseCount
} from "./client.mjs";
export {
  promptStartingTerritory, promptJoinWar, promptBuyRedStars, promptTrade, promptAttack, promptExpand, promptManeuver,
  promptPower
} from "./prompts.mjs";
export { computeResults, advanceTurn } from "./war.mjs";
export { powerOptions, checkPower } from "./actions.mjs";
export { snapshot } from "./util.mjs";

/** GM actions: name → [handler, serialized]. Handlers called by other areas mid-action are not serialized. */
const ACTIONS = {
  "turn.createWar": [war.createWar, true],
  "turn.beginPlacement": [war.beginPlacement, true],
  "turn.placeStartingForces": [war.placeStartingForces, true],
  "turn.beginPlay": [war.beginPlay, true],
  "turn.endWar": [war.endWar, true],
  "turn.eliminate": [war.eliminate, true],
  "turn.setPhase": [steps.setPhase, true],
  "turn.advancePhase": [steps.advancePhase, true],
  "turn.buyRedStars": [steps.buyRedStars, true],
  "turn.tradeForTroops": [steps.tradeForTroops, true],
  "turn.recruit": [steps.recruit, true],
  "turn.joinWar": [steps.joinWar, true],
  "turn.placeReserve": [steps.placeReserve, true],
  "turn.expand": [steps.expand, true],
  "turn.maneuver": [steps.maneuver, true],
  "turn.advance": [steps.advance, true],
  "turn.moveHQ": [steps.moveHQ, true],
  "turn.end": [steps.end, true],
  "turn.usePower": [steps.usePower, true],
  // Called by the battle area (possibly from inside its own handlers): run immediately.
  "turn.attack": [steps.attack, false],
  "turn.recordConquest": [steps.recordConquest, false],
  "turn.protect": [steps.protect, false]
};

/**
 * Start-of-turn automation (called by RLCombat#_onStartTurn on the active GM). Serialized behind the action that
 * ended the previous turn, so the next player's first request sees the fresh turn record.
 */
export function onStartTurn(combat, combatant) {
  return serialize(() => war.startTurn(combat, combatant));
}

/** Victory watcher: Red Star tokens awarded outside the turn flow (coin pile, missions) can end the war. */
const watchVictory = foundry.utils.debounce(() => {
  const w = getWar();
  if ( !game.user.isActiveGM || !w || (w.system.stage !== "playing") ) return;
  serialize(async () => {
    const current = getWar();
    if ( current?.system.stage !== "playing" ) return;
    const win = rules.victoryCheck(snapshot());
    if ( win ) await war.endWarInternal(current, win.winner, win.reason);
  }).catch(err => console.error(`${SYSTEM_ID} | victory check failed`, err));
}, 300);

export function init() {
  for ( const [name, [handler, serialized]] of Object.entries(ACTIONS) ) {
    registerAction(name, serialized ? (payload, ctx) => serialize(() => handler(payload ?? {}, ctx)) : handler);
  }
  for ( const hook of INVALIDATING_HOOKS ) Hooks.on(hook, invalidate);
  Hooks.on("updateActor", (actor, changed) => {
    if ( (actor.type === "faction") && foundry.utils.hasProperty(changed, "system.war.redStarTokens") ) watchVictory();
  });
}

export function ready() {
  invalidate();
}
