import { CARD_STACKS } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { TEMPLATES, loc } from "../util.mjs";
import { cardView } from "../views.mjs";
import { attachZoom } from "./zoom.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Face-up piles anyone may look through. */
const BROWSABLE = new Set(["discard", "eventDiscard", "row", "missionSlot", "coinDeck"]);

/**
 * Browse a face-up pile (DISCARD, events in play). The GM gets "after resolving" controls for pending events.
 */
export default class PileApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-pile-app"],
    window: { icon: "fa-solid fa-layer-group", resizable: true },
    position: { width: 620, height: "auto" },
    actions: { resolve: PileApp.#onResolve }
  };

  static PARTS = {
    pile: { template: `${TEMPLATES}/pile.hbs`, scrollable: [".rl-pile__cards"] }
  };

  /** @override */
  get title() {
    return loc(CARD_STACKS[this.options.role]?.label ?? "RL.Sideboard.title");
  }

  #hooks = [];

  #refresh = foundry.utils.debounce(() => this.rendered && this.render(), 60);

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const stack = state.getCardStack(this.options.role);
    const cards = (stack?.cards.contents ?? []).sort((a, b) => b.sort - a.sort);
    context.cards = cards.map(c => cardView(c));
    context.isGM = game.user.isGM;
    context.isEvents = this.options.role === "eventDiscard";
    context.empty = !cards.length;
    return context;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    for ( const name of ["createCard", "updateCard", "deleteCard"] ) this.#hooks.push([name, Hooks.on(name, () => this.#refresh())]);
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    for ( const [name, id] of this.#hooks ) Hooks.off(name, id);
    this.#hooks = [];
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    attachZoom(this.element.querySelector(".rl-pile"));
  }

  static async #onResolve(event, target) {
    const cardId = target.closest("[data-card-id]")?.dataset.cardId;
    try {
      await game.risklegacy.cards.resolveEvent({ cardId, outcome: target.dataset.outcome });
    } catch(err) {
      ui.notifications.error(err.message);
    }
  }

  /** Open the viewer for a pile role. */
  static open(role) {
    if ( !BROWSABLE.has(role) ) return null;
    const id = `rl-pile-${role}`;
    const app = foundry.applications.instances.get(id) ?? new this({ id, role });
    return app.render({ force: true });
  }
}

