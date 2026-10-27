import { PIECES, SYSTEM_ID } from "../config.mjs";
import { getBoard, getBoardScene, getBoardVariant, getCampaignBoard, pieceKind, pointInPolygon, territoryAtPoint } from "../state/_module.mjs";

/**
 * Board geometry helpers for the canvas area: which board a scene shows, piece sizes, the territory a token stands
 * in, and the placement slots pieces are arranged on.
 */

/** Default piece size (scene px) when a board definition doesn't give one. */
const DEFAULT_PIECE_SIZE = 90;

/** Zone kept free of generated piece slots around a territory's bow-tie mark (city above, scar below). */
const MARK_ZONE = { left: 95, right: 95, top: 210, bottom: 180 };

/**
 * Is this scene the world board (a scene built by buildBoardScene)?
 * @param {Scene|null} scene
 */
export function isBoardScene(scene) {
  return !!scene?.getFlag?.(SYSTEM_ID, "board");
}

/**
 * The board definition a scene shows.
 * @param {Scene|null} [scene]
 * @returns {object|null}
 */
export function boardForScene(scene = getBoardScene()) {
  const variant = scene?.getFlag?.(SYSTEM_ID, "board") ?? getBoardVariant();
  // The campaign board includes territories and sea lines added during the campaign (Alien Island, pen sea lines)
  if ( variant === getBoardVariant() ) return getCampaignBoard() ?? getBoard(variant);
  return getBoard(variant) ?? getCampaignBoard();
}

/** @returns {Scene|null} the board scene if it is the one on the canvas */
export function viewedBoardScene() {
  return canvas?.ready && isBoardScene(canvas.scene) ? canvas.scene : null;
}

/**
 * Piece footprint.
 * @param {object} board
 * @param {string} kind     troop | triple | hq
 * @param {number} gridSize
 * @returns {{px: number, units: number}}
 */
export function pieceSize(board, kind, gridSize = 100) {
  const px = Math.round((board?.pieceSize ?? DEFAULT_PIECE_SIZE) * (PIECES[kind]?.scale ?? 1));
  return { px, units: px / gridSize };
}

/**
 * Center of a token from its source data (or a hypothetical position).
 * @param {TokenDocument} token
 * @param {{x?: number, y?: number}} [at]   top-left position override
 */
export function centerOf(token, at = {}) {
  const size = token.parent?.grid?.size ?? 100;
  const x = at.x ?? token._source.x;
  const y = at.y ?? token._source.y;
  return { x: x + ((token._source.width * size) / 2), y: y + ((token._source.height * size) / 2) };
}

/**
 * Territory at a point of a scene, using the scene's board.
 * @param {{x: number, y: number}} point
 * @param {Scene} [scene]
 */
export function territoryAt(point, scene = getBoardScene()) {
  return territoryAtPoint(point, scene, boardForScene(scene));
}

/**
 * Every piece token on a scene, grouped by territory id (null = outside any territory).
 * @param {Scene} scene
 * @returns {Map<string|null, {doc: TokenDocument, kind: string, faction: string}[]>}
 */
export function piecesByTerritory(scene) {
  const map = new Map();
  if ( !scene ) return map;
  const board = boardForScene(scene);
  for ( const doc of scene.tokens ) {
    const kind = pieceKind(doc);
    if ( !kind ) continue;
    const territory = territoryAtPoint(centerOf(doc), scene, board);
    if ( !map.has(territory) ) map.set(territory, []);
    map.get(territory).push({ doc, kind, faction: doc.actorId });
  }
  return map;
}

/**
 * Pieces of one faction in one territory.
 * @param {Scene} scene
 * @param {string} territory
 * @param {string} factionId
 * @returns {{hq: TokenDocument[], triple: TokenDocument[], troop: TokenDocument[], troops: number}}
 */
export function factionPieces(scene, territory, factionId) {
  const out = { hq: [], triple: [], troop: [], troops: 0 };
  for ( const p of piecesByTerritory(scene).get(territory) ?? [] ) {
    if ( p.faction !== factionId ) continue;
    out[p.kind]?.push(p.doc);
    out.troops += PIECES[p.kind]?.value ?? 0;
  }
  return out;
}

/**
 * Polygons of a territory as flat point arrays. Prefers the scene's territory Region (a GM may have corrected it)
 * and falls back to the board definition.
 * @param {string} territory
 * @param {Scene} [scene]
 * @returns {number[][]}
 */
export function territoryPolygons(territory, scene = getBoardScene()) {
  const region = scene?.regions?.find(r => r.getFlag(SYSTEM_ID, "territory") === territory);
  const fromRegion = region?.shapes?.filter(s => (s.type === "polygon") && !s.hole).map(s => [...s.points]) ?? [];
  if ( fromRegion.length ) return fromRegion;
  return boardForScene(scene)?.territories?.[territory]?.polygons ?? [];
}

/* -------------------------------------------- */
/*  Placement slots                             */
/* -------------------------------------------- */

const slotCache = new Map();

/** Forget cached slots (after the board definition or the regions change). */
export function clearSlotCache() {
  slotCache.clear();
}

/**
 * Piece centers for a territory, one per piece kind, in order (see layoutOrder: HQ first).
 *
 * Candidates are the board definition's `spots` (spots[0] is the central one), then extra points on a hex lattice
 * inside the territory. Each piece takes the first candidate that doesn't overlap the pieces already placed (5%
 * slack; when nothing fits, the candidate with the most room), so 3-troop pieces don't pile up on tightly packed
 * spots. Candidates over the printed territory name come after the free ones, and candidates under the territory's
 * stickers (city above the bow-tie mark, scar below, pack marks beside it) are used last. When every candidate is
 * taken, pieces stack with a small offset like a pile on the table.
 * @param {object} board
 * @param {string} territory
 * @param {string[]} kinds          piece kinds in layout order
 * @param {object} [options]
 * @param {object} [options.marks]  the campaign's marks for this territory (campaign.system.territories[id])
 * @returns {{x: number, y: number}[]}
 */
export function layoutSlots(board, territory, kinds, { marks } = {}) {
  const base = candidateSlots(board, territory);
  if ( !base.length ) return [];
  const size = board.pieceSize ?? DEFAULT_PIECE_SIZE;
  const def = board.territories[territory];
  const zones = stickerZones(def, marks);
  const covered = p => zones.some(z => (p.x > z.x0 - (size * 0.35)) && (p.x < z.x1 + (size * 0.35))
    && (p.y > z.y0 - (size * 0.35)) && (p.y < z.y1 + (size * 0.35)));
  const onLabel = labelCover(def, size * 0.42);
  // Free spots first, then spots over the printed name, then spots over stickers (stable within each group)
  const rank = p => (covered(p) ? 2 : (onLabel(p) ? 1 : 0));
  const ordered = base.map((p, i) => ({ p, i, k: rank(p) })).sort((a, b) => (a.k - b.k) || (a.i - b.i)).map(o => o.p);
  const used = new Set();
  const placed = [];
  const out = [];
  for ( const kind of kinds ) {
    const r = (size * (PIECES[kind]?.scale ?? 1)) / 2;
    let pick = -1;
    let bestClearance = -Infinity;
    for ( let i = 0; i < ordered.length; i++ ) {
      if ( used.has(i) ) continue;
      const p = ordered[i];
      let clearance = Infinity;
      for ( const q of placed ) clearance = Math.min(clearance, Math.hypot(p.x - q.x, p.y - q.y) - ((q.r + r) * 0.95));
      if ( clearance >= 0 ) {
        pick = i;
        break;
      }
      if ( clearance > bestClearance ) {
        bestClearance = clearance;
        pick = i;
      }
    }
    let point;
    if ( pick >= 0 ) {
      used.add(pick);
      point = ordered[pick];
    } else {
      const n = out.length;
      const p = ordered[n % ordered.length];
      const layer = Math.floor(n / ordered.length);
      point = { x: p.x + (layer * 14), y: p.y - (layer * 14) };
    }
    placed.push({ x: point.x, y: point.y, r });
    out.push({ x: point.x, y: point.y });
  }
  return out;
}

/**
 * Simple version of layoutSlots: `count` centers for 1-troop pieces.
 * @param {object} board
 * @param {string} territory
 * @param {number} count
 * @returns {{x: number, y: number}[]}
 */
export function territorySlots(board, territory, count) {
  return layoutSlots(board, territory, Array(Math.max(0, count)).fill("troop"));
}

/**
 * Test for points whose piece (radius `r`) would cover the territory's printed name.
 * @param {object} def  territory definition
 * @param {number} r
 * @returns {(p: {x: number, y: number}) => boolean}
 */
function labelCover(def, r) {
  if ( !def?.label ) return () => false;
  const [lx, ly] = def.label;
  const half = Math.max(70, (def.name?.length ?? 8) * 10);
  return p => (Math.abs(p.x - lx) < half + r) && (Math.abs(p.y - ly) < 30 + r);
}

/**
 * Rectangles covered by a territory's stickers, around its bow-tie mark.
 * @param {object} def     territory definition
 * @param {object} [marks]
 * @returns {{x0: number, y0: number, x1: number, y1: number}[]}
 */
function stickerZones(def, marks) {
  if ( !def?.mark || !marks ) return [];
  const [mx, my] = def.mark;
  const zones = [];
  if ( marks.city?.type ) {
    const w = marks.city.type === "capital" ? 105 : 90;
    const ring = marks.fortification?.active ? 25 : 0;
    zones.push({ x0: mx - w - ring, x1: mx + w + ring, y0: my - 200 - ring, y1: my });
  }
  if ( marks.scar || marks.marks?.includes("cancel_scar") ) zones.push({ x0: mx - 78, x1: mx + 78, y0: my, y1: my + 158 });
  const packMarks = (marks.marks ?? []).filter(m => !["cancel_scar", "scar_cancelled"].includes(m)).length;
  if ( packMarks ) zones.push({ x0: mx + 65, x1: mx + 230, y0: my - 50 - (Math.floor((packMarks - 1) / 2) * 82), y1: my + 70 });
  return zones;
}

function candidateSlots(board, territory) {
  const key = `${board?.id}.${territory}`;
  if ( slotCache.has(key) ) return slotCache.get(key);
  const def = board?.territories?.[territory];
  if ( !def ) return [];
  const size = board.pieceSize ?? DEFAULT_PIECE_SIZE;
  const spots = (def.spots ?? []).map(([x, y]) => ({ x, y }));
  if ( !spots.length && def.center ) spots.push({ x: def.center[0], y: def.center[1] });
  const origin = spots[0] ?? { x: def.center?.[0] ?? 0, y: def.center?.[1] ?? 0 };

  // Hex lattice inside the polygons, keeping a piece radius away from the borders
  const polygons = def.polygons ?? [];
  const step = size * 1.02;
  const r = size * 0.42;
  const extra = [];
  const inside = (x, y) => polygons.some(points => pointInPolygon(x, y, points));
  const fits = (x, y) => inside(x, y) && inside(x - r, y) && inside(x + r, y) && inside(x, y - r) && inside(x, y + r);
  const near = (x, y, list, d) => list.some(p => ((p.x - x) ** 2) + ((p.y - y) ** 2) < d * d);
  const onLabel = labelCover(def, r);
  const mark = def.mark ? { x: def.mark[0], y: def.mark[1] } : null;
  for ( const points of polygons ) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for ( let i = 0; i < points.length; i += 2 ) {
      minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
      minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
    }
    const rowH = step * Math.sqrt(3) / 2;
    for ( let row = 0, y = minY + r; y <= maxY - r; row++, y += rowH ) {
      for ( let x = minX + r + ((row % 2) ? step / 2 : 0); x <= maxX - r; x += step ) {
        if ( !fits(x, y) ) continue;
        if ( near(x, y, spots, step * 0.85) || near(x, y, extra, step * 0.95) ) continue;
        if ( onLabel({ x, y }) ) continue;
        if ( mark && (x > mark.x - MARK_ZONE.left - r) && (x < mark.x + MARK_ZONE.right + r)
          && (y > mark.y - MARK_ZONE.top - r) && (y < mark.y + MARK_ZONE.bottom + r) ) continue;
        extra.push({ x: Math.round(x), y: Math.round(y) });
      }
    }
  }
  extra.sort((a, b) => (((a.x - origin.x) ** 2) + ((a.y - origin.y) ** 2)) - (((b.x - origin.x) ** 2) + ((b.y - origin.y) ** 2)));
  const all = spots.concat(extra);
  slotCache.set(key, all);
  return all;
}

/**
 * Order pieces for layout: HQs first (the central spot), then the territory owner's triples and singles, then any
 * other faction's pieces.
 * @param {{doc?: TokenDocument, kind: string, faction: string}[]} pieces
 * @param {string|null} owner
 */
export function layoutOrder(pieces, owner) {
  const rank = p => (p.kind === "hq" ? 0 : 10) + (p.faction === owner ? 0 : 20) + (p.kind === "triple" ? 0 : 1);
  return [...pieces].sort((a, b) => (rank(a) - rank(b)) || String(a.doc?.id ?? "").localeCompare(String(b.doc?.id ?? "")));
}

/* -------------------------------------------- */
/*  Open water (placing stickers on the ocean)  */
/* -------------------------------------------- */

/** Gap kept between a sticker placed on the ocean and the land, other stickers, sea lines and furniture (scene px). */
export const WATER_MARGIN = 12;

/**
 * Is a circle of the board open water, where a round sticker (Alien Island) can be placed? The whole circle plus a
 * small margin must lie
 *  - inside the board (scene rect),
 *  - outside every territory of the campaign board, including the ones added during the campaign: the centre and
 *    points on the rim (at least 24, about every 40 px) are tested with `board.territoryAt`, then every territory
 *    outline is tested exactly against the circle (so a thin cape or a small island between rim points counts too),
 *  - clear of the board furniture (`board.furniture` boxes: victors, charts, reference stickers, world name; the
 *    continent plates),
 *  - clear of the printed and pen-drawn sea lines (a sticker must not hide a connection).
 * Synchronous; usable as `pickPoint`'s `validate`.
 * @param {{x: number, y: number}} point     centre (scene px)
 * @param {number} radius                    scene px
 * @param {object} [options]
 * @param {string[]} [options.ignore]        territory ids to ignore (e.g. the sticker being moved)
 * @param {object} [options.board]           board definition (default: the viewed board scene's campaign board)
 * @returns {{ok: boolean, reason: string}}  `reason` is localized ("" when ok)
 */
export function isOpenWater({ x, y } = {}, radius = 0, { ignore = [], board } = {}) {
  board ??= boardForScene(viewedBoardScene() ?? getBoardScene());
  const no = (key, data = {}) => ({ ok: false, reason: game.i18n.format(key, data) });
  if ( !board ) return no("RL.Canvas.Water.noBoard");
  if ( !Number.isFinite(x) || !Number.isFinite(y) ) return no("RL.Canvas.Water.offBoard");
  const R = Math.max(0, Number(radius) || 0) + WATER_MARGIN;
  const { width = 6000, height = 4000 } = board.scene ?? {};
  if ( (x - R < 0) || (y - R < 0) || (x + R > width) || (y + R > height) ) return no("RL.Canvas.Water.offBoard");

  const skip = new Set(ignore ?? []);
  const name = id => board.territories?.[id]?.name ?? id;
  const blocked = id => no(board.territories?.[id]?.custom ? "RL.Canvas.Water.sticker" : "RL.Canvas.Water.land",
    { name: name(id) });

  // Land: centre and rim samples, then the exact outline test
  const n = Math.max(24, Math.ceil((2 * Math.PI * R) / 40));
  const samples = [[x, y]];
  for ( let i = 0; i < n; i++ ) {
    const a = (i / n) * Math.PI * 2;
    samples.push([x + (Math.cos(a) * R), y + (Math.sin(a) * R)]);
  }
  for ( const [px, py] of samples ) {
    const id = board.territoryAt?.(px, py);
    if ( id && !skip.has(id) ) return blocked(id);
  }
  for ( const [id, def] of Object.entries(board.territories ?? {}) ) {
    if ( skip.has(id) ) continue;
    if ( (def.polygons ?? []).some(points => polygonNearCircle(points, x, y, R)) ) return blocked(id);
  }

  // Furniture printed on the board
  for ( const { key, box, label } of furnitureBoxes(board) ) {
    if ( !rectNearCircle(box, x, y, R) ) continue;
    const what = label ?? (game.i18n.has(`RL.Canvas.Water.Furniture.${key}`)
      ? game.i18n.localize(`RL.Canvas.Water.Furniture.${key}`) : game.i18n.localize("RL.Canvas.Water.Furniture.other"));
    return no("RL.Canvas.Water.furniture", { what });
  }

  // Sea lines (printed and pen-drawn)
  for ( const line of board.seaLines ?? [] ) {
    if ( (line.points?.length !== 2) || skip.has(line.a) || skip.has(line.b) ) continue;
    const [[ax, ay], [bx, by]] = line.points;
    if ( segmentDistance(x, y, ax, ay, bx, by) < R ) return no("RL.Canvas.Water.seaLine", { a: name(line.a), b: name(line.b) });
  }
  return { ok: true, reason: "" };
}

/**
 * Rectangles of the board furniture.
 * @param {object} board
 * @returns {{key: string, box: {x: number, y: number, width: number, height: number}, label?: string}[]}
 */
function furnitureBoxes(board) {
  const out = [];
  const isBox = b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite);
  for ( const [key, value] of Object.entries(board.furniture ?? {}) ) {
    for ( const box of (Array.isArray(value) ? value : [value]) ) if ( isBox(box) ) out.push({ key, box });
  }
  for ( const def of Object.values(board.continents ?? {}) ) {
    if ( isBox(def.plate) ) {
      out.push({ key: "plate", box: def.plate, label: game.i18n.format("RL.Canvas.Water.Furniture.plate", { name: def.label ?? "" }) });
    }
  }
  return out;
}

/** Does a circle touch a rectangle? */
function rectNearCircle(box, x, y, r) {
  const cx = Math.max(box.x, Math.min(x, box.x + box.width));
  const cy = Math.max(box.y, Math.min(y, box.y + box.height));
  return ((cx - x) ** 2) + ((cy - y) ** 2) < r * r;
}

/** Does a circle touch a polygon (flat point array): centre inside, or an edge closer than r? */
function polygonNearCircle(points, x, y, r) {
  if ( !points?.length ) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for ( let i = 0; i < points.length; i += 2 ) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  if ( (x < minX - r) || (x > maxX + r) || (y < minY - r) || (y > maxY + r) ) return false;
  if ( pointInPolygon(x, y, points) ) return true;
  for ( let i = 0, j = points.length - 2; i < points.length; j = i, i += 2 ) {
    if ( segmentDistance(x, y, points[j], points[j + 1], points[i], points[i + 1]) < r ) return true;
  }
  return false;
}

/** Distance from a point to a segment. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = (dx * dx) + (dy * dy);
  const t = l2 ? Math.max(0, Math.min(1, (((px - ax) * dx) + ((py - ay) * dy)) / l2)) : 0;
  return Math.hypot(px - (ax + (t * dx)), py - (ay + (t * dy)));
}
