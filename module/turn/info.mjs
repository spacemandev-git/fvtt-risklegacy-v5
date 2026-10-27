import { PHASES } from "../config.mjs";
import { canActFor, factionOfUser, getWar } from "../state/_module.mjs";
import * as rules from "../rules/_module.mjs";
import WarData from "../data/combat-war.mjs";
import { activeFactionId, snapshot } from "./util.mjs";
import { powerOptions } from "./actions.mjs";

/**
 * `getTurnInfo()`: synchronous and cheap, for the War Room HUD (called on every render).
 *
 * The result is cached until a relevant document changes (combat, combatant, actor, token, card, item hooks).
 * `snapshot`, `actions` and `recruit` are lazy getters: the board snapshot is only built when something reads them,
 * once per cache generation.
 */

let cached = null;

/** Drop the cached info (called from document hooks). */
export function invalidate() {
  cached = null;
}

/** Document hooks that invalidate the cache. */
export const INVALIDATING_HOOKS = [
  "createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant",
  "createActor", "updateActor", "deleteActor", "createItem", "updateItem", "deleteItem",
  "createToken", "updateToken", "deleteToken", "createCard", "updateCard", "deleteCard",
  "createCards", "updateCards", "deleteCards", "createRegion", "updateRegion", "deleteRegion", "canvasReady"
];

/**
 * @typedef {object} TurnInfo
 * @property {Combat|null} war
 * @property {string|null} stage         setup | placement | playing | ended
 * @property {string|null} phase         start | recruit | attack | maneuver | end
 * @property {number} step               1..5 (0 outside a turn)
 * @property {number} round
 * @property {number|null} game
 * @property {Actor|null} faction        whose turn it is (playing) / who is choosing a starting territory (placement)
 * @property {string|null} factionId
 * @property {boolean} isMyTurn          this user may act for `faction`
 * @property {Actor|null} myFaction      this user's faction in the war
 * @property {object|null} log           war.system.turn (fresh if the start-of-turn reset hasn't landed yet)
 * @property {number} reserve            troops left to place
 * @property {string[]} order            faction ids in turn order
 * @property {{order: string[], index: number}|null} placement
 * @property {Actor|null} winner
 * @property {object|null} snapshot      (lazy) BoardState
 * @property {object} actions            (lazy) RuleResult per action: buyRedStars, trade, recruit, joinWar, place,
 *                                       expand, attack, maneuver, endTurn, draw; plus `powers` (activatable powers)
 * @property {object|null} recruit       (lazy) the recruit breakdown for `faction`
 */

/** @returns {TurnInfo} */
export function getTurnInfo() {
  if ( cached ) return cached;
  const war = getWar();
  const stage = war?.system.stage ?? null;
  const factionId = activeFactionId(war);
  const faction = factionId ? game.actors.get(factionId) ?? null : null;
  const phase = war ? war.system.phase : null;
  const log = war?.system.turn ?? null;
  let snap;
  let actions;
  let breakdown;
  const info = {
    war, stage, phase,
    step: (stage === "playing") ? (PHASES[phase]?.step ?? 0) : 0,
    round: war?.round ?? 0,
    game: war?.system.game ?? null,
    faction, factionId,
    isMyTurn: !!faction && canActFor(game.user, faction),
    myFaction: war ? factionOfUser(game.user) : null,
    log: log && factionId && (log.faction !== factionId) && (stage === "playing") ? WarData.freshTurn(factionId) : log,
    reserve: faction?.system.war.reserve ?? 0,
    order: war?.turns.map(c => c.actorId) ?? [],
    placement: stage === "placement" ? { ...war.system.placement } : null,
    winner: war?.system.winner ? (game.actors.get(war.system.winner) ?? null) : null,
    get snapshot() {
      if ( snap === undefined ) {
        try { snap = snapshot(); } catch(err) { snap = null; }
      }
      return snap;
    },
    get actions() {
      actions ??= computeActions(this.snapshot, factionId, stage);
      return actions;
    },
    get recruit() {
      if ( breakdown === undefined ) {
        breakdown = (this.snapshot && factionId && (stage === "playing")) ? rules.recruitBreakdown(this.snapshot, factionId) : null;
      }
      return breakdown;
    }
  };
  cached = info;
  return info;
}

/** RuleResults for every turn action of the current faction. */
function computeActions(snap, fid, stage) {
  if ( !snap || !fid || (stage !== "playing") ) return {};
  const f = snap.factions[fid];
  const check = action => rules.checkTurnAction(snap, fid, action);
  const both = (a, b) => (a.ok ? b : a);
  return {
    buyRedStars: both(check("buyRedStars"), (f?.hand?.count ?? 0) >= 4 ? rules.ok() : rules.fail("RL.Rules.stars.notEnough", { count: 4, have: f?.hand?.count ?? 0 })),
    trade: both(check("trade"), (f?.hand?.coins ?? 0) >= 2 ? rules.ok() : rules.fail("RL.Rules.trade.tooFew", { coins: f?.hand?.coins ?? 0 })),
    recruit: check("recruit"),
    joinWar: both(check("join"), rules.canJoinWar(snap, fid) ? rules.ok({ territories: rules.legalStartingTerritories(snap, fid, { joining: true }) }) : rules.fail("RL.Rules.join.nowhere")),
    place: check("place"),
    expand: check("expand"),
    attack: check("attack"),
    maneuver: check("maneuver"),
    endTurn: check("endTurn"),
    draw: rules.resourceDrawEligibility(snap, fid),
    powers: powerOptions(snap, fid)
  };
}
