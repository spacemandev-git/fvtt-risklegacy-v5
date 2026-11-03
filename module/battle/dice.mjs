/**
 * Rolling combat dice: one Foundry Roll ("Nd6 + Md6": black attack dice, red defence dice), shown with Dice So Nice
 * when it is active. The rolls are not attached to the chat message (the battle card renders its own dice), so
 * Dice So Nice is driven explicitly with `showForRoll` and we wait for the animation before revealing the result.
 *
 * 3D dice are the default experience: world setting `battle3dDice` (on by default) gates them, and on the active GM's
 * `ready` we offer to enable Dice So Nice when it is installed but not active (once, "don't ask again" remembered in
 * `battleDsnPrompt`), or show a one-time hint when it isn't installed. Before each throw the previous dice are wiped
 * from the Dice So Nice canvas on every client (socket `system.<id>` message `battle.clearDice`).
 */
import { SYSTEM_ID } from "../config.mjs";

/** Dice So Nice appearance of the black attack dice and the red defence dice (rulebook p.5). */
export const ATTACK_APPEARANCE = { foreground: "#ffffff", background: "#141414", outline: "#000000", edge: "#2b2b2b", texture: "none" };
export const DEFEND_APPEARANCE = { foreground: "#ffffff", background: "#b5121b", outline: "#4a0000", edge: "#8e0d12", texture: "none" };

/** Longest we wait for a Dice So Nice animation before carrying on. */
const DSN_TIMEOUT = 12_000;

const DSN_ID = "dice-so-nice";
const SOCKET = `system.${SYSTEM_ID}`;
const CLEAR_DICE = "battle.clearDice";

/** @returns {boolean} whether Dice So Nice is active on this client */
export function diceSoNiceActive() {
  return !!(game.modules.get(DSN_ID)?.active && game.dice3d);
}

/** @returns {boolean} whether battles should be thrown with 3D dice (world setting, on by default) */
function dice3dEnabled() {
  try {
    return game.settings.get(SYSTEM_ID, "battle3dDice") !== false;
  } catch(err) {
    return true;
  }
}

/* -------------------------------------------- */
/*  Settings and Dice So Nice setup             */
/* -------------------------------------------- */

/** Register the dice settings and the clear-dice socket listener (battle init). */
export function registerDiceSettings() {
  game.settings.register(SYSTEM_ID, "battle3dDice", {
    name: "RL.Battle.Settings.dice3d.name",
    hint: "RL.Battle.Settings.dice3d.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  // "" = ask, "never" = the GM chose "don't ask again", "hinted" = the not-installed hint was shown
  game.settings.register(SYSTEM_ID, "battleDsnPrompt", {
    scope: "world", config: false, type: String, default: ""
  });
  // Dice So Nice's world settings were checked once for settings that would hide every battle throw
  game.settings.register(SYSTEM_ID, "battleDsnTuned", {
    scope: "world", config: false, type: Boolean, default: false
  });
  Hooks.once("ready", () => {
    game.socket.on(SOCKET, data => {
      if ( data?.type === CLEAR_DICE ) clearDice();
    });
  });
}

/**
 * Active GM, on ready: make the 3D dice the default experience.
 *  - Dice So Nice installed but not enabled: offer to enable it (and reload everyone), unless told not to ask again.
 *  - Not installed: a one-time hint.
 *  - Active: turn off its world settings that would hide every battle throw (once).
 */
export async function setupDiceSoNice() {
  if ( !game.user.isActiveGM || !dice3dEnabled() ) return;
  const module = game.modules.get(DSN_ID);
  try {
    if ( module?.active ) await tuneDiceSoNice();
    else if ( module ) await promptEnableDiceSoNice(module);
    else if ( game.settings.get(SYSTEM_ID, "battleDsnPrompt") === "" ) {
      ui.notifications.info("RL.Battle.Dice.notInstalled", { localize: true, permanent: true });
      await game.settings.set(SYSTEM_ID, "battleDsnPrompt", "hinted");
    }
  } catch(err) {
    console.warn("risklegacy | Dice So Nice setup failed", err);
  }
}

/** Ask the GM to enable the installed Dice So Nice module. */
async function promptEnableDiceSoNice(module) {
  if ( game.settings.get(SYSTEM_ID, "battleDsnPrompt") === "never" ) return;
  if ( !game.user.can("SETTINGS_MODIFY") ) return;
  const choice = await foundry.applications.api.DialogV2.wait({
    classes: ["risklegacy"],
    window: { title: "RL.Battle.Dice.promptTitle", icon: "fa-solid fa-dice" },
    position: { width: 560 },
    content: `<p>${game.i18n.format("RL.Battle.Dice.promptBody", { module: module.title })}</p>`,
    buttons: [
      { action: "enable", label: "RL.Battle.Dice.enable", icon: "fa-solid fa-dice-d6", default: true },
      { action: "later", label: "RL.Battle.Dice.later" },
      { action: "never", label: "RL.Battle.Dice.never" }
    ],
    rejectClose: false
  });
  if ( choice === "never" ) {
    await game.settings.set(SYSTEM_ID, "battleDsnPrompt", "never");
    return;
  }
  if ( choice !== "enable" ) return;
  const MM = foundry.applications.sidebar.apps.ModuleManagement;
  const key = MM?.SETTING ?? "moduleConfiguration";
  const config = foundry.utils.deepClone(game.settings.get("core", key) ?? {});
  config[DSN_ID] = true;
  await game.settings.set("core", key, config);
  // Everyone reloads so Dice So Nice starts on every client (core does the same after Manage Modules).
  game.socket.emit("reload");
  foundry.utils.debouncedReload();
}

/**
 * Dice So Nice world settings that would hide every battle throw: our turns run in a started Combat (type "war"),
 * so "disabled during combat" would turn the 3D dice off for the whole game. Checked once per world.
 */
async function tuneDiceSoNice() {
  if ( game.settings.get(SYSTEM_ID, "battleDsnTuned") ) return;
  const key = `${DSN_ID}.disabledDuringCombat`;
  if ( game.settings.settings.has(key) && game.settings.get(DSN_ID, "disabledDuringCombat") ) {
    await game.settings.set(DSN_ID, "disabledDuringCombat", false);
    ui.notifications.info("RL.Battle.Dice.tuned", { localize: true });
  }
  await game.settings.set(SYSTEM_ID, "battleDsnTuned", true);
}

/* -------------------------------------------- */
/*  Clearing the previous throw                 */
/* -------------------------------------------- */

/** Remove the dice left on this client's Dice So Nice canvas (not while a throw is still rolling). */
export async function clearDice() {
  if ( !diceSoNiceActive() ) return;
  const box = game.dice3d.box;
  if ( !box?.initialized || box.rolling ) return;
  try {
    await box.clearAll();
  } catch(err) {
    console.warn("risklegacy | could not clear the Dice So Nice dice", err);
  }
}

/** Clear the previous dice on every client before a new throw. */
export function clearDiceEverywhere() {
  if ( !diceSoNiceActive() ) return;
  game.socket.emit(SOCKET, { type: CLEAR_DICE });
  return clearDice();
}

/**
 * Roll the dice of one combat roll.
 * @param {object} options
 * @param {number} options.attackDice           1..3
 * @param {number} options.defendDice           1..2
 * @param {boolean} [options.rerollOnes]        re-roll attack 1s until they aren't 1s (Mutants vs Bringer)
 * @param {boolean} [options.show=true]         animate with Dice So Nice
 * @param {ChatMessage} [options.message]       the battle message (for Dice So Nice visibility)
 * @param {User} [options.user]                 the user the throw is shown for
 * @returns {Promise<{attack: {slot, natural}[], defend: {slot, natural}[], rerolled: number}>}
 */
export async function rollCombatDice({ attackDice, defendDice, rerollOnes = false, show = true, message = null, user = null }) {
  const roll = new Roll(`${attackDice}d6 + ${defendDice}d6`, {}, { risklegacy: "battle" });
  const [attackTerm, defendTerm] = roll.dice;
  attackTerm.options.appearance = { ...ATTACK_APPEARANCE };
  defendTerm.options.appearance = { ...DEFEND_APPEARANCE };
  await roll.evaluate({ allowInteractive: false });
  const attack = attackTerm.results.filter(r => r.active !== false).map(r => r.result);
  const defend = defendTerm.results.filter(r => r.active !== false).map(r => r.result);

  // Mutants vs Bringer of Nuclear Fire: re-roll 1s on the attack dice until they are no longer 1s.
  const rerolls = [];
  if ( rerollOnes ) {
    for ( let i = 0; i < attack.length; i++ ) {
      let guard = 0;
      while ( (attack[i] === 1) && (guard++ < 50) ) {
        const again = new Roll("1d6");
        again.dice[0].options.appearance = { ...ATTACK_APPEARANCE };
        await again.evaluate({ allowInteractive: false });
        rerolls.push(again);
        attack[i] = again.total;
      }
    }
  }

  if ( show ) {
    await showDice(roll, { message, user });
    for ( const r of rerolls ) await showDice(r, { message, user, clear: false });
  }
  return {
    attack: attack.map((natural, slot) => ({ slot, natural })),
    defend: defend.map((natural, slot) => ({ slot, natural })),
    rerolled: rerolls.length
  };
}

/**
 * Show a roll with Dice So Nice on every client and wait for the animation (bounded by a timeout).
 * @param {Roll} roll
 * @param {object} [options]
 * @param {boolean} [options.clear=true]  wipe the previous throw first (not for re-rolls of the same throw)
 */
export async function showDice(roll, { message = null, user = null, clear = true } = {}) {
  if ( !diceSoNiceActive() || !dice3dEnabled() ) return;
  try {
    if ( clear ) await clearDiceEverywhere();
    // synchronize = true and users = null: thrown on every client. No speaker: the faction actor may have no
    // player owner (GM- or bot-played), and Dice So Nice's "hide NPC rolls" would then hide the battle throw.
    const shown = game.dice3d.showForRoll(roll, user ?? game.user, true, null, false, message?.id ?? null, null);
    await Promise.race([shown, new Promise(resolve => setTimeout(resolve, DSN_TIMEOUT))]);
  } catch(err) {
    console.warn("risklegacy | Dice So Nice could not show the battle roll", err);
  }
}
