import { CITY_TYPES, FORTIFICATION_USES, PIECES, STARTING_TROOPS, SYSTEM_ID } from "../config.mjs";
import { buildSnapshot, findEntry, getBoardScene, getCampaign } from "../state/_module.mjs";
import { boardForScene, isBoardScene, piecesByTerritory } from "./geometry.mjs";
import { territoryArt } from "./marks.mjs";
import { spawnPieces } from "./pieces.mjs";

/**
 * Board interaction on the client: territory picking, point picking (placing a sticker on the board), click-to-place,
 * highlights, the prompt banner and the territory hover tooltip.
 *
 * Only one mode (pick, point or place) runs at a time. While it runs the `rlBoard` layer is active (so clicks reach it
 * and not the tokens); the previous layer comes back when it ends. Esc or a right-click cancels.
 */

const TEMPLATES = {
  banner: "systems/fvtt-risklegacy-v5/templates/canvas/banner.hbs",
  tooltip: "systems/fvtt-risklegacy-v5/templates/canvas/tooltip.hbs"
};
export const TEMPLATE_PATHS = Object.values(TEMPLATES);

/** @type {object|null} the running pick/place mode */
let mode = null;

/** @type {{ids: string[], color: number, alpha: number}|null} highlights requested through the API */
let extra = null;

/** @returns {object|null} */
export function currentMode() {
  return mode;
}

/** @returns {{ids: string[], color: number, alpha: number}|null} */
export function extraHighlights() {
  return extra;
}

/** @returns {object} game.risklegacy.<area> or {} */
const area = name => game.risklegacy?.[name] ?? {};

/**
 * Make sure the world board is on the canvas.
 * @returns {Promise<boolean>}
 */
async function ensureBoardView() {
  if ( canvas.ready && isBoardScene(canvas.scene) ) return true;
  const scene = getBoardScene();
  if ( !scene ) {
    ui.notifications.warn("RL.Canvas.Error.noScene", { localize: true });
    return false;
  }
  await scene.view();
  return canvas.ready && isBoardScene(canvas.scene);
}

/**
 * A colour option: a number, a CSS colour, or a faction actor id.
 * @param {number|string|undefined} value
 * @param {number} fallback
 */
function toColor(value, fallback) {
  if ( value === undefined || value === null || value === "" ) return fallback;
  if ( typeof value === "number" ) return value;
  const faction = game.actors.get(value);
  if ( faction?.type === "faction" ) return Number(faction.system.color ?? fallback);
  try {
    return Number(foundry.utils.Color.from(value));
  } catch(err) {
    return fallback;
  }
}

/* -------------------------------------------- */
/*  Highlights                                  */
/* -------------------------------------------- */

/**
 * Highlight territories on the board (e.g. legal targets) until cleared.
 * @param {string[]} ids
 * @param {object} [options]
 * @param {number|string} [options.color]  number, CSS colour or faction id (default hazard yellow)
 * @param {number} [options.alpha=1]
 */
export function highlightTerritories(ids, { color, alpha = 1 } = {}) {
  extra = { ids: [...(ids ?? [])], color: toColor(color, 0xfcdc07), alpha };
  canvas.rlBoard?.drawHighlights();
}

/** Remove highlights set with highlightTerritories. */
export function clearHighlights() {
  extra = null;
  canvas.rlBoard?.drawHighlights();
}

/* -------------------------------------------- */
/*  Modes                                       */
/* -------------------------------------------- */

function startMode(m) {
  mode = m;
  const layer = canvas.rlBoard;
  const previous = canvas.activeLayer;
  m.previousLayer = (previous && (previous !== layer)) ? previous.options?.name : "tokens";
  m.restoring = false;
  layer?.activate();
  renderBanner();
  layer?.drawHighlights();
  layer?.drawGhost();
}

function endMode({ restore = true } = {}) {
  const m = mode;
  mode = null;
  removeBanner();
  canvas.rlBoard?.drawHighlights();
  canvas.rlBoard?.drawGhost();
  if ( restore && m?.previousLayer && canvas.ready && canvas.rlBoard?.active ) {
    m.restoring = true;
    canvas[m.previousLayer]?.activate();
  }
  return m;
}

/**
 * Cancel the running pick/place mode.
 * @returns {boolean} whether something was cancelled
 */
export function cancelMode({ restore = true } = {}) {
  if ( !mode ) return false;
  const m = endMode({ restore });
  m?.onCancel?.();
  return true;
}

/** The rlBoard layer was deactivated (the user switched tools): cancel. */
export function onLayerDeactivated() {
  if ( mode && !mode.restoring ) cancelMode({ restore: false });
}

/**
 * A click on the board while the rlBoard layer is active.
 * @param {string|null} territory
 * @param {PIXI.FederatedEvent} event
 */
export function handleClick(territory, event, point) {
  if ( !mode ) return;
  if ( mode.kind === "point" ) {
    if ( point ) mode.onPoint?.(point, event);
    return;
  }
  if ( !territory ) return;
  if ( mode.allowed && !mode.allowed.includes(territory) ) {
    ui.notifications.warn(game.i18n.format("RL.Canvas.Notify.notAllowed", { name: territoryName(territory) }));
    return;
  }
  mode.onClick?.(territory, event);
}

/** Re-render the banner and highlights of the running mode (e.g. after the reserve changed). */
export function refreshMode() {
  if ( !mode ) return;
  mode.refresh?.();
  renderBanner();
  canvas.rlBoard?.drawHighlights();
}

function territoryName(id) {
  return boardForScene()?.territories?.[id]?.name ?? id;
}

/* -------------------------------------------- */
/*  Pick a territory                            */
/* -------------------------------------------- */

/**
 * Ask the user to click a territory.
 * @param {object} [options]
 * @param {string} [options.prompt]       text (or localization key) shown in the banner
 * @param {string[]} [options.allowed]    clickable territory ids (default: any)
 * @param {string} [options.faction]      faction id (banner name, highlight colour)
 * @returns {Promise<string|null>}        the territory id, or null if cancelled
 */
export async function pickTerritory({ prompt, allowed, faction } = {}) {
  cancelMode();
  if ( !(await ensureBoardView()) ) return null;
  return new Promise(resolve => {
    startMode({
      kind: "pick", faction, prompt: prompt ? game.i18n.localize(prompt) : game.i18n.localize("RL.Canvas.Banner.pick"),
      hint: game.i18n.localize("RL.Canvas.Banner.pickHint"),
      allowed: allowed ? [...allowed] : null,
      color: toColor(faction, 0xfcdc07),
      onClick: territory => {
        endMode();
        resolve(territory);
      },
      onCancel: () => resolve(null)
    });
  });
}

/* -------------------------------------------- */
/*  Pick a point (place a sticker)              */
/* -------------------------------------------- */

/**
 * Ask the user to click a spot of the board, e.g. where to stick a sticker. A ghost of the sticker (the image, or a
 * plain disc of `radius` without one) follows the pointer inside a ring of `radius`, yellow where `validate` accepts
 * the spot, red with the reason where it doesn't. A click on an accepted spot resolves its centre; a click elsewhere
 * only warns. Same conventions as pickTerritory: banner with Cancel, Esc or right-click resolves null.
 * @param {object} [options]
 * @param {string} [options.prompt]        text (or localization key) shown in the banner
 * @param {string} [options.hint]          banner hint (or key); default: how to place and cancel
 * @param {number} [options.radius=0]      sticker radius in scene px (the ghost's size)
 * @param {string} [options.img]           sticker image (system-relative or full path). Known sticker art (Alien
 *                                         Island) is drawn exactly as the final sticker will be (same scale and mask)
 * @param {(point: {x: number, y: number}) => ({ok: boolean, reason?: string}|boolean)} [options.validate]
 *                                         synchronous check of a candidate centre (default: anywhere), e.g.
 *                                         `p => board.isOpenWater(p, radius)`
 * @param {string} [options.faction]       faction id (banner name)
 * @returns {Promise<{x: number, y: number}|null>}  the chosen centre (integer scene px), null if cancelled
 */
export async function pickPoint({ prompt, hint, radius = 0, img, validate, faction } = {}) {
  cancelMode();
  if ( !(await ensureBoardView()) ) return null;
  const r = Math.max(0, Number(radius) || 0);
  let art = null;
  try {
    if ( img || (r > 0) ) art = await territoryArt({ img, radius: r || 60, shadow: false });
  } catch(err) {
    console.warn(`${SYSTEM_ID} | pickPoint: no ghost for ${img}`, err);
  }
  if ( !canvas.ready || !isBoardScene(canvas.scene) ) {
    art?.destroy({ children: true });
    return null;
  }
  cancelMode();   // something else may have started while the art loaded
  return new Promise(resolve => {
    startMode({
      kind: "point", faction,
      prompt: prompt ? game.i18n.localize(prompt) : game.i18n.localize("RL.Canvas.Banner.point"),
      hint: game.i18n.localize(hint ?? "RL.Canvas.Banner.pointHint"),
      allowed: [],
      color: 0xfcdc07,
      radius: r, art, validate,
      onPoint: point => {
        const p = { x: Math.round(point.x), y: Math.round(point.y) };
        const verdict = checkPoint(p);
        if ( !verdict.ok ) {
          ui.notifications.warn(verdict.reason || game.i18n.localize("RL.Canvas.Notify.badPoint"));
          return;
        }
        endMode();
        resolve(p);
      },
      onCancel: () => resolve(null)
    });
  });
}

/**
 * Run the point mode's validator on a candidate centre (never throws).
 * @param {{x: number, y: number}} point   integer scene px
 * @returns {{ok: boolean, reason: string}}
 */
export function checkPoint(point) {
  if ( mode?.kind !== "point" ) return { ok: false, reason: "" };
  if ( typeof mode.validate !== "function" ) return { ok: true, reason: "" };
  try {
    const v = mode.validate({ x: point.x, y: point.y });
    if ( typeof v === "boolean" ) return { ok: v, reason: "" };
    return { ok: !!v?.ok, reason: v?.reason ? game.i18n.localize(String(v.reason)) : "" };
  } catch(err) {
    console.error(`${SYSTEM_ID} | pickPoint validate failed`, err);
    return { ok: false, reason: err.message ?? "" };
  }
}

/* -------------------------------------------- */
/*  Click-to-place                              */
/* -------------------------------------------- */

/**
 * Let a faction place troops by clicking territories.
 *   reserve   click: 1 troop, shift-click: 3, through `turn.placeReserve` until the reserve is empty
 *   starting  one click: HQ + starting troops in a legal starting territory (`turn.placeStartingForces`)
 *   join      one click: Join the War in a legal starting territory (`turn.joinWar`)
 * @param {object} options
 * @param {string} options.faction   faction actor id
 * @param {"reserve"|"starting"|"join"} [options.mode="reserve"]
 * @returns {Promise<{placed: number, territory: string|null, cancelled: boolean}>} when placement ends
 */
export async function startPlacement({ faction, mode: placeMode = "reserve" } = {}) {
  cancelMode();
  const actor = game.actors.get(faction);
  if ( actor?.type !== "faction" ) throw new Error(game.i18n.format("RL.Canvas.Error.noFaction", { id: String(faction) }));
  if ( !(await ensureBoardView()) ) return { placed: 0, territory: null, cancelled: true };

  return new Promise(resolve => {
    let placed = 0;
    let busy = false;
    const reserve = () => game.actors.get(faction)?.system?.war?.reserve ?? 0;
    const m = {
      kind: "place", placeMode, faction,
      prompt: game.i18n.localize(`RL.Canvas.Banner.place.${placeMode}`),
      hint: game.i18n.localize(placeMode === "reserve" ? "RL.Canvas.Banner.placeHint" : "RL.Canvas.Banner.pickHint"),
      color: toColor(faction, 0xfcdc07),
      allowed: placementTargets(faction, placeMode),
      reserve: placeMode === "reserve" ? reserve() : null,
      refresh() {
        m.allowed = placementTargets(faction, placeMode);
        if ( placeMode === "reserve" ) m.reserve = reserve();
      },
      onClick: async (territory, event) => {
        if ( busy ) return;
        busy = true;
        try {
          if ( placeMode === "reserve" ) {
            const left = reserve();
            const count = Math.max(1, Math.min(event?.shiftKey ? 3 : 1, left || 1));
            await placeReserve(faction, territory, count);
            placed += count;
          }
          else {
            await (placeMode === "starting" ? placeStarting(faction, territory) : joinWar(faction, territory));
            placed += 1;
            endMode();
            resolve({ placed, territory, cancelled: false });
            return;
          }
        } catch(err) {
          console.error(`${SYSTEM_ID} | placement failed`, err);
        } finally {
          busy = false;
        }
        // Give the actor update a moment to arrive, then refresh or finish
        await new Promise(r => setTimeout(r, 150));
        if ( mode !== m ) return;
        m.refresh();
        if ( (placeMode === "reserve") && (m.reserve <= 0) ) {
          endMode();
          resolve({ placed, territory, cancelled: false });
          return;
        }
        renderBanner();
        canvas.rlBoard?.drawHighlights();
      },
      onCancel: () => resolve({ placed, territory: null, cancelled: true })
    };
    startMode(m);
  });
}

/** Stop click-to-place (or a pick) without placing anything else. */
export function stopPlacement() {
  return cancelMode();
}

/**
 * Territories the faction may place in now.
 * @param {string} faction
 * @param {string} placeMode
 * @returns {string[]|null}  null = any
 */
function placementTargets(faction, placeMode) {
  const rules = area("rules");
  const state = buildSnapshot();
  try {
    if ( state && (placeMode === "reserve") ) {
      if ( typeof rules.placementTargets === "function" ) return rules.placementTargets(state, faction);
      return state.factions?.[faction]?.territories ?? [];
    }
    if ( state && (typeof rules.legalStartingTerritories === "function") ) {
      return rules.legalStartingTerritories(state, faction, { joining: placeMode === "join" });
    }
  } catch(err) {
    console.error(`${SYSTEM_ID} | placement targets failed`, err);
  }
  if ( placeMode === "reserve" ) {
    const owned = [];
    for ( const [territory, pieces] of piecesByTerritory(getBoardScene()) ) {
      if ( territory && pieces.some(p => (p.faction === faction) && (p.kind !== "hq")) ) owned.push(territory);
    }
    return owned;
  }
  return null;
}

/* Turn API calls with fallbacks for sandbox use (no turn controller yet). */

async function placeReserve(faction, territory, count) {
  const turn = area("turn");
  if ( typeof turn.placeReserve === "function" ) return turn.placeReserve({ faction, territory, count });
  await spawnPieces({ faction, territory, troops: count });
  const actor = game.actors.get(faction);
  if ( actor?.isOwner ) await actor.update({ "system.war.reserve": Math.max(0, (actor.system.war.reserve ?? 0) - count) });
}

async function placeStarting(faction, territory) {
  const turn = area("turn");
  if ( typeof turn.placeStartingForces === "function" ) return turn.placeStartingForces({ faction, territory });
  return spawnPieces({ faction, territory, troops: STARTING_TROOPS, hq: true });
}

async function joinWar(faction, territory) {
  const turn = area("turn");
  if ( typeof turn.joinWar === "function" ) return turn.joinWar({ faction, territory });
  return spawnPieces({ faction, territory, troops: Math.floor(STARTING_TROOPS / 2) });
}

/* -------------------------------------------- */
/*  Banner                                      */
/* -------------------------------------------- */

let bannerElement = null;
let bannerRender = 0;

async function renderBanner() {
  if ( !mode ) return removeBanner();
  const ticket = ++bannerRender;
  const faction = mode.faction ? game.actors.get(mode.faction) : null;
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATES.banner, {
    prompt: mode.prompt,
    hint: mode.hint,
    factionName: faction?.name ?? "",
    factionColor: faction ? (faction.system.color?.css ?? "#808285") : "",
    reserve: mode.reserve,
    hasReserve: Number.isFinite(mode.reserve)
  });
  if ( (ticket !== bannerRender) || !mode ) return;
  if ( !bannerElement ) {
    bannerElement = document.createElement("section");
    bannerElement.id = "rl-board-banner";
    bannerElement.className = "risklegacy rl-board-banner";
    bannerElement.setAttribute("role", "status");
    bannerElement.addEventListener("click", event => {
      if ( event.target.closest("[data-action='cancel']") ) cancelMode();
    });
    document.body.append(bannerElement);
  }
  bannerElement.innerHTML = html;
}

function removeBanner() {
  bannerRender++;
  bannerElement?.remove();
  bannerElement = null;
}

/* -------------------------------------------- */
/*  Hover tooltip                               */
/* -------------------------------------------- */

let tipElement = null;
let tipTerritory = null;
let tipTimer = null;
let tipRender = 0;
let lastClient = { x: 0, y: 0 };

/**
 * Pointer moved over the board: show (after a short delay) or move the territory tooltip.
 * @param {string|null} territory
 * @param {{x: number, y: number}} point  canvas coordinates
 */
export function updateTooltip(territory, point) {
  if ( !game.settings.get(SYSTEM_ID, "canvas.showTooltip") || !territory ) return hideTooltip();
  if ( !canvas.app?.view?.matches(":hover") ) return hideTooltip();
  lastClient = canvas.clientCoordinatesFromCanvas(point);
  if ( territory !== tipTerritory ) {
    hideTooltip();
    tipTerritory = territory;
    tipTimer = setTimeout(() => showTooltip(territory), 450);
  }
  if ( tipElement ) positionTooltip(lastClient);
}

export function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipTerritory = null;
  tipRender++;
  tipElement?.remove();
  tipElement = null;
}

async function showTooltip(territory) {
  const ticket = ++tipRender;
  const context = tooltipContext(territory);
  if ( !context ) return;
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATES.tooltip, context);
  if ( (ticket !== tipRender) || (tipTerritory !== territory) ) return;
  tipElement?.remove();
  tipElement = document.createElement("aside");
  tipElement.className = "risklegacy rl-board-tooltip";
  tipElement.setAttribute("role", "tooltip");
  tipElement.innerHTML = html;
  document.body.append(tipElement);
  positionTooltip(lastClient);
}

function positionTooltip({ x, y }) {
  if ( !tipElement ) return;
  const w = tipElement.offsetWidth;
  const h = tipElement.offsetHeight;
  let left = x + 22;
  let top = y + 22;
  if ( left + w > window.innerWidth - 8 ) left = x - w - 22;
  if ( top + h > window.innerHeight - 8 ) top = y - h - 22;
  tipElement.style.left = `${Math.max(8, left)}px`;
  tipElement.style.top = `${Math.max(8, top)}px`;
}

/**
 * Everything the tooltip shows about a territory.
 * @param {string} id
 */
export function tooltipContext(id) {
  const scene = canvas.scene;
  const board = boardForScene(scene);
  const def = board?.territories?.[id];
  if ( !def ) return null;
  const campaign = getCampaign();
  const marks = campaign?.system?.territories?.[id] ?? {};
  const continentName = campaign?.system?.continents?.[def.continent]?.name || board.continents?.[def.continent]?.label;

  // Pieces (works without a campaign)
  const totals = {};
  for ( const p of piecesByTerritory(scene).get(id) ?? [] ) {
    const t = totals[p.faction] ??= { troops: 0, hq: false };
    t.troops += PIECES[p.kind]?.value ?? 0;
    if ( p.kind === "hq" ) t.hq = true;
  }
  const factions = Object.entries(totals).map(([fid, t]) => {
    const actor = game.actors.get(fid);
    return { id: fid, name: actor?.name ?? "?", color: actor?.system?.color?.css ?? "#808285", ...t };
  }).sort((a, b) => b.troops - a.troops);
  const owner = factions.find(f => f.troops > 0) ?? null;
  const others = factions.filter(f => f !== owner);

  const cityType = marks.city?.type;
  const fort = marks.fortification;
  const scarEntry = marks.scar ? findEntry("scars", marks.scar) : null;
  // Connections drawn in pen during the campaign (the only connections of an added territory)
  const penLines = (board.seaLines ?? []).filter(l => l.custom && ((l.a === id) || (l.b === id)))
    .map(l => board.territories[l.a === id ? l.b : l.a]?.name ?? (l.a === id ? l.b : l.a));
  return {
    name: def.name,
    continent: continentName ?? (def.custom ? game.i18n.localize("RL.Canvas.Tooltip.noContinent") : ""),
    seaLines: [...new Set(penLines)].join(", "),
    owner,
    others,
    city: cityType ? {
      name: marks.city.name || game.i18n.localize("RL.Canvas.Tooltip.unnamed"),
      label: game.i18n.localize(CITY_TYPES[cityType]?.label ?? cityType),
      population: CITY_TYPES[cityType]?.population ?? 0,
      founder: marks.city.founder ?? ""
    } : null,
    fortification: (cityType && fort?.active) ? {
      left: Math.max(0, FORTIFICATION_USES - (fort.used ?? 0)), total: FORTIFICATION_USES,
      depleted: (fort.used ?? 0) >= FORTIFICATION_USES
    } : null,
    scar: marks.scar ? (scarEntry?.name ?? game.i18n.localize(`RL.Scar.${marks.scar}`)) : "",
    // The card's last paragraph is the effect printed on the board's reference sticker
    scarText: String(scarEntry?.text ?? "").split(/\n\s*\n/).at(-1).trim(),
    marks: (marks.marks ?? []).map(m => findEntry("marks", m)?.name ?? m),
    cardDestroyed: !!marks.cardDestroyed
  };
}

/* -------------------------------------------- */
/*  Labels                                      */
/* -------------------------------------------- */

/**
 * Short label for the drag hint.
 * @param {{type: string, allow: boolean, dice?: number}} preview
 */
export function moveLabel(preview) {
  const key = {
    expand: "RL.Canvas.Hint.expand", maneuver: "RL.Canvas.Hint.maneuver", advance: "RL.Canvas.Hint.advance",
    attack: "RL.Canvas.Hint.attack", outside: "RL.Canvas.Hint.outside", hq: "RL.Canvas.Hint.hq"
  }[preview.type];
  if ( !key ) return "";
  const text = game.i18n.format(key, { dice: preview.dice ?? 1 });
  return preview.allow ? text : `✕ ${text}`;
}
