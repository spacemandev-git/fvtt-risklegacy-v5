import { POWER_SLOTS } from "../config.mjs";

const { StringField, BooleanField } = foundry.data.fields;

/**
 * A faction-card sticker (Item type "power"): starting powers, mission/weakness/missile/knockout powers, and
 * faction scars (white slot). Embedded on a faction actor = the sticker is on that faction card. A world-level power
 * item is an unplaced sticker (e.g. the First Game Power choices, or a pack's powers waiting to be assigned).
 */
export default class PowerData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["RL.Power.Data"];

  static defineSchema() {
    return {
      /** Faction-card slot (colour) this sticker goes in. */
      slot: new StringField({ required: true, blank: false, initial: "starter", choices: Object.keys(POWER_SLOTS) }),
      /** The printed text. */
      text: new StringField({ required: true, blank: true }),
      /** Faction key this sticker was printed for (khan_1 → "khan"), or "" for generic stickers. */
      faction: new StringField({ required: true, blank: true }),
      /** Pack that introduced it. */
      pack: new StringField({ required: true, blank: false, initial: "base" }),
      /** Content catalog id; also the automation key the rules engine switches on (e.g. "khan_1"). */
      key: new StringField({ required: true, blank: true }),
      /** When the power applies: startOfTurn | recruit | attack | defend | maneuver | endOfTurn | drawCard | passive | anytime */
      timing: new StringField({ required: true, blank: true }),
      /** One-shot powers that have been used this game (reset by game setup). */
      used: new BooleanField()
    };
  }
}
