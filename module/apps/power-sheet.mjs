import { FACTIONS, PACKS, POWER_SLOTS } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { powerIcon, slotLabel, t, tpl } from "./helpers.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/** When a power applies (PowerData.timing vocabulary). */
const TIMINGS = ["", "startOfTurn", "recruit", "attack", "defend", "maneuver", "endOfTurn", "drawCard", "passive", "anytime"];

/**
 * A faction-card sticker (Item type "power"), shown as the coloured sticker on its power card. GMs see the fields
 * under the card; everyone else sees only the sticker.
 */
export default class PowerSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-ui-sheet", "rl-power-sheet"],
    position: { width: 400, height: "auto" },
    window: { resizable: false, icon: "fa-solid fa-note-sticky" },
    form: { submitOnChange: true }
  };

  static PARTS = {
    sticker: { template: tpl("apps/power-sheet.hbs") }
  };

  /** @override */
  get title() {
    return this.document.name;
  }

  /** @inheritDoc */
  _initializeApplicationOptions(options) {
    options = super._initializeApplicationOptions(options);
    const slot = options.document?.system?.slot;
    if ( slot ) options.classes.push(`rl-power--${slot}`);
    return options;
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.document;
    const system = item.system;
    const owner = item.parent;
    const printedFor = system.faction
      ? (state.getFactionByKey(system.faction)?.name ?? (FACTIONS[system.faction] ? t(FACTIONS[system.faction].label) : system.faction))
      : "";
    Object.assign(context, {
      item, system,
      systemFields: system.schema.fields,
      canEdit: this.isEditable && game.user.isGM,
      icon: powerIcon(item),
      slotLabel: slotLabel(system.slot),
      printedFor,
      placedOn: owner?.type === "faction" ? owner.name : "",
      packLabel: PACKS[system.pack] ? t(PACKS[system.pack].label) : system.pack,
      slotChoices: Object.fromEntries(Object.entries(POWER_SLOTS).map(([k, v]) => [k, v.label])),
      timingChoices: Object.fromEntries(TIMINGS.map(k => [k, k ? `RL.Sheet.Power.Timing.${k}` : "—"])),
      factionChoices: { "": "—", ...Object.fromEntries(Object.entries(FACTIONS).map(([k, v]) => [k, v.label])) },
      packChoices: Object.fromEntries(Object.entries(PACKS).map(([k, v]) => [k, v.label]))
    });
    return context;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    // Keep the colour class in sync when the slot changes
    for ( const slot of Object.keys(POWER_SLOTS) ) this.element.classList.toggle(`rl-power--${slot}`, slot === this.document.system.slot);
  }
}
