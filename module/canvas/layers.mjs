import { PIECES, SYSTEM_ID } from "../config.mjs";
import { getCampaign, pieceKind, preload } from "../state/_module.mjs";
import {
  boardForScene, centerOf, isBoardScene, layoutOrder, piecesByTerritory, territoryAt, territoryPolygons
} from "./geometry.mjs";
import { drawMarks, handText, stickerSources } from "./marks.mjs";
import { previewMove } from "./movement.mjs";
import { pieceTexture } from "./pieces.mjs";
import * as interaction from "./interaction.mjs";
import { sceneControl } from "./controls.mjs";

/**
 * Canvas layers of the world board.
 *
 *  - `canvas.rlMarks` (RLMarksLayer, primary group): the legacy marks, drawn between the board image and the piece
 *    tokens, so stickers sit *under* the pieces like on the table. This includes the territories added during the
 *    campaign (Alien Island) and the sea lines drawn in pen.
 *  - `canvas.rlBoard` (RLBoardLayer, interface group): what sits *above* the pieces: troop-total badges,
 *    highlights for territory picking and placement, the drag hint while moving pieces, the ghost of a sticker being
 *    placed (pickPoint). It is also the layer of the Risk Legacy scene-control group and receives clicks while
 *    picking.
 *
 * Both draw nothing on scenes other than the world board.
 */

const FONT_NUMBERS = ["Big Shoulders Display", "Roboto Condensed", "Arial Narrow", "sans-serif"];

/** Ensure the board fonts are loaded before PIXI rasterizes text with them. */
async function loadFonts() {
  try {
    await Promise.all([
      document.fonts.load('40px "Gochi Hand"'),
      document.fonts.load('900 40px "Big Shoulders Display"')
    ]);
  } catch(err) { /* fall back silently */ }
}

/* -------------------------------------------- */
/*  Marks (under the pieces)                    */
/* -------------------------------------------- */

export class RLMarksLayer extends foundry.canvas.layers.CanvasLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "rlMarks", zIndex: 0 });
  }

  /** Sorted in the primary group like a scene-level object: above the background, below tiles and tokens. */
  get elevation() {
    return canvas.level?.elevation?.base ?? 0;
  }

  get sortLayer() {
    return 100;
  }

  get sort() {
    return 0;
  }

  /** @type {PIXI.Container|null} */
  content = null;

  #pending = null;

  /** @inheritDoc */
  async _draw(options) {
    await super._draw(options);
    this.content = this.addChild(new PIXI.Container());
    this.content.eventMode = "none";
    if ( !isBoardScene(canvas.scene) ) return;
    // The canvas is drawn before `ready`: wait for the board definitions (drawing nothing if they're missing)
    await preload();
    await loadFonts();
    // Stickers and every faction's piece art, so the first spawned pieces don't wait for their textures
    const pieces = game.actors.filter(a => a.type === "faction")
      .flatMap(a => ["troop", "triple", "hq"].map(kind => pieceTexture(a, kind))).filter(Boolean);
    await foundry.canvas.TextureLoader.loader.load([...stickerSources(), ...pieces], { displayProgress: false });
    await this.redraw();
  }

  /** @inheritDoc */
  async _tearDown(options) {
    this.content = null;
    return super._tearDown(options);
  }

  /**
   * Redraw the marks from the campaign actor (coalesces overlapping requests).
   * @returns {Promise<void>}
   */
  redraw() {
    if ( this.#pending ) return this.#pending;
    this.#pending = (async () => {
      await new Promise(r => setTimeout(r, 30));
      this.#pending = null;
      if ( !this.content || !isBoardScene(canvas.scene) ) return;
      const fresh = new PIXI.Container();
      await drawMarks(fresh, { board: boardForScene(canvas.scene), campaign: getCampaign() });
      if ( !this.content ) {
        fresh.destroy({ children: true });
        return;
      }
      for ( const c of this.content.removeChildren() ) c.destroy({ children: true });
      this.content.addChild(fresh);
    })();
    return this.#pending;
  }
}

/* -------------------------------------------- */
/*  Board interface (above the pieces)          */
/* -------------------------------------------- */

export class RLBoardLayer extends foundry.canvas.layers.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "rlBoard", zIndex: 250 });
  }

  /** @override */
  static prepareSceneControls() {
    return sceneControl();
  }

  /** @type {PIXI.Graphics} */
  highlights;

  /** @type {PIXI.Container} */
  badges;

  /** @type {PIXI.Container} */
  hint;

  /** @type {PIXI.Container} the sticker being placed (pickPoint) */
  ghost;

  /** Territory under the pointer. */
  hovered = null;

  #badgeTimer = null;

  /** @inheritDoc */
  async _draw(options) {
    await super._draw(options);
    this.highlights = this.addChild(new PIXI.Graphics());
    this.badges = this.addChild(new PIXI.Container());
    this.hint = this.addChild(new PIXI.Container());
    this.ghost = this.addChild(new PIXI.Container());
    for ( const c of [this.highlights, this.badges, this.hint, this.ghost] ) c.eventMode = "none";
    // Real pointer moves only (not the moves Foundry emulates while panning)
    canvas.registerMouseMoveHandler(RLBoardLayer.#onMouseMove, foundry.canvas.Canvas.MOUSE_MOVE_HANDLER_PRIORITIES.LOW,
      RLBoardLayer, true);
    if ( !isBoardScene(canvas.scene) ) return;
    // The canvas is drawn before `ready`: wait for the board definitions (drawing nothing if they're missing)
    await preload();
    await loadFonts();
    this.drawBadges();
    this.drawHighlights();
  }

  /** @inheritDoc */
  async _tearDown(options) {
    this.hovered = null;
    this._ghostParts = null;
    interaction.hideTooltip();
    return super._tearDown(options);
  }

  /* -------------------------------------------- */
  /*  Troop badges                                */
  /* -------------------------------------------- */

  /** Schedule a badge redraw (token changes come in bursts). */
  refreshBadges() {
    clearTimeout(this.#badgeTimer);
    this.#badgeTimer = setTimeout(() => this.drawBadges(), 60);
  }

  /** Draw a troop-total badge on every occupied territory. */
  drawBadges() {
    if ( !this.badges || this.badges.destroyed ) return;
    for ( const c of this.badges.removeChildren() ) c.destroy({ children: true });
    if ( !isBoardScene(canvas.scene) ) return;
    if ( !game.settings.get(SYSTEM_ID, "canvas.showCounts") ) return;
    const board = boardForScene(canvas.scene);
    if ( !board ) return;
    for ( const [territory, pieces] of piecesByTerritory(canvas.scene) ) {
      if ( !territory || !board.territories[territory] ) continue;
      const totals = {};
      for ( const p of pieces ) totals[p.faction] = (totals[p.faction] ?? 0) + (PIECES[p.kind]?.value ?? 0);
      const ranked = Object.entries(totals).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      if ( !ranked.length ) continue;
      const [owner, troops] = ranked[0];
      const lead = layoutOrder(pieces.filter(p => p.faction === owner), owner)[0];
      this.badges.addChild(this.#badge(board, lead, owner, troops, ranked.length > 1));
    }
  }

  /**
   * A troop-total disc at the top-right of the owner's lead piece (HQ or first 3-troop piece), so it follows the
   * pieces wherever they stand in the territory.
   */
  #badge(board, lead, factionId, troops, contested) {
    const center = centerOf(lead.doc);
    const radius = (lead.doc._source.width * canvas.grid.size) / 2;
    const color = factionColor(factionId);
    const r = 25;
    const c = new PIXI.Container();
    c.position.set(center.x + (radius * 0.78), center.y - (radius * 0.78));
    const g = c.addChild(new PIXI.Graphics());
    g.beginFill(0x000000, 0.35).drawCircle(2, 3, r + 3).endFill();
    g.lineStyle(4, contested ? 0xb11116 : 0x111213, 1).beginFill(color, 1).drawCircle(0, 0, r).endFill();
    g.lineStyle(2, 0xfbfcfc, 0.9).drawCircle(0, 0, r - 4);
    const [cr, cg, cb] = foundry.utils.Color.from(color).rgb;
    const light = ((0.299 * cr) + (0.587 * cg) + (0.114 * cb)) > 0.6;
    const text = new foundry.canvas.containers.PreciseText(String(troops), new PIXI.TextStyle({
      fontFamily: FONT_NUMBERS, fontWeight: "900", fontSize: troops > 99 ? 26 : 34,
      fill: light ? 0x111213 : 0xfbfcfc, stroke: light ? 0xfbfcfc : 0x111213, strokeThickness: 3, padding: 4
    }));
    text.resolution = 3;
    text.anchor.set(0.5, 0.52);
    c.addChild(text);
    return c;
  }

  /* -------------------------------------------- */
  /*  Highlights (picking / placement)            */
  /* -------------------------------------------- */

  /** Redraw the highlights of the active pick/placement mode. */
  drawHighlights() {
    const g = this.highlights;
    if ( !g || g.destroyed ) return;
    g.clear();
    if ( !isBoardScene(canvas.scene) ) return;
    const draw = (id, color, { alpha = 1, hovered = false } = {}) => {
      for ( const points of territoryPolygons(id, canvas.scene) ) {
        g.lineStyle(hovered ? 14 : 8, hovered ? 0xfbfcfc : color, 0.95 * alpha);
        g.beginFill(color, (hovered ? 0.45 : 0.22) * alpha).drawPolygon(points).endFill();
      }
    };

    // Highlights requested through the API (legal targets…)
    const extra = interaction.extraHighlights();
    if ( extra ) for ( const id of extra.ids ) draw(id, extra.color, { alpha: extra.alpha ?? 1 });

    // The running pick/placement mode: allowed territories, the hovered one brighter
    const mode = interaction.currentMode();
    if ( !mode || (mode.kind === "point") ) return;
    const ids = mode.allowed ?? [];
    for ( const id of ids ) draw(id, mode.color, { hovered: id === this.hovered });
    if ( this.hovered && !mode.allowed ) draw(this.hovered, mode.color, { hovered: true });
  }

  /* -------------------------------------------- */
  /*  Sticker ghost (pickPoint)                   */
  /* -------------------------------------------- */

  /**
   * Show (or move) the ghost of the sticker being placed at a point, outlined by whether the spot is accepted; clear
   * it when no point is being picked.
   * @param {{x: number, y: number}} [point]   default: the pointer
   */
  drawGhost(point = canvas.mousePosition) {
    const ghost = this.ghost;
    if ( !ghost || ghost.destroyed ) return;
    const mode = interaction.currentMode();
    if ( mode?.kind !== "point" ) {
      for ( const c of ghost.removeChildren() ) c.destroy({ children: true });
      this._ghostParts = null;
      return;
    }
    if ( !this._ghostParts || (this._ghostParts.mode !== mode) ) {
      for ( const c of ghost.removeChildren() ) c.destroy({ children: true });
      const ring = new PIXI.Graphics();
      const label = handText("", { size: 40, color: 0xfbfcfc, font: "Big Shoulders Display", weight: "900" });
      label.style.stroke = 0x111213;
      label.style.strokeThickness = 6;
      label.anchor.set(0.5, 0);
      if ( mode.art ) ghost.addChild(mode.art);
      ghost.addChild(ring, label);
      this._ghostParts = { mode, art: mode.art, ring, label, key: null };
    }
    const parts = this._ghostParts;
    const p = { x: Math.round(point?.x ?? 0), y: Math.round(point?.y ?? 0) };
    ghost.position.set(p.x, p.y);
    const verdict = interaction.checkPoint(p);
    const key = `${verdict.ok}|${verdict.reason}`;
    if ( key === parts.key ) return;
    parts.key = key;

    const r = mode.radius || 0;
    const color = verdict.ok ? 0xfcdc07 : 0xc4151c;
    const g = parts.ring.clear();
    if ( r > 0 ) {
      g.lineStyle(10, 0x111213, 0.55).drawCircle(0, 0, r);
      g.lineStyle(6, color, 0.95).beginFill(color, mode.art ? 0.08 : 0.22).drawCircle(0, 0, r).endFill();
    }
    // Centre cross
    g.lineStyle(5, 0x111213, 0.7).moveTo(-16, 0).lineTo(16, 0).moveTo(0, -16).lineTo(0, 16);
    g.lineStyle(3, color, 1).moveTo(-14, 0).lineTo(14, 0).moveTo(0, -14).lineTo(0, 14);
    if ( parts.art ) {
      parts.art.alpha = verdict.ok ? 0.85 : 0.5;
      if ( parts.art.art ) parts.art.art.tint = verdict.ok ? 0xffffff : 0xff8a8a;
    }
    parts.label.text = verdict.ok ? "" : (verdict.reason ? `✕ ${verdict.reason}` : "✕");
    parts.label.position.set(0, Math.max(r, 20) + 14);
  }

  /* -------------------------------------------- */
  /*  Drag hint                                   */
  /* -------------------------------------------- */

  /**
   * While pieces are dragged, outline the territory under the pointer in the colour of what the drop would do.
   * @param {{x: number, y: number}} point
   */
  #drawDragHint(point) {
    const hint = this.hint;
    for ( const c of hint.removeChildren() ) c.destroy({ children: true });
    const dragged = canvas.tokens?._draggedToken;
    const kind = pieceKind(dragged?.document);
    if ( !kind || !dragged.document.isOwner ) return;
    const doc = dragged.document;
    const from = territoryAt(centerOf(doc), canvas.scene);
    const to = territoryAt(point, canvas.scene);
    const contexts = dragged.mouseInteractionManager?.interactionData?.contexts ?? {};
    let troops = 0;
    for ( const ctx of Object.values(contexts) ) {
      const d = ctx.token?.document;
      if ( !d || (d.actorId !== doc.actorId) ) continue;
      if ( territoryAt(centerOf(d), canvas.scene) !== from ) continue;
      troops += PIECES[pieceKind(d)]?.value ?? 0;
    }
    const key = `${doc.actorId}|${from}|${to}|${troops}`;
    if ( key !== this._hintKey ) {
      this._hintKey = key;
      this._hintPreview = previewMove(doc.actorId, from, to, troops);
    }
    const preview = this._hintPreview;
    if ( !to || (preview.type === "rearrange") ) return;
    const COLORS = { expand: 0xfcdc07, maneuver: 0x2f9fd0, advance: 0x2f9fd0, attack: 0xc4151c, free: 0xe0e1e2 };
    const color = preview.allow ? (COLORS[preview.type] ?? 0xe0e1e2) : 0x6d6f71;
    const g = hint.addChild(new PIXI.Graphics());
    for ( const points of territoryPolygons(to, canvas.scene) ) {
      g.lineStyle(10, color, 0.95).beginFill(color, 0.18).drawPolygon(points).endFill();
    }
    const label = interaction.moveLabel(preview);
    if ( label ) {
      const t = handText(label, { size: 44, color: 0xfbfcfc, font: "Big Shoulders Display", weight: "900" });
      t.style.stroke = 0x111213;
      t.style.strokeThickness = 6;
      t.anchor.set(0.5, 1);
      t.position.set(point.x, point.y - 70);
      hint.addChild(t);
    }
  }

  /* -------------------------------------------- */
  /*  Events                                      */
  /* -------------------------------------------- */

  /**
   * Pointer moved over the canvas (registered once; runs whatever layer is active).
   * @this {typeof RLBoardLayer}
   */
  static #onMouseMove() {
    const layer = canvas.rlBoard;
    if ( !layer?.highlights || !isBoardScene(canvas.scene) ) return;
    const point = canvas.mousePosition;
    if ( interaction.currentMode()?.kind === "point" ) {
      layer.drawGhost(point);
      interaction.hideTooltip();
      return;
    }
    const territory = territoryAt(point, canvas.scene);
    if ( canvas.tokens?._draggedToken ) {
      layer.#drawDragHint(point);
      interaction.hideTooltip();
      return;
    }
    if ( layer.hint.children.length ) {
      for ( const c of layer.hint.removeChildren() ) c.destroy({ children: true });
      layer._hintKey = null;
    }
    if ( territory !== layer.hovered ) {
      layer.hovered = territory;
      if ( interaction.currentMode() ) layer.drawHighlights();
    }
    interaction.updateTooltip(territory, point);
  }

  /** @override */
  _onClickLeft(event) {
    const point = event.getLocalPosition(this);
    interaction.handleClick(territoryAt(point, canvas.scene), event, point);
  }

  /** @override */
  _onClickRight() {
    interaction.cancelMode();
  }

  /** @override */
  _deactivate() {
    interaction.onLayerDeactivated();
  }
}

/**
 * A faction's colour as a number.
 * @param {string} factionId
 */
export function factionColor(factionId) {
  const color = game.actors.get(factionId)?.system?.color;
  return Number(color ?? 0x808285);
}
