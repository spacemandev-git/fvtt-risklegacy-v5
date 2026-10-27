/**
 * The bots' brain: every decision a bot makes, as pure async functions of a BotContext (BOTS.md §5).
 * No Foundry globals in here or below: the driver gathers the context on the GM client, and Node tests pass fixtures.
 * Judgments come from Jev through `ctx.ask`; arithmetic, legality and the final decision stay in code.
 *
 * THIS FILE IS THE CONTRACT: the exported names, parameters and return shapes below are what the driver relies on.
 * Implementations live in ./decide/*.mjs (turn, battle, setup) on top of odds.mjs (exact battle odds), features.mjs
 * (board facts), candidates.mjs (legal moves + code pre-scores), context.mjs (Jev states), judge.mjs (asking and
 * reading answers) and profiles.mjs (difficulty). All question wording is in module/bots/jev/questions.mjs.
 *
 * @typedef {"easy"|"normal"|"hard"} Difficulty
 *
 * @typedef {object} BotView         Public facts the snapshot lacks, gathered by the driver (never hidden information)
 * @property {{id:string, kind:"territory"|"coin", territory:string|null, coins:number}[]} hand   own resource cards
 * @property {Record<string,{count:number, coins:number}>} hands   every active faction's hand size and coin total
 * @property {{id:string, scar:string, name:string, text:string, target:string}[]} scarCards   own scar cards in hand
 * @property {{cardId:string, territory:string, slot:number, coins:number}[]} row   sideboard row, slot 1 first
 * @property {number} coinCount      coin cards left in the coin pile
 * @property {{name:string, text:string, reward:string}|null} mission     the revealed mission
 * @property {object|null} missionStatus   cards.missionStatus(me)
 * @property {object|null} drawOptions     cards.drawOptions(me)
 * @property {Record<string,{key:string, name:string, text:string, timing:string, used:boolean}[]>} powers  by faction id
 * @property {{id:string, name:string, text:string}[]} activeEvents
 * @property {{territory:string, until:string, source:string}[]} protections
 * @property {Record<string,string>} factionNames   faction id → display name
 * @property {number} round
 * @property {number} game            game number in the campaign
 *
 * @typedef {object} BotContext
 * @property {string} me              the bot's faction actor id
 * @property {Difficulty} difficulty
 * @property {object} state           BoardState from game.risklegacy.turn.snapshot()
 * @property {BotView} view
 * @property {Function} lookup        catalog lookup (state findEntry), needed by battle modifiers
 * @property {((purpose:string, request:{state:object, questions:object}) => Promise<{answers:object, model:string, usage:object}>)|null} ask
 *           Sends one Jev request (the client adds `model`). Throws JevError on failure: never catch it to invent an
 *           answer. `null` = heuristic mode (the GM chose to play on without Jev): use the built-in neutral judgments.
 * @property {() => number} random    RNG in [0,1) (seeded in tests)
 * @property {object} [situation]     cached assessSituation() result for this turn
 * @property {Set<string>} [excluded] moves the game refused this turn, as "attack:from>to" / "expand:from>to"
 *
 * Every decision object carries `why: {reason, ...data}` (BOTS.md §5.3) for narration and the log. Reasons added by
 * the brain beyond §5.3: see WHY_REASONS_ADDED. Data fields used beyond §5.3: `heuristic` (true when no Jev answer was
 * used), `count`, `kind`.
 */
export {
  /**
   * Turn-level judgments shared by later decisions (the driver caches it in ctx.situation each turn).
   * @returns {Promise<{leader:string|null, leaderP:number, leaderProbs:Record<string,number>, threats:Record<string,number>,
   *   hqDanger:number, hqDangerLevel:number, hq:string|null, hqWorst:number, hqNeed:number,
   *   cards:{choice:string, probs:object}|null, stars:Record<string,number>, why:object}>}
   *   hqDanger 0..3 (safe, pressured, at risk, likely lost); threats = P(opponent attacks the bot's HQ next turn)
   */
  assessSituation,
  /** Start of turn: Red Star purchase (4 resource cards). Called again while it returns cards. @returns {{buyRedStars:string[]|null, why}} */
  planStartOfTurn,
  /**
   * Start-of-turn scar cards to play.
   * @returns {{plays:{cardId:string, territory?:string, faction?:string}[], why}}  `faction` for weakness scars that target a faction
   */
  planScars,
  /** Step 2: Join the War (when knocked out) or recruit, plus an optional card trade for troops. @returns {{join:string}|{recruit:true, tradeForTroops:string[]|null}} */
  planRecruit,
  /** Where to put the reserve. @returns {{placements:{territory:string, count:number}[], why}} */
  planPlacement,
  /** The next attack or expansion, or stop. Called after every battle/expansion. @returns {{type:"attack", from, to, dice}|{type:"expand", from, to, count}|{type:"stop"}} (+ why) */
  nextMove,
  /** Extra troops to move into a territory just conquered or expanded into. @returns {{count:number, why}} count in [min, max] */
  moveIn,
  /** The one maneuver of the turn, or null. @returns {{from, to, count, why}|null} */
  planManeuver,
  /** End of turn: complete the mission or draw (and which card). @returns {{draw, completeMission, powers, why}} */
  planEndOfTurn
} from "./decide/turn.mjs";

export {
  /** Defender dice for a bot defender. @returns {{dice:number, why}} */
  chooseDefenseDice,
  /** Before the roll: play a Bunker / Ammo Shortage scar card on the defending territory? @returns {{cardId, why}|null} */
  preRollScar,
  /** After the roll: fire one missile, or not. Called again after each missile while the battle is open. @returns {{fire:false, why}|{fire:true, side, index, why}} */
  missileDecision
} from "./decide/battle.mjs";

export {
  /** Starting territory (game setup) or a Join-the-War territory. @returns {{territory:string|null, why}} */
  chooseStartingTerritory,
  /**
   * Any multiple-choice prompt (faction pick, event steps, rewards, power options...).
   * Options may name a `territory` or `faction` id so the brain can describe them with computed facts.
   * @param {{kind:string, title?:string, text?:string, options:{value:any, label:string, hint?:string, disabled?:boolean, territory?:string, faction?:string}[]}} prompt
   * @returns {{value:any, why}}
   */
  chooseOption,
  /** A name to write on the board (city, signature, world name, continent). Never asks Jev (sync). @returns {{name:string, why}} */
  pickName
} from "./decide/setup.mjs";

export { PROFILES } from "./profiles.mjs";

/** `why` reasons the brain uses beyond BOTS.md §5.3 (the UI shows a generic line for unknown reasons). */
export const WHY_REASONS_ADDED = Object.freeze({
  missileSwing: "fired a missile to swing a battle that matters (not an HQ or the win)",
  defendFewer: "defended with fewer dice because the exact odds favour it"
});
