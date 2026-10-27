/**
 * Test helpers: hand-built BoardState fixtures on the real board graph (data/boards/original.json), falling back
 * to the compact copy in tools/fixtures/turn/classic-board.json (forced with RL_BOARD_FIXTURE=1).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_TYPES } from "../../config.mjs";
import { deriveState } from "../state.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let cached = null;
/** @returns {{board: object, source: string}} */
export function loadBoard() {
  if ( cached ) return cached;
  const real = path.join(ROOT, "data/boards/original.json");
  const fallback = path.join(ROOT, "tools/fixtures/turn/classic-board.json");
  // RL_BOARD_FIXTURE=1 forces the compact fixture (to check it stays in sync with the real board).
  const file = (fs.existsSync(real) && !process.env.RL_BOARD_FIXTURE) ? real : fallback;
  cached = { board: JSON.parse(fs.readFileSync(file, "utf8")), source: path.relative(ROOT, file) };
  return cached;
}

/** Same shape as WarData.freshTurn (the data model can't be imported outside Foundry). */
export function freshTurn(factionId = "") {
  return {
    faction: factionId, recruited: false, recruitTotal: 0, joinedWar: false, starsBought: 0, tradedForTroops: false,
    conquered: 0, expanded: 0, expandedIntoCity: false, attacks: 0, firstAttackTarget: "", protected: [],
    maneuver: { done: false, from: "", to: "" }, cardDrawn: false, missionCompleted: false, events: 0, flags: {}
  };
}

/**
 * @param {object} spec
 * @param {string} spec.faction
 * @param {string} [spec.phase="start"]
 * @param {string} [spec.stage="playing"]
 * @param {object} [spec.log]    overrides of the turn record (flags merged)
 */
export function makeTurn({ faction, phase = "start", stage = "playing", log = {} }) {
  const base = freshTurn(faction);
  return {
    warId: "war1", game: 1, stage, phase, faction, order: [],
    log: { ...base, ...log, maneuver: { ...base.maneuver, ...(log.maneuver ?? {}) }, flags: { ...(log.flags ?? {}) } }
  };
}

/**
 * Build a BoardState.
 * @param {object} spec
 * @param {Object<string, object>} [spec.factions]   id → {key, powers, reserve, redStarTokens, missiles, playerId, status, hand…}
 * @param {Object<string, Object<string, number|{troops, hq}>>} [spec.pieces]  territory → faction → troops or {troops, hq}
 * @param {Object<string, {city, founderId, founder, fortified, scar, marks}>} [spec.marks]
 * @param {Object<string, {name, namedById, modifier}>} [spec.continents]
 * @param {object} [spec.turn]  makeTurn() spec
 * @param {object} [spec.packs] opened packs
 * @param {object} [spec.effects]
 */
export function makeState({ factions = {}, pieces = {}, marks = {}, continents = {}, turn = null, packs = {}, effects } = {}) {
  const { board } = loadBoard();
  const territories = {};
  for ( const [id, def] of Object.entries(board.territories) ) {
    const m = marks[id] ?? {};
    const city = m.city ? {
      type: m.city, name: m.cityName ?? "", founder: m.founder ?? "", founderId: m.founderId ?? "",
      population: CITY_TYPES[m.city].population
    } : null;
    territories[id] = {
      id, name: def.name, continent: def.continent, neighbors: [...def.neighbors],
      owner: null, troops: 0, contested: false, pieces: {}, hq: null,
      city, population: city?.population ?? 0, fortified: !!(city && m.fortified), fortificationUsed: 0,
      scar: m.scar ?? null, marks: [...(m.marks ?? [])], cardDestroyed: !!m.cardDestroyed
    };
  }
  for ( const [id, byFaction] of Object.entries(pieces) ) {
    if ( !territories[id] ) throw new Error(`fixture: unknown territory ${id}`);
    for ( const [fid, v] of Object.entries(byFaction) ) {
      const p = typeof v === "number" ? { troops: v, hq: false } : { troops: v.troops ?? 0, hq: !!v.hq };
      territories[id].pieces[fid] = { ...p, tokens: [] };
    }
  }
  const conts = {};
  for ( const [id, def] of Object.entries(board.continents) ) {
    const c = continents[id] ?? {};
    conts[id] = {
      id, label: def.label, name: c.name ?? "", namedById: c.namedById ?? "", bonus: def.bonus,
      modifier: c.modifier ?? 0, value: def.bonus + (c.modifier ?? 0), territories: [...def.territories]
    };
  }
  const facs = {};
  let seat = 0;
  for ( const [id, f] of Object.entries(factions) ) {
    facs[id] = {
      id, key: f.key ?? id, name: f.name ?? id, color: "#000000", active: f.active ?? true,
      status: f.status ?? "playing", playerId: f.playerId ?? `user-${id}`, playerName: f.playerName ?? `Player ${id}`,
      seat: f.seat ?? seat, redStarTokens: f.redStarTokens ?? 0, missiles: f.missiles ?? 0, reserve: f.reserve ?? 0,
      startingTerritory: f.startingTerritory ?? "", powers: [...(f.powers ?? [])],
      hand: { count: 0, coins: 0, territoryIds: [], ...(f.hand ?? {}) }
    };
    seat++;
  }
  const state = {
    variant: "original", board: { seaLines: board.seaLines ?? [] }, territories, factions: facs, continents: conts,
    turn: turn ? makeTurn(turn) : null, unplaced: [],
    campaign: { gamesPlayed: 0, nextGame: 1, packs: { base: true, ...packs }, stickers: {} }
  };
  if ( effects ) state.effects = effects;
  return deriveState(state);
}

/** Every territory of a continent, for fixtures: {territory: {faction: troops}}. */
export function fill(continentId, factionId, troops = 1) {
  const { board } = loadBoard();
  return Object.fromEntries(board.continents[continentId].territories.map(id => [id, { [factionId]: troops }]));
}

/** First n territory ids in board order not in `exclude`. */
export function someTerritories(n, exclude = []) {
  const { board } = loadBoard();
  return Object.keys(board.territories).filter(id => !exclude.includes(id)).slice(0, n);
}
