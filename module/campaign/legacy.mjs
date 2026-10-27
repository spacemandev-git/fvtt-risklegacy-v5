import { CITY_TYPES, FORTIFICATION_USES, MAX_CARD_VALUE, SYSTEM_ID } from "../config.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import * as state from "../state/_module.mjs";
import { triggerPack } from "./packs.mjs";
import {
  CITY_STICKERS, api, assertGM, callArea, cityLabel, cityType, continentName, currentGame, logEntry, requireCampaign,
  stickerId, stickerLabel, territoryName, today
} from "./common.mjs";

/**
 * Legacy operations: every permanent change to the world board. Each one is a GM action (`campaign.<op>`) that
 * validates the change against the board, takes the sticker out of the inventory when one is used, updates the
 * campaign actor in a single update, appends to the chronicle (`system.log`) and fires its §8 hook.
 *
 * Exported functions are thin `runAction` wrappers and can be called from any client.
 */

const fmt = (key, data) => game.i18n.format(key, data);

/**
 * Validate a legacy change: GMs editing by hand follow the enforcement setting (strict blocks, advisory warns).
 * @param {boolean} condition  true when the change is legal
 * @param {string} reason      localization key
 * @param {object} [data]
 */
function check(condition, reason, data = {}) {
  if ( condition ) return;
  const result = state.fail(reason, data);
  if ( state.enforcementLevel() === "off" ) return;
  if ( state.enforcementLevel() === "advisory" ) {
    ui.notifications.warn(game.i18n.format("RL.Enforce.advisory", { reason: state.reasonText(result) }));
    return;
  }
  throw new Error(state.reasonText(result));
}

function requireTerritory(territory) {
  const board = state.getCampaignBoard();
  if ( !territory || (board && !board.territories[territory]) ) {
    throw new Error(fmt("RL.Legacy.Error.unknownTerritory", { territory: territory ?? "" }));
  }
}

function requireContinent(continent) {
  const board = state.getCampaignBoard();
  if ( !continent || (board && !board.continents[continent]) ) {
    throw new Error(fmt("RL.Legacy.Error.unknownContinent", { continent: continent ?? "" }));
  }
}

/** Current marks of a territory, with defaults. */
function marksOf(campaign, territory) {
  const t = campaign.system.territories?.[territory] ?? {};
  return {
    city: t.city ?? { type: "", name: "", founder: "", founderId: "", game: 0 },
    fortification: t.fortification ?? { active: false, used: 0 },
    scar: t.scar ?? "",
    scarGame: t.scarGame ?? 0,
    cardDestroyed: !!t.cardDestroyed,
    marks: [...(t.marks ?? [])]
  };
}

/** Is a territory permanently sealed against new marks (Fallout Zone)? */
const isUnmodifiable = marks => marks.marks.includes("fallout_zone");

/**
 * Territories added during the campaign (Alien Island) are round stickers on the ocean: they have no bow-tie spot
 * for a city, scar, fortification or mark.
 */
function requireMarkSpot(territory) {
  const custom = !!state.getCampaignBoard()?.territories?.[territory]?.custom;
  check(!custom, "RL.Legacy.Error.noMarkSpot", { territory: territoryName(territory) });
}

/**
 * Add a sticker decrement to an update, checking stock. A GM may `force` a placement when the sheet has run out
 * (the count stays at 0).
 * @returns {object} update data
 */
function useSticker(campaign, id, count = 1, force = false) {
  const left = campaign.system.stickers?.[id] ?? 0;
  if ( !force ) check(left >= count, "RL.Legacy.Error.noSticker", { sticker: stickerLabel(id) });
  return { [`system.stickers.${id}`]: Math.max(0, left - count) };
}

/** Only GMs may override the sticker stock. */
const forced = (force, user) => !!force && !!user?.isGM;

/** Apply an update plus chronicle entries in one database write. */
async function commit(campaign, update, entries = []) {
  if ( entries.length ) update["system.log"] = [...campaign.system.toObject().log, ...entries];
  await campaign.update(update);
  return campaign;
}

/* -------------------------------------------- */
/*  Cities, fortifications, scars, marks        */
/* -------------------------------------------- */

/**
 * Found a city (Minor/Major as an end-of-game reward, the World Capital from "The world is ready").
 * @param {object} payload
 * @param {string} payload.territory
 * @param {"minor"|"major"|"capital"} [payload.type="minor"]
 * @param {string} payload.name           the name written on the sticker
 * @param {string} [payload.founder]      player name (initials)
 * @param {string} [payload.founderId]    User id (a Major City is a legal start for its founder only)
 * @param {boolean} [payload.sticker=true]  take the sticker from the inventory
 */
async function foundCityHandler({ territory, type = "minor", name = "", founder = "", founderId = "", sticker = true, game: gameNumber, force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  type = cityType(type);
  requireTerritory(territory);
  requireMarkSpot(territory);
  if ( !CITY_TYPES[type] ) throw new Error(fmt("RL.Legacy.Error.unknownCity", { type }));
  const marks = marksOf(campaign, territory);
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  // The World Capital replaces any mark already in the city slot; other cities need an empty slot.
  if ( type !== "capital" ) check(!marks.city.type, "RL.Legacy.Error.hasCity", { territory: territoryName(territory) });
  check(!!name.trim(), "RL.Legacy.Error.noName");

  // The World Capital envelope must be opened as the mark is about to go on the board.
  if ( (type === "capital") && !campaign.system.isPackOpen("worldcapital") ) {
    await triggerPack("worldcapital", { reason: fmt("RL.Legacy.Log.capitalAbout", { territory: territoryName(territory) }) });
  }

  const g = gameNumber ?? currentGame(campaign);
  const update = {
    [`system.territories.${territory}.city`]: { type, name: name.trim(), founder, founderId, game: g }
  };
  if ( sticker ) Object.assign(update, useSticker(campaign, CITY_STICKERS[type], 1, forced(force, user)));
  if ( marks.marks.includes("ruins") ) update[`system.territories.${territory}.marks`] = marks.marks.filter(m => m !== "ruins");
  const text = fmt("RL.Legacy.Log.cityFounded", {
    founder: founder || game.i18n.localize("RL.Legacy.Someone"), type: cityLabel(type), name: name.trim(),
    territory: territoryName(territory)
  });
  await commit(campaign, update, [logEntry("city", text, g)]);
  Hooks.callAll("risklegacy.cityFounded", territory, type);
  return { territory, type };
}

/**
 * Place a Fortification mark around a city (a new mark replaces a worn one: its remaining uses are lost).
 * @param {object} payload
 * @param {string} payload.territory
 * @param {boolean} [payload.sticker=true]
 */
async function fortifyCityHandler({ territory, sticker = true, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  requireMarkSpot(territory);
  const marks = marksOf(campaign, territory);
  check(!!marks.city.type, "RL.Legacy.Error.noCity", { territory: territoryName(territory) });
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  const update = { [`system.territories.${territory}.fortification`]: { active: true, used: 0 } };
  if ( sticker ) Object.assign(update, useSticker(campaign, "fortification", 1, forced(force, user)));
  const text = fmt("RL.Legacy.Log.fortified", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), name: marks.city.name || cityLabel(marks.city.type),
    territory: territoryName(territory)
  });
  await commit(campaign, update, [logEntry("fortification", text)]);
  return { territory, uses: FORTIFICATION_USES };
}

/**
 * Put a scar sticker on a territory (scar cards are normally played through `cards.playScar`; this is for
 * corrections and events).
 * @param {object} payload
 * @param {string} payload.territory
 * @param {string} payload.scar    scar id (bunker, ammo_shortage, biohazard, mercenary…)
 */
async function placeScarHandler({ territory, scar, by = "" } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  requireMarkSpot(territory);
  if ( !scar ) throw new Error(game.i18n.localize("RL.Legacy.Error.noScarId"));
  const marks = marksOf(campaign, territory);
  check(!marks.scar, "RL.Legacy.Error.hasScar", { territory: territoryName(territory) });
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  const g = currentGame(campaign);
  const scarName = state.findEntry("scars", scar)?.name ?? scar;
  const text = fmt("RL.Legacy.Log.scarPlaced", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), scar: scarName, territory: territoryName(territory)
  });
  // A new scar sticker covers a white "cancelled" sticker.
  await commit(campaign, {
    [`system.territories.${territory}.scar`]: scar,
    [`system.territories.${territory}.scarGame`]: g,
    [`system.territories.${territory}.marks`]: marks.marks.filter(m => m !== "cancel_scar")
  }, [logEntry("scar", text, g)]);
  return { territory, scar };
}

/**
 * Cancel a scar with a white sticker.
 * @param {object} payload
 * @param {string} payload.territory
 * @param {boolean} [payload.sticker=true]
 */
async function cancelScarHandler({ territory, sticker = true, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  requireMarkSpot(territory);
  const marks = marksOf(campaign, territory);
  check(!!marks.scar, "RL.Legacy.Error.noScar", { territory: territoryName(territory) });
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  const scarName = state.findEntry("scars", marks.scar)?.name ?? marks.scar;
  // The white sticker covers the old scar: the board overlay draws it from the "cancel_scar" mark.
  const update = {
    [`system.territories.${territory}.scar`]: "",
    [`system.territories.${territory}.scarGame`]: 0,
    [`system.territories.${territory}.marks`]: [...new Set([...marks.marks, "cancel_scar"])]
  };
  if ( sticker ) Object.assign(update, useSticker(campaign, "cancel_scar", 1, forced(force, user)));
  const text = fmt("RL.Legacy.Log.scarCancelled", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), scar: scarName, territory: territoryName(territory)
  });
  await commit(campaign, update, [logEntry("scar", text)]);
  return { territory };
}

/**
 * Place a pack mark on a territory (fallout_zone, ruins, …). The Fallout Zone covers the city and scar, and
 * destroys the territory card. Ruins replace a city.
 * @param {object} payload
 * @param {string} payload.territory
 * @param {string} payload.mark       catalog mark id
 * @param {boolean} [payload.sticker=true]
 */
async function placeMarkHandler({ territory, mark, sticker = true, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  requireMarkSpot(territory);
  if ( !mark ) throw new Error(game.i18n.localize("RL.Legacy.Error.noMarkId"));
  const marks = marksOf(campaign, territory);
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  const update = { [`system.territories.${territory}.marks`]: [...new Set([...marks.marks, mark])] };
  const missing = [];
  if ( mark === "fallout_zone" ) {
    update[`system.territories.${territory}.city`] = { type: "", name: "", founder: "", founderId: "", game: 0 };
    update[`system.territories.${territory}.fortification`] = { active: false, used: 0 };
    update[`system.territories.${territory}.scar`] = "";
    update[`system.territories.${territory}.cardDestroyed`] = true;
  }
  else if ( mark === "ruins" ) {
    check(!!marks.city.type, "RL.Legacy.Error.noCity", { territory: territoryName(territory) });
    update[`system.territories.${territory}.city`] = { type: "", name: "", founder: "", founderId: "", game: 0 };
    update[`system.territories.${territory}.fortification`] = { active: false, used: 0 };
  }
  if ( sticker && (campaign.system.stickers?.[stickerId(mark)] !== undefined) ) {
    Object.assign(update, useSticker(campaign, stickerId(mark), 1, forced(force, user)));
  }
  const markName = state.findEntry("marks", mark)?.name ?? mark;
  const text = fmt("RL.Legacy.Log.markPlaced", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), mark: markName, territory: territoryName(territory)
  });
  await commit(campaign, update, [logEntry("mark", text)]);
  if ( mark === "fallout_zone" ) {
    // "Find the territory card for the fallout territory and DESTROY it, even if it is currently in a player's
    // hand. Reshuffle the territory deck."
    await callArea("cards", "destroyTerritoryCard", { territory }, missing);
    await state.getCardStack("territoryDeck")?.shuffle({ chatNotification: false });
  }
  return { territory, mark, missing };
}

/* -------------------------------------------- */
/*  Continents                                  */
/* -------------------------------------------- */

/**
 * Name an unnamed continent (+1 troop for the namer when they control it).
 * @param {object} payload
 * @param {string} payload.continent
 * @param {string} payload.name
 * @param {string} [payload.namedBy]    player name
 * @param {string} [payload.namedById]  User id
 */
async function nameContinentHandler({ continent, name = "", namedBy = "", namedById = "" } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireContinent(continent);
  const current = campaign.system.continents?.[continent];
  check(!current?.name, "RL.Legacy.Error.continentNamed", { continent: continentName(continent) });
  check(!!name.trim(), "RL.Legacy.Error.noName");
  const g = currentGame(campaign);
  const text = fmt("RL.Legacy.Log.continentNamed", {
    by: namedBy || game.i18n.localize("RL.Legacy.Someone"), continent: continentName(continent, { printed: true }),
    name: name.trim()
  });
  await commit(campaign, {
    [`system.continents.${continent}`]: {
      name: name.trim(), namedBy, namedById, modifier: current?.modifier ?? 0, game: g
    }
  }, [logEntry("continent", text, g)]);
  return { continent };
}

/**
 * Put the +1 or −1 continent mark next to a continent's bonus (once per continent).
 * @param {object} payload
 * @param {string} payload.continent
 * @param {1|-1} payload.delta
 * @param {boolean} [payload.sticker=true]
 */
async function modifyContinentHandler({ continent, delta, sticker = true, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireContinent(continent);
  delta = Math.sign(Number(delta));
  if ( !delta ) throw new Error(game.i18n.localize("RL.Legacy.Error.badDelta"));
  const current = campaign.system.continents?.[continent];
  check(!current?.modifier, "RL.Legacy.Error.continentModified", { continent: continentName(continent) });
  const update = {
    [`system.continents.${continent}`]: {
      name: current?.name ?? "", namedBy: current?.namedBy ?? "", namedById: current?.namedById ?? "",
      modifier: delta, game: current?.game ?? 0
    }
  };
  if ( sticker ) Object.assign(update, useSticker(campaign, delta > 0 ? "continent_plus" : "continent_minus", 1, forced(force, user)));
  const text = fmt("RL.Legacy.Log.continentModified", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), continent: continentName(continent),
    delta: delta > 0 ? "+1" : "−1"
  });
  await commit(campaign, update, [logEntry("continent", text)]);
  return { continent, modifier: delta };
}

/* -------------------------------------------- */
/*  Territory cards                             */
/* -------------------------------------------- */

/**
 * Set a territory card's value directly on the Card documents (fallback when the cards area doesn't provide
 * `setTerritoryValue`/`upgradeTerritoryCard`).
 */
async function setCardValueDirect(territory, value) {
  value = Math.clamp(value, 1, MAX_CARD_VALUE);
  for ( const stack of game.cards ) {
    const updates = stack.cards.filter(c => (c.type === "territory") && (c.system.territory === territory))
      .map(c => ({ _id: c.id, "system.value": value, face: Math.min(value - 1, (c.faces?.length ?? 1) - 1) }));
    if ( updates.length ) await stack.updateEmbeddedDocuments("Card", updates);
  }
}

/** Current resource value of a territory's card: the campaign's record, the Card documents, the catalog. */
export function territoryCardValue(territory) {
  const campaign = state.getCampaign();
  const recorded = campaign?.system.cards?.values?.[territory] ?? campaign?.flags?.[SYSTEM_ID]?.cards?.values?.[territory];
  if ( Number.isFinite(recorded) ) return recorded;
  for ( const stack of game.cards ) {
    const card = stack.cards.find(c => (c.type === "territory") && (c.system.territory === territory));
    if ( card ) return card.system.value;
  }
  return state.findEntry("territoryCards", territory)?.value ?? 1;
}

/** Does a territory card still exist (not destroyed)? */
export function territoryCardExists(territory) {
  if ( state.getCampaign()?.system.territories?.[territory]?.cardDestroyed ) return false;
  const anyCards = game.cards.some(s => s.cards.some(c => c.type === "territory"));
  if ( !anyCards ) return true;
  return game.cards.some(s => s.cards.some(c => (c.type === "territory") && (c.system.territory === territory)));
}

/**
 * Add coin stickers to a territory card.
 * @param {object} payload
 * @param {string} payload.territory
 * @param {number} [payload.amount=1]
 * @param {string|null} [payload.sticker="coin_heldon"]  sticker taken per coin (null = none)
 * @param {number} [payload.max=6]       maximum value (3 before the first game)
 */
async function upgradeCardHandler({ territory, amount = 1, sticker = "coin_heldon", max = MAX_CARD_VALUE, by = "", log = true, force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  check(territoryCardExists(territory), "RL.Legacy.Error.cardDestroyed", { territory: territoryName(territory) });
  const before = territoryCardValue(territory);
  const value = before + amount;
  check(value <= max, "RL.Legacy.Error.cardMax", { territory: territoryName(territory), max });
  const update = sticker ? useSticker(campaign, sticker, amount, forced(force, user)) : {};
  const missing = [];
  if ( api("cards", "setTerritoryValue") ) await callArea("cards", "setTerritoryValue", { territory, value }, missing);
  else if ( api("cards", "upgradeTerritoryCard") ) await callArea("cards", "upgradeTerritoryCard", { territory, amount }, missing);
  else {
    missing.push("cards.upgradeTerritoryCard");
    await setCardValueDirect(territory, value);
  }
  const entries = log ? [logEntry("card", fmt("RL.Legacy.Log.cardUpgraded", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), territory: territoryName(territory), value
  }))] : [];
  if ( Object.keys(update).length || entries.length ) await commit(campaign, update, entries);
  return { territory, value, missing };
}

/**
 * Destroy a territory card (winner's reward, Fallout Zone): the card is torn up and a small "x" is written next to
 * the territory's name on the board.
 * @param {object} payload
 * @param {string} payload.territory
 */
async function destroyCardHandler({ territory, by = "" } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  check(!campaign.system.territories?.[territory]?.cardDestroyed, "RL.Legacy.Error.cardDestroyed",
    { territory: territoryName(territory) });
  const missing = [];
  if ( api("cards", "destroyTerritoryCard") ) await callArea("cards", "destroyTerritoryCard", { territory }, missing);
  else {
    missing.push("cards.destroyTerritoryCard");
    for ( const stack of game.cards ) {
      const ids = stack.cards.filter(c => (c.type === "territory") && (c.system.territory === territory)).map(c => c.id);
      if ( ids.length ) await stack.deleteEmbeddedDocuments("Card", ids);
    }
  }
  const text = fmt("RL.Legacy.Log.cardDestroyed", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), territory: territoryName(territory)
  });
  await commit(campaign, { [`system.territories.${territory}.cardDestroyed`]: true }, [logEntry("card", text)]);
  return { territory, missing };
}

/* -------------------------------------------- */
/*  Games, victors, the world                   */
/* -------------------------------------------- */

/**
 * Record (or update) a game in `campaign.system.games`, upserting by game number. When the entry becomes signed,
 * fires `risklegacy.victorSigned(game, playerId, signatureCount)`.
 * @param {object} entry  a games[] entry (partial entries are merged into the existing one)
 * @returns {{number: number, signatures: number}}
 */
async function recordGameHandler(entry = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  const games = campaign.system.toObject().games;
  const number = entry.number ?? (games.length + 1);
  const index = games.findIndex(g => g.number === number);
  const previous = index >= 0 ? games[index] : null;
  const merged = foundry.utils.mergeObject(previous ?? {
    number, date: today(), winner: { faction: "", factionName: "", player: "", playerId: "", motto: "" },
    signed: false, reward: "", rewardDetail: "", results: []
  }, entry, { inplace: false });
  merged.number = number;
  if ( index >= 0 ) games[index] = merged;
  else games.push(merged);
  games.sort((a, b) => a.number - b.number);

  const entries = [];
  if ( !previous ) {
    const winner = merged.winner.factionName
      ? fmt("RL.Legacy.Log.gameWon", { number, faction: merged.winner.factionName, player: merged.winner.player || "?" })
      : fmt("RL.Legacy.Log.gameEnded", { number });
    entries.push(logEntry("victory", winner, number));
  }
  const newlySigned = merged.signed && !previous?.signed;
  if ( newlySigned ) {
    entries.push(logEntry("victory", fmt("RL.Legacy.Log.signed", {
      player: merged.winner.player, number, motto: merged.winner.motto ? `“${merged.winner.motto}”` : ""
    }).trim(), number));
  }
  await commit(campaign, { "system.games": games }, entries);
  const signatures = campaign.system.signaturesOf(merged.winner.playerId, merged.winner.player);
  if ( newlySigned ) Hooks.callAll("risklegacy.victorSigned", number, merged.winner.playerId, signatures);
  return { number, signatures };
}

/**
 * Name the world ("The World Of ___") after the 15th game.
 * @param {object} payload
 * @param {string} payload.name
 * @param {string} [payload.namedBy]
 * @param {string} [payload.namedById]
 */
async function nameWorldHandler({ name = "", namedBy = "", namedById = "" } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  check(!!name.trim(), "RL.Legacy.Error.noName");
  const text = fmt("RL.Legacy.Log.worldNamed", { by: namedBy || game.i18n.localize("RL.Legacy.Someone"), name: name.trim() });
  await commit(campaign, {
    "system.worldName": name.trim(), "system.worldNamedBy": namedBy, "system.worldNamedById": namedById
  }, [logEntry("world", text)]);
  return { name: name.trim() };
}

/**
 * Add an entry to the chronicle.
 * @param {object} payload
 * @param {string} payload.text
 * @param {string} [payload.kind="note"]
 * @param {number} [payload.game]
 */
async function addLogHandler({ text = "", kind = "note", game: g } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  if ( !text.trim() ) return { ok: false };
  await commit(campaign, {}, [logEntry(kind, text.trim(), g)]);
  return { ok: true };
}

/**
 * Change the sticker inventory (pack contents, GM corrections).
 * @param {object} payload
 * @param {Object<string, number>} payload.add   sticker id → count to add (negative to remove)
 */
async function adjustStickersHandler({ add = {} } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  const update = {};
  for ( const [raw, n] of Object.entries(add) ) {
    const id = stickerId(raw);
    update[`system.stickers.${id}`] = Math.max(0, (campaign.system.stickers?.[id] ?? 0) + Number(n || 0));
  }
  await campaign.update(update);
  return { stickers: campaign.system.stickers };
}

/* -------------------------------------------- */
/*  Changing the map: sea lines, Alien Island   */
/* -------------------------------------------- */

/**
 * Stickers used per pen-drawn sea line: Explore the World's two "sea-line start" stickers make ONE line (one sticker
 * at each end); each of Alien Island's two start stickers makes one line to a sea line printed on the island.
 */
export const SEA_LINE_STICKERS = { sea_line_start: 2, alien_island_sea_line_start: 1 };

/** Is a war being played on the board right now (pieces on the board)? */
export function warOnBoard() {
  const stage = state.getWar()?.system.stage;
  return (stage === "placement") || (stage === "playing");
}

/** A pen line's ends, if given as two [x, y] pairs. */
function validPoints(points) {
  if ( !Array.isArray(points) || (points.length !== 2) ) return null;
  const pts = points.map(p => (Array.isArray(p) ? p.slice(0, 2).map(Number) : []));
  return pts.every(p => (p.length === 2) && p.every(Number.isFinite)) ? pts.map(p => p.map(Math.round)) : null;
}

/**
 * Connect two coastal territories with a pen-drawn sea line (Explore the World, Alien Island). The new connection
 * goes into `campaign.system.seaLines`, which the campaign board merges into every territory's neighbours.
 * @param {object} payload
 * @param {string} payload.a
 * @param {string} payload.b                  a printed territory or a custom one (alien_island)
 * @param {string} [payload.sticker="sea_line_start"]  sea_line_start (2 per line) | alien_island_sea_line_start (1)
 * @param {number[][]} [payload.points]       the pen line's ends [[xa, ya], [xb, yb]] (default: nearest coast points)
 * @param {string} [payload.by]
 * @param {boolean} [payload.force=false]     GM: place it even if the sticker sheet has run out
 */
async function addSeaLineHandler({ a, b, sticker = "sea_line_start", by = "", points, force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(a);
  requireTerritory(b);
  const board = state.getCampaignBoard();
  check(a !== b, "RL.Legacy.Error.seaLineSame");
  for ( const id of [a, b] ) {
    check(!!board?.territories?.[id]?.coastal, "RL.Legacy.Error.notCoastal", { territory: territoryName(id) });
    check(!isUnmodifiable(marksOf(campaign, id)), "RL.Legacy.Error.unmodifiable", { territory: territoryName(id) });
  }
  check(!board?.areAdjacent(a, b), "RL.Legacy.Error.alreadyConnected", { a: territoryName(a), b: territoryName(b) });
  const perLine = SEA_LINE_STICKERS[sticker] ?? 2;
  const update = useSticker(campaign, sticker, perLine, forced(force, user));
  const ends = validPoints(points) ?? (board ? state.seaLineEndpoints(board, a, b) : []);
  update["system.seaLines"] = [...campaign.system.toObject().seaLines,
    { a, b, sticker, game: currentGame(campaign), points: ends }];
  const text = fmt("RL.Legacy.Log.seaLine", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), a: territoryName(a), b: territoryName(b)
  });
  await commit(campaign, update, [logEntry("mark", text)]);
  return { a, b, sticker, points: ends };
}

/** Default size of the Alien Island sticker on the board (scene px). */
export const ALIEN_ISLAND_RADIUS = 150;

/**
 * Stick the Alien Island sticker onto an ocean: a new territory `alien_island` of no continent, connected to the
 * world only by the two sea lines drawn next (`addSeaLine` with b = "alien_island").
 * @param {object} payload
 * @param {number} payload.x
 * @param {number} payload.y
 * @param {number} [payload.radius=150]
 * @param {string} [payload.by]            who placed it (the Alien Collaborator's player)
 * @param {boolean} [payload.force=false]
 */
async function placeAlienIslandHandler({ x, y, radius = ALIEN_ISLAND_RADIUS, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  if ( campaign.system.customTerritories?.alien_island ) {
    throw new Error(game.i18n.localize("RL.Legacy.Error.alienIslandPlaced"));
  }
  x = Math.round(Number(x));
  y = Math.round(Number(y));
  radius = Math.max(40, Math.round(Number(radius) || ALIEN_ISLAND_RADIUS));
  const board = state.getCampaignBoard();
  const width = board?.scene?.width ?? 6000;
  const height = board?.scene?.height ?? 4000;
  if ( !Number.isFinite(x) || !Number.isFinite(y) || (x < 0) || (y < 0) || (x > width) || (y > height) ) {
    throw new Error(game.i18n.localize("RL.Legacy.Error.badPoint"));
  }
  const water = api("board", "isOpenWater")?.({ x, y }, radius);
  if ( water && !water.ok ) check(false, "RL.Legacy.Error.notOpenWater", { reason: water.reason ?? "" });
  const update = useSticker(campaign, "alien_island", 1, forced(force, user));
  const name = state.findEntry("marks", "alien_island")?.name ?? game.i18n.localize("RL.Legacy.AlienIsland.name");
  const g = currentGame(campaign);
  update["system.customTerritories.alien_island"] = {
    name, kind: "alien_island", x, y, radius, continent: "", game: g, by
  };
  const text = fmt("RL.Legacy.Log.alienIsland", { by: by || game.i18n.localize("RL.Legacy.Someone") });
  await commit(campaign, update, [logEntry("mark", text, g)]);
  return { territory: "alien_island", x, y, radius };
}

/**
 * The War Progresses (Thirty Troops 4): the Alien Collaborator places the 30+ troops he is getting (his reserve)
 * onto Alien Island along with 10 Alien troops. For this game the Collaborator and the Aliens are one faction, so
 * the 10 Alien troops are spawned as the Collaborator's own pieces (the island stays uncontested).
 * @param {object} payload
 * @param {string} payload.faction  the collaborating faction
 * @param {number} [payload.aliens=10]
 * @returns {{troops: number, reserve: number, aliens: number, skipped?: boolean}}
 */
async function alienLandingHandler({ faction, aliens = 10, force = false } = {}, { user }) {
  assertGM(user);
  const actor = game.actors.get(faction);
  if ( !actor || (actor.type !== "faction") ) throw new Error(fmt("RL.Legacy.Error.noFaction", { faction: String(faction ?? "") }));
  if ( !warOnBoard() || !actor.system.war?.active ) return { troops: 0, reserve: 0, aliens: 0, skipped: true };
  requireTerritory("alien_island");
  // It happens once, in the game the pocket is opened
  const campaign = requireCampaign();
  const war = state.getWar();
  const done = campaign.getFlag(SYSTEM_ID, "alienLanding");
  if ( done && (done.war === war?.id) && !forced(force, user) ) return { troops: 0, reserve: 0, aliens: 0, skipped: true, already: true };
  const reserve = Math.max(0, actor.system.war.reserve ?? 0);
  const troops = reserve + Math.max(0, Math.round(Number(aliens) || 0));
  const missing = [];
  await callArea("board", "spawnPieces", { faction: actor.id, territory: "alien_island", troops }, missing);
  if ( missing.length ) throw new Error(fmt("RL.Legacy.Error.boardMissing", { list: missing.join(", ") }));
  await actor.update({ "system.war.reserve": 0 });
  await campaign.setFlag(SYSTEM_ID, "alienLanding", { war: war?.id ?? "", game: currentGame(campaign), faction: actor.id, troops });
  const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
  await ChatMessage.implementation.create({
    content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
      <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(game.i18n.localize("RL.Legacy.AlienIsland.landingTitle"))}</h3>
      <span class="rl-chat-card__sub">${esc(game.i18n.localize("RL.Legacy.AlienIsland.landingSub"))}</span></div>
      <div class="rl-chat-card__body"><p>${esc(fmt("RL.Legacy.AlienIsland.landingText", { faction: actor.name, reserve, aliens: troops - reserve }))}</p>
      <p>${esc(fmt("RL.Legacy.AlienIsland.oneFaction", { faction: actor.name }))}</p></div>
      <div class="rl-chat-card__result">${esc(fmt("RL.Legacy.AlienIsland.landingResult", { faction: actor.name, troops }))}</div>
    </div>`,
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    flags: { [SYSTEM_ID]: { card: true } }
  });
  return { troops, reserve, aliens: troops - reserve };
}

/**
 * Remove every piece from a territory (troops of all factions and any HQ, which is DEMOLISHED): the Ruins sticker.
 * Runs on the GM through the board API; HQ tokens are deleted directly (the board API never removes an HQ).
 * @returns {Promise<{troops: number, hqs: number}>}
 */
async function clearTerritory(territory) {
  const scene = state.getBoardScene();
  const byTerritory = api("board", "piecesByTerritory");
  if ( !scene || !byTerritory ) return { troops: 0, hqs: 0 };
  const pieces = byTerritory(scene).get(territory) ?? [];
  const factions = new Set(pieces.filter(p => p.kind !== "hq").map(p => p.faction));
  let troops = 0;
  for ( const p of pieces ) if ( p.kind !== "hq" ) troops += p.kind === "triple" ? 3 : 1;
  for ( const faction of factions ) await callArea("board", "setTroops", { faction, territory, count: 0 });
  const hqs = (byTerritory(scene).get(territory) ?? []).filter(p => p.kind === "hq").map(p => p.doc.id);
  if ( hqs.length ) await scene.deleteEmbeddedDocuments("Token", hqs, { [SYSTEM_ID]: { internal: true } });
  return { troops, hqs: hqs.length };
}

/**
 * Ruins (Thirty Troops): the Alien player chooses a Minor City; the ruin mark goes over the city mark, that city is
 * gone; remove all troops and DEMOLISH any HQ in that territory. A ruin is not a city and can't be fortified; a new
 * city may be built over it later.
 * @param {object} payload
 * @param {string} payload.territory
 * @param {string} [payload.by]
 * @param {boolean} [payload.force=false]  GM: place it even if no Ruins sticker is left
 * @returns {{territory: string, troops: number, hqs: number}}
 */
async function ruinCityHandler({ territory, by = "", force = false } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  requireTerritory(territory);
  requireMarkSpot(territory);
  const marks = marksOf(campaign, territory);
  check(!isUnmodifiable(marks), "RL.Legacy.Error.unmodifiable", { territory: territoryName(territory) });
  check(marks.city.type === "minor", "RL.Legacy.Error.notMinorCity", { territory: territoryName(territory) });
  const update = {
    [`system.territories.${territory}.city`]: { type: "", name: "", founder: "", founderId: "", game: 0 },
    [`system.territories.${territory}.fortification`]: { active: false, used: 0 },
    [`system.territories.${territory}.marks`]: [...new Set([...marks.marks, "ruins"])]
  };
  Object.assign(update, useSticker(campaign, "ruins", 1, forced(force, user)));
  const text = fmt("RL.Legacy.Log.ruined", {
    by: by || game.i18n.localize("RL.Legacy.Someone"), name: marks.city.name || cityLabel(marks.city.type || "minor"),
    territory: territoryName(territory)
  });
  await commit(campaign, update, [logEntry("mark", text)]);
  const cleared = warOnBoard() ? await clearTerritory(territory) : { troops: 0, hqs: 0 };
  if ( cleared.troops || cleared.hqs ) {
    await commit(campaign, {}, [logEntry("mark", fmt("RL.Legacy.Log.ruinCleared", {
      territory: territoryName(territory), troops: cleared.troops, hqs: cleared.hqs
    }))]);
  }
  return { territory, ...cleared };
}

/* -------------------------------------------- */
/*  Registration and public API                 */
/* -------------------------------------------- */

const HANDLERS = {
  foundCity: foundCityHandler,
  fortifyCity: fortifyCityHandler,
  placeScar: placeScarHandler,
  cancelScar: cancelScarHandler,
  placeMark: placeMarkHandler,
  nameContinent: nameContinentHandler,
  modifyContinent: modifyContinentHandler,
  upgradeCard: upgradeCardHandler,
  destroyTerritoryCard: destroyCardHandler,
  recordGame: recordGameHandler,
  nameWorld: nameWorldHandler,
  addLog: addLogHandler,
  adjustStickers: adjustStickersHandler,
  addSeaLine: addSeaLineHandler,
  placeAlienIsland: placeAlienIslandHandler,
  alienLanding: alienLandingHandler,
  ruinCity: ruinCityHandler
};

/** Register the GM actions. Called from the area's init(). */
export function registerActions() {
  for ( const [name, handler] of Object.entries(HANDLERS) ) registerAction(`campaign.${name}`, handler);
}

/** Run a legacy handler directly on the GM (from other campaign handlers that are already on the GM). */
export function runLocal(name, payload) {
  return HANDLERS[name](payload, { user: game.user });
}

export const foundCity = payload => runAction("campaign.foundCity", payload);
export const fortifyCity = payload => runAction("campaign.fortifyCity", payload);
export const placeScar = payload => runAction("campaign.placeScar", payload);
export const cancelScar = payload => runAction("campaign.cancelScar", payload);
export const placeMark = payload => runAction("campaign.placeMark", payload);
export const nameContinent = payload => runAction("campaign.nameContinent", payload);
export const modifyContinent = payload => runAction("campaign.modifyContinent", payload);
export const upgradeCard = payload => runAction("campaign.upgradeCard", payload);
export const destroyTerritoryCard = payload => runAction("campaign.destroyTerritoryCard", payload);
export const recordGame = payload => runAction("campaign.recordGame", payload);
export const nameWorld = payload => runAction("campaign.nameWorld", payload);
export const addLog = payload => runAction("campaign.addLog", payload);
export const adjustStickers = payload => runAction("campaign.adjustStickers", payload);
export const addSeaLine = payload => runAction("campaign.addSeaLine", payload);
export const addAlienIsland = payload => runAction("campaign.placeAlienIsland", payload);
export const alienLanding = payload => runAction("campaign.alienLanding", payload);
export const ruinCity = payload => runAction("campaign.ruinCity", payload);

/** The flag scope used by campaign-area flags. */
export const FLAG = SYSTEM_ID;
