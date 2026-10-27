import { PIECES, SYSTEM_ID, systemPath } from "../config.mjs";
import { canActFor, enforcementLevel, getBoardScene, getCampaign, pieceKind, preload } from "../state/_module.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import {
  boardForScene, centerOf, layoutOrder, layoutSlots, piecesByTerritory, pieceSize, territorySlots
} from "./geometry.mjs";

/**
 * Pieces: the plastic troops and HQs are linked tokens of their faction actor, flagged
 * `flags[SYSTEM_ID].piece = troop | triple | hq`.
 *
 * Everything here that creates, deletes or moves other users' tokens runs on the active GM through the action bus
 * (`pieces.*`). The exported functions are thin `runAction` wrappers callable from any client.
 *
 * Piece bookkeeping rules:
 *  - **Make change**: taking troops from a territory that doesn't have enough single pieces breaks a 3-troop piece.
 *  - **Consolidate**: after every operation a faction's troops in a territory are shown with as many 3-troop pieces
 *    as possible (floor(n/3) triples + n%3 singles). HQs are never touched.
 *  - **Arrange**: pieces sit on the territory's placement spots, HQ on the first (central) spot.
 */

/**
 * Token update/create options marking writes made by this module (not intercepted as player moves).
 *
 * Bookkeeping moves are never animated. While a token animates, Foundry writes interpolated positions into
 * `document.x/y` on every client that draws it, so a snapshot taken right after an animated update (the turn
 * controller recording a conquest, a victory check) would still see the pieces in the old territory. And an
 * `animation` option makes core compute the movement speed from `canvas.dimensions`, which is null on a GM client
 * without a canvas or viewing another scene. Unanimated updates are complete when the promise resolves, everywhere.
 */
export const internalOptions = () => ({ [SYSTEM_ID]: { internal: true } });

/** Fresh options for every call: core mutates operation options (e.g. defines `_movement` on them). */
const still = () => ({ ...internalOptions(), animate: false });

/** Cosmetic tidying (the scene-control tool) may animate, when few tokens move and the board is on the canvas. */
const ANIMATE_LIMIT = 16;
const ANIMATION_MS = 450;

/* -------------------------------------------- */
/*  Serial queue (GM side)                      */
/* -------------------------------------------- */

let queue = Promise.resolve();

/**
 * Run piece operations one at a time on the GM, so concurrent requests (two battles resolving, a drag and an
 * arrange) never work from the same stale token list.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serial(fn) {
  const run = queue.then(async () => {
    await preload();
    return fn();
  });
  queue = run.catch(() => null);
  return run;
}

/* -------------------------------------------- */
/*  Public API (any client)                     */
/* -------------------------------------------- */

/**
 * [GM] Put new pieces in a territory.
 * @param {object} payload
 * @param {string} payload.faction    faction actor id
 * @param {string} payload.territory
 * @param {number} [payload.troops=0]
 * @param {boolean} [payload.hq=false]
 * @returns {Promise<string[]>} ids of the created tokens
 */
export function spawnPieces(payload) {
  return runAction("pieces.spawn", payload);
}

/**
 * [GM] Remove troops from a territory (casualties, city costs). Makes change as needed. HQs stay.
 * @param {{faction: string, territory: string, count: number}} payload
 * @returns {Promise<{removed: number, remaining: number}>}
 */
export function removeTroops(payload) {
  return runAction("pieces.remove", payload);
}

/**
 * [GM] Move troops between territories (conquest move-in, scripted maneuvers). Makes change; HQs never move.
 * @param {{faction: string, from: string, to: string, count: number}} payload
 * @returns {Promise<{moved: number}>}
 */
export function moveTroops(payload) {
  return runAction("pieces.move", payload);
}

/**
 * [GM] Set a faction's troop count in a territory (GM corrections, setup).
 * @param {{faction: string, territory: string, count: number}} payload
 * @returns {Promise<{troops: number}>}
 */
export function setTroops(payload) {
  return runAction("pieces.set", payload);
}

/**
 * [GM] Delete piece tokens from the board (all factions, or one).
 * @param {{faction?: string}} [payload]
 * @returns {Promise<{deleted: number}>}
 */
export function clearPieces(payload = {}) {
  return runAction("pieces.clear", payload);
}

/**
 * [GM] Tidy a territory's pieces onto its placement spots.
 * @param {object} [payload]
 * @param {string} [payload.territory]
 * @param {string[]} [payload.territories]   omit both to arrange the whole board
 * @param {boolean} [payload.animate=false]  cosmetic: slide the pieces (resolves after the slide has finished on the
 *                                           GM; other clients may still be animating)
 * @returns {Promise<{moved: number}>}
 */
export function arrangeTerritory(payload = {}) {
  return runAction("pieces.arrange", payload);
}

/**
 * [GM] Replace a 3-troop piece by three 1-troop pieces (token HUD).
 * @param {{token: string}} payload
 */
export function splitPiece(payload) {
  return runAction("pieces.split", payload);
}

/**
 * [GM] Replace three 1-troop pieces of the same faction and territory by one 3-troop piece (token HUD).
 * @param {{token: string}} payload
 */
export function mergePieces(payload) {
  return runAction("pieces.merge", payload);
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerPieceActions() {
  registerAction("pieces.spawn", (p, ctx) => serial(() => handleSpawn(p, ctx)));
  registerAction("pieces.remove", (p, ctx) => serial(() => handleRemove(p, ctx)));
  registerAction("pieces.move", (p, ctx) => serial(() => handleMove(p, ctx)));
  registerAction("pieces.set", (p, ctx) => serial(() => handleSet(p, ctx)));
  registerAction("pieces.clear", (p, ctx) => serial(() => handleClear(p, ctx)));
  registerAction("pieces.arrange", p => serial(() => handleArrange(p)));
  registerAction("pieces.split", (p, ctx) => serial(() => handleSplit(p, ctx)));
  registerAction("pieces.merge", (p, ctx) => serial(() => handleMerge(p, ctx)));
}

/* -------------------------------------------- */
/*  Permission helpers                          */
/* -------------------------------------------- */

function requireScene() {
  const scene = getBoardScene();
  if ( !scene ) throw new Error(game.i18n.localize("RL.Canvas.Error.noScene"));
  if ( !boardForScene(scene) ) {
    throw new Error(game.i18n.format("RL.Canvas.Error.noBoard", { variant: scene.getFlag(SYSTEM_ID, "board") ?? "?" }));
  }
  return scene;
}

function requireFaction(id) {
  const actor = game.actors.get(id);
  if ( actor?.type !== "faction" ) throw new Error(game.i18n.format("RL.Canvas.Error.noFaction", { id: String(id) }));
  return actor;
}

function requireTerritory(board, id) {
  if ( !board?.territories?.[id] ) throw new Error(game.i18n.format("RL.Canvas.Error.noTerritory", { id: String(id) }));
  return id;
}

/**
 * Board-changing piece operations are game mechanics: other areas call them from their own GM actions. A player may
 * call them directly for their own faction only when enforcement isn't strict (free play, advisory fixes).
 */
function requireMechanicsPermission(user, factionId) {
  if ( user.isGM ) return;
  if ( factionId && canActFor(user, factionId) && (enforcementLevel() !== "strict") ) return;
  throw new Error(game.i18n.localize("RL.Canvas.Error.gmOnly"));
}

const count = (n) => Math.max(0, Math.floor(Number(n) || 0));

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

async function handleSpawn({ faction, territory, troops = 0, hq = false }, { user }) {
  requireMechanicsPermission(user, faction);
  const scene = requireScene();
  const board = boardForScene(scene);
  const actor = requireFaction(faction);
  requireTerritory(board, territory);
  const current = troopsOf(scene, territory, faction);
  const created = await reconcile(scene, actor, territory, current + count(troops), { addHQ: !!hq });
  return created;
}

async function handleRemove({ faction, territory, count: n }, { user }) {
  requireMechanicsPermission(user, faction);
  const scene = requireScene();
  const actor = requireFaction(faction);
  requireTerritory(boardForScene(scene), territory);
  const current = troopsOf(scene, territory, faction);
  const removed = Math.min(current, count(n));
  await reconcile(scene, actor, territory, current - removed);
  return { removed, remaining: current - removed };
}

async function handleSet({ faction, territory, count: n }, { user }) {
  requireMechanicsPermission(user, faction);
  const scene = requireScene();
  const actor = requireFaction(faction);
  requireTerritory(boardForScene(scene), territory);
  await reconcile(scene, actor, territory, count(n));
  return { troops: count(n) };
}

async function handleClear({ faction } = {}, { user }) {
  requireMechanicsPermission(user, faction);
  if ( !faction && !user.isGM ) throw new Error(game.i18n.localize("RL.Canvas.Error.gmOnly"));
  const scene = requireScene();
  const ids = scene.tokens.filter(t => pieceKind(t) && (!faction || (t.actorId === faction))).map(t => t.id);
  if ( ids.length ) await scene.deleteEmbeddedDocuments("Token", ids, internalOptions());
  return { deleted: ids.length };
}

async function handleArrange({ territory, territories, animate = false } = {}) {
  const scene = requireScene();
  const board = boardForScene(scene);
  let ids = territories ?? (territory ? [territory] : null);
  ids = (ids ?? board.ids).filter(id => board.territories[id]);
  const moved = await arrange(scene, ids, { animate: !!animate });
  return { moved };
}

async function handleMove({ faction, from, to, count: n }, { user }) {
  requireMechanicsPermission(user, faction);
  const scene = requireScene();
  const board = boardForScene(scene);
  const actor = requireFaction(faction);
  requireTerritory(board, from);
  requireTerritory(board, to);
  if ( from === to ) return { moved: 0 };

  const source = byKind(scene, from, faction);
  const available = (source.troop.length) + (3 * source.triple.length);
  let k = Math.min(count(n), available);
  if ( !k ) return { moved: 0 };
  const moved = k;

  // Pick whole pieces: triples first, then singles; break one triple when the change doesn't work out.
  const moving = [];
  const triples = [...source.triple];
  const singles = [...source.troop];
  while ( (k >= 3) && triples.length ) { moving.push(triples.shift()); k -= 3; }
  while ( (k > 0) && singles.length ) { moving.push(singles.shift()); k -= 1; }
  const toCreate = [];   // [{territory, kind}]
  const toDelete = [];
  if ( k > 0 ) {
    // Make change: the triple is broken; `k` singles go to the destination, the rest stay behind.
    const broken = triples.shift();
    if ( broken ) {
      toDelete.push(broken.id);
      for ( let i = 0; i < k; i++ ) toCreate.push({ territory: to, kind: "troop" });
      for ( let i = k; i < 3; i++ ) toCreate.push({ territory: from, kind: "troop" });
    }
  }

  // Positions in the destination: provisional slots after the pieces already there (arrange tidies afterwards)
  const destCount = (piecesByTerritory(scene).get(to) ?? []).length;
  const slots = territorySlots(board, to, destCount + moving.length + toCreate.length);
  let slot = destCount;
  const updates = moving.map(doc => {
    const p = slots[slot++] ?? slots.at(-1);
    const { px } = pieceSize(board, pieceKind(doc), scene.grid.size);
    return { _id: doc.id, x: Math.round(p.x - (px / 2)), y: Math.round(p.y - (px / 2)) };
  });
  if ( updates.length ) await scene.updateEmbeddedDocuments("Token", updates, still());
  if ( toDelete.length ) await scene.deleteEmbeddedDocuments("Token", toDelete, internalOptions());
  if ( toCreate.length ) {
    const data = [];
    for ( const c of toCreate ) {
      const s = (c.territory === to) ? (slots[slot++] ?? slots.at(-1)) : territorySlots(board, from, 1)[0];
      data.push(await pieceData(actor, scene, c.kind, s));
    }
    await scene.createEmbeddedDocuments("Token", data, internalOptions());
  }

  // Consolidate both sides, then tidy
  await reconcile(scene, actor, from, troopsOf(scene, from, faction), { arrange: false });
  await reconcile(scene, actor, to, troopsOf(scene, to, faction), { arrange: false });
  await arrange(scene, [from, to]);
  return { moved };
}

async function handleSplit({ token }, { user }) {
  const scene = requireScene();
  const doc = scene.tokens.get(token);
  if ( !doc || (pieceKind(doc) !== "triple") ) throw new Error(game.i18n.localize("RL.Canvas.Error.notTriple"));
  if ( !canActFor(user, doc.actorId) ) throw new Error(game.i18n.localize("RL.Canvas.Error.notYours"));
  const actor = requireFaction(doc.actorId);
  const board = boardForScene(scene);
  const c = centerOf(doc);
  const { px } = pieceSize(board, "troop", scene.grid.size);
  const offsets = [[-0.55, 0.3], [0.55, 0.3], [0, -0.55]];
  const data = [];
  for ( const [dx, dy] of offsets ) {
    data.push(await pieceData(actor, scene, "troop", { x: c.x + (dx * px), y: c.y + (dy * px) }));
  }
  await scene.deleteEmbeddedDocuments("Token", [doc.id], internalOptions());
  const created = await scene.createEmbeddedDocuments("Token", data, internalOptions());
  return created.map(t => t.id);
}

async function handleMerge({ token }, { user }) {
  const scene = requireScene();
  const doc = scene.tokens.get(token);
  if ( !doc || (pieceKind(doc) !== "troop") ) throw new Error(game.i18n.localize("RL.Canvas.Error.notSingle"));
  if ( !canActFor(user, doc.actorId) ) throw new Error(game.i18n.localize("RL.Canvas.Error.notYours"));
  const actor = requireFaction(doc.actorId);
  const territory = territoryOfPiece(scene, doc);
  const c = centerOf(doc);
  const others = byKind(scene, territory, doc.actorId).troop
    .filter(t => t.id !== doc.id)
    .sort((a, b) => dist2(centerOf(a), c) - dist2(centerOf(b), c))
    .slice(0, 2);
  if ( others.length < 2 ) throw new Error(game.i18n.localize("RL.Canvas.Error.needThree"));
  const data = await pieceData(actor, scene, "triple", c);
  await scene.deleteEmbeddedDocuments("Token", [doc.id, ...others.map(t => t.id)], internalOptions());
  const [created] = await scene.createEmbeddedDocuments("Token", [data], internalOptions());
  return created?.id ?? null;
}

/* -------------------------------------------- */
/*  Core operations (run on the GM)             */
/* -------------------------------------------- */

const dist2 = (a, b) => ((a.x - b.x) ** 2) + ((a.y - b.y) ** 2);

function territoryOfPiece(scene, doc) {
  for ( const [territory, list] of piecesByTerritory(scene) ) {
    if ( list.some(p => p.doc.id === doc.id) ) return territory;
  }
  return null;
}

/** A faction's piece documents in a territory, by kind. */
function byKind(scene, territory, factionId) {
  const out = { troop: [], triple: [], hq: [] };
  for ( const p of piecesByTerritory(scene).get(territory) ?? [] ) {
    if ( p.faction === factionId ) out[p.kind]?.push(p.doc);
  }
  return out;
}

function troopsOf(scene, territory, factionId) {
  const k = byKind(scene, territory, factionId);
  return k.troop.length + (3 * k.triple.length);
}

/**
 * Token data for a new piece.
 * @param {Actor} faction
 * @param {Scene} scene
 * @param {string} kind
 * @param {{x: number, y: number}} center
 */
export async function pieceData(faction, scene, kind, center) {
  const board = boardForScene(scene);
  const { px, units } = pieceSize(board, kind, scene.grid.size);
  const src = pieceTexture(faction, kind);
  const overrides = {
    name: faction.name,
    x: Math.round(center.x - (px / 2)),
    y: Math.round(center.y - (px / 2)),
    width: units, height: units,
    level: scene.initialLevel?.id ?? scene.firstLevel?.id,
    texture: { src, fit: "contain", anchorX: 0.5, anchorY: 0.5, scaleX: 1, scaleY: 1 },
    actorLink: true,
    lockRotation: true, rotation: 0,
    displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
    displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    sight: { enabled: false },
    ring: { enabled: false },
    sort: kind === "hq" ? 1000 : 100,
    flags: { [SYSTEM_ID]: { piece: kind } }
  };
  const doc = await faction.getTokenDocument(overrides, { parent: scene });
  const data = doc.toObject();
  delete data._id;
  return data;
}

/**
 * Image for a faction's piece.
 * @param {Actor} faction
 * @param {string} kind
 */
export function pieceTexture(faction, kind) {
  const src = faction.system?.pieces?.[kind];
  if ( src ) return systemPath(src);
  const key = faction.system?.key;
  const file = { troop: "1", triple: "3", hq: "hq" }[kind];
  if ( key && file ) return systemPath(`assets/unlocks/base/factions/images/${key}_${file}.png`);
  return faction.img;
}

/**
 * Bring a faction's pieces in a territory to `target` troops in canonical form (as many triples as possible),
 * creating and deleting as few tokens as possible, then arrange the territory.
 * @param {Scene} scene
 * @param {Actor} faction
 * @param {string} territory
 * @param {number} target
 * @param {object} [options]
 * @param {boolean} [options.addHQ]     also place an HQ piece
 * @param {boolean} [options.arrange=true]
 * @returns {Promise<string[]>} ids of created tokens
 */
async function reconcile(scene, faction, territory, target, { addHQ = false, arrange: doArrange = true } = {}) {
  const board = boardForScene(scene);
  const current = byKind(scene, territory, faction.id);
  const wantTriples = Math.floor(target / 3);
  const wantSingles = target % 3;
  const toDelete = [
    ...current.triple.slice(wantTriples).map(d => d.id),
    ...current.troop.slice(wantSingles).map(d => d.id)
  ];
  const kinds = [];
  if ( addHQ ) kinds.push("hq");
  for ( let i = current.triple.length; i < wantTriples; i++ ) kinds.push("triple");
  for ( let i = current.troop.length; i < wantSingles; i++ ) kinds.push("troop");

  if ( toDelete.length ) await scene.deleteEmbeddedDocuments("Token", toDelete, internalOptions());
  let created = [];
  if ( kinds.length ) {
    // Create the new pieces directly on their final slots
    const existing = (piecesByTerritory(scene).get(territory) ?? []).map(p => ({ ...p }));
    const future = existing.concat(kinds.map(kind => ({ kind, faction: faction.id, doc: null })));
    const ordered = layoutOrder(future, ownerOf(future));
    const slots = layoutSlots(board, territory, ordered.map(p => p.kind), { marks: marksOf(territory) });
    const data = [];
    for ( const [i, p] of ordered.entries() ) {
      if ( p.doc ) continue;
      data.push(await pieceData(faction, scene, p.kind, slots[i] ?? slots.at(-1)));
    }
    created = (await scene.createEmbeddedDocuments("Token", data, internalOptions())).map(t => t.id);
  }
  if ( doArrange && (toDelete.length || kinds.length) ) await arrange(scene, [territory]);
  return created;
}

/** The campaign's marks on a territory (city, scar…), so pieces are laid out beside the stickers. */
function marksOf(territory) {
  return getCampaign()?.system?.territories?.[territory] ?? null;
}

/** The faction with the most troops among a list of pieces. */
function ownerOf(pieces) {
  const totals = {};
  for ( const p of pieces ) totals[p.faction] = (totals[p.faction] ?? 0) + (PIECES[p.kind]?.value ?? 0);
  const best = Object.entries(totals).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? null;
}

/**
 * Move every piece of the given territories onto its layout slot.
 * @param {Scene} scene
 * @param {string[]} territories
 * @returns {Promise<number>} number of tokens moved
 */
export async function arrange(scene, territories, { animate = false } = {}) {
  const board = boardForScene(scene);
  if ( !board ) return 0;
  const byTerritory = piecesByTerritory(scene);
  const updates = [];
  for ( const territory of new Set(territories) ) {
    if ( !territory || !board.territories[territory] ) continue;
    const pieces = byTerritory.get(territory) ?? [];
    if ( !pieces.length ) continue;
    const ordered = layoutOrder(pieces, ownerOf(pieces));
    const slots = layoutSlots(board, territory, ordered.map(p => p.kind), { marks: marksOf(territory) });
    for ( const [i, p] of ordered.entries() ) {
      const s = slots[i];
      if ( !s ) continue;
      const w = p.doc._source.width * scene.grid.size;
      const x = Math.round(s.x - (w / 2));
      const y = Math.round(s.y - (w / 2));
      // HQs on top: in a crowded territory the Red Star they're worth must stay visible
      const sort = (p.kind === "hq" ? 1000 : 100) + i;
      const change = { _id: p.doc.id };
      if ( (Math.abs(p.doc._source.x - x) > 1) || (Math.abs(p.doc._source.y - y) > 1) ) Object.assign(change, { x, y });
      if ( p.doc._source.sort !== sort ) change.sort = sort;
      if ( Object.keys(change).length > 1 ) updates.push(change);
    }
  }
  if ( !updates.length ) return 0;
  const moving = updates.filter(u => "x" in u).length;
  const slide = animate && (moving <= ANIMATE_LIMIT) && canvas.ready && (canvas.scene === scene);
  await scene.updateEmbeddedDocuments("Token", updates,
    slide ? { ...internalOptions(), animate: true, animation: { duration: ANIMATION_MS } } : still());
  if ( slide ) await settle(scene, updates.map(u => u._id));
  return moving;
}

/**
 * Wait until the movement animations of these tokens have finished on this client. While a token animates, Foundry
 * writes interpolated positions into `document.x/y` (only `_source` holds the destination), so callers that build a
 * snapshot right after a piece operation would otherwise see pieces half-way.
 * @param {Scene} scene
 * @param {string[]} ids
 */
async function settle(scene, ids) {
  if ( !canvas.ready || (canvas.scene !== scene) ) return;
  const promises = ids.map(id => scene.tokens.get(id)?.object?.movementAnimationPromise).filter(Boolean);
  if ( !promises.length ) return;
  await Promise.race([Promise.allSettled(promises), new Promise(r => setTimeout(r, 2500))]);
}
