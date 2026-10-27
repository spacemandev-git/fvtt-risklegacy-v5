/**
 * Area: battle (ARCHITECTURE §5.3), exposed as `game.risklegacy.battle`.
 *
 * Battles are ChatMessages of type "battle" (data: module/data/chat-battle.mjs, card: module/battle/card.mjs).
 * Every mutation is a GM action ("battle.*", handlers in flow.mjs); the exported functions below are thin
 * `runAction` wrappers that can be called from any client. Messages are passed as ids (a ChatMessage also works).
 */
import { SYSTEM_ID } from "../config.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import { getWar } from "../state/_module.mjs";
import { CARD_TEMPLATE, DIE_TEMPLATE, forgetBattleUI } from "./card.mjs";
import { registerDefenseQuery } from "./defense.mjs";
import * as flow from "./flow.mjs";

export {
  applySources, collectSources, computeModifiers, resolveDice, COMBAT_POWERS
} from "./modifiers.mjs";
export { setServiceOverride } from "./services.mjs";
export { prepareBattleContext, renderBattleMessage } from "./card.mjs";
export { anyMissiles } from "./flow.mjs";

const id = message => flow.messageIdOf(message);

/** Register settings, GM actions, the defender query and templates. */
export function init() {
  game.settings.register(SYSTEM_ID, "battleAutoResolve", {
    name: "RL.Battle.Settings.autoResolve.name",
    hint: "RL.Battle.Settings.autoResolve.hint",
    scope: "world", config: true, type: String, default: "whenNoMissiles",
    choices: {
      whenNoMissiles: "RL.Battle.Settings.autoResolve.whenNoMissiles",
      never: "RL.Battle.Settings.autoResolve.never"
    }
  });

  registerAction("battle.start", flow.handleStart);
  registerAction("battle.roll", flow.handleRoll);
  registerAction("battle.defend", flow.handleDefend);
  registerAction("battle.fireMissile", flow.handleFireMissile);
  registerAction("battle.resolve", flow.handleResolve);
  registerAction("battle.moveIn", flow.handleMoveIn);
  registerAction("battle.attackAgain", flow.handleAttackAgain);
  registerAction("battle.blitz", flow.handleBlitz);
  registerAction("battle.stop", flow.handleStop);
  registerAction("battle.cancel", flow.handleCancel);
  registerAction("battle.emp", flow.handleEmp);
  registerAction("battle.scar", flow.handleScar);
  registerDefenseQuery();

  foundry.applications.handlebars.loadTemplates([CARD_TEMPLATE, DIE_TEMPLATE]);

  Hooks.on("combatTurnChange", combat => {
    if ( combat.type === "war" ) flow.onTurnChange();
  });
  Hooks.on("deleteChatMessage", message => {
    if ( message.type === "battle" ) forgetBattleUI(message);
  });
}

export function ready() {
  flow.recoverBattles().catch(err => console.warn("risklegacy | could not recover battles", err));
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * [GM] Declare an attack: validates with rules.checkAttack, posts the battle card and rolls (after the defender's
 * choice and any pre-roll reactions). Resolves as soon as the card is posted.
 * @param {{attacker: string, from: string, to: string, dice?: number}} payload  dice defaults to the maximum
 * @returns {Promise<string>} the battle message id
 */
export function startBattle({ attacker, from, to, dice } = {}) {
  return runAction("battle.start", { attacker, from, to, dice });
}

/** [GM] Roll a battle that is waiting in its pre-roll window. */
export function rollBattle({ message } = {}) {
  return runAction("battle.roll", { message: id(message) });
}

/** [GM] The defender (or GM) chooses the defence dice of a battle awaiting them. */
export function chooseDefense({ message, dice } = {}) {
  return runAction("battle.defend", { message: id(message), dice });
}

/**
 * [GM] Fire a missile: the die becomes an unmodifiable 6. The third missile on one roll opens Pocket 1 before
 * resolving.
 * @param {{message: string, faction: string, side: "attack"|"defend", index: number}} payload  index = the die's slot
 * @returns {Promise<{count: number}>}
 */
export function fireMissile({ message, faction, side, index } = {}) {
  return runAction("battle.fireMissile", { message: id(message), faction, side, index });
}

/** [GM] Resolve a rolled battle (casualties, fortification wear, conquest). */
export function resolve({ message } = {}) {
  return runAction("battle.resolve", { message: id(message) });
}

/** [GM] Move extra troops into a conquered territory (at least one stays behind). */
export function moveIn({ message, count } = {}) {
  return runAction("battle.moveIn", { message: id(message), count });
}

/** [GM] Attack again between the same territories with the maximum dice. @returns {Promise<string>} new message id */
export function attackAgain({ message } = {}) {
  return runAction("battle.attackAgain", { message: id(message) });
}

/** [GM] Blitz from a resolved battle until conquest or the attacker is down to `stopAt` troops. */
export function blitz({ message, stopAt = 1 } = {}) {
  return runAction("battle.blitz", { message: id(message), stopAt });
}

/** [GM] Close a resolved battle's follow-up controls. */
export function stopBattle({ message } = {}) {
  return runAction("battle.stop", { message: id(message) });
}

/** [GM, GM users only] Cancel an unresolved battle. */
export function cancelBattle({ message } = {}) {
  return runAction("battle.cancel", { message: id(message) });
}

/** [GM] Activate the EMP missile power on a battle's territory before its roll. */
export function activateEmp({ message, faction } = {}) {
  return runAction("battle.emp", { message: id(message), faction });
}

/** [GM] Play a scar card on the defending territory before the roll. */
export function playScarBeforeRoll({ message, faction, cardId } = {}) {
  return runAction("battle.scar", { message: id(message), faction, cardId });
}

/**
 * The battle message currently recorded on the war (may be resolved).
 * @returns {ChatMessage|null}
 */
export function currentBattle() {
  const war = getWar();
  const message = war?.system.battle ? game.messages.get(war.system.battle) : null;
  return message?.type === "battle" ? message : null;
}
