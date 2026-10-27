/**
 * Area: canvas (`game.risklegacy.board`). See ARCHITECTURE.md §5.4.
 *
 *  - scene.mjs        buildBoardScene: the "The World" scene and one Region per territory; the Regions follow the
 *                     campaign's added territories (Alien Island) by themselves
 *  - pieces.mjs       piece tokens: spawn/remove/move/set/clear/arrange, make change, consolidate, split/merge
 *  - movement.mjs     drag interception: rearrange / expand / maneuver / attack / snap back
 *  - layers.mjs       canvas layers: legacy marks under the pieces, badges/highlights/drag hint/sticker ghost above
 *  - marks.mjs        drawing the stickers and the writing on the board, added territories, pen-drawn sea lines
 *  - interaction.mjs  pickTerritory, pickPoint, click-to-place, highlights, prompt banner, hover tooltip
 *  - geometry.mjs     territory lookup, piece slots, isOpenWater
 *  - controls.mjs     scene controls and token HUD buttons
 *
 * init() runs in the system's "init" hook; ready() runs after board definitions and the content catalog are loaded.
 */
import { SYSTEM_ID } from "../config.mjs";
import { getCampaign } from "../state/_module.mjs";
import { RLBoardLayer, RLMarksLayer } from "./layers.mjs";
import { registerPieceActions } from "./pieces.mjs";
import { registerSceneActions, syncCampaignRegions } from "./scene.mjs";
import { clearSlotCache, isBoardScene, territoryAt } from "./geometry.mjs";
import * as interaction from "./interaction.mjs";
import { onRenderTokenHUD } from "./controls.mjs";
import { RLTokenRuler } from "./ruler.mjs";

export { buildBoardScene, syncTerritoryRegions } from "./scene.mjs";
export {
  spawnPieces, removeTroops, moveTroops, setTroops, clearPieces, arrangeTerritory, splitPiece, mergePieces
} from "./pieces.mjs";
export {
  pickTerritory, pickPoint, highlightTerritories, clearHighlights, startPlacement, stopPlacement
} from "./interaction.mjs";
export { territoryAt, piecesByTerritory, factionPieces, territorySlots, isOpenWater } from "./geometry.mjs";
export { previewMove } from "./movement.mjs";

/** Redraw the legacy marks (e.g. after a campaign change made outside document hooks). */
export function refreshMarks() {
  return canvas.rlMarks?.redraw();
}

/** Redraw the troop badges. */
export function refreshBadges() {
  canvas.rlBoard?.refreshBadges();
}

export function init() {
  registerSettings();
  registerKeybindings();

  CONFIG.Canvas.layers.rlMarks = { layerClass: RLMarksLayer, group: "primary" };
  CONFIG.Canvas.layers.rlBoard = { layerClass: RLBoardLayer, group: "interface" };
  CONFIG.Token.rulerClass = RLTokenRuler;

  registerSceneActions();
  registerPieceActions();
  foundry.applications.handlebars.loadTemplates(interaction.TEMPLATE_PATHS);

  // Redraw triggers
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createToken", onTokenChange);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("deleteToken", onTokenChange);
  Hooks.on("createRegion", onRegionChange);
  Hooks.on("updateRegion", onRegionChange);
  Hooks.on("deleteRegion", onRegionChange);
  Hooks.on("updateCombat", () => interaction.refreshMode());
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  Hooks.on("canvasTearDown", () => {
    interaction.cancelMode({ restore: false });
    interaction.hideTooltip();
  });
  Hooks.on("canvasReady", () => {
    canvas.app?.view?.addEventListener("pointerleave", interaction.hideTooltip);
  });
}

export function ready() {
  // Board definitions are loaded now: slots may have been computed from a fallback, so start clean
  clearSlotCache();
  if ( canvas.ready && isBoardScene(canvas.scene) ) {
    canvas.rlMarks?.redraw();
    canvas.rlBoard?.drawBadges();
  }
  // Territories added while no GM was connected (or before a crash): give them their Regions
  if ( game.user.isActiveGM ) syncCampaignRegions();
}

/* -------------------------------------------- */

function registerSettings() {
  const { BooleanField } = foundry.data.fields;
  game.settings.register(SYSTEM_ID, "canvas.showCounts", {
    name: "RL.Canvas.Settings.showCounts.name",
    hint: "RL.Canvas.Settings.showCounts.hint",
    scope: "client", config: true, type: new BooleanField({ initial: true }),
    onChange: () => canvas.rlBoard?.drawBadges()
  });
  game.settings.register(SYSTEM_ID, "canvas.showTooltip", {
    name: "RL.Canvas.Settings.showTooltip.name",
    hint: "RL.Canvas.Settings.showTooltip.hint",
    scope: "client", config: true, type: new BooleanField({ initial: true }),
    onChange: value => {
      if ( !value ) interaction.hideTooltip();
    }
  });
  game.settings.register(SYSTEM_ID, "canvas.autoArrange", {
    name: "RL.Canvas.Settings.autoArrange.name",
    hint: "RL.Canvas.Settings.autoArrange.hint",
    scope: "world", config: true, type: new BooleanField({ initial: true })
  });
}

function registerKeybindings() {
  game.keybindings.register(SYSTEM_ID, "cancelBoardPrompt", {
    name: "RL.Canvas.Keys.cancel",
    hint: "RL.Canvas.Keys.cancelHint",
    uneditable: [{ key: "Escape" }],
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => interaction.cancelMode()
  });
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

/** Keys of `changed.system` that change the map itself (added territories, pen-drawn sea lines). */
const TERRITORIES_KEY = /^(-=|==)?customTerritories$/;
const SEA_LINES_KEY = /^(-=|==)?seaLines$/;

function onUpdateActor(actor, changed) {
  if ( actor.type === "campaign" ) {
    if ( actor !== getCampaign() ) return;
    const keys = Object.keys(changed.system ?? {});
    const territories = keys.some(k => TERRITORIES_KEY.test(k));
    const mapChanged = territories || keys.some(k => SEA_LINES_KEY.test(k));
    if ( territories ) {
      clearSlotCache();
      // Regions follow the campaign (create the island's, delete removed ones): one GM does it
      if ( game.user.isActiveGM ) syncCampaignRegions();
    }
    if ( !canvas.ready || !isBoardScene(canvas.scene) ) return;
    canvas.rlMarks?.redraw();
    if ( mapChanged ) {
      canvas.rlBoard?.refreshBadges();
      interaction.refreshMode();
    }
    return;
  }
  if ( !canvas.ready || !isBoardScene(canvas.scene) ) return;
  if ( actor.type === "faction" ) {
    if ( foundry.utils.hasProperty(changed, "system.color") ) canvas.rlBoard?.refreshBadges();
    if ( foundry.utils.hasProperty(changed, "system.war") ) interaction.refreshMode();
  }
}

function onTokenChange(token) {
  if ( (token.parent === canvas.scene) && isBoardScene(token.parent) ) canvas.rlBoard?.refreshBadges();
}

function onUpdateToken(token, changed) {
  if ( !("x" in changed) && !("y" in changed) && !("width" in changed) && !("flags" in changed)
    && !("actorId" in changed) ) return;
  onTokenChange(token);
}

function onRegionChange(region) {
  if ( !region.getFlag(SYSTEM_ID, "territory") ) return;
  clearSlotCache();
  if ( region.parent === canvas.scene ) canvas.rlBoard?.drawHighlights();
}

/** Territory id under a canvas point of the viewed board (convenience for macros). */
export function territoryUnderCursor() {
  return canvas.ready ? territoryAt(canvas.mousePosition, canvas.scene) : null;
}
