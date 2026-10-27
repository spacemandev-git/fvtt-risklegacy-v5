import { SYSTEM_ID } from "../config.mjs";
import { BACK_LABELS, loc, textToHTML } from "./util.mjs";

/**
 * Plain view objects for templates (cards, piles). Card art is the real scan; cards without a scanned back get a
 * CSS back (`.rl-cardback--<type>`).
 */

const LANDSCAPE = new Set(["scar", "mission", "draft"]);

/** Scanned back image of a card, or null. */
export function backImage(card) {
  return card?._source?.back?.img || null;
}

/**
 * @param {Card} card
 * @param {object} [options]
 * @param {boolean} [options.reveal=true]  show the face (false: the back)
 * @returns {object}
 */
export function cardView(card, { reveal = true } = {}) {
  if ( !card ) return null;
  const type = card.type;
  const value = type === "territory" ? card.system.value : (type === "coin" ? 1 : null);
  const faceImg = card.currentFace?.img ?? card.faces?.[0]?.img ?? null;
  return {
    id: card.id,
    type,
    hidden: !reveal,
    name: reveal ? card.name : loc(BACK_LABELS[type] ?? "RL.CardsUI.back.resource"),
    img: reveal ? faceImg : backImage(card),
    backLabel: loc(BACK_LABELS[type] ?? "RL.CardsUI.back.resource"),
    landscape: LANDSCAPE.has(type),
    orientation: LANDSCAPE.has(type) ? "landscape" : "portrait",
    value: reveal ? value : null,
    even: reveal && (type === "territory") && (value % 2 === 0),
    coins: reveal ? (card.system?.coins ?? 0) : null,
    territory: reveal ? (card.system?.territory ?? "") : "",
    slot: card.system?.slot ?? 0,
    reward: reveal && (type === "mission") ? card.system.reward : null,
    text: reveal ? card.system?.text ?? "" : "",
    textHTML: reveal ? textToHTML(card.system?.text) : "",
    pending: !!card.getFlag?.(SYSTEM_ID, "pending"),
    kept: !!card.getFlag?.(SYSTEM_ID, "kept"),
    isResource: (type === "territory") || (type === "coin")
  };
}

/** Coins as an array for `{{#each}}` (filled/empty pips out of 6). */
export function coinPips(value) {
  return Array.from({ length: 6 }, (_, i) => ({ filled: i < value }));
}
