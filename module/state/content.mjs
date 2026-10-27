import { PACKS, systemPath } from "../config.mjs";

/**
 * The content catalog (data/content/<pack>.json, schema in ARCHITECTURE.md §Content catalog). Loaded at `ready`,
 * then available synchronously. Paths inside the catalog are relative to the system root; pass them through
 * `systemPath()` (config.mjs) before giving them to Foundry.
 */

const packs = new Map();
let index = null;

/** @returns {Promise<object>} the catalog index */
export async function loadIndex() {
  if ( index ) return index;
  const response = await fetch(systemPath("data/content/index.json"));
  if ( !response.ok ) throw new Error(`Could not load data/content/index.json (${response.status})`);
  index = await response.json();
  return index;
}

/**
 * Load (and cache) one pack's catalog.
 * @param {string} packId
 * @returns {Promise<object>}
 */
export async function loadPack(packId) {
  if ( packs.has(packId) ) return packs.get(packId);
  const response = await fetch(systemPath(`data/content/${packId}.json`));
  if ( !response.ok ) throw new Error(`Could not load data/content/${packId}.json (${response.status})`);
  const data = await response.json();
  packs.set(packId, data);
  return data;
}

/** Load every pack listed in PACKS. Missing files are logged, not thrown. */
export async function preloadContent() {
  await loadIndex().catch(err => console.warn(`risklegacy | ${err.message}`));
  await Promise.all(Object.keys(PACKS).map(id => loadPack(id).catch(err => {
    console.warn(`risklegacy | ${err.message}`);
  })));
}

/** @returns {object|null} a loaded pack catalog */
export function getPack(packId) {
  return packs.get(packId) ?? null;
}

/** @returns {object[]} all loaded pack catalogs, in pack order */
export function allPacks() {
  return [...packs.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Find a catalog entry by category and id across all loaded packs.
 * @param {string} category  e.g. "scars", "powers", "missions", "events", "territoryCards", "rules", "factions"
 * @param {string} id
 * @returns {object|null}  the entry, with a non-enumerable `pack` id attached
 */
export function findEntry(category, id) {
  for ( const pack of packs.values() ) {
    const entry = pack[category]?.find?.(e => e.id === id);
    if ( entry ) {
      if ( !("packId" in entry) ) Object.defineProperty(entry, "packId", { value: pack.id, enumerable: false });
      return entry;
    }
  }
  return null;
}
