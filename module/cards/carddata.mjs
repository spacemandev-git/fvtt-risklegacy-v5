import { MAX_CARD_VALUE, SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { territoryFaces } from "./catalog.mjs";
import { BACK_LABELS } from "./util.mjs";

/**
 * Card creation data built from content catalog entries (ARCHITECTURE §7). Every card carries
 * `system.catalogId` and `system.pack`, and its card-type specific fields from module/data/cards.mjs.
 */

const back = (type, img) => {
  const data = { name: game.i18n.localize(BACK_LABELS[type] ?? "RL.CardsUI.back.resource") };
  if ( img ) data.img = systemPath(img);
  return data;
};
/** A face entry; faces without a scan fall back to the core default icon. */
const face = (name, img) => ({ name, img: img ? systemPath(img) : foundry.documents.BaseCard.DEFAULT_ICON, text: "" });
const clampValue = v => Math.clamp(Math.round(Number(v) || 1), 1, MAX_CARD_VALUE);

/**
 * A territory card: six faces (1..6 resources) for the board variant; `face = value - 1`.
 * @param {object} entry   catalog territoryCard
 * @param {object} options
 * @param {string} options.variant
 * @param {number} [options.value]   current value (campaign record), defaults to the catalog's printed value
 * @param {string} options.pack
 */
export function territoryCard(entry, { variant, value, pack }) {
  const v = clampValue(value ?? entry.value ?? 1);
  const board = state.getBoard(variant);
  const name = board?.territories?.[entry.id]?.name ?? entry.name;
  const continent = board?.territories?.[entry.id]?.continent ?? entry.continent ?? "";
  return {
    name,
    type: "territory",
    suit: "territory",
    value: v,
    faces: territoryFaces(entry, variant).map(img => face(name, img)),
    face: v - 1,
    back: back("territory", entry.back),
    system: { catalogId: entry.id, pack, text: "", territory: entry.id, continent: continent ?? "", value: v, slot: 0 }
  };
}

/** One Coin card. */
export function coinCard(coinCards, pack = "base") {
  const name = game.i18n.localize("RL.CardsUI.coinCard");
  return {
    name,
    type: "coin",
    suit: "coin",
    value: 1,
    faces: [face(name, coinCards.img)],
    face: 0,
    back: back("coin", coinCards.back),
    system: { catalogId: "coin", pack, text: coinCards.text ?? "" }
  };
}

/** One Scar card. */
export function scarCard(entry, pack) {
  return {
    name: entry.name,
    type: "scar",
    suit: "scar",
    faces: [face(entry.name, entry.cardImg)],
    face: 0,
    back: back("scar"),
    system: {
      catalogId: entry.id, pack, text: entry.text ?? "",
      scar: entry.id,
      target: entry.target === "faction" ? "faction" : "territory",
      stickerImg: entry.stickerImg ? systemPath(entry.stickerImg) : "",
      effect: entry.effect ?? null
    },
    flags: { [SYSTEM_ID]: { play: entry.play ?? null, power: entry.power ?? null, code: entry.code ?? "" } }
  };
}

/** One Mission card. */
export function missionCard(entry, pack) {
  return {
    name: entry.name,
    type: "mission",
    suit: "mission",
    faces: [face(entry.name, entry.img)],
    face: 0,
    back: back("mission"),
    system: { catalogId: entry.id, pack, text: entry.text ?? "", reward: entry.reward ?? 1, check: entry.check ?? null },
    flags: { [SYSTEM_ID]: {
      afterComplete: entry.afterComplete ?? "box", power: entry.power ?? null, private: !!entry.private,
      opens: entry.opens ?? null, code: entry.code ?? ""
    } }
  };
}

/** One Event card. */
export function eventCard(entry, pack) {
  return {
    name: entry.name,
    type: "event",
    suit: "event",
    faces: [face(entry.name, entry.img)],
    face: 0,
    back: back("event"),
    system: { catalogId: entry.id, pack, text: entry.text ?? "", afterResolve: entry.afterResolve ?? "box", effect: entry.effect ?? null },
    flags: { [SYSTEM_ID]: { afterResolveText: entry.afterResolveText ?? "", code: entry.code ?? "" } }
  };
}

/** One Draft card. */
export function draftCard(entry, pack) {
  return {
    name: entry.name,
    type: "draft",
    suit: entry.type ?? "draft",
    value: entry.value ?? 0,
    faces: [face(entry.name, entry.img)],
    face: 0,
    back: back("draft"),
    system: { catalogId: entry.id, pack, text: entry.text ?? "", draftType: entry.type ?? "", players: entry.players ?? 0, value: entry.value ?? 0 }
  };
}
