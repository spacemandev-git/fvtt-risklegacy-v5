import { MAX_CARD_VALUE, MAX_CARD_VALUE_BEFORE_FIRST_GAME } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as chat from "./chat.mjs";
import { territoryEntry } from "./scars.mjs";
import { closeRowGap } from "./sideboard.mjs";
import { deleteCardEverywhere, recordValue, updateCardEverywhere } from "./stacks.mjs";
import {
  gameNumber, gate, loc, requireActFor, requireCampaign, requireGM, territoryName, today
} from "./util.mjs";

/**
 * Permanent changes to territory cards: coin stickers (pre-game and held-on upgrades) and destroying a card.
 * Values are written on the card (home deck + any copy in play: `system.value`, the core `value` and `face`)
 * and recorded on the campaign so a deck rebuild keeps them.
 */

/** Before the first game a territory card can't go above 3 resources (rulebook p. 6). */
export function beforeFirstGame(campaign = state.getCampaign()) {
  return !!campaign && !campaign.system.firstGameReady && (campaign.system.gamesPlayed === 0);
}

/** Highest value a territory card may have right now. */
export function maxCardValue(campaign = state.getCampaign()) {
  return beforeFirstGame(campaign) ? MAX_CARD_VALUE_BEFORE_FIRST_GAME : MAX_CARD_VALUE;
}

/** The home (deck) territory card for a territory, or null. */
export function territoryCard(territory) {
  return state.getCardStack("territoryDeck")?.cards.find(c => (c.type === "territory") && (c.system.territory === territory)) ?? null;
}

/** Current value of a territory card (null if it has no card). */
export function territoryValue(territory) {
  return territoryCard(territory)?.system.value ?? null;
}

/** Permission: GMs, or the player of the faction named in the payload (held-on rewards). */
function requireLegacyPermission(user, faction) {
  if ( user.isGM ) return;
  if ( faction ) return requireActFor(user, faction);
  requireGM(user);
}

/** Write a value to the card everywhere and on the campaign record. */
async function writeValue(card, value) {
  await updateCardEverywhere(card.id, { "system.value": value, value, face: value - 1 });
  await recordValue(card.system.territory, value);
}

/**
 * [GM] Set a territory card's resource value (the "Before your first game" coin-sticker wizard).
 * @param {object} options
 * @param {string} options.territory
 * @param {number} options.value     1..3 before the first game, 1..6 afterwards
 * @returns {Promise<{territory: string, value: number}>}
 */
export async function setTerritoryValue({ territory, value, faction }, { user } = {}) {
  requireLegacyPermission(user ?? game.user, faction);
  const campaign = requireCampaign();
  const card = territoryCard(territory);
  if ( !card ) throw new Error(game.i18n.format("RL.CardsUI.error.noTerritoryCard", { territory: territoryName(territory) }));
  const max = maxCardValue(campaign);
  const v = Math.round(Number(value));
  if ( !Number.isFinite(v) || (v < 1) ) throw new Error(loc("RL.CardsUI.error.badValue"));
  if ( v > MAX_CARD_VALUE ) throw new Error(game.i18n.format("RL.CardsUI.reason.maxValue", { max: MAX_CARD_VALUE }));
  if ( v > max ) gate(state.fail("RL.CardsUI.reason.maxValue", { max }));
  await writeValue(card, v);
  return { territory, value: v };
}

/**
 * [GM] Add resource (coin) stickers to a territory card (held-on reward "Upgrade a card").
 * @param {object} options
 * @param {string} options.territory
 * @param {number} [options.amount=1]
 * @param {string} [options.faction]   the faction taking the reward (lets its player run it)
 * @param {boolean} [options.log=false] add a chronicle entry
 * @returns {Promise<{territory: string, value: number}>}
 */
export async function upgradeTerritoryCard({ territory, amount = 1, faction, log = false }, { user } = {}) {
  requireLegacyPermission(user ?? game.user, faction);
  const campaign = requireCampaign();
  const card = territoryCard(territory);
  if ( !card ) throw new Error(game.i18n.format("RL.CardsUI.error.noTerritoryCard", { territory: territoryName(territory) }));
  const max = maxCardValue(campaign);
  const v = card.system.value + Math.round(Number(amount) || 1);
  if ( v > MAX_CARD_VALUE ) throw new Error(game.i18n.format("RL.CardsUI.reason.maxValue", { max: MAX_CARD_VALUE }));
  if ( v > max ) gate(state.fail("RL.CardsUI.reason.maxValue", { max }));
  await writeValue(card, v);
  if ( log ) {
    const text = game.i18n.format("RL.Sideboard.log.upgrade", { territory: territoryName(territory), n: v });
    await campaign.update({ "system.log": [...campaign.system.toObject().log, { game: gameNumber(), date: today(), kind: "card", text }] });
  }
  return { territory, value: v };
}

/**
 * [GM] DESTROY a territory card (winner reward, fallout…): deleted from the home deck and from play, and the
 * board gets its small "x" (`campaign.system.territories.<id>.cardDestroyed`).
 * @param {object} options
 * @param {string} options.territory
 * @param {boolean} [options.log=false]
 * @returns {Promise<{territory: string}>}
 */
export async function destroyTerritoryCard({ territory, log = false }, { user } = {}) {
  requireGM(user ?? game.user);
  const campaign = requireCampaign();
  const card = territoryCard(territory);
  const entry = territoryEntry(campaign, territory);
  entry.cardDestroyed = true;
  const update = { [`system.territories.${territory}`]: entry };
  if ( log ) {
    const text = game.i18n.format("RL.Sideboard.log.destroy", { territory: territoryName(territory) });
    update["system.log"] = [...campaign.system.toObject().log, { game: gameNumber(), date: today(), kind: "card", text }];
  }
  await campaign.update(update);
  if ( card ) {
    const image = { img: card.currentFace?.img ?? card.img, alt: card.name, orientation: "portrait", destroyed: true };
    const rowSlot = state.getCardStack("row")?.cards.get(card.id)?.system.slot ?? 0;
    await deleteCardEverywhere(card.id);
    if ( rowSlot ) await closeRowGap(rowSlot);
    await chat.post({
      kind: "destroyCard",
      title: game.i18n.format("RL.Sideboard.chat.destroyTitle", { name: territoryName(territory) }),
      images: [image],
      result: loc("RL.Sideboard.chat.destroyText")
    });
  }
  return { territory };
}
