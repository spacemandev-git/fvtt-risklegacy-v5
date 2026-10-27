import { SYSTEM_ID } from "../config.mjs";

/**
 * Cards and Card document classes. OWNER: cards area (module/cards/).
 * Card stacks carry `flags[SYSTEM_ID].role` (a CARD_STACKS key or "hand") and, for hands, `flags[SYSTEM_ID].faction`.
 */
export class RLCards extends foundry.documents.Cards {
  /** CARD_STACKS role of this stack ("hand" for faction hands), or null. */
  get role() {
    return this.flags?.[SYSTEM_ID]?.role ?? null;
  }

  /** Faction actor id of a hand, or null. */
  get factionId() {
    return this.flags?.[SYSTEM_ID]?.faction ?? null;
  }

  /** Resource cards (territory + coin) in this stack that are available (not drawn). */
  get resourceCards() {
    return this.availableCards.filter(c => c.isResource);
  }
}

export class RLCard extends foundry.documents.Card {
  /** Territory or Coin card. */
  get isResource() {
    return (this.type === "territory") || (this.type === "coin");
  }

  /** Resources (coins) printed on the card: territory value, 1 for a Coin card, 0 otherwise. */
  get coins() {
    return this.system?.coins ?? 0;
  }

  /** Content catalog id. */
  get catalogId() {
    return this.system?.catalogId ?? "";
  }
}
