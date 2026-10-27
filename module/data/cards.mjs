import { MAX_CARD_VALUE } from "../config.mjs";

const { StringField, NumberField, ObjectField } = foundry.data.fields;

/**
 * Card sub-types (Card documents inside Cards stacks; see CARD_STACKS in config.mjs).
 *
 * Image faces use the core Card fields: `faces[]` (+ `face` index) and `back`. Territory cards have six faces, one per
 * resource value 1..6 for the campaign's board variant, so `face = value - 1`. Upgrading a card updates `system.value`
 * AND `face` on the card in its home deck (the copy in a hand/pile too, if drawn); see module/cards/.
 */
class BaseCardData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      /** Content catalog id. */
      catalogId: new StringField({ required: true, blank: true }),
      /** Pack that introduced the card. */
      pack: new StringField({ required: true, blank: false, initial: "base" }),
      /** Transcribed card text. */
      text: new StringField({ required: true, blank: true })
    };
  }

  /** Resources (coins) on the card; only territory and coin cards have any. */
  get coins() { return 0; }

  /** Territory and Coin cards are resource cards. */
  get isResource() { return false; }
}

/** A Territory card: a resource card with 1..6 coins naming a territory. */
export class TerritoryCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.territory"];
  static defineSchema() {
    return {
      ...super.defineSchema(),
      territory: new StringField({ required: true, blank: false, initial: "alaska" }),
      continent: new StringField({ required: true, blank: true }),
      value: new NumberField({ required: true, nullable: false, integer: true, min: 1, max: MAX_CARD_VALUE, initial: 1 }),
      /** Slot 1..4 while the card is face up in the sideboard row pile (0 elsewhere). */
      slot: new NumberField({ required: true, nullable: false, integer: true, min: 0, max: 4, initial: 0 })
    };
  }
  /** Resource (coin) count used for trades. */
  get coins() { return this.value; }

  get isResource() { return true; }
}

/** A Coin card: a resource card worth exactly 1 coin, never upgraded. */
export class CoinCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.coin"];
  get coins() { return 1; }

  get isResource() { return true; }
}

/** A Scar card: deal one per player before a game; play it to put its scar sticker on a territory (or faction). */
export class ScarCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.scar"];
  static defineSchema() {
    return {
      ...super.defineSchema(),
      /** Scar id (bunker, ammo_shortage, …). */
      scar: new StringField({ required: true, blank: false, initial: "bunker" }),
      /** What the sticker goes on. */
      target: new StringField({ required: true, blank: false, initial: "territory", choices: ["territory", "faction"] }),
      /** Sticker image (the round scar mark). */
      stickerImg: new StringField({ required: true, blank: true }),
      /** Structured effect from the catalog (see data/content/README.md), or null. */
      effect: new ObjectField({ nullable: true, initial: null })
    };
  }
}

/** A Mission card: face up on the sideboard; complete it at the end of your turn for 1 or 2 Red Stars. */
export class MissionCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.mission"];
  static defineSchema() {
    return {
      ...super.defineSchema(),
      reward: new NumberField({ required: true, nullable: false, integer: true, min: 0, max: 4, initial: 1 }),
      /** Structured completion check from the catalog, or null (manual). */
      check: new ObjectField({ nullable: true, initial: null })
    };
  }
}

/** An Event card: drawn when the new slot-1 territory card has an even value. */
export class EventCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.event"];
  static defineSchema() {
    return {
      ...super.defineSchema(),
      /** Where the card goes after resolving: box | keep | player | deck | other */
      afterResolve: new StringField({ required: true, blank: true }),
      effect: new ObjectField({ nullable: true, initial: null })
    };
  }
}

/** A draft card (Minor Cities pack): drafted at setup to decide placement order, turn order, coins, troops… */
export class DraftCardData extends BaseCardData {
  static LOCALIZATION_PREFIXES = ["RL.Card.draft"];
  static defineSchema() {
    return {
      ...super.defineSchema(),
      draftType: new StringField({ required: true, blank: true }),
      /** Minimum player count this card is used with. */
      players: new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
      value: new NumberField({ required: true, nullable: false, integer: true, initial: 0 })
    };
  }
}
