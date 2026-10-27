import { CARD_STACKS, SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";

/**
 * Small helpers shared by the cards area. Nothing here writes to the database.
 */

export const TEMPLATES = `systems/${SYSTEM_ID}/templates/cards`;

/** Card types that are resource cards (count for Red Stars and troop trades). */
export const RESOURCE_TYPES = ["territory", "coin"];

/** Shorthand for the ownership levels. */
export const LEVELS = () => CONST.DOCUMENT_OWNERSHIP_LEVELS;

/** Stacks whose order is secret: players get LIMITED (count only, no core sheet that would list the order). */
export const SECRET_STACKS = new Set(["territoryDeck", "scarDeck", "missionDeck", "eventDeck", "draftDeck"]);

/** Card back labels for card types that have no scanned back. */
export const BACK_LABELS = {
  territory: "RL.CardsUI.back.resource",
  coin: "RL.CardsUI.back.resource",
  scar: "RL.CardsUI.back.scar",
  mission: "RL.CardsUI.back.mission",
  event: "RL.CardsUI.back.event",
  draft: "RL.CardsUI.back.draft"
};

/** Resolve a faction argument (actor or id) to the faction Actor. */
export function factionActor(faction) {
  if ( !faction ) return null;
  const actor = typeof faction === "string" ? game.actors.get(faction) : faction;
  return actor?.type === "faction" ? actor : null;
}

/** Resolve a faction argument to its id. */
export function factionId(faction) {
  return typeof faction === "string" ? faction : faction?.id ?? null;
}

/** A Cards stack by role, or throw a localized error. */
export function requireStack(role) {
  const stack = state.getCardStack(role);
  if ( !stack ) throw new Error(game.i18n.format("RL.CardsUI.error.noStack", { stack: game.i18n.localize(CARD_STACKS[role]?.label ?? role) }));
  return stack;
}

/** The faction's hand, or throw. */
export function requireHand(faction) {
  const hand = state.getHand(faction);
  if ( !hand ) throw new Error(game.i18n.format("RL.CardsUI.error.noHand", { faction: factionActor(faction)?.name ?? faction }));
  return hand;
}

/** The faction actor, or throw. */
export function requireFaction(faction) {
  const actor = factionActor(faction);
  if ( !actor ) throw new Error(game.i18n.format("RL.CardsUI.error.noFaction", { faction: String(faction) }));
  return actor;
}

/** The campaign actor, or throw. */
export function requireCampaign() {
  const campaign = state.getCampaign();
  if ( !campaign ) throw new Error(game.i18n.localize("RL.Error.noCampaign"));
  return campaign;
}

/** Throw unless the user may act for the faction. */
export function requireActFor(user, faction) {
  if ( !state.canActFor(user, faction) ) {
    throw new Error(game.i18n.format("RL.CardsUI.error.notYourFaction", { faction: factionActor(faction)?.name ?? "?" }));
  }
}

/** Throw unless the user is a GM. */
export function requireGM(user) {
  if ( !user?.isGM ) throw new Error(game.i18n.localize("RL.CardsUI.error.gmOnly"));
}

/**
 * Apply the world's enforcement level to a rules result inside a GM action. Strict mode throws (the requesting
 * client sees the reason), advisory mode warns on the GM's client and continues, off continues silently.
 * @param {import("../state/enforce.mjs").RuleResult} result
 */
export function gate(result) {
  if ( !result || result.ok ) return;
  if ( state.enforce(result, { notify: false }) ) {
    if ( state.enforcementLevel() === "advisory" ) {
      ui.notifications.warn(game.i18n.format("RL.Enforce.advisory", { reason: state.reasonText(result) }));
    }
    return;
  }
  throw new Error(game.i18n.format("RL.Enforce.blocked", { reason: state.reasonText(result) }));
}

/** Localize a key with optional data. */
export const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Escape text and turn newlines into <br> for chat/HTML display. */
export function textToHTML(text) {
  if ( !text ) return "";
  return foundry.utils.escapeHTML(String(text)).replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
}

/** System asset path → URL (null-safe). */
export const asset = path => (path ? systemPath(path) : null);

/** Serialize card operations on the GM so two draws never interleave. Do not nest. */
let queue = Promise.resolve();
export function serialize(fn) {
  const run = queue.then(() => fn());
  queue = run.catch(() => {});
  return run;
}

/** The faction whose turn it is in a war being played, or null. */
export function currentWarFaction() {
  return state.currentFaction();
}

/** Is the faction the current faction of the war in progress? */
export function isCurrentFaction(faction) {
  const current = state.currentFaction();
  return !!current && (current.id === factionId(faction));
}

/** The territory's display name (board definition, else the catalog, else a prettified id). */
export function territoryName(id) {
  const board = state.getCampaignBoard();
  return board?.territories?.[id]?.name
    ?? state.findEntry("territoryCards", id)?.name
    ?? String(id ?? "").split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Next game number for log entries. */
export function gameNumber() {
  const war = state.getWar();
  return war?.system.game ?? state.getCampaign()?.system.nextGameNumber ?? 1;
}

/** Today as YYYY-MM-DD. */
export const today = () => new Date().toISOString().slice(0, 10);
