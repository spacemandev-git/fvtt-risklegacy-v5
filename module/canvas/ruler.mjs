import { pieceKind } from "../state/_module.mjs";

/**
 * Token ruler for the world board: piece tokens show their drag path but no distance labels (distances mean nothing
 * on the Risk board; the board layer's drag hint says what the drop will do instead). Other tokens keep core labels.
 */
export class RLTokenRuler extends foundry.canvas.placeables.tokens.TokenRuler {
  /** @inheritDoc */
  _getWaypointLabelContext(waypoint, state) {
    if ( pieceKind(this.token?.document) ) return null;
    return super._getWaypointLabelContext(waypoint, state);
  }
}
