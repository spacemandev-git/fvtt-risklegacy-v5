/**
 * Small pure helpers over a `BoardState` (module/state/snapshot.mjs). Nothing here touches Foundry.
 */

/** @returns {object|null} TerritoryState */
export const territory = (state, id) => state?.territories?.[id] ?? null;

/** @returns {object|null} FactionState */
export const faction = (state, id) => state?.factions?.[id] ?? null;

/** @returns {object} the current turn record (war.system.turn), or an empty object */
export const turnLog = state => state?.turn?.log ?? {};

/** @returns {object} the current turn's free-form flags */
export const turnFlags = state => state?.turn?.log?.flags ?? {};

/** Troops a faction has in a territory. */
export function troopsIn(t, factionId) {
  if ( !t ) return 0;
  const p = t.pieces?.[factionId];
  if ( p ) return p.troops ?? 0;
  return t.owner === factionId ? (t.troops ?? 0) : 0;
}

/** Is anyone's piece (troops or an HQ) standing in the territory? */
export function isOccupied(t) {
  if ( !t ) return false;
  if ( t.owner || t.hq ) return true;
  return Object.values(t.pieces ?? {}).some(p => (p.troops > 0) || p.hq);
}

/**
 * Does the territory carry a mark (city, scar or pack mark)? A destroyed-card "x" is not a mark, and neither is the
 * white "cancel scar" sticker: the rulebook says the territory "no longer has a Scar on it".
 */
export const NON_MARKS = new Set(["cancel_scar"]);
export const isMarked = t => !!(t?.city || t?.scar || t?.marks?.some(m => !NON_MARKS.has(m)));

/** Are two territories adjacent (land border or sea line)? */
export function areAdjacent(state, a, b) {
  const ta = territory(state, a);
  if ( ta?.neighbors ) return ta.neighbors.includes(b);
  return !!state?.board?.areAdjacent?.(a, b);
}

/** Territory ids a faction controls. */
export function ownedIds(state, factionId) {
  return Object.values(state?.territories ?? {}).filter(t => t.owner === factionId).map(t => t.id);
}

/** Normalise a city type ("worldCapital" in the catalog = "capital" in CITY_TYPES). */
export const cityType = type => (type === "worldCapital" ? "capital" : type);

/** Is the player of this faction the founder of the territory's city? */
export function isFounder(state, factionId, t) {
  const f = faction(state, factionId);
  if ( !f || !t?.city ) return false;
  if ( t.city.founderId && f.playerId ) return t.city.founderId === f.playerId;
  const a = String(t.city.founder ?? "").trim().toLowerCase();
  const b = String(f.playerName ?? "").trim().toLowerCase();
  return !!a && (a === b);
}

/* -------------------------------------------- */
/*  Derived data                                */
/* -------------------------------------------- */

const clone = value => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

/**
 * Recompute everything that depends on piece positions (territory owner/troops/hq, faction territories, population,
 * troops, HQs, continents and Red Stars) from `territories[*].pieces`. Mutates and returns the state.
 * @param {object} state  BoardState
 * @returns {object}
 */
export function deriveState(state) {
  const territories = state.territories ?? {};
  for ( const t of Object.values(territories) ) {
    t.pieces ??= {};
    const withTroops = Object.entries(t.pieces).filter(([, p]) => (p.troops ?? 0) > 0);
    withTroops.sort((a, b) => b[1].troops - a[1].troops);
    t.contested = withTroops.length > 1;
    t.owner = withTroops[0]?.[0] ?? null;
    t.troops = withTroops[0]?.[1].troops ?? 0;
    const hq = Object.entries(t.pieces).find(([, p]) => p.hq);
    t.hq = hq ? hq[0] : null;
  }
  for ( const f of Object.values(state.factions ?? {}) ) {
    const owned = Object.values(territories).filter(t => t.owner === f.id);
    f.territories = owned.map(t => t.id);
    f.population = owned.reduce((n, t) => n + (t.population ?? 0), 0);
    f.troops = owned.reduce((n, t) => n + (t.troops ?? 0), 0);
    f.hqs = owned.filter(t => t.hq).map(t => t.id);
    f.continents = Object.values(state.continents ?? {})
      .filter(c => c.territories?.length && c.territories.every(id => territories[id]?.owner === f.id))
      .map(c => c.id);
    const tokens = f.redStarTokens ?? 0;
    f.redStars = { tokens, hqs: f.hqs.length, total: tokens + f.hqs.length };
  }
  return state;
}

/**
 * A copy of the state with `count` troops of a faction moved between two territories (no validation). The board
 * definition is shared, not copied.
 * @returns {object} new BoardState
 */
export function applyMove(state, factionId, from, to, count) {
  const next = { ...state, territories: clone(state.territories), factions: clone(state.factions) };
  const a = next.territories[from];
  const b = next.territories[to];
  if ( !a || !b ) return next;
  const pa = a.pieces[factionId] ??= { troops: 0, hq: false, tokens: [] };
  const pb = b.pieces[factionId] ??= { troops: 0, hq: false, tokens: [] };
  const n = Math.max(0, Math.min(count, pa.troops));
  pa.troops -= n;
  pb.troops += n;
  return deriveState(next);
}

/**
 * Undo a move that has already happened on the board (the player dragged the tokens first): the state as it was
 * before `count` troops went from `from` to `to`.
 * @returns {object} new BoardState
 */
export function revertMove(state, factionId, from, to, count) {
  return applyMove(state, factionId, to, from, count);
}
