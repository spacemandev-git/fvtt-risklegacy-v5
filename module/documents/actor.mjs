import { SYSTEM_ID } from "../config.mjs";

/**
 * Actor document class. Thin on purpose: game logic lives in the area services (module/turn, module/cards, …).
 * Owner: integrator. Areas should not add methods here; add helpers in their own modules instead.
 */
export default class RLActor extends foundry.documents.Actor {
  get isFaction() { return this.type === "faction"; }
  get isCampaign() { return this.type === "campaign"; }

  /** Piece tokens of this faction on the given scene (default: the scene they're on, all scenes otherwise). */
  pieceTokens(scene) {
    const scenes = scene ? [scene] : game.scenes.contents;
    return scenes.flatMap(s => s.tokens.filter(t => (t.actorId === this.id) && t.getFlag(SYSTEM_ID, "piece")));
  }
}
