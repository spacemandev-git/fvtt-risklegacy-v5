import { PACKS, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";

/**
 * Content catalog access for the cards area.
 *
 * The real catalog is data/content/<pack>.json, loaded by module/state/content.mjs. While the content producer is
 * still generating it, the cards area falls back to its development fixture (tools/fixtures/cards/<pack>.json,
 * built from the same transcriptions). The fallback is only used when the real `base` pack is missing.
 */

const fallback = new Map();

/** Load the development fixture if the real catalog is absent. Called from the area's ready(). */
export async function loadFallback() {
  if ( state.getPack("base") ) return;
  console.warn("risklegacy | cards: data/content/base.json is missing; using tools/fixtures/cards/*.json");
  await Promise.all(Object.keys(PACKS).map(async id => {
    try {
      const response = await fetch(systemPath(`tools/fixtures/cards/${id}.json`));
      if ( response.ok ) fallback.set(id, await response.json());
    } catch(err) { /* ignore */ }
  }));
}

/** @returns {object|null} a pack catalog */
export function pack(id) {
  return state.getPack(id) ?? fallback.get(id) ?? null;
}

/** @returns {object[]} all known pack catalogs in pack order */
export function packs() {
  const loaded = state.allPacks();
  const list = loaded.length ? loaded : [...fallback.values()];
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Find a catalog entry (any pack). */
export function entry(category, id) {
  const found = state.findEntry(category, id);
  if ( found ) return found;
  for ( const p of fallback.values() ) {
    const e = p[category]?.find?.(x => x.id === id);
    if ( e ) return e;
  }
  return null;
}

/** Packs whose cards are in play for this campaign (base is always open). */
export function openedPackIds(campaign = state.getCampaign()) {
  return Object.keys(PACKS).filter(id => (id === "base") || !!campaign?.system.packs?.[id]?.opened);
}

/**
 * The six face image paths of a territory card for a board variant, with gaps filled (a pack card may lack scans
 * for some values; it then shows the nearest scanned face, or its placeholder, or the card back).
 * @param {object} card     catalog territoryCard entry
 * @param {string} variant  board variant
 * @returns {string[]}      6 system-relative paths
 */
export function territoryFaces(card, variant) {
  const raw = card.faces?.[variant] ?? card.faces?.original ?? Object.values(card.faces ?? {}).find(Array.isArray) ?? [];
  const list = Array.from({ length: 6 }, (_, i) => raw[i] ?? null);
  const fallbackImg = list.find(Boolean) ?? card.placeholderImg ?? card.back ?? null;
  return list.map((img, i) => {
    if ( img ) return img;
    for ( let d = 1; d < 6; d++ ) {
      if ( list[i - d] ) return list[i - d];
      if ( list[i + d] ) return list[i + d];
    }
    return fallbackImg;
  });
}
