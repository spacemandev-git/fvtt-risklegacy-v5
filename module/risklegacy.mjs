/**
 * Risk Legacy for Foundry VTT v14: entry point.
 *
 * The system is split into areas, each with its own folder and `_module.mjs` exposing `init()`, `ready()` and a
 * public API (see ARCHITECTURE.md). This file wires them together:
 *   init  → CONFIG, document classes, data models, settings, GM action bus, then every area's init()
 *   ready → load board definitions + content catalog, then every area's ready()
 *
 * Runtime API: `game.risklegacy` (config, state, actions, and each area's exports).
 */
import { RISKLEGACY, SYSTEM_ID } from "./config.mjs";
import * as dataModels from "./data/_module.mjs";
import * as documents from "./documents/_module.mjs";
import { registerSettings } from "./settings.mjs";
import * as actions from "./gm/actions.mjs";
import * as state from "./state/_module.mjs";
import * as rules from "./rules/_module.mjs";
import * as turn from "./turn/_module.mjs";
import * as battle from "./battle/_module.mjs";
import * as board from "./canvas/_module.mjs";
import * as cards from "./cards/_module.mjs";
import * as apps from "./apps/_module.mjs";
import * as campaign from "./campaign/_module.mjs";
import * as bots from "./bots/_module.mjs";
import * as dev from "./dev/fixtures.mjs";

const AREAS = { rules, turn, battle, board, cards, apps, campaign, bots };

Hooks.once("init", () => {
  console.log(`${SYSTEM_ID} | Initializing Risk Legacy`);
  CONFIG.RISKLEGACY = RISKLEGACY;

  // Document classes
  CONFIG.Actor.documentClass = documents.RLActor;
  CONFIG.Item.documentClass = documents.RLItem;
  CONFIG.Combat.documentClass = documents.RLCombat;
  CONFIG.ChatMessage.documentClass = documents.RLChatMessage;
  CONFIG.Token.documentClass = documents.RLTokenDocument;
  CONFIG.Cards.documentClass = documents.RLCards;
  CONFIG.Card.documentClass = documents.RLCard;

  // Data models (keys = documentTypes in system.json)
  CONFIG.Actor.dataModels.faction = dataModels.FactionData;
  CONFIG.Actor.dataModels.campaign = dataModels.CampaignData;
  CONFIG.Item.dataModels.power = dataModels.PowerData;
  CONFIG.Card.dataModels.territory = dataModels.TerritoryCardData;
  CONFIG.Card.dataModels.coin = dataModels.CoinCardData;
  CONFIG.Card.dataModels.scar = dataModels.ScarCardData;
  CONFIG.Card.dataModels.mission = dataModels.MissionCardData;
  CONFIG.Card.dataModels.event = dataModels.EventCardData;
  CONFIG.Card.dataModels.draft = dataModels.DraftCardData;
  CONFIG.Combat.dataModels.war = dataModels.WarData;
  CONFIG.ChatMessage.dataModels.battle = dataModels.BattleData;

  // Fonts loaded at startup, so PIXI text on the board (and the text editor) can use the design system's faces.
  const font = file => `${RISKLEGACY.path}/styles/assets/fonts/${file}`;
  Object.assign(CONFIG.fontDefinitions, {
    "Big Shoulders Display": { editor: false, fonts: [
      { urls: [font("BigShouldersDisplay-normal-700-900-latin.woff2")], weight: "700 900" }
    ] },
    "Big Shoulders Stencil Display": { editor: false, fonts: [
      { urls: [font("BigShouldersStencilDisplay-normal-900-latin.woff2")], weight: "900" }
    ] },
    "Gochi Hand": { editor: true, fonts: [{ urls: [font("GochiHand-normal-400-latin.woff2")] }] },
    "Roboto Condensed": { editor: true, fonts: [
      { urls: [font("RobotoCondensed-normal-400-700-latin.woff2")], weight: "400 700" },
      { urls: [font("RobotoCondensed-italic-400-700-latin.woff2")], weight: "400 700", style: "italic" }
    ] }
  });

  registerSettings();
  actions.init();
  state.preload();   // start fetching board definitions + content now; the canvas draws before "ready"

  game.risklegacy = {
    id: SYSTEM_ID,
    config: RISKLEGACY,
    state,
    actions: { run: actions.runAction, register: actions.registerAction, has: actions.hasAction },
    dev,
    ...AREAS
  };

  for ( const [name, area] of Object.entries(AREAS) ) {
    try {
      area.init?.();
    } catch(err) {
      console.error(`${SYSTEM_ID} | ${name}.init() failed`, err);
    }
  }
});

Hooks.once("ready", async () => {
  await state.preload();
  for ( const [name, area] of Object.entries(AREAS) ) {
    try {
      await area.ready?.();
    } catch(err) {
      console.error(`${SYSTEM_ID} | ${name}.ready() failed`, err);
    }
  }
  Hooks.callAll("risklegacy.ready", game.risklegacy);
  console.log(`${SYSTEM_ID} | Ready`);
});
