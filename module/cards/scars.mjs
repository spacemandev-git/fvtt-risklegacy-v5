import { SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as catalog from "./catalog.mjs";
import * as chat from "./chat.mjs";
import { deleteCardEverywhere, ensureHand, recordRemoved } from "./stacks.mjs";
import {
  factionActor, gameNumber, gate, loc, requireActFor, requireCampaign, requireFaction, requireGM, requireHand,
  territoryName, today
} from "./util.mjs";

/**
 * Scar cards (rulebook p. 7): before a game, shuffle the available Scar cards and deal ONE to each player, but only
 * if there are enough for everyone. Playing a scar puts its sticker on a territory (or, for the weakness scars of
 * the Thirty Troops pocket, on a faction card). A sticker card with no stickers left is DESTROYED, so a played
 * scar card is deleted for good.
 */

/** A campaign territory entry with every field, for writing a territory that has no marks yet. */
export function territoryEntry(campaign, id) {
  const source = campaign.system._source.territories?.[id];
  if ( source ) return foundry.utils.deepClone(source);
  return campaign.system.schema.fields.territories.element.getInitialValue({});
}

/**
 * [GM] Deal one Scar card to each faction, if there are enough for all of them.
 * @param {object} options
 * @param {string[]} options.factions  faction ids taking part
 * @returns {Promise<{dealt: Object<string, string>, enough: boolean, available: number}>}
 */
export async function dealScars({ factions = [] }, { user } = {}) {
  requireGM(user ?? game.user);
  const deck = state.getCardStack("scarDeck");
  const actors = factions.map(f => requireFaction(f));
  if ( !deck ) return { dealt: {}, enough: false, available: 0 };
  await deck.recall({ chatNotification: false });
  const available = deck.availableCards.length;
  if ( !actors.length || (available < actors.length) ) {
    await chat.post({
      kind: "scarsNone", title: loc("RL.Sideboard.chat.scarsTitle"),
      result: game.i18n.format("RL.Sideboard.chat.scarsNotEnough", { n: available, players: actors.length })
    });
    return { dealt: {}, enough: false, available };
  }
  await deck.shuffle({ chatNotification: false });
  const hands = [];
  for ( const actor of actors ) {
    if ( !state.getHand(actor) ) await ensureHand({ faction: actor.id });
    hands.push(requireHand(actor));
  }
  const before = new Map(hands.map(h => [h.id, new Set(h.cards.keys())]));
  await deck.deal(hands, 1, { how: CONST.CARD_DRAW_MODES.TOP, chatNotification: false });
  const dealt = {};
  actors.forEach((actor, i) => {
    const hand = hands[i];
    const card = hand.cards.find(c => (c.type === "scar") && !before.get(hand.id).has(c.id));
    if ( card ) dealt[actor.id] = card.id;
  });
  await chat.post({
    kind: "scars", title: loc("RL.Sideboard.chat.scarsTitle"),
    result: game.i18n.format("RL.Sideboard.chat.scarsDealt", { n: actors.length })
  });
  return { dealt, enough: true, available };
}

/**
 * [GM] Play a Scar card from a faction's hand.
 * @param {object} options
 * @param {string} options.faction      the faction playing it
 * @param {string} options.cardId       the scar card in its hand
 * @param {string} [options.territory]  target territory (territory scars)
 * @param {string} [options.target]     target faction id (faction/weakness scars)
 * @returns {Promise<{scar: string, territory: string|null, target: string|null}>}
 */
export async function playScar({ faction, cardId, territory = null, target = null }, { user } = {}) {
  const actor = requireFaction(faction);
  requireActFor(user ?? game.user, actor);
  const campaign = requireCampaign();
  const hand = requireHand(actor);
  const card = hand.cards.get(cardId);
  if ( !card || (card.type !== "scar") ) throw new Error(loc("RL.CardsUI.error.notInHand"));
  const scarId = card.system.scar || card.system.catalogId;
  const game_ = gameNumber();
  const update = {};
  let text;

  if ( card.system.target === "faction" ) {
    const targetActor = factionActor(target);
    if ( !targetActor ) throw new Error(loc("RL.CardsUI.error.noTarget"));
    const slotTaken = targetActor.items.some(i => (i.type === "power") && (i.system.slot === "weakness"));
    gate(slotTaken ? state.fail("RL.CardsUI.reason.weaknessTaken", { faction: targetActor.name }) : state.ok());
    const powerId = card.getFlag(SYSTEM_ID, "power") ?? scarId;
    const power = catalog.entry("powers", powerId);
    await targetActor.createEmbeddedDocuments("Item", [{
      name: power?.name ?? card.name, type: "power",
      img: power?.img ? systemPath(power.img) : undefined,
      system: { slot: "weakness", text: power?.text ?? card.system.text, faction: "", pack: card.system.pack, key: power?.id ?? scarId, timing: power?.timing ?? "" }
    }]);
    text = game.i18n.format("RL.Sideboard.log.scarFaction", { faction: actor.name, scar: card.name, target: targetActor.name });
  }
  else {
    const board = state.getCampaignBoard();
    if ( !territory || (board && !board.territories[territory]) ) throw new Error(loc("RL.CardsUI.error.noTarget"));
    const blocker = scarBlocker(territory);
    gate(blocker ? state.fail(blocker, { territory: territoryName(territory) }) : state.ok());
    text = game.i18n.format("RL.Sideboard.log.scarTerritory", { faction: actor.name, scar: card.name, territory: territoryName(territory) });
    const entry = territoryEntry(campaign, territory);
    entry.scar = scarId;
    entry.scarGame = game_;
    // The new scar sticker covers a cancelled scar's white sticker (same as campaign.placeScar)
    entry.marks = (entry.marks ?? []).filter(m => m !== "cancel_scar");
    update[`system.territories.${territory}`] = entry;
  }
  update["system.log"] = [...campaign.system.toObject().log, { game: game_, date: today(), kind: "scar", text }];
  await campaign.update(update);

  const image = { img: card.currentFace?.img ?? card.img, alt: card.name, orientation: "landscape" };
  await recordRemoved("scar", card.system.catalogId);
  await deleteCardEverywhere(card.id);
  await chat.post({
    kind: "scarPlayed", faction: actor,
    title: game.i18n.format("RL.Sideboard.chat.scarPlayedTitle", { name: card.name }),
    images: [image, ...(card.system.stickerImg ? [{ img: card.system.stickerImg, alt: card.name, orientation: "sticker" }] : [])],
    result: foundry.utils.escapeHTML(text)
  });
  return { scar: scarId, territory, target };
}

/** Scar cards in a faction's hand (sync). */
export function getScarCards(faction) {
  return state.getHand(faction)?.cards.filter(c => c.type === "scar") ?? [];
}

/**
 * Why a territory can't take a scar sticker, or "" if it can. Scars go on any printed territory of the campaign board
 * that has no scar (a cancelled scar's white sticker may be covered by a new scar) and no Fallout Zone (it can't be
 * marked in any way). Territories added during the campaign (Alien Island) are stickers themselves, with no scar spot.
 * @param {string} id
 * @returns {string} a localization key, or ""
 */
export function scarBlocker(id) {
  const board = state.getCampaignBoard();
  const def = board?.territories?.[id];
  if ( board && !def ) return "RL.CardsUI.error.noTarget";
  if ( def?.custom ) return "RL.CardsUI.reason.noScarSpot";
  const marks = state.getCampaign()?.system.territories?.[id];
  if ( marks?.marks?.includes("fallout_zone") ) return "RL.CardsUI.reason.falloutZone";
  if ( marks?.scar ) return "RL.CardsUI.reason.alreadyScarred";
  return "";
}

/** Territories a territory scar may go on (sync): every printed territory without a scar or a Fallout Zone. */
export function scarTargets() {
  const board = state.getCampaignBoard();
  const ids = board?.ids ?? [];
  return ids.filter(id => !scarBlocker(id));
}

