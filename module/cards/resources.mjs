import * as state from "../state/_module.mjs";
import * as chat from "./chat.mjs";
import { topCard } from "./events.mjs";
import { ensureHand } from "./stacks.mjs";
import {
  RESOURCE_TYPES, isCurrentFaction, loc, requireActFor, requireFaction, requireGM, requireHand, requireStack
} from "./util.mjs";

/**
 * Resource cards in hands: reading, turning in (discard), dealing coins, and handing a knocked-out faction's cards
 * to the attacker.
 */

/**
 * The faction's resource cards (territory + coin), sync.
 * @param {Actor|string} faction
 * @returns {Card[]}
 */
export function getResourceCards(faction) {
  const hand = state.getHand(faction);
  if ( !hand ) return [];
  return hand.cards.contents.filter(c => RESOURCE_TYPES.includes(c.type))
    .sort((a, b) => (a.type === b.type) ? (b.system.coins - a.system.coins) || a.name.localeCompare(b.name) : (a.type === "coin" ? 1 : -1));
}

/** Total coins on a set of cards. */
export function coinsOf(cards) {
  return cards.reduce((n, c) => n + (c.system?.coins ?? 0), 0);
}

/**
 * [GM] Turn in resource cards: territory cards go to the discard pile, Coin cards back to the coin pile
 * (rulebook p. 8/9). Validates ownership only; the trade's legality is the caller's (turn.buyRedStars /
 * turn.tradeForTroops).
 * @param {object} options
 * @param {string} options.faction
 * @param {string[]} options.cardIds
 * @param {"redStar"|"troops"|string} [options.purpose]   recorded in war.system.turn.flags.discards for missions
 * @returns {Promise<{count: number, coins: number}>}
 */
export async function discardResources({ faction, cardIds = [], purpose = "" }, { user } = {}) {
  const actor = requireFaction(faction);
  requireActFor(user ?? game.user, actor);
  const hand = requireHand(actor);
  const cards = cardIds.map(id => hand.cards.get(id));
  if ( cards.some(c => !c || !RESOURCE_TYPES.includes(c.type)) ) throw new Error(loc("RL.CardsUI.error.notInHand"));
  if ( new Set(cardIds).size !== cardIds.length ) throw new Error(loc("RL.CardsUI.error.notInHand"));

  const coins = coinsOf(cards);
  const record = cards.map(c => ({ type: c.type, value: c.system.coins, territory: c.system.territory ?? "" }));
  const territoryIds = cards.filter(c => c.type === "territory").map(c => c.id);
  const coinIds = cards.filter(c => c.type === "coin").map(c => c.id);
  if ( territoryIds.length ) {
    await hand.pass(requireStack("discard"), territoryIds, { chatNotification: false, updateData: { system: { slot: 0 } } });
  }
  if ( coinIds.length ) {
    const coinDeck = requireStack("coinDeck");
    await hand.pass(coinDeck, coinIds, { chatNotification: false });
  }

  const war = state.getWar();
  if ( war && isCurrentFaction(actor) ) {
    const discards = [...(war.system.turn.flags?.discards ?? []), { purpose, cards: record }];
    await war.update({ "system.turn.flags.discards": discards });
  }
  return { count: cards.length, coins };
}

/**
 * [GM] Deal Coin cards from the coin pile to a faction (starting coin cards from the Minor Cities draft, events).
 * @param {object} options
 * @param {string} options.faction
 * @param {number} [options.count=1]
 * @returns {Promise<{cardIds: string[]}>}
 */
export async function dealCoins({ faction, count = 1 }, { user } = {}) {
  requireGM(user ?? game.user);
  const actor = requireFaction(faction);
  if ( !state.getHand(actor) ) await ensureHand({ faction: actor.id });
  const hand = requireHand(actor);
  const coinDeck = requireStack("coinDeck");
  const ids = [];
  for ( let i = 0; i < count; i++ ) {
    const card = topCard(coinDeck);
    if ( !card ) break;
    await coinDeck.pass(hand, [card.id], { chatNotification: false });
    ids.push(card.id);
  }
  if ( ids.length ) {
    await chat.post({
      kind: "dealCoins", faction: actor,
      title: game.i18n.format("RL.Sideboard.chat.dealCoinsTitle", { faction: actor.name, n: ids.length })
    });
  }
  return { cardIds: ids };
}

/**
 * [GM] Move a faction's resource cards to another faction (knock-out: the defender's cards go to the attacker).
 * @param {object} options
 * @param {string} options.from
 * @param {string} options.to
 * @param {boolean} [options.all=false]  move every card, not only resource cards
 * @returns {Promise<{count: number, cardIds: string[]}>}
 */
export async function transferHand({ from, to, all = false }, { user } = {}) {
  requireGM(user ?? game.user);
  const source = requireFaction(from);
  const target = requireFaction(to);
  const fromHand = state.getHand(source);
  if ( !fromHand ) return { count: 0, cardIds: [] };
  if ( !state.getHand(target) ) await ensureHand({ faction: target.id });
  const toHand = requireHand(target);
  const ids = fromHand.cards.filter(c => all || RESOURCE_TYPES.includes(c.type)).map(c => c.id);
  if ( !ids.length ) return { count: 0, cardIds: [] };
  await fromHand.pass(toHand, ids, { chatNotification: false });
  await chat.post({
    kind: "transfer", faction: target,
    title: game.i18n.format("RL.Sideboard.chat.transferTitle", { from: source.name, to: target.name, n: ids.length })
  });
  return { count: ids.length, cardIds: ids };
}
