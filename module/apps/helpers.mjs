/**
 * Shared helpers for the apps area (sheets, War Room, dialogs). Nothing here touches the database.
 */
import {
  CITY_TYPES, FACTIONS, FORTIFICATION_USES, POWER_SLOTS, POWER_SLOT_ORDER, RED_STARS_TO_WIN, SYSTEM_ID, SYSTEM_PATH,
  TERRITORY_IDS, systemPath
} from "../config.mjs";
import * as state from "../state/_module.mjs";

/** Full path of a template in this system. */
export const tpl = path => `${SYSTEM_PATH}/templates/${path}`;

/** Localize a key (with optional format data). Safe before i18n is ready (returns the key). */
export const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** "northwest_territory" → "Northwest Territory" (used when no board definition is loaded). */
export function humanize(id) {
  return String(id ?? "").split(/[_\s-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** Escape user text for HTML strings built in code. */
export const esc = s => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[c]);

/* -------------------------------------------- */
/*  Board lookups (graceful without a board)    */
/* -------------------------------------------- */

/** @returns {object|null} the campaign's board definition, if loaded */
export function board() {
  try {
    return state.getCampaignBoard();
  } catch(err) {
    return null;
  }
}

/** Territory display name. */
export function territoryName(id, b = board()) {
  if ( !id ) return "";
  return b?.territories?.[id]?.name ?? humanize(id);
}

/** All territory ids (board order if loaded, else the config list). */
export function territoryIds(b = board()) {
  return b?.ids?.length ? [...b.ids] : [...TERRITORY_IDS];
}

/** Continent id of a territory ("" without a board). */
export function continentOf(id, b = board()) {
  return b?.territories?.[id]?.continent ?? "";
}

/** Continent label (printed) from the board definition, or a humanized id. */
export function continentLabel(id, b = board()) {
  const label = b?.continents?.[id]?.label;
  return label ? (game.i18n.has(label) ? t(label) : label) : humanize(id);
}

/**
 * Resolve free text typed into a "starting territory" field to a territory id when it matches a name or id.
 * @returns {string} the id, or the text unchanged
 */
export function territoryIdFromText(text, b = board()) {
  const s = String(text ?? "").trim();
  if ( !s ) return "";
  const lower = s.toLowerCase();
  for ( const id of territoryIds(b) ) {
    if ( (id === lower) || (territoryName(id, b).toLowerCase() === lower) ) return id;
  }
  return s;
}

/* -------------------------------------------- */
/*  Factions                                    */
/* -------------------------------------------- */

/** The faction's accent colour as a CSS string. */
export function factionColor(actor) {
  return actor?.system?.color?.css ?? FACTIONS[actor?.system?.key]?.color ?? "#808285";
}

/**
 * Text colour that reads on a faction-colour background (white on dark colours, ink on light ones like Saharan
 * yellow).
 * @param {string} css  "#rrggbb"
 */
export function inkOn(css) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(css ?? "").trim());
  if ( !m ) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = (0.2126 * lin((n >> 16) & 255)) + (0.7152 * lin((n >> 8) & 255)) + (0.0722 * lin(n & 255));
  return L > 0.32 ? "#231f20" : "#ffffff";
}

/** Set `--rl-faction` and `--rl-on-faction` on an element. */
export function applyFactionVars(element, css) {
  if ( !element ) return;
  if ( css ) {
    element.style.setProperty("--rl-faction", css);
    element.style.setProperty("--rl-on-faction", inkOn(css));
  }
  else {
    element.style.removeProperty("--rl-faction");
    element.style.removeProperty("--rl-on-faction");
  }
}

/** The faction-card portrait cut-out (actor img, else the base art for the key). */
export function factionArt(actor) {
  const img = actor?.img;
  if ( img && !img.startsWith("icons/") && (img !== CONST.DEFAULT_TOKEN) ) return img;
  const key = actor?.system?.key;
  return key ? systemPath(`assets/unlocks/base/factions/images/${key}.png`) : CONST.DEFAULT_TOKEN;
}

/** The faction's HQ piece image. */
export function factionHQ(actor) {
  return actor?.system?.pieces?.hq || actor?.prototypeToken?.texture?.src || factionArt(actor);
}

/** CSS class for a faction key (only base factions have token variables; others use the inline colour). */
export const factionClass = key => (key ? `rl-faction--${key}` : "");

/** A display name for the user playing a faction this war. */
export function playerName(actor) {
  const w = actor?.system?.war;
  if ( !w ) return "";
  return game.users.get(w.playerId)?.name ?? w.playerName ?? "";
}

/* -------------------------------------------- */
/*  Powers                                      */
/* -------------------------------------------- */

/** Icon art for each power-slot type (the round icons printed on power cards). */
export const POWER_ICONS = {
  starter: systemPath("assets/unlocks/base/powers/starter.png"),
  mission: systemPath("assets/unlocks/worldcapital/powers/images/mission.png"),
  weakness: systemPath("assets/unlocks/thirtytroops/powers/images/weakness.png"),
  missile: systemPath("assets/unlocks/threemissiles/powers/images/missile.png"),
  knockout: systemPath("assets/unlocks/eliminated/powers/images/knockout.png"),
  scar: systemPath("assets/unlocks/base/scars/images/scar_bunker.png"),
  other: systemPath("assets/icons/star.png")
};

/** Power slot ids in rulebook order (white scar, red mission, yellow weakness, orange missile, blue knockout, green). */
export const SLOT_ORDER = POWER_SLOT_ORDER;

/** The sticker's display image: the item's own image unless it's a default icon, else the slot icon. */
export function powerIcon(item) {
  const img = item?.img;
  if ( img && !img.startsWith("icons/svg") && (img !== CONST.DEFAULT_TOKEN) ) return img;
  return POWER_ICONS[item?.system?.slot] ?? POWER_ICONS.other;
}

/** Localized slot label ("Mission Power"). */
export const slotLabel = slot => t(POWER_SLOTS[slot]?.label ?? "RL.Power.other");

/* -------------------------------------------- */
/*  Marks & campaign                            */
/* -------------------------------------------- */

/** Sticker sheet art for the base stickers (pack stickers bring their own `img` in the catalog). */
export const STICKER_ART = {
  coin_pregame: systemPath("assets/unlocks/base/stickersheet/images/coin.png"),
  coin_heldon: systemPath("assets/unlocks/base/stickersheet/images/coin.png"),
  minor_city: systemPath("assets/unlocks/base/stickersheet/images/minor_city.png"),
  major_city: systemPath("assets/unlocks/base/stickersheet/images/major_city.png"),
  fortification: systemPath("assets/unlocks/base/stickersheet/images/fortification.png"),
  cancel_scar: systemPath("assets/unlocks/base/stickersheet/images/cancel.png"),
  continent_plus: systemPath("assets/unlocks/base/stickersheet/images/plus_one.png"),
  continent_minus: systemPath("assets/unlocks/base/stickersheet/images/minus_one.png")
};

/** City mark art by city type. */
export const CITY_ART = {
  minor: STICKER_ART.minor_city,
  major: STICKER_ART.major_city,
  capital: STICKER_ART.major_city
};

/** Scar sticker art & name (catalog first, then the base scars). */
export function scarInfo(id) {
  if ( !id ) return null;
  const entry = safeFind("scars", id);
  const base = { bunker: "scar_bunker.png", ammo_shortage: "scar_ammo_shortage.png" }[id];
  const label = game.i18n.has(`RL.Scar.${id}`) ? t(`RL.Scar.${id}`) : (entry?.name ?? humanize(id));
  const img = entry?.stickerImg ? systemPath(entry.stickerImg)
    : (base ? systemPath(`assets/unlocks/base/scars/images/${base}`) : null);
  // The board reference shows the effect only: our short text, else the card's last paragraph
  const text = game.i18n.has(`RL.Sheet.ScarText.${id}`) ? t(`RL.Sheet.ScarText.${id}`)
    : (String(entry?.text ?? "").split(/\n\s*\n/).filter(Boolean).at(-1) ?? "");
  return { id, label, img, text };
}

/** Pack mark (biohazard, mercenary, …) art & name from the catalog. */
export function markInfo(id) {
  const entry = safeFind("marks", id);
  return { id, label: entry?.name ?? humanize(id), img: entry?.img ? systemPath(entry.img) : null, text: entry?.text ?? "" };
}

/** Catalog lookup that never throws (the catalog may not be loaded yet). */
export function safeFind(category, id) {
  try {
    return state.findEntry(category, id);
  } catch(err) {
    return null;
  }
}

/** Population of a city type. */
export const cityPopulation = type => CITY_TYPES[type]?.population ?? 0;

/** The ten fortification boxes, with `used` marked. */
export function fortificationBoxes(used = 0) {
  return Array.from({ length: FORTIFICATION_USES }, (_, i) => ({ index: i, used: i < used }));
}

/* -------------------------------------------- */
/*  Snapshot & live numbers                     */
/* -------------------------------------------- */

/** buildSnapshot() that never throws. */
export function snapshot() {
  try {
    return state.buildSnapshot();
  } catch(err) {
    console.warn(`${SYSTEM_ID} | apps: buildSnapshot failed`, err);
    return null;
  }
}

/**
 * Red Star slots for display: tokens first, then controlled HQs, then empty slots up to the goal.
 * @param {number} tokens
 * @param {number} hqs
 * @returns {{kind: "token"|"hq"|"empty"}[]}
 */
export function redStarSlots(tokens = 0, hqs = 0) {
  const slots = [];
  for ( let i = 0; i < tokens; i++ ) slots.push({ kind: "token" });
  for ( let i = 0; i < hqs; i++ ) slots.push({ kind: "hq" });
  while ( slots.length < RED_STARS_TO_WIN ) slots.push({ kind: "empty" });
  return slots;
}

/**
 * Call an optional API function of another area; resolves undefined when it doesn't exist.
 * @param {string} area   key of game.risklegacy
 * @param {string} name   function name
 */
export function api(area, name) {
  const fn = game.risklegacy?.[area]?.[name];
  return typeof fn === "function" ? fn.bind(game.risklegacy[area]) : null;
}

/** Run an async UI action, reporting errors as notifications instead of throwing into the void. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch(err) {
    console.error(`${SYSTEM_ID} | apps`, err);
    if ( err?.message ) ui.notifications.error(err.message);
    return null;
  }
}

/**
 * Register hooks that call `callback` (debounced) and return a disposer.
 * @param {string[]} names
 * @param {Function} callback
 * @param {object} [options]
 * @param {number} [options.wait=120]          debounce delay (ms)
 * @param {(doc: *, hook: string) => boolean} [options.filter]  ignore events for which this returns false
 * @returns {() => void}
 */
export function watchHooks(names, callback, { wait = 120, filter } = {}) {
  const fn = foundry.utils.debounce(callback, wait);
  const ids = names.map(name => [name, Hooks.on(name, doc => {
    if ( !filter || filter(doc, name) ) fn();
  })]);
  return () => {
    for ( const [name, id] of ids ) Hooks.off(name, id);
  };
}

/** Is this a document whose change can move numbers shown in the live (war) views? */
export function affectsWar(doc) {
  switch ( doc?.documentName ) {
    case "Token": return state.pieceKind(doc) !== null;
    case "Actor": return ["faction", "campaign"].includes(doc.type);
    case "Combat": return doc.type === "war";
    case "Card": case "Cards": return true;
    case "Item": return doc.type === "power";
    default: return true;
  }
}

/** Hooks the live views (War Room, faction "This War") listen to. */
export const WAR_HOOKS = ["createToken", "updateToken", "deleteToken", "createCombat", "updateCombat", "deleteCombat",
  "createCombatant", "updateCombatant", "deleteCombatant", "updateActor", "createCard", "updateCard", "deleteCard",
  "createCards", "updateCards", "deleteCards"];
