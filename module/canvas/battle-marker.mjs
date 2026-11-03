import { boardForScene, isBoardScene, territoryPolygons } from "./geometry.mjs";
import { factionColor } from "./layers.mjs";
import { handText } from "./marks.mjs";

/**
 * The battle marker on the world board: while two territories are battling, the defending territory pulses red, the
 * attacking territory gets an outline in the attacker's colour, and a marker-red arrow points from one to the other.
 *
 * Purely client-side drawing, driven by the battle area (module/battle/highlight.mjs), which watches the battle chat
 * messages on every client and calls `showBattleMarker` / `clearBattleMarker` (exported as
 * `game.risklegacy.board.showBattleMarker/clearBattleMarker`). Drawn in its own container at the bottom of the
 * `rlBoard` layer (above the pieces, below the troop badges and the pick/drag highlights).
 */

const RED = 0xc4151c;
const INK = 0x111213;
const PAPER = 0xfbfcfc;

/** Pulse period (ms) and fade-out duration (ms). */
const PERIOD = 1100;
const FADE = 600;

/** @type {{spec: object, container: PIXI.Container, pulse: PIXI.Graphics, started: number, fadeFrom: number|null}|null} */
let state = null;
let ticking = false;

/**
 * Highlight a battle on the board (replaces the current one).
 * @param {object} spec
 * @param {string} spec.id            battle message id
 * @param {string} spec.from          attacking territory
 * @param {string} spec.to            defending territory
 * @param {string} [spec.attacker]    attacking faction actor id (outline colour)
 * @param {string} [spec.defender]    defending faction actor id
 * @param {string} [spec.label]       text over the defender ("BATTLE")
 */
export function showBattleMarker(spec) {
  if ( !spec?.from || !spec?.to ) return;
  const same = state && (state.spec.id === spec.id) && (state.spec.from === spec.from) && (state.spec.to === spec.to);
  if ( same && (state.fadeFrom === null) && state.container && !state.container.destroyed && state.container.parent ) return;
  destroyContainer();
  state = { spec: { ...spec }, container: null, pulse: null, started: performance.now(), fadeFrom: null };
  draw();
}

/**
 * Remove the battle highlight.
 * @param {string} [id]               only if it highlights this battle
 * @param {object} [options]
 * @param {boolean} [options.fade=true]  fade out instead of disappearing at once
 */
export function clearBattleMarker(id, { fade = true } = {}) {
  if ( !state || (id && (state.spec.id !== id)) ) return;
  if ( fade && state.container && !state.container.destroyed ) {
    if ( state.fadeFrom === null ) state.fadeFrom = performance.now();
    return;
  }
  destroyContainer();
  state = null;
}

/** @returns {object|null} the battle currently highlighted (spec), for tests and macros */
export function battleMarker() {
  return state ? { ...state.spec, fading: state.fadeFrom !== null } : null;
}

/**
 * Redraw after the canvas was (re)drawn (the layer's children, and so the marker, go with a canvas teardown).
 * A marker that was fading out is dropped instead.
 */
export function redrawBattleMarker() {
  if ( !state ) return;
  destroyContainer();
  if ( state.fadeFrom !== null ) {
    state = null;
    return;
  }
  draw();
}

/* -------------------------------------------- */

function destroyContainer() {
  const c = state?.container;
  if ( c && !c.destroyed ) {
    c.parent?.removeChild(c);
    c.destroy({ children: true });
  }
  if ( state ) {
    state.container = null;
    state.pulse = null;
  }
}

/** Territory centre: the board definition's, else the middle of its polygons' bounds. */
function centerOf(board, territory) {
  const c = board?.territories?.[territory]?.center;
  if ( Array.isArray(c) ) return { x: c[0], y: c[1] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for ( const pts of territoryPolygons(territory, canvas.scene) ) {
    for ( let i = 0; i < pts.length; i += 2 ) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
  }
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

/**
 * Where to draw the arrow(s): one straight arrow, or two half-arrows leaving/entering at the board's edges when the
 * territories are neighbours across the map's wrap-around (Alaska ↔ Kamchatka).
 * @returns {{ax, ay, bx, by, head: boolean}[]}
 */
function arrowSegments(a, b, width) {
  const dx = b.x - a.x;
  if ( !width || (Math.abs(dx) <= width / 2) ) return [{ ax: a.x, ay: a.y, bx: b.x, by: b.y, head: true }];
  const shift = dx > 0 ? -width : width;
  return [
    { ax: a.x, ay: a.y, bx: b.x + shift, by: b.y, head: false },
    { ax: a.x - shift, ay: a.y, bx: b.x, by: b.y, head: true }
  ];
}

/** Center of the battle, for panning the view: the midpoint, or the defender across the wrap-around. */
export function battleFocus({ from, to } = {}) {
  const scene = canvas?.scene;
  if ( !canvas?.ready || !isBoardScene(scene) ) return null;
  const board = boardForScene(scene);
  const a = centerOf(board, from);
  const b = centerOf(board, to);
  if ( !a || !b ) return b ?? a ?? null;
  const width = board?.scene?.width ?? scene.dimensions?.sceneWidth ?? 0;
  if ( width && (Math.abs(b.x - a.x) > width / 2) ) return { ...b, a, b };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, a, b };
}

function draw() {
  const layer = canvas?.rlBoard;
  if ( !state || !canvas?.ready || !layer || layer.destroyed || !isBoardScene(canvas.scene) ) return;
  const { from, to, attacker, label } = state.spec;
  const board = boardForScene(canvas.scene);
  const container = new PIXI.Container();
  container.eventMode = "none";
  container.name = "rlBattleMarker";

  // Attacker: dark under-stroke and the attacker's colour, light fill.
  const atkColor = attacker ? factionColor(attacker) : PAPER;
  const base = container.addChild(new PIXI.Graphics());
  for ( const points of territoryPolygons(from, canvas.scene) ) {
    base.lineStyle(20, INK, 0.7).drawPolygon(points);
    base.lineStyle(11, atkColor, 1).beginFill(atkColor, 0.18).drawPolygon(points).endFill();
    base.lineStyle(4, PAPER, 0.95).drawPolygon(points);
  }
  // Defender: dark under-stroke (static) and the pulsing red layer.
  for ( const points of territoryPolygons(to, canvas.scene) ) {
    base.lineStyle(22, INK, 0.6).drawPolygon(points);
  }
  const pulse = container.addChild(new PIXI.Graphics());
  for ( const points of territoryPolygons(to, canvas.scene) ) {
    pulse.lineStyle(14, RED, 1).beginFill(RED, 0.32).drawPolygon(points).endFill();
  }

  // Arrow(s) from the attacker to the defender.
  const a = centerOf(board, from);
  const b = centerOf(board, to);
  if ( a && b ) {
    const width = board?.scene?.width ?? canvas.scene.dimensions?.sceneWidth ?? 0;
    const arrow = container.addChild(new PIXI.Graphics());
    for ( const seg of arrowSegments(a, b, width) ) drawArrow(arrow, seg);
    if ( label ) {
      const t = handText(label, { size: 56, color: PAPER, font: "Big Shoulders Display", weight: "900" });
      t.style.stroke = INK;
      t.style.strokeThickness = 8;
      t.style.letterSpacing = 3;
      t.anchor.set(0.5, 1);
      t.position.set(b.x, b.y - 70);
      container.addChild(t);
    }
  }
  layer.addChildAt(container, 0);
  state.container = container;
  state.pulse = pulse;
  startTicker();
}

/** A thick marker-red arrow with a dark outline, shortened at both ends so it doesn't cover the pieces' centre. */
function drawArrow(g, { ax, ay, bx, by, head }) {
  const len = Math.hypot(bx - ax, by - ay);
  if ( len < 1 ) return;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const startGap = Math.min(70, len * 0.2);
  const endGap = head ? Math.min(60, len * 0.15) : 0;
  const sx = ax + (ux * startGap);
  const sy = ay + (uy * startGap);
  const ex = bx - (ux * endGap);
  const ey = by - (uy * endGap);
  const headLen = head ? Math.min(90, len * 0.35) : 0;
  const shaftX = ex - (ux * headLen * 0.8);
  const shaftY = ey - (uy * headLen * 0.8);
  // A slight bow, like an arrow drawn in marker
  const nx = -uy;
  const ny = ux;
  const bow = Math.min(80, len * 0.12);
  const cx = ((sx + shaftX) / 2) + (nx * bow);
  const cy = ((sy + shaftY) / 2) + (ny * bow);

  for ( const [w, color, alpha] of [[34, INK, 0.75], [20, RED, 1]] ) {
    g.lineStyle({ width: w, color, alpha, cap: "round", join: "round" });
    g.moveTo(sx, sy).quadraticCurveTo(cx, cy, shaftX, shaftY);
  }
  if ( !head ) return;
  // Head along the curve's end tangent
  let tx = shaftX - cx;
  let ty = shaftY - cy;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const hw = headLen * 0.6;
  const baseX = ex - (tx * headLen);
  const baseY = ey - (ty * headLen);
  const pts = [ex, ey, baseX + (-ty * hw), baseY + (tx * hw), baseX - (-ty * hw), baseY - (tx * hw)];
  g.lineStyle({ width: 10, color: INK, alpha: 0.75, join: "round" }).beginFill(RED, 1).drawPolygon(pts).endFill();
}

/* -------------------------------------------- */
/*  Animation                                   */
/* -------------------------------------------- */

function startTicker() {
  if ( ticking || !canvas?.app?.ticker ) return;
  canvas.app.ticker.add(tick);
  ticking = true;
}

function stopTicker() {
  canvas?.app?.ticker?.remove(tick);
  ticking = false;
}

function tick() {
  if ( !state?.container || state.container.destroyed ) {
    stopTicker();
    return;
  }
  const now = performance.now();
  const phase = (Math.sin(((now - state.started) / PERIOD) * Math.PI * 2) + 1) / 2;   // 0..1
  if ( state.pulse && !state.pulse.destroyed ) state.pulse.alpha = 0.45 + (0.55 * phase);
  if ( state.fadeFrom !== null ) {
    const t = Math.min(1, (now - state.fadeFrom) / FADE);
    state.container.alpha = 1 - t;
    if ( t >= 1 ) {
      destroyContainer();
      state = null;
      stopTicker();
    }
  }
}
