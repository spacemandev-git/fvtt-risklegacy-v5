/**
 * Area: apps (sheets, the War Room HUD, shared dialogs). See ARCHITECTURE.md §5.6.
 *
 * Public API (`game.risklegacy.apps`):
 *   FactionSheet, CampaignSheet, PowerSheet       sheet classes (registered in init)
 *   WarRoom, ReferenceApp                         app classes
 *   openWarRoom()                                 open/focus the turn HUD → Promise<WarRoom>
 *   openReference()                               open/focus the player aid → Promise<ReferenceApp>
 *   chooseNumber, confirmAction, chooseOption, promptText   shared DialogV2 helpers (value or null)
 */
import { SYSTEM_ID } from "../config.mjs";
import CampaignSheet from "./campaign-sheet.mjs";
import FactionSheet from "./faction-sheet.mjs";
import PowerSheet from "./power-sheet.mjs";
import ReferenceApp from "./reference.mjs";
import WarRoom from "./war-room.mjs";
import {
  onGetSceneControlButtons, onRenderChatMessageHTML, onRenderCombatTracker, registerAutoOpen, registerClientConfig
} from "./hooks.mjs";

export { chooseNumber, chooseOption, confirmAction, promptText } from "./dialogs.mjs";
export { CampaignSheet, FactionSheet, PowerSheet, ReferenceApp, WarRoom };

/** Open (or focus) the War Room turn HUD. */
export function openWarRoom() {
  return WarRoom.open();
}

/** Open (or focus) the player-aid window. */
export function openReference() {
  return ReferenceApp.open();
}

export function init() {
  const { DocumentSheetConfig } = foundry.applications.apps;
  DocumentSheetConfig.registerSheet(Actor, SYSTEM_ID, FactionSheet, {
    types: ["faction"], makeDefault: true, label: "RL.Sheet.Faction.Label"
  });
  DocumentSheetConfig.registerSheet(Actor, SYSTEM_ID, CampaignSheet, {
    types: ["campaign"], makeDefault: true, label: "RL.Sheet.Campaign.Label"
  });
  DocumentSheetConfig.registerSheet(Item, SYSTEM_ID, PowerSheet, {
    types: ["power"], makeDefault: true, label: "RL.Sheet.Power.Label"
  });

  registerClientConfig();
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
  Hooks.on("renderCombatTracker", onRenderCombatTracker);
  Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
}

export function ready() {
  registerAutoOpen();
}
