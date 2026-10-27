import { CITY_TYPES, FORTIFICATION_USES, PIECES, SYSTEM_ID } from "../config.mjs";
import { getBoard } from "./boards.mjs";
import {
  getBoardScene, getBoardVariant, getCampaign, getCampaignBoard, getFactions, getHand, getWar, pieceKind
} from "./accessors.mjs";

/**
 * The board snapshot: one plain, serializable object describing the whole game state at this moment. The rules
 * engine (module/rules/) works only on snapshots, so it stays pure and unit-testable. Build one with
 * `buildSnapshot()` whenever you need to validate or compute something; it is cheap (42 territories, < 200 tokens).
 *
 * @typedef {object} BoardState
 * @property {string} variant                              board variant id
 * @property {object} board                                the board definition (data/boards/<variant>.json + helpers)
 * @property {Object<string, TerritoryState>} territories  by territory id
 * @property {Object<string, FactionState>} factions       by faction actor id (all factions, active or not)
 * @property {Object<string, ContinentState>} continents   by continent id
 * @property {TurnState|null} turn                         null when no war is being played
 * @property {object} campaign                             {gamesPlayed, nextGame, packs: {id: bool}, stickers: {...}}
 * @property {string[]} unplaced                           ids of piece tokens not inside any territory
 *
 * @typedef {object} TerritoryState
 * @property {string} id
 * @property {string} name
 * @property {string} continent
 * @property {string[]} neighbors
 * @property {string|null} owner           faction id controlling it (the faction with troops there)
 * @property {number} troops               the owner's troop count there
 * @property {boolean} contested           troops of more than one faction are present (an illegal leftover)
 * @property {Object<string, {troops: number, hq: boolean, tokens: string[]}>} pieces  by faction id
 * @property {string|null} hq              faction id whose HQ piece stands here (whoever owns the territory controls it)
 * @property {{type: string, name: string, founderId: string, founder: string, population: number}|null} city
 * @property {number} population           0 without a city
 * @property {boolean} fortified           has an active fortification with uses left
 * @property {number} fortificationUsed
 * @property {string|null} scar            board scar id
 * @property {string[]} marks              pack marks
 * @property {boolean} cardDestroyed
 *
 * @typedef {object} FactionState
 * @property {string} id                   actor id
 * @property {string} key                  catalog key
 * @property {string} name
 * @property {string} color
 * @property {boolean} active              in the current war
 * @property {string} status               playing | knockedOut | eliminated
 * @property {string} playerId
 * @property {string} playerName
 * @property {number} seat
 * @property {number} redStarTokens
 * @property {number} missiles
 * @property {number} reserve
 * @property {string} startingTerritory
 * @property {string[]} powers             keys of the power stickers on the card
 * @property {string[]} territories        ids controlled
 * @property {number} population           sum of city populations controlled
 * @property {number} troops               troops on the board
 * @property {string[]} hqs                territory ids holding an HQ this faction controls
 * @property {string[]} continents         continent ids fully controlled
 * @property {{tokens: number, hqs: number, total: number}} redStars
 * @property {{count: number, coins: number, territoryIds: string[]}} hand   resource cards in hand
 *
 * @typedef {object} ContinentState
 * @property {string} id
 * @property {string} label                printed/default label
 * @property {string} name                 name given by a winner ("" if unnamed)
 * @property {string} namedById
 * @property {number} bonus                printed bonus
 * @property {number} modifier             -1 | 0 | +1 (continent mark)
 * @property {number} value                bonus + modifier (the namer's personal +1 is not included)
 * @property {string[]} territories
 *
 * @typedef {object} TurnState
 * @property {string} warId
 * @property {number} game
 * @property {string} stage                WAR_STAGES key
 * @property {string} phase                PHASES key
 * @property {string|null} faction         faction id whose turn it is
 * @property {object} log                  war.system.turn (recruited, conquered, expanded, maneuver, …)
 * @property {string[]} order              faction ids in turn order
 */

/**
 * Center of a token document in scene px.
 * @param {TokenDocument} token
 * @param {Scene} scene
 */
export function tokenCenter(token, scene = token.parent) {
  const size = scene?.grid?.size ?? 100;
  // While a token animates, core writes intermediate positions into tokenDoc.x/y; the persisted destination is in
  // _source. Plain objects (snapshot overrides) have no _source.
  const src = token._source ?? token;
  return { x: src.x + ((src.width * size) / 2), y: src.y + ((src.height * size) / 2) };
}

/**
 * The territory a point lies in. Uses the scene's territory Regions (flag `territory`) when they exist, so a GM can
 * correct a region's shape in the Regions layer; falls back to the board definition polygons.
 * @param {{x: number, y: number}} point
 * @param {Scene} [scene]
 * @param {object} [board]
 * @returns {string|null}
 */
export function territoryAtPoint(point, scene = getBoardScene(), board = getCampaignBoard()) {
  const regions = scene?.regions?.filter(r => r.getFlag(SYSTEM_ID, "territory")) ?? [];
  if ( regions.length ) {
    const elevated = { x: point.x, y: point.y, elevation: 0 };
    for ( const region of regions ) {
      try {
        if ( region.testPoint(elevated) ) return region.getFlag(SYSTEM_ID, "territory");
      } catch(err) { /* fall through to the JSON geometry */ }
    }
  }
  return board?.territoryAt(point.x, point.y) ?? null;
}

/**
 * The territory a token stands in.
 * @param {TokenDocument} token
 * @returns {string|null}
 */
export function territoryOfToken(token) {
  return territoryAtPoint(tokenCenter(token), token.parent);
}

/**
 * Build the board snapshot.
 * @param {object} [options]
 * @param {Scene} [options.scene]   board scene (default: the campaign's)
 * @param {object} [options.overrides]  {tokens: TokenDocument-like[]} to evaluate hypothetical positions
 * @returns {BoardState|null}       null when the campaign or board definition isn't available
 */
export function buildSnapshot({ scene = getBoardScene(), overrides = {} } = {}) {
  const campaign = getCampaign();
  const variant = getBoardVariant();
  const board = getCampaignBoard();
  if ( !campaign || !board ) return null;
  const marks = campaign.system.territories ?? {};
  const war = getWar();

  // Territories with permanent marks
  const territories = {};
  for ( const id of board.ids ) {
    const def = board.territories[id];
    const m = marks[id] ?? {};
    const cityType = m.city?.type || "";
    const fortUsed = m.fortification?.used ?? 0;
    territories[id] = {
      id, name: def.name, continent: def.continent, neighbors: [...board.neighbors(id)],
      owner: null, troops: 0, contested: false, pieces: {}, hq: null,
      city: cityType ? {
        type: cityType, name: m.city.name, founder: m.city.founder, founderId: m.city.founderId,
        population: CITY_TYPES[cityType]?.population ?? 0
      } : null,
      population: cityType ? (CITY_TYPES[cityType]?.population ?? 0) : 0,
      fortified: !!(cityType && m.fortification?.active && (fortUsed < FORTIFICATION_USES)),
      fortificationUsed: fortUsed,
      scar: m.scar || null,
      marks: [...(m.marks ?? [])],
      cardDestroyed: !!m.cardDestroyed
    };
  }

  // Pieces → territories
  const unplaced = [];
  const tokens = overrides.tokens ?? scene?.tokens?.contents ?? [];
  for ( const token of tokens ) {
    const kind = pieceKind(token);
    if ( !kind ) continue;
    const factionId = token.actorId ?? token.actor?.id;
    const territoryId = overrides.tokens && token.territory ? token.territory : territoryOfToken(token);
    if ( !territoryId || !territories[territoryId] ) {
      unplaced.push(token.id);
      continue;
    }
    const t = territories[territoryId];
    const p = t.pieces[factionId] ??= { troops: 0, hq: false, tokens: [] };
    p.troops += PIECES[kind]?.value ?? 0;
    p.tokens.push(token.id);
    if ( kind === "hq" ) {
      p.hq = true;
      t.hq = factionId;
    }
  }
  for ( const t of Object.values(territories) ) {
    const withTroops = Object.entries(t.pieces).filter(([, p]) => p.troops > 0);
    withTroops.sort((a, b) => b[1].troops - a[1].troops);
    t.contested = withTroops.length > 1;
    if ( withTroops.length ) {
      t.owner = withTroops[0][0];
      t.troops = withTroops[0][1].troops;
    }
  }

  // Continents
  const continents = {};
  for ( const [id, def] of Object.entries(board.continents) ) {
    const c = campaign.system.continents?.[id] ?? {};
    continents[id] = {
      id, label: def.label, name: c.name ?? "", namedById: c.namedById ?? "",
      bonus: def.bonus, modifier: c.modifier ?? 0, value: def.bonus + (c.modifier ?? 0),
      territories: [...def.territories]
    };
  }

  // Factions
  const factions = {};
  for ( const actor of getFactions() ) {
    const w = actor.system.war;
    const owned = Object.values(territories).filter(t => t.owner === actor.id);
    const hand = getHand(actor);
    const handCards = hand?.cards.contents ?? [];
    const hqs = owned.filter(t => t.hq).map(t => t.id);
    factions[actor.id] = {
      id: actor.id, key: actor.system.key, name: actor.name, color: actor.system.color?.css ?? "#808285",
      active: w.active, status: w.status, playerId: w.playerId, playerName: w.playerName, seat: w.seat,
      redStarTokens: w.redStarTokens, missiles: w.missiles, reserve: w.reserve,
      startingTerritory: w.startingTerritory,
      powers: actor.items.filter(i => i.type === "power").map(i => i.system.key).filter(Boolean),
      territories: owned.map(t => t.id),
      population: owned.reduce((n, t) => n + t.population, 0),
      troops: owned.reduce((n, t) => n + t.troops, 0),
      hqs,
      continents: Object.values(continents)
        .filter(c => c.territories.length && c.territories.every(id => territories[id]?.owner === actor.id))
        .map(c => c.id),
      redStars: { tokens: w.redStarTokens, hqs: hqs.length, total: w.redStarTokens + hqs.length },
      hand: {
        count: handCards.filter(c => ["territory", "coin"].includes(c.type)).length,
        coins: handCards.reduce((n, c) => n + (c.system?.coins ?? 0), 0),
        territoryIds: handCards.filter(c => c.type === "territory").map(c => c.system.territory)
      }
    };
  }

  // Turn
  let turn = null;
  if ( war ) {
    turn = {
      warId: war.id,
      game: war.system.game,
      stage: war.system.stage,
      phase: war.system.phase,
      faction: war.combatant?.actorId ?? null,
      log: war.system.toObject().turn,
      order: war.turns.map(c => c.actorId)
    };
  }

  return {
    variant, board, territories, factions, continents, turn, unplaced,
    campaign: {
      gamesPlayed: campaign.system.gamesPlayed,
      nextGame: campaign.system.nextGameNumber,
      packs: Object.fromEntries(Object.entries(campaign.system.packs ?? {}).map(([k, v]) => [k, !!v.opened])),
      stickers: { ...(campaign.system.stickers ?? {}) }
    }
  };
}
