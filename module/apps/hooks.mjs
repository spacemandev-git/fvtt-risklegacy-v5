/**
 * UI hooks of the apps area: chat-card frames, the Combat Tracker tweak, scene-control and keybinding entries for
 * the War Room, and auto-opening the War Room during a war.
 */
import { SYSTEM_ID } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { esc, factionColor, snapshot, t } from "./helpers.mjs";
import ReferenceApp from "./reference.mjs";
import WarRoom from "./war-room.mjs";

/* -------------------------------------------- */
/*  Chat                                        */
/* -------------------------------------------- */

/**
 * Give flagged Risk Legacy messages (`flags[SYSTEM_ID].card`) the printed-dispatch frame by adding `risklegacy` to
 * the outer `li.chat-message`. Battle messages get it too.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderChatMessageHTML(message, html) {
  const flagged = !!(message.flags?.[SYSTEM_ID]?.card) || (message.type === "battle");
  if ( !flagged || !(html instanceof HTMLElement) ) return;
  const li = html.matches("li.chat-message") ? html
    : (html.closest("li.chat-message") ?? html.querySelector("li.chat-message") ?? html);
  li.classList.add("risklegacy");
}

/* -------------------------------------------- */
/*  Combat Tracker                              */
/* -------------------------------------------- */

/**
 * During a war, colour each combatant row with its faction and show its Red Stars; add a War Room button.
 * @param {CombatTracker} app
 * @param {HTMLElement} element
 */
export function onRenderCombatTracker(app, element) {
  const combat = app.viewed;
  if ( !(element instanceof HTMLElement) ) return;

  // War Room button in the tracker header (idempotent)
  const header = element.querySelector(".combat-tracker-header, header");
  if ( header && combat?.type === "war" && !header.querySelector(".rl-ct-warroom") ) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rl-ct-warroom inline-control";
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", t("RL.UI.WarRoom.Open"));
    button.innerHTML = `<i class="fa-solid fa-chess-board" inert></i> <span>${esc(t("RL.UI.WarRoom.Title"))}</span>`;
    button.addEventListener("click", () => WarRoom.open());
    header.append(button);
  }

  if ( combat?.type !== "war" ) return;
  const snap = snapshot();
  for ( const li of element.querySelectorAll("li.combatant[data-combatant-id]") ) {
    const actor = combat.combatants.get(li.dataset.combatantId)?.actor;
    if ( actor?.type !== "faction" ) continue;
    li.classList.add("rl-ct-faction");
    li.style.setProperty("--rl-ct-faction", factionColor(actor));
    const tokens = actor.system.war.redStarTokens;
    const hqs = snap?.factions?.[actor.id]?.redStars?.hqs ?? 0;
    li.querySelector(".rl-ct-stars")?.remove();
    const badge = document.createElement("span");
    badge.className = "rl-ct-stars";
    badge.dataset.tooltip = t("RL.UI.CombatTracker.StarsTip", { tokens, hqs });
    badge.innerHTML = `<span class="rl-ct-star" inert></span><b>${tokens + hqs}</b>`;
    li.querySelector(".token-name .name")?.after(badge);
    if ( actor.system.war.status !== "playing" ) li.classList.add("rl-ct-out");
  }
}

/* -------------------------------------------- */
/*  Controls                                    */
/* -------------------------------------------- */

/** Token-layer buttons: War Room and Rules Reference. */
export function onGetSceneControlButtons(controls) {
  const tokens = controls.tokens;
  if ( !tokens?.tools ) return;
  const order = Object.keys(tokens.tools).length;
  tokens.tools.rlWarRoom = {
    name: "rlWarRoom", title: "RL.UI.WarRoom.Title", icon: "fa-solid fa-chess-board", order,
    button: true, visible: true, onChange: () => WarRoom.open()
  };
  tokens.tools.rlReference = {
    name: "rlReference", title: "RL.UI.Reference.Title", icon: "fa-solid fa-book-open", order: order + 1,
    button: true, visible: true, onChange: () => ReferenceApp.open()
  };
}

/** Client settings and keybindings (called from init). */
export function registerClientConfig() {
  game.settings.register(SYSTEM_ID, "warRoomAutoOpen", {
    name: "RL.UI.Settings.AutoOpen.name", hint: "RL.UI.Settings.AutoOpen.hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(SYSTEM_ID, "warRoomCompact", {
    scope: "client", config: false, type: Boolean, default: false
  });
  game.settings.register(SYSTEM_ID, "warRoomPosition", {
    scope: "client", config: false, type: Object, default: {}
  });
  game.keybindings.register(SYSTEM_ID, "warRoom", {
    name: "RL.UI.Keybinding.WarRoom", editable: [], restricted: false,
    onDown: () => {
      const app = WarRoom.instance;
      if ( app?.rendered ) app.close();
      else WarRoom.open();
      return true;
    }
  });
  game.keybindings.register(SYSTEM_ID, "reference", {
    name: "RL.UI.Keybinding.Reference", editable: [], restricted: false,
    onDown: () => {
      ReferenceApp.open();
      return true;
    }
  });
}

/* -------------------------------------------- */
/*  Auto-open                                   */
/* -------------------------------------------- */

const autoOpen = () => game.settings.get(SYSTEM_ID, "warRoomAutoOpen");

/** Open the War Room when a war exists at login, when one is created, and when it becomes your turn. */
export function registerAutoOpen() {
  if ( autoOpen() && state.getWar() ) WarRoom.open();
  Hooks.on("createCombat", combat => {
    if ( (combat.type === "war") && autoOpen() ) WarRoom.open();
  });
  Hooks.on("deleteCombat", combat => {
    if ( combat.type === "war" ) WarRoom.instance?.render();
  });
  Hooks.on("updateCombat", (combat, changed) => {
    if ( (combat.type !== "war") || !autoOpen() ) return;
    if ( !(("turn" in changed) || ("round" in changed) || foundry.utils.hasProperty(changed, "system.stage")) ) return;
    const faction = combat.combatant?.actor;
    const mine = faction && (faction.system.war.playerId === game.user.id);
    if ( mine || !WarRoom.instance?.rendered ) WarRoom.open();
  });
}
