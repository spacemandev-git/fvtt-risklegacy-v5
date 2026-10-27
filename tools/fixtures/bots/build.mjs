/**
 * Bot fixtures: compact JSON situations (tools/fixtures/bots/*.json) → BoardState + BotView + BotContext.
 * Used by the brain's unit tests (module/bots/brain/tests/) and the live probe (tools/qa/jev-probe.mjs).
 *
 * A situation file:
 *   { name, description, me, difficulty,
 *     factions: {id: {name, key, redStarTokens, missiles, powers, startingTerritory, status, hand:{count, coins}}},
 *     pieces: {territory: {faction: troops | {troops, hq}}}, marks: {territory: {city, fortified, scar, marks}},
 *     continents: {id: {name, modifier}}, turn: {faction, phase, stage, log} | null,
 *     view: {...BotView overrides}, calls: [{fn, args, phase?, reserve?, log?}] }
 * Args may say "auto" for `legal` / `legalJoin` (computed with the rules engine).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_TYPES } from "../../../module/config.mjs";
import * as rules from "../../../module/rules/_module.mjs";
import { seededRandom } from "../../../module/bots/brain/util.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

let board = null;
/** The classic board graph (data/boards/original.json, or the compact copy used by the rules tests). */
export function loadBoard() {
  if ( board ) return board;
  const real = path.join(ROOT, "data/boards/original.json");
  const fallback = path.join(ROOT, "tools/fixtures/turn/classic-board.json");
  board = JSON.parse(fs.readFileSync(fs.existsSync(real) ? real : fallback, "utf8"));
  return board;
}

/** Same shape as WarData.freshTurn. */
export function freshTurn(factionId = "") {
  return {
    faction: factionId, recruited: false, recruitTotal: 0, joinedWar: false, starsBought: 0, tradedForTroops: false,
    conquered: 0, expanded: 0, expandedIntoCity: false, attacks: 0, firstAttackTarget: "", protected: [],
    maneuver: { done: false, from: "", to: "" }, cardDrawn: false, missionCompleted: false, events: 0, flags: {}
  };
}

/** A BoardState from a situation spec. */
export function makeState({ factions = {}, pieces = {}, marks = {}, continents = {}, turn = null } = {}) {
  const b = loadBoard();
  const territories = {};
  for ( const [id, def] of Object.entries(b.territories) ) {
    const m = marks[id] ?? {};
    const city = m.city ? {
      type: m.city, name: m.cityName ?? "", founder: m.founder ?? "", founderId: m.founderId ?? "",
      population: CITY_TYPES[m.city].population
    } : null;
    territories[id] = {
      id, name: def.name, continent: def.continent, neighbors: [...def.neighbors],
      owner: null, troops: 0, contested: false, pieces: {}, hq: null,
      city, population: city?.population ?? 0, fortified: !!(city && m.fortified), fortificationUsed: m.fortificationUsed ?? 0,
      scar: m.scar ?? null, marks: [...(m.marks ?? [])], cardDestroyed: false
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
  for ( const [id, def] of Object.entries(b.continents) ) {
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
  let t = null;
  if ( turn ) {
    const base = freshTurn(turn.faction);
    const log = turn.log ?? {};
    t = {
      warId: "war1", game: 2, stage: turn.stage ?? "playing", phase: turn.phase ?? "start", faction: turn.faction,
      order: Object.keys(factions),
      log: { ...base, ...log, maneuver: { ...base.maneuver, ...(log.maneuver ?? {}) }, flags: { ...(log.flags ?? {}) } }
    };
  }
  const state = {
    variant: "original", board: { seaLines: b.seaLines ?? [] }, territories, factions: facs, continents: conts,
    turn: t, unplaced: [], campaign: { gamesPlayed: 1, nextGame: 2, packs: { base: true }, stickers: {} }
  };
  return rules.deriveState(state);
}

/** Read a situation file by name. */
export function readSituation(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

/** Every situation name in the fixture folder. */
export function situationNames() {
  return fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, "")).sort();
}

/** The BotView for a situation (defaults + overrides). */
export function makeView(spec, state) {
  const factionNames = Object.fromEntries(Object.entries(spec.factions ?? {}).map(([id, f]) => [id, f.name ?? id]));
  const hands = Object.fromEntries(Object.entries(spec.factions ?? {}).map(([id, f]) => [id, { count: f.hand?.count ?? 0, coins: f.hand?.coins ?? 0 }]));
  const mine = spec.view?.hand ?? [];
  if ( spec.me && mine.length ) hands[spec.me] = { count: mine.length, coins: mine.reduce((n, c) => n + (c.coins ?? 1), 0) };
  return {
    hand: [], hands, scarCards: [], row: [], coinCount: 20, mission: null, missionStatus: null, drawOptions: null,
    powers: {}, activeEvents: [], protections: [], factionNames, round: 4, game: 2,
    ...(spec.view ?? {}), hands: { ...hands, ...(spec.view?.hands ?? {}) }
  };
}

/** Catalog lookup stand-in for battle modifiers (base scars come from CONFIG; no pack content needed here). */
export const lookup = () => null;

/**
 * A BotContext for a situation, optionally with one call's phase/reserve/log applied.
 * @param {object} spec      situation
 * @param {object} [opts]    {ask, seed, difficulty, call}
 */
export function makeContext(spec, opts = {}) {
  const s = structuredClone(spec);
  const call = opts.call ?? null;
  if ( call && s.turn ) {
    if ( call.phase ) s.turn.phase = call.phase;
    if ( call.log ) s.turn.log = { ...(s.turn.log ?? {}), ...call.log };
  }
  if ( call?.reserve !== undefined && s.me ) s.factions[s.me].reserve = call.reserve;
  // The snapshot's hand summary matches the bot's own cards.
  const hand = s.view?.hand ?? [];
  if ( s.me && hand.length && s.factions[s.me] ) {
    s.factions[s.me].hand = { count: hand.length, coins: hand.reduce((n, c) => n + (c.coins ?? 1), 0), territoryIds: hand.map(c => c.territory).filter(Boolean) };
  }
  const state = makeState(s);
  return {
    me: s.me ?? null, difficulty: opts.difficulty ?? s.difficulty ?? "normal", state, view: makeView(s, state),
    lookup, ask: opts.ask ?? null, random: seededRandom(opts.seed ?? 7), excluded: new Set(opts.excluded ?? [])
  };
}

/** Resolve "auto" arguments of a call (legal starting / join territories). */
export function resolveArgs(ctx, args = {}) {
  const out = structuredClone(args);
  if ( out.legal === "auto" ) out.legal = rules.legalStartingTerritories(ctx.state, ctx.me, { joining: !!out.joining });
  if ( out.legalJoin === "auto" ) out.legalJoin = rules.legalStartingTerritories(ctx.state, ctx.me, { joining: true });
  if ( out.battle?.useState ) delete out.battle.useState;
  return out;
}
