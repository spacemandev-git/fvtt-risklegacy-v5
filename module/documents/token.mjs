import { SYSTEM_ID } from "../config.mjs";
import { afterMovement, guardMovement } from "../canvas/movement.mjs";
import { boardForScene, isBoardScene, pieceSize } from "../canvas/geometry.mjs";
import { pieceTexture } from "../canvas/pieces.mjs";

/**
 * TokenDocument for Risk Legacy. OWNER: canvas area.
 *
 * Piece tokens (`flags[SYSTEM_ID].piece`) on the world board:
 *  - a faction actor dropped on the board from the sidebar becomes a 1-troop piece,
 *  - user movement (drag, keyboard) is classified and validated as expand / attack / maneuver / rearrange
 *    (module/canvas/movement.mjs).
 */
export default class RLTokenDocument extends foundry.documents.TokenDocument {

  /** @returns {string|null} troop | triple | hq, or null if this token isn't a piece */
  get pieceKind() {
    return this.getFlag(SYSTEM_ID, "piece") ?? null;
  }

  /** @inheritDoc */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if ( allowed === false ) return false;
    const actor = this.actor ?? game.actors.get(this.actorId);
    if ( (actor?.type !== "faction") || !isBoardScene(this.parent) || this.getFlag(SYSTEM_ID, "piece") ) return;

    // A faction dropped onto the board from the sidebar: make it a 1-troop piece
    const board = boardForScene(this.parent);
    const { units } = pieceSize(board, "troop", this.parent.grid.size);
    this.updateSource({
      width: units, height: units, actorLink: true, lockRotation: true, rotation: 0,
      "texture.src": pieceTexture(actor, "troop"),
      displayName: CONST.TOKEN_DISPLAY_MODES.NONE,
      displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
      [`flags.${SYSTEM_ID}.piece`]: "troop"
    });
  }

  /** @inheritDoc */
  async _preUpdateMovement(movement, operation) {
    const allowed = await super._preUpdateMovement(movement, operation);
    if ( allowed === false ) return false;
    try {
      return guardMovement(this, movement, operation);
    } catch(err) {
      console.error(`${SYSTEM_ID} | movement check failed`, err);
      return true;
    }
  }

  /** @inheritDoc */
  _onUpdateMovement(movement, operation, user) {
    super._onUpdateMovement(movement, operation, user);
    try {
      afterMovement(this, movement, user);
    } catch(err) {
      console.error(`${SYSTEM_ID} | movement follow-up failed`, err);
    }
  }
}
