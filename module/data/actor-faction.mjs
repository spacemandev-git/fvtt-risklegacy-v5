import { FACTION_STATUS, GAME_RESULTS } from "../config.mjs";

const {
  SchemaField, StringField, NumberField, BooleanField, ArrayField, ColorField, FilePathField, HTMLField
} = foundry.data.fields;

const int = (initial = 0, extra = {}) => new NumberField({ required: true, nullable: false, integer: true, min: 0, initial, ...extra });

/**
 * A Faction card (Actor type "faction").
 *
 * - Front of the card: `actor.img` (art), name plate (`actor.name`), the colour, and the power stickers, which are
 *   embedded Items of type "power" (one per slot, see POWER_SLOTS).
 * - Back of the card: `history`, one row per game (game #, player, starting territory, result).
 * - `war`: per-game state, reset by the game setup wizard at the start of each war.
 *
 * Board-dependent numbers (territories held, population, HQs, red star total) are not stored here. They are derived
 * from the board snapshot (module/state/snapshot.mjs), because they depend on token positions.
 *
 * Every piece token on the board is a *linked* token of its faction actor; `token.flags[SYSTEM_ID].piece` says which
 * piece it is (troop | triple | hq).
 */
export default class FactionData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["RL.Faction.Data"];

  static defineSchema() {
    return {
      /** Catalog id of the faction (balkania, enclave, khan, mechaniker, saharan, mutants…). */
      key: new StringField({ required: true, blank: false, initial: "balkania" }),
      /** Pack that introduced the faction. */
      pack: new StringField({ required: true, blank: false, initial: "base" }),
      color: new ColorField({ required: true, nullable: false, initial: "#808285" }),
      /** Piece token images. */
      pieces: new SchemaField({
        troop: new FilePathField({ categories: ["IMAGE"] }),
        triple: new FilePathField({ categories: ["IMAGE"] }),
        hq: new FilePathField({ categories: ["IMAGE"] })
      }),
      /** Back of the faction card: one row per game played in this world. */
      history: new ArrayField(new SchemaField({
        game: int(1, { min: 1 }),
        player: new StringField({ required: true, blank: true }),
        startingTerritory: new StringField({ required: true, blank: true }),
        result: new StringField({ required: true, blank: true, choices: { "": "", ...GAME_RESULTS } })
      })),
      /** Per-game state (reset at the start of every war). */
      war: new SchemaField({
        /** Taking part in the current war. */
        active: new BooleanField(),
        /** The User playing this faction this game, and their display name at the time. */
        playerId: new StringField({ required: true, blank: true }),
        playerName: new StringField({ required: true, blank: true }),
        /** 0-based seat in turn order (clockwise). */
        seat: int(0),
        /** Red Star tokens in front of the player (never change hands). */
        redStarTokens: int(0),
        /** Missile tokens still available this game. */
        missiles: int(0),
        /** Recruited/joined troops not yet placed on the board. */
        reserve: int(0),
        /** Territory where the faction's HQ was placed at the start of the game (the "starting HQ"). */
        startingTerritory: new StringField({ required: true, blank: true }),
        status: new StringField({ required: true, blank: false, initial: "playing", choices: FACTION_STATUS }),
        /** Faction ids this faction has knocked out this game (for "root against" flavour and missions). */
        knockedOut: new ArrayField(new StringField())
      }),
      notes: new HTMLField()
    };
  }

  /** Wins recorded on the back of this card. */
  get wins() {
    return this.history.filter(h => h.result === "won").length;
  }

  /**
   * The back of the card, summed up.
   * @returns {{won: number, heldOn: number, eliminated: number, played: number}}
   */
  get record() {
    const count = r => this.history.filter(h => h.result === r).length;
    return {
      won: count("won"), heldOn: count("heldOn"), eliminated: count("eliminated"),
      played: this.history.filter(h => h.result && (h.result !== "absent")).length
    };
  }
}
