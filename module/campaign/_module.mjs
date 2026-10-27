/**
 * Area: campaign. Campaign lifecycle, wizards, sealed packages and the rulebook (ARCHITECTURE.md §5.7).
 *
 * init()  registers the GM actions, the User query used to ask players for choices, and the §8 hook listeners
 *         that detect package unlocks.
 * ready() shows the GM the landing page when there is something to do (no campaign, before the first game,
 *         between games, an unfinished end of game).
 *
 * Public API (game.risklegacy.campaign): see the exports below.
 */
import { SYSTEM_ID } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { registerQuery } from "./ask.mjs";
import * as create from "./create.mjs";
import * as legacy from "./legacy.mjs";
import * as packs from "./packs.mjs";
import * as placements from "./placements.mjs";
import * as rulebook from "./rulebook.mjs";
import { registerPrompts } from "./apps/prompts.mjs";
import { openNewCampaign } from "./apps/new-campaign.mjs";
import { openFirstGame } from "./apps/first-game.mjs";
import { openGameSetup } from "./apps/game-setup.mjs";
import { openEndGame } from "./apps/end-game.mjs";
import { openLanding } from "./apps/landing.mjs";
import StickerSheet, { openStickerSheet } from "./apps/sticker-sheet.mjs";

export function init() {
  create.registerActions();
  legacy.registerActions();
  packs.registerActions();
  rulebook.registerActions();
  registerQuery();
  registerPrompts();
  placements.registerPlacementPrompts();
  packs.registerHooks();
  Hooks.on("renderActorDirectory", addDirectoryButton);
}

export async function ready() {
  if ( !game.user.isGM ) return;
  const campaign = state.getCampaign();
  if ( !campaign ) return openLanding();
  const endGame = campaign.getFlag(SYSTEM_ID, "endGame");
  if ( endGame && !endGame.finished ) return openEndGame();
  const war = state.getWar();
  if ( !campaign.system.firstGameReady || !war ) return openLanding();
  return null;
}

/** A "Risk Legacy" button in the Actors sidebar header that opens the landing page (GM). */
function addDirectoryButton(app, element) {
  if ( !game.user.isGM ) return;
  const actions = element.querySelector(".header-actions");
  if ( !actions || actions.querySelector(".rl-campaign-button") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rl-campaign-button";
  button.innerHTML = `<i class="fa-solid fa-earth-americas" inert></i><span>${game.i18n.localize("RL.Wizard.Landing.button")}</span>`;
  button.addEventListener("click", () => openLanding());
  actions.append(button);
}

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

// Creation
export const createCampaign = create.createCampaign;

// Wizards
export { openNewCampaign, openFirstGame, openGameSetup, openEndGame, openLanding };

// The Sticker Sheet
export { openStickerSheet, StickerSheet };

// Legacy operations [GM]
export const foundCity = legacy.foundCity;
export const fortifyCity = legacy.fortifyCity;
export const placeScar = legacy.placeScar;
export const cancelScar = legacy.cancelScar;
export const placeMark = legacy.placeMark;
export const nameContinent = legacy.nameContinent;
export const modifyContinent = legacy.modifyContinent;
export const upgradeCard = legacy.upgradeCard;
export const destroyTerritoryCard = legacy.destroyTerritoryCard;
export const recordGame = legacy.recordGame;
export const nameWorld = legacy.nameWorld;
export const addLog = legacy.addLog;
export const adjustStickers = legacy.adjustStickers;
export const addSeaLine = legacy.addSeaLine;
/** [GM] Write the Alien Island sticker at {x, y, radius?, by?, force?} (placeAlienIsland runs the whole flow). */
export const addAlienIsland = legacy.addAlienIsland;
/** [GM] War Progresses 4: {faction} → the collaborator's reserve + 10 Alien troops onto Alien Island. */
export const alienLanding = legacy.alienLanding;
/** [GM] Ruins: {territory, by?, force?} → remove the Minor City, place the ruin mark, clear the pieces there. */
export const ruinCity = placements.ruinCity;

// Changing the map, placing stickers (client flows; the writes are GM actions)
export const placeSeaLine = placements.placeSeaLine;
export const offerSeaLine = placements.offerSeaLine;
export const placeAlienIsland = placements.placeAlienIsland;
export const placeSticker = placements.placeSticker;
export const choosePlacement = placements.choosePlacement;
export const applyPlacement = placements.applyPlacement;
export const applyReward = placements.applyReward;
export const placeScarCorrection = placements.placeScarCorrection;
export const placeability = placements.placeability;
export const scarTargets = placements.scarTargets;
export const seaLinePoints = placements.seaLinePoints;
export const placementTargets = placements.TARGETS;

// Packages
export const triggerPack = packs.triggerPack;
export const openPack = packs.openPack;
export const packsForEvent = packs.packsForEvent;
export const offerComebackPower = packs.offerComebackPower;
export const offerMissilePower = packs.offerMissilePower;

// Rulebook
export const buildRulebook = rulebook.buildRulebook;
export const applyRuleAddition = rulebook.applyRuleAddition;
export const openRulebook = rulebook.openRulebook;
