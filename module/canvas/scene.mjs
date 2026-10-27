import { BOARD_VARIANTS, SYSTEM_ID, systemPath } from "../config.mjs";
import { getBoard, getBoardScene, getBoardVariant, getCampaign, getCampaignBoard, loadBoard, preload } from "../state/_module.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import { clearSlotCache } from "./geometry.mjs";

/**
 * The world board scene: "The World", 6000×4000, gridless, the board image as the background of its (only) Level,
 * no fog or vision, and one Region per territory (polygon shapes from the board definition, `flags[SYSTEM_ID]
 * .territory`, visible only on the Regions layer to GMs, no behaviours). Territory lookup (`territoryAtPoint`) uses
 * these Regions, so a GM can correct a shape in the Regions layer; rebuilding resets them to the definition.
 */

/** Id of the scene's single Level (core's default level id). */
const LEVEL_ID = "defaultLevel0000";

/**
 * [GM] Build (or rebuild) the world board scene for a board variant.
 * @param {object} [options]
 * @param {string} [options.variant]       board variant (default: the campaign's)
 * @param {boolean} [options.activate]     activate the scene (default: only if no scene is active)
 * @returns {Promise<string>} the scene id
 */
export function buildBoardScene({ variant, activate } = {}) {
  return runAction("board.build", { variant: variant ?? getBoardVariant(), activate });
}

export function registerSceneActions() {
  registerAction("board.build", async (payload, { user }) => {
    if ( !user.isGM ) throw new Error(game.i18n.localize("RL.Canvas.Error.gmOnly"));
    const scene = await build(payload);
    return scene.id;
  });
  registerAction("board.syncRegions", async (payload, { user }) => {
    if ( !user.isGM ) throw new Error(game.i18n.localize("RL.Canvas.Error.gmOnly"));
    return syncCampaignRegions();
  });
}

/**
 * [GM] Bring the board scene's territory Regions in line with the campaign board: create the Regions of territories
 * added during the campaign (Alien Island), update theirs when they moved, delete the Regions of removed ones.
 * The Regions of the printed territories are left alone (a GM may have corrected them). Runs by itself on the active
 * GM whenever `campaign.system.customTerritories` changes; callable from any client.
 * @returns {Promise<{created: number, updated: number, deleted: number}|null>}
 */
export function syncTerritoryRegions() {
  return runAction("board.syncRegions", {});
}

let regionQueue = Promise.resolve();

/**
 * Sync the campaign's territory Regions on this (GM) client; requests are queued so two quick campaign updates never
 * create a Region twice.
 * @returns {Promise<{created: number, updated: number, deleted: number}|null>}
 */
export function syncCampaignRegions() {
  const run = regionQueue.then(async () => {
    await preload();
    const scene = getBoardScene();
    if ( !scene || (scene.getFlag(SYSTEM_ID, "board") !== getBoardVariant()) ) return null;
    const board = getCampaignBoard();
    if ( !board ) return null;
    const result = await syncRegions(scene, board, { reset: false });
    clearSlotCache();
    return result;
  });
  regionQueue = run.catch(err => console.error(`${SYSTEM_ID} | syncing the territory regions failed`, err));
  return run;
}

/**
 * Scene data shared by creation and rebuilds.
 * @param {object} board
 */
function sceneData(board, variant) {
  const { width = 6000, height = 4000, background } = board.scene ?? {};
  return {
    name: game.i18n.localize("RL.Canvas.Scene.name"),
    navName: game.i18n.localize("RL.Canvas.Scene.name"),
    width, height,
    // No padding: canvas coordinates then equal the board definition's scene px (token x/y, Region polygons)
    padding: 0,
    shiftX: 0, shiftY: 0,
    grid: { type: CONST.GRID_TYPES.GRIDLESS, size: 100, distance: 1, units: "", alpha: 0 },
    tokenVision: false,
    fog: { mode: CONST.FOG_EXPLORATION_MODES.DISABLED },
    environment: {
      darknessLevel: 0, darknessLock: true, cycle: false,
      globalLight: { enabled: true, bright: true }
    },
    initial: { x: Math.round(width / 2), y: Math.round(height / 2), scale: 0.25 },
    navigation: true,
    flags: { [SYSTEM_ID]: { board: variant, background: background ?? "" } },
    _levelBackground: background ? systemPath(background) : null
  };
}

/**
 * Create or update the scene and its territory regions.
 * @param {{variant?: string, activate?: boolean}} payload
 * @returns {Promise<Scene>}
 */
async function build({ variant, activate } = {}) {
  await preload();
  variant = BOARD_VARIANTS[variant] ? variant : getBoardVariant();
  // Campaign board: includes added territories (Alien Island), which get a Region like any other territory
  const board = ((variant === getBoardVariant()) ? getCampaignBoard() : null) ?? getBoard(variant) ?? await loadBoard(variant);
  if ( !board ) throw new Error(game.i18n.format("RL.Canvas.Error.noBoard", { variant }));
  const { _levelBackground: backgroundSrc, ...data } = sceneData(board, variant);
  const level = {
    _id: LEVEL_ID,
    name: game.i18n.localize("RL.Canvas.Scene.level"),
    background: { src: backgroundSrc, color: "#4a4b4d" },
    textures: { fit: "fill", anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 }
  };

  let scene = getBoardScene();
  if ( scene ) {
    await scene.update(data);
    const existing = scene.levels.get(LEVEL_ID) ?? scene.firstLevel;
    if ( existing ) await scene.updateEmbeddedDocuments("Level", [{ ...level, _id: existing.id }]);
    else await scene.createEmbeddedDocuments("Level", [level], { keepId: true });
    await syncRegions(scene, board);
    if ( activate && !scene.active ) await scene.activate();
  }
  else {
    // Regions go into the creation data: creating them afterwards races the canvas drawing the new active scene
    scene = await Scene.implementation.create({
      ...data, levels: [level], initialLevel: LEVEL_ID,
      regions: Object.keys(board.territories).map(id => regionData(board, id, LEVEL_ID)),
      active: activate ?? !game.scenes.active
    }, { keepEmbeddedIds: true });
  }
  clearSlotCache();

  const campaign = getCampaign();
  if ( campaign && (campaign.system.documents?.scene !== scene.id) ) {
    await campaign.update({ "system.documents.scene": scene.id });
  }
  return scene;
}

/**
 * One Region per territory: update the ones that exist, create the missing ones, delete territory regions that the
 * board doesn't have.
 * @param {Scene} scene
 * @param {object} board
 * @param {object} [options]
 * @param {boolean} [options.reset=true]   reset every Region to the board definition; false: only the Regions of
 *                                         territories added during the campaign are updated (when they changed)
 * @returns {Promise<{created: number, updated: number, deleted: number}>}
 */
async function syncRegions(scene, board, { reset = true } = {}) {
  const levelId = scene.initialLevel?.id ?? LEVEL_ID;
  const byTerritory = new Map();
  const stale = [];
  for ( const region of scene.regions ) {
    const id = region.getFlag(SYSTEM_ID, "territory");
    if ( !id ) continue;
    if ( !board.territories[id] || byTerritory.has(id) ) stale.push(region.id);
    else byTerritory.set(id, region);
  }
  const toCreate = [];
  const toUpdate = [];
  for ( const id of Object.keys(board.territories) ) {
    const data = regionData(board, id, levelId);
    const region = byTerritory.get(id);
    if ( !region ) toCreate.push(data);
    else if ( reset ) toUpdate.push({ _id: region.id, ...data });
    else if ( board.territories[id].custom && !sameShapes(region, data) ) toUpdate.push({ _id: region.id, ...data });
  }
  if ( stale.length ) await scene.deleteEmbeddedDocuments("Region", stale);
  if ( toUpdate.length ) await scene.updateEmbeddedDocuments("Region", toUpdate);
  if ( toCreate.length ) await scene.createEmbeddedDocuments("Region", toCreate);
  return { created: toCreate.length, updated: toUpdate.length, deleted: stale.length };
}

/** Does a Region already have these polygon shapes and name? */
function sameShapes(region, data) {
  const current = region.shapes.filter(s => s.type === "polygon").map(s => [...s.points]);
  return (region.name === data.name) && (JSON.stringify(current) === JSON.stringify(data.shapes.map(s => s.points)));
}

/**
 * Region data for one territory: its polygons, GM-only (visible on the Regions layer), no behaviours.
 * @param {object} board
 * @param {string} id
 * @param {string} levelId
 */
function regionData(board, id, levelId) {
  const def = board.territories[id];
  return {
    name: def.name,
    color: board.continents?.[def.continent]?.color ?? "#fcdc07",
    shapes: (def.polygons ?? []).filter(p => p.length >= 6).map(points => ({ type: "polygon", points: [...points] })),
    levels: [levelId],
    elevation: { bottom: null, top: null },
    visibility: CONST.REGION_VISIBILITY.LAYER,
    highlightMode: "shapes",
    locked: true,
    restriction: { enabled: false },
    flags: { [SYSTEM_ID]: { territory: id, continent: def.continent } }
  };
}
