/**
 * Area: cards (ARCHITECTURE §5.5). Foundry Cards for the territory deck, coin cards, the sideboard row, discard,
 * scar / mission / event / draft decks and one hand per faction; the Sideboard app; hand views; card dialogs.
 *
 * Functions marked [GM] are thin `runAction("cards.<verb>")` wrappers: they can be called from any client and run
 * on the active GM, which re-checks permissions and rules. Everything is async unless marked sync.
 */
import { registerAction, runAction } from "../gm/actions.mjs";
import * as catalog from "./catalog.mjs";
import * as chat from "./chat.mjs";
import * as events from "./events.mjs";
import * as eventEffects from "./event-effects.mjs";
import * as legacy from "./legacy.mjs";
import * as missions from "./missions.mjs";
import * as resources from "./resources.mjs";
import * as scars from "./scars.mjs";
import * as sideboard from "./sideboard.mjs";
import * as stacks from "./stacks.mjs";
import { requireGM, serialize } from "./util.mjs";
import * as dialogs from "./apps/dialogs.mjs";
import * as hand from "./apps/hand.mjs";
import PileApp from "./apps/pile-app.mjs";
import SideboardApp from "./apps/sideboard-app.mjs";

/* -------------------------------------------- */
/*  GM actions                                  */
/* -------------------------------------------- */

/** name → [handler, gmOnly]. Handlers receive (payload, {user}). */
const ACTIONS = {
  buildDecks: [p => stacks.buildDecks(p), true],
  addPackCards: [p => stacks.addPackCards(p), true],
  ensureHand: [p => stacks.ensureHand(p), true],
  setupSideboard: [(p, c) => sideboard.setupSideboard(p, c), true],
  draw: [(p, c) => sideboard.drawResourceCard(p, c), false],
  discardResources: [(p, c) => resources.discardResources(p, c), false],
  dealCoins: [(p, c) => resources.dealCoins(p, c), true],
  transferHand: [(p, c) => resources.transferHand(p, c), true],
  dealScars: [(p, c) => scars.dealScars(p, c), true],
  playScar: [(p, c) => scars.playScar(p, c), false],
  upgradeTerritoryCard: [(p, c) => legacy.upgradeTerritoryCard(p, c), false],
  destroyTerritoryCard: [(p, c) => legacy.destroyTerritoryCard(p, c), true],
  setTerritoryValue: [(p, c) => legacy.setTerritoryValue(p, c), false],
  revealMission: [(p, c) => missions.revealMission(p, c), true],
  completeMission: [(p, c) => missions.completeMission(p, c), false],
  revealEvent: [p => events.revealEvent(p), true],
  resolveEvent: [(p, c) => events.resolveEvent(p, c), true],
  runEvent: [(p, c) => events.runEvent(p, c), true]
};

const run = (name, payload = {}) => runAction(`cards.${name}`, payload);

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/** [GM] Create every CARD_STACKS stack and fill it from the opened packs. → {role: id} */
export const buildDecks = (payload = {}) => run("buildDecks", payload);
/** [GM] Add an opened pack's cards ({pack}). → {added: {role: n}} */
export const addPackCards = payload => run("addPackCards", payload);
/** [GM] Find or create a faction's hand ({faction}). → hand id */
export const ensureHand = payload => run("ensureHand", payload);
/** [GM] Lay out the sideboard for a new game. → {row: ids, missionId} */
export const setupSideboard = (payload = {}) => run("setupSideboard", payload);
/** [GM] Draw at the end of a turn ({faction, cardId|null}). → {cardId, eventCardId, coinPile} */
export const drawResourceCard = payload => run("draw", payload);
/** [GM] Turn in resource cards ({faction, cardIds, purpose?}). → {count, coins} */
export const discardResources = payload => run("discardResources", payload);
/** [GM] Deal Coin cards from the coin pile ({faction, count}). → {cardIds} */
export const dealCoins = payload => run("dealCoins", payload);
/** Alias of dealCoins (the campaign's draft step looks for this name). */
export const giveCoinCards = dealCoins;
/** [GM] Move a faction's resource cards to another ({from, to}). → {count, cardIds} */
export const transferHand = payload => run("transferHand", payload);
/** [GM] Deal one Scar card to each faction if there are enough ({factions}). → {dealt: {factionId: cardId}, enough} */
export const dealScars = payload => run("dealScars", payload);
/** [GM] Play a Scar card ({faction, cardId, territory} or {faction, cardId, target}). */
export const playScar = payload => run("playScar", payload);
/** [GM] Add coin stickers to a territory card ({territory, amount=1, faction?, log?}). → {territory, value} */
export const upgradeTerritoryCard = payload => run("upgradeTerritoryCard", payload);
/** [GM] DESTROY a territory card ({territory, log?}). */
export const destroyTerritoryCard = payload => run("destroyTerritoryCard", payload);
/** [GM] Set a territory card's value ({territory, value}); max 3 before the first game. → {territory, value} */
export const setTerritoryValue = payload => run("setTerritoryValue", payload);
/** [GM] Put a mission face up ({replace?, cardId?}). → {cardId} */
export const revealMission = (payload = {}) => run("revealMission", payload);
/** [GM] Complete the face-up mission ({faction}). → {missionCardId, reward, nextMissionId, sticker} */
export const completeMission = payload => run("completeMission", payload);
/** [GM] Reveal the top event card. → {eventCardId, outcome} */
export const revealEvent = (payload = {}) => run("revealEvent", payload);
/** [GM] Decide where a pending event card goes ({cardId, outcome: box|destroy|keep}). */
export const resolveEvent = payload => run("resolveEvent", payload);
/** [GM] Carry out an automated event now ({catalogId} | {cardId}, faction?, dryRun?). → {eventCardId, outcome, occurred, messageId, result} */
export const runEvent = (payload = {}) => run("runEvent", payload);
/** Event automation: is it on (world setting `eventAutomation`), and which catalog events it covers (sync). */
export const eventAutomationEnabled = eventEffects.automationEnabled;
export const isEventAutomated = eventEffects.isAutomated;

// Sync reads
export const getRow = sideboard.getRow;
export const getResourceCards = resources.getResourceCards;
export const drawOptions = sideboard.drawOptions;
export const coinCount = sideboard.coinCount;
export const missionStatus = missions.missionStatus;
export const currentMission = missions.currentMission;
export const territoryValue = legacy.territoryValue;
export const maxCardValue = legacy.maxCardValue;
export const getScarCards = scars.getScarCards;
export const scarTargets = scars.scarTargets;
export const handOwnership = stacks.handOwnership;

// Client UI
export const promptResourceDraw = dialogs.promptResourceDraw;
export const chooseResourceCards = dialogs.chooseResourceCards;
export const evaluateSelection = dialogs.evaluateSelection;
export const renderHand = hand.renderHand;
export const openHand = faction => hand.HandApp.open(faction);
export const openSideboard = () => SideboardApp.open();
export const browsePile = role => PileApp.open(role);
export { SideboardApp, PileApp };
export const HandApp = hand.HandApp;
export const RLHandElement = hand.RLHandElement;

/** Buttons in our chat cards (GM). */
export async function chatAction(action, data = {}) {
  if ( action === "resolveEvent" ) return resolveEvent({ cardId: data.cardId ?? data.cardid, outcome: data.outcome });
  throw new Error(`Unknown cards chat action "${action}"`);
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

export function init() {
  for ( const [name, [handler, gmOnly]] of Object.entries(ACTIONS) ) {
    registerAction(`cards.${name}`, (payload, context) => serialize(async () => {
      if ( gmOnly ) requireGM(context?.user ?? game.user);
      return handler(payload ?? {}, context ?? { user: game.user });
    }));
  }

  if ( !customElements.get(hand.RLHandElement.tagName) ) customElements.define(hand.RLHandElement.tagName, hand.RLHandElement);

  eventEffects.init();   // world setting "eventAutomation" + the "events.choose" User query

  Hooks.on("updateActor", stacks.onUpdateActor);
  Hooks.on("renderChatMessageHTML", chat.onRenderChatMessageHTML);
  Hooks.on("renderCardsDirectory", onRenderCardsDirectory);
}

export async function ready() {
  await catalog.loadFallback();
  document.addEventListener("click", hand.onDocumentClick);
}

/** "Sideboard" button in the Cards sidebar. */
function onRenderCardsDirectory(app, html) {
  const actions = html.querySelector(".header-actions");
  if ( !actions || actions.querySelector(".rl-open-sideboard") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rl-open-sideboard";
  button.innerHTML = `<i class="fa-solid fa-layer-group" inert></i><span>${game.i18n.localize("RL.Sideboard.open")}</span>`;
  button.addEventListener("click", () => openSideboard());
  actions.append(button);
}
