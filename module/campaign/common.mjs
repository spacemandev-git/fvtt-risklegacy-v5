import { CITY_TYPES, PACKS, STICKERS, SYSTEM_ID, TERRITORY_IDS, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";

/**
 * Small helpers shared by the campaign area: catalog access, names, sticker ids, the current game number,
 * other areas' APIs (looked up defensively), and log entries.
 */

export const TEMPLATES = `systems/${SYSTEM_ID}/templates/campaign`;
export const tpl = name => `${TEMPLATES}/${name}.hbs`;

/** Sticker ids in the catalog that have a different id in config STICKERS. */
export const STICKER_ALIASES = { continent_bonus: "continent_plus", continent_penalty: "continent_minus" };
export const stickerId = id => STICKER_ALIASES[id] ?? id;

/** Catalog city types (`effect.cityType`) → CITY_TYPES keys. */
export const CITY_ALIASES = { worldCapital: "capital", world_capital: "capital" };
export const cityType = type => CITY_ALIASES[type] ?? type;

/** Sticker used by each city type. */
export const CITY_STICKERS = { minor: "minor_city", major: "major_city", capital: "world_capital" };

/** Sticker art for UI, by inventory id (falls back to the catalog). */
const STICKER_ART = {
  coin_pregame: "assets/unlocks/base/stickersheet/images/coin.png",
  coin_heldon: "assets/unlocks/base/stickersheet/images/coin.png",
  minor_city: "assets/unlocks/base/stickersheet/images/minor_city.png",
  major_city: "assets/unlocks/base/stickersheet/images/major_city.png",
  fortification: "assets/unlocks/base/stickersheet/images/fortification.png",
  cancel_scar: "assets/unlocks/base/stickersheet/images/cancel.png",
  continent_plus: "assets/unlocks/base/stickersheet/images/plus_one.png",
  continent_minus: "assets/unlocks/base/stickersheet/images/minus_one.png",
  world_capital: "assets/unlocks/secondwin/stickersheet/images/scar_capital.png"
};

/** @returns {string} URL of a sticker's art */
export function stickerImg(id) {
  if ( STICKER_ART[id] ) return systemPath(STICKER_ART[id]);
  for ( const pack of state.allPacks() ) {
    const entry = pack.stickers?.find(s => stickerId(s.id) === id);
    if ( entry?.img ) return systemPath(entry.img);
  }
  return systemPath("assets/icons/star.png");
}

/** @returns {string} localized sticker name */
export function stickerLabel(id) {
  const key = STICKERS[id]?.label;
  if ( key ) return game.i18n.localize(key);
  for ( const pack of state.allPacks() ) {
    const entry = pack.stickers?.find(s => stickerId(s.id) === id);
    if ( entry ) return entry.name;
  }
  return id;
}

/* -------------------------------------------- */
/*  Catalog                                     */
/* -------------------------------------------- */

/**
 * A pack catalog, loading it if the preload missed it.
 * @param {string} packId
 * @returns {Promise<object|null>}
 */
export async function getCatalog(packId) {
  return state.getPack(packId) ?? await state.loadPack(packId).catch(err => {
    console.warn(`${SYSTEM_ID} | campaign: ${err.message}`);
    return null;
  });
}

/** @returns {string} the display label of a pack */
export function packLabel(packId) {
  const key = PACKS[packId]?.label;
  if ( key && game.i18n.has(key) ) return game.i18n.localize(key);
  return state.getPack(packId)?.label ?? packId;
}

/** Every catalog faction entry from the opened packs (and `extra` packs), in pack order. */
export function catalogFactions(packIds) {
  return state.allPacks().filter(p => !packIds || packIds.includes(p.id)).flatMap(p => p.factions ?? []);
}

/* -------------------------------------------- */
/*  Names                                       */
/* -------------------------------------------- */

const titleCase = id => id.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** @returns {string} the printed name of a territory */
export function territoryName(id) {
  if ( !id ) return "";
  const board = state.getCampaignBoard() ?? state.getBoard("original");
  return board?.territories?.[id]?.name ?? state.findEntry("territoryCards", id)?.name ?? titleCase(id);
}

/** @returns {string} a continent's name: the one written by a winner, else the printed label */
export function continentName(id, { printed = false } = {}) {
  if ( !id ) return "";
  const board = state.getCampaignBoard();
  const label = board?.continents?.[id]?.label ?? titleCase(id);
  if ( printed ) return label;
  return state.getCampaign()?.system.continents?.[id]?.name || label;
}

/** @returns {string} localized city type label */
export function cityLabel(type) {
  return game.i18n.localize(CITY_TYPES[type]?.label ?? type);
}

/**
 * Territories of the campaign board grouped by continent, for <select> optgroups and grids.
 * @param {object} [options]
 * @param {string[]} [options.only]  restrict to these territory ids
 * @returns {{id: string, label: string, color: string, territories: {id: string, name: string}[]}[]}
 */
export function territoryGroups({ only } = {}) {
  const board = state.getCampaignBoard() ?? state.getBoard("original");
  const allowed = only ? new Set(only) : null;
  if ( !board ) {
    const ids = (only ?? TERRITORY_IDS);
    return [{ id: "", label: "", color: "", territories: ids.map(id => ({ id, name: territoryName(id) })) }];
  }
  return Object.entries(board.continents).map(([id, c]) => ({
    id, label: continentName(id), color: c.color,
    territories: c.territories.filter(t => !allowed || allowed.has(t))
      .map(t => ({ id: t, name: board.territories[t]?.name ?? titleCase(t) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })).filter(g => g.territories.length);
}

/* -------------------------------------------- */
/*  Game number, dates, logging                 */
/* -------------------------------------------- */

/** Today as YYYY-MM-DD (local time). */
export function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The game the world is in: the war in progress, else the last game played (0 before the first game). */
export function currentGame(campaign = state.getCampaign()) {
  const war = state.getWar();
  if ( war ) return war.system.game;
  return campaign?.system.gamesPlayed ?? 0;
}

/**
 * Build a chronicle entry.
 * @param {string} kind
 * @param {string} text
 * @param {number} [game]
 */
export function logEntry(kind, text, game) {
  return { game: game ?? currentGame(), date: today(), kind, text };
}

/* -------------------------------------------- */
/*  Other areas (looked up at call time)        */
/* -------------------------------------------- */

/**
 * Another area's API function, or null if that area hasn't provided it (yet).
 * @param {string} area  "cards" | "board" | "turn" | "rules" | "apps" | "battle"
 * @param {string} name
 * @returns {Function|null}
 */
export function api(area, name) {
  const fn = game.risklegacy?.[area]?.[name];
  return typeof fn === "function" ? fn : null;
}

/**
 * Call another area's API defensively. Missing functions and failures are reported (console + `missing`), never
 * thrown, so the campaign flow carries on.
 * @param {string} area
 * @param {string} name
 * @param {object} payload
 * @param {string[]} [missing]  collects "area.name" strings for the report
 * @returns {Promise<*>} the result, or undefined
 */
export async function callArea(area, name, payload, missing) {
  const fn = api(area, name);
  if ( !fn ) {
    console.warn(`${SYSTEM_ID} | campaign: ${area}.${name}() is not available`);
    missing?.push(`${area}.${name}`);
    return undefined;
  }
  try {
    return await fn(payload);
  } catch(err) {
    console.error(`${SYSTEM_ID} | campaign: ${area}.${name}() failed`, err);
    missing?.push(`${area}.${name} (${err.message})`);
    return undefined;
  }
}

/** Throw unless this user is a GM. */
export function assertGM(user) {
  if ( !user?.isGM ) throw new Error(game.i18n.localize("RL.Legacy.Error.gmOnly"));
}

/** @returns {Actor} the campaign actor or throws */
export function requireCampaign() {
  const campaign = state.getCampaign();
  if ( !campaign ) throw new Error(game.i18n.localize("RL.Error.noCampaign"));
  return campaign;
}

/** A user's display name. */
export function userName(userId) {
  return game.users.get(userId)?.name ?? "";
}

/** Escape text for HTML. */
export function esc(text) {
  return foundry.utils.escapeHTML(String(text ?? ""));
}

/** Shuffle an array in place (Fisher–Yates). */
export function shuffle(array) {
  for ( let i = array.length - 1; i > 0; i-- ) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
