import { BOARD_VARIANTS, systemPath } from "../config.mjs";

/**
 * Board definitions (data/boards/<variant>.json). Loaded once at `ready` (see preloadBoards) and then available
 * synchronously through getBoard(). The raw JSON shape is documented in ARCHITECTURE.md §Board definition; this
 * module adds a few derived, non-enumerable helpers to the loaded object:
 *
 *   board.ids                      string[]  territory ids
 *   board.neighbors(id)            Set<string>
 *   board.areAdjacent(a, b)        boolean
 *   board.continentOf(id)          string    continent id
 *   board.territoryAt(x, y)        string|null  pure point-in-polygon on the JSON polygons (scene px)
 */

const boards = new Map();

/**
 * Load (and cache) a board definition.
 * @param {string} variant  "original" | "advanced"
 * @returns {Promise<object>}
 */
export async function loadBoard(variant) {
  if ( boards.has(variant) ) return boards.get(variant);
  const entry = BOARD_VARIANTS[variant];
  if ( !entry ) throw new Error(`Unknown board variant "${variant}"`);
  const response = await fetch(systemPath(entry.file));
  if ( !response.ok ) throw new Error(`Could not load board definition ${entry.file} (${response.status})`);
  const board = prepareBoard(await response.json());
  boards.set(variant, board);
  return board;
}

/** Load every board variant that exists. Missing files are logged, not thrown. */
export async function preloadBoards() {
  await Promise.all(Object.keys(BOARD_VARIANTS).map(v => loadBoard(v).catch(err => {
    console.warn(`risklegacy | ${err.message}`);
  })));
}

/**
 * Get a loaded board definition synchronously.
 * @param {string} variant
 * @returns {object|null}
 */
export function getBoard(variant) {
  return boards.get(variant) ?? null;
}

/**
 * Attach derived helpers to a raw board definition.
 * @param {object} raw
 * @returns {object}
 */
export function prepareBoard(raw) {
  const board = raw;
  const ids = Object.keys(board.territories);
  const neighborSets = Object.fromEntries(ids.map(id => [id, new Set(board.territories[id].neighbors ?? [])]));
  const continentOf = Object.fromEntries(ids.map(id => [id, board.territories[id].continent]));

  // Precompute bounding boxes for fast point tests
  const boxes = {};
  for ( const id of ids ) {
    boxes[id] = (board.territories[id].polygons ?? []).map(points => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for ( let i = 0; i < points.length; i += 2 ) {
        minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
        minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
      }
      return { minX, minY, maxX, maxY, points };
    });
  }

  const define = (key, value) => Object.defineProperty(board, key, { value, enumerable: false });
  define("ids", ids);
  define("neighbors", id => neighborSets[id] ?? new Set());
  define("areAdjacent", (a, b) => !!neighborSets[a]?.has(b));
  define("continentOf", id => continentOf[id]);
  define("territoryAt", (x, y) => {
    for ( const id of ids ) {
      for ( const box of boxes[id] ) {
        if ( (x < box.minX) || (x > box.maxX) || (y < box.minY) || (y > box.maxY) ) continue;
        if ( pointInPolygon(x, y, box.points) ) return id;
      }
    }
    return null;
  });
  return board;
}

/**
 * Even-odd ray casting test on a flat [x0,y0,x1,y1,…] polygon.
 * @returns {boolean}
 */
export function pointInPolygon(x, y, points) {
  let inside = false;
  for ( let i = 0, j = points.length - 2; i < points.length; j = i, i += 2 ) {
    const xi = points[i], yi = points[i + 1], xj = points[j], yj = points[j + 1];
    if ( ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi) ) inside = !inside;
  }
  return inside;
}

/* -------------------------------------------- */
/*  Campaign board (base board + legacy changes) */
/* -------------------------------------------- */

const augmented = new Map();

/**
 * The board as it is in this campaign: the printed board definition plus everything drawn onto it during the
 * campaign that changes the map itself:
 *   - `customTerritories` (e.g. Alien Island): new round territories with polygons, centre, label and piece spots,
 *   - `seaLines` drawn in pen: added to both territories' `neighbors` and to `board.seaLines` (with `custom: true`).
 * Everything downstream (snapshot, rules, Regions, piece spots, overlays) uses this, so a new connection or territory
 * just works. Cached per variant until the campaign's lines/territories change.
 *
 * @param {object} base          a loaded board definition (getBoard)
 * @param {object} [changes]
 * @param {object[]} [changes.seaLines]           campaign.system.seaLines
 * @param {object} [changes.customTerritories]    campaign.system.customTerritories
 * @returns {object} a prepared board (same helpers as getBoard)
 */
export function augmentBoard(base, { seaLines = [], customTerritories = {} } = {}) {
  if ( !base ) return null;
  if ( !seaLines.length && !Object.keys(customTerritories).length ) return base;
  const key = `${base.id}|${JSON.stringify(seaLines)}|${JSON.stringify(customTerritories)}`;
  const cached = augmented.get(base.id);
  if ( cached?.key === key ) return cached.board;

  const raw = JSON.parse(JSON.stringify(base));
  const pieceSize = raw.pieceSize ?? 90;
  for ( const [id, t] of Object.entries(customTerritories) ) {
    const r = Math.max(40, t.radius ?? 150);
    raw.territories[id] = {
      name: t.name || id, continent: t.continent || null, custom: true, kind: t.kind || id,
      polygons: [circlePolygon(t.x, t.y, r, 32)],
      center: [t.x, t.y],
      label: [t.x, Math.round(t.y + (r * 0.72))],
      mark: null,
      spots: ringSpots(t.x, t.y, r, pieceSize),
      neighbors: [],
      coastal: true,
      coastPoints: circlePolygon(t.x, t.y, r, 16).reduce((pts, v, i, a) => (i % 2 ? pts : [...pts, [v, a[i + 1]]]), [])
    };
    if ( t.continent && raw.continents[t.continent] ) raw.continents[t.continent].territories.push(id);
  }
  raw.seaLines = [...(raw.seaLines ?? [])];
  for ( const line of seaLines ) {
    const ta = raw.territories[line.a];
    const tb = raw.territories[line.b];
    if ( !ta || !tb || (line.a === line.b) ) continue;
    if ( !ta.neighbors.includes(line.b) ) ta.neighbors.push(line.b);
    if ( !tb.neighbors.includes(line.a) ) tb.neighbors.push(line.a);
    const points = line.points?.length === 2 ? line.points : seaLineEndpoints(raw, line.a, line.b);
    raw.seaLines.push({ a: line.a, b: line.b, points, custom: true, sticker: line.sticker ?? "" });
  }
  const board = prepareBoard(raw);
  augmented.set(base.id, { key, board });
  return board;
}

/**
 * Where a pen-drawn sea line between two territories should start and end: the closest pair of coast points
 * (falls back to polygon vertices, then centres).
 * @param {object} board  raw or prepared board definition
 * @param {string} a
 * @param {string} b
 * @returns {number[][]} [[xa, ya], [xb, yb]]
 */
export function seaLineEndpoints(board, a, b) {
  const pts = id => {
    const t = board.territories[id];
    if ( !t ) return [];
    if ( t.coastPoints?.length ) return t.coastPoints;
    const out = [];
    for ( const poly of t.polygons ?? [] ) for ( let i = 0; i < poly.length; i += 2 ) out.push([poly[i], poly[i + 1]]);
    return out.length ? out : [t.center];
  };
  const pa = pts(a);
  const pb = pts(b);
  let best = [board.territories[a]?.center, board.territories[b]?.center];
  let bestD = Infinity;
  for ( const p of pa ) {
    for ( const q of pb ) {
      const d = ((p[0] - q[0]) ** 2) + ((p[1] - q[1]) ** 2);
      if ( d < bestD ) { bestD = d; best = [p, q]; }
    }
  }
  return best.map(p => [Math.round(p[0]), Math.round(p[1])]);
}

/** A regular polygon approximating a circle, as a flat point array. */
function circlePolygon(x, y, r, n) {
  const pts = [];
  for ( let i = 0; i < n; i++ ) {
    const a = (i / n) * Math.PI * 2;
    pts.push(Math.round(x + (Math.cos(a) * r)), Math.round(y + (Math.sin(a) * r)));
  }
  return pts;
}

/** Piece spots inside a round territory: the centre, then rings. */
function ringSpots(x, y, r, pieceSize) {
  const spots = [[Math.round(x), Math.round(y)]];
  for ( let ring = 1; ; ring++ ) {
    const rr = ring * pieceSize * 0.85;
    if ( rr > (r - (pieceSize * 0.45)) ) break;
    const n = Math.max(6, Math.floor((2 * Math.PI * rr) / (pieceSize * 0.85)));
    for ( let i = 0; i < n; i++ ) {
      const a = ((i + (ring % 2 ? 0.5 : 0)) / n) * Math.PI * 2;
      spots.push([Math.round(x + (Math.cos(a) * rr)), Math.round(y + (Math.sin(a) * rr))]);
    }
  }
  return spots;
}
