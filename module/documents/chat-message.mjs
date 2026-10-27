import { renderBattleMessage } from "../battle/card.mjs";

/**
 * ChatMessage document class. OWNER: battle area (module/battle/).
 *
 * Battle messages (type "battle") render their card from `system` data per user, so each client only shows the
 * controls it may use (missiles, resolve, move in…). Core re-renders a message on every update, which keeps the card
 * live for everyone. Other messages render as core does.
 */
export default class RLChatMessage extends foundry.documents.ChatMessage {
  /** @override */
  async renderHTML(options = {}) {
    if ( this.type === "battle" ) return renderBattleMessage(this, options);
    return super.renderHTML(options);
  }

  /** The battle data of a battle message (null otherwise). */
  get battle() {
    return this.type === "battle" ? this.system : null;
  }
}
