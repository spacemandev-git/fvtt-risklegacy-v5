import * as state from "../../state/_module.mjs";
import { api, territoryGroups, territoryName } from "../common.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Base class for the campaign's one-shot choice windows ("prompts"). A prompt renders a form; submitting resolves
 * `prompt.promise` with the value from `_getResult(formData)` and closes. Closing without submitting resolves null.
 *
 * Shared actions:
 * - `cancel`: resolve null.
 * - `pickOnBoard` (on a button with `data-target="<select name>"`): pick a territory on the canvas with
 *   `board.pickTerritory`, limited to the options of that select, and write it into the select.
 * - `choose` (on an element with `data-name` and `data-value`): set a hidden input and mark the element selected.
 */
export default class CampaignPrompt extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    const data = options.data ?? {};
    super(foundry.utils.mergeObject(options, data.promptId ? { id: `rl-prompt-${data.promptId}` } : {}, { inplace: false }));
    this.data = data;
    this.promise = new Promise(resolve => this.#resolve = resolve);
  }

  #resolve;

  #settled = false;

  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-campaign", "rl-prompt"],
    tag: "form",
    window: { resizable: true, minimizable: true },
    position: { width: 560, height: "auto", left: 130, top: 80 },
    form: { handler: CampaignPrompt.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      cancel: CampaignPrompt.#onCancel,
      pickOnBoard: CampaignPrompt.#onPickOnBoard,
      choose: CampaignPrompt.#onChoose
    }
  };

  /**
   * Open a prompt and wait for the answer.
   * @param {object} data
   * @param {object} [options]  application options
   * @returns {Promise<*>}
   */
  static async ask(data = {}, options = {}) {
    const app = new this({ ...options, data });
    await app.render({ force: true });
    app.bringToFront();
    return app.promise;
  }

  /** @override */
  get title() {
    return this.data.title ?? game.i18n.localize(this.options.window.title || "RL.SystemTitle");
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return Object.assign(context, {
      data: this.data,
      hotSeat: this.data.hotSeat && this.data.forUserName,
      forUserName: this.data.forUserName ?? ""
    });
  }

  /** Resolve the prompt and close. */
  finish(value) {
    if ( this.#settled ) return;
    this.#settled = true;
    this.#resolve(value);
    this.close();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( !this.#settled ) {
      this.#settled = true;
      this.#resolve(null);
    }
  }

  /**
   * Turn the submitted form into the answer. Return `undefined` to keep the prompt open (invalid input).
   * @param {object} data  formData.object
   * @returns {*}
   * @protected
   */
  _getResult(data) {
    return data;
  }

  /** Show a validation message and keep the prompt open. */
  _invalid(key, data) {
    ui.notifications.warn(game.i18n.format(key, data ?? {}));
    return undefined;
  }

  static async #onSubmit(event, form, formData) {
    const value = await this._getResult(foundry.utils.expandObject(formData.object), event);
    if ( value === undefined ) return;
    this.finish(value);
  }

  static #onCancel() {
    this.finish(null);
  }

  /** Mark a card/option chosen (radio-like selection on any element). */
  static #onChoose(event, target) {
    const name = target.dataset.name;
    const input = this.element.querySelector(`input[type="hidden"][name="${name}"]`);
    if ( !input || target.classList.contains("is-disabled") ) return;
    input.value = target.dataset.value;
    for ( const el of this.element.querySelectorAll(`[data-action="choose"][data-name="${name}"]`) ) {
      el.classList.toggle("is-selected", el === target);
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    this._onChoose?.(name, target.dataset.value, target);
  }

  /** Pick a territory on the board for the select named by data-target. */
  static async #onPickOnBoard(event, target) {
    const select = this.element.querySelector(`select[name="${target.dataset.target}"]`);
    const allowed = [...(select?.options ?? [])].map(o => o.value).filter(Boolean);
    const territory = await pickTerritory({ allowed, prompt: this.title, app: this });
    if ( territory && select ) {
      select.value = territory;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      this._onPicked?.(territory, select);
    }
  }
}

/**
 * Pick a territory on the canvas (canvas area's `board.pickTerritory`), viewing the board scene first.
 * @param {object} options
 * @param {string[]} options.allowed
 * @param {string} [options.prompt]
 * @param {string} [options.faction]
 * @param {ApplicationV2} [options.app]  minimized while picking
 * @returns {Promise<string|null>}
 */
export async function pickTerritory({ allowed, prompt, faction, app } = {}) {
  const fn = api("board", "pickTerritory");
  if ( !fn ) {
    ui.notifications.warn("RL.Wizard.Ask.noBoardPick", { localize: true });
    return null;
  }
  const scene = state.getBoardScene();
  if ( scene && (canvas.scene?.id !== scene.id) ) await scene.view();
  if ( app?.rendered ) await app.minimize();
  // Clear the board: tuck away any open campaign wizard while the player clicks a territory.
  const wizards = [...foundry.applications.instances.values()]
    .filter(a => a.rendered && !a.minimized && a.element?.classList.contains("rl-wizard"));
  for ( const w of wizards ) await w.minimize();
  try {
    const territory = await fn({ prompt, allowed, faction });
    if ( territory && allowed?.length && !allowed.includes(territory) ) {
      ui.notifications.warn(game.i18n.format("RL.Wizard.Ask.notAllowed", { territory: territoryName(territory) }));
      return null;
    }
    return territory ?? null;
  } finally {
    for ( const w of wizards ) if ( w.rendered ) await w.maximize();
    if ( app?.rendered ) await app.maximize();
  }
}

/** Template context for a grouped territory <select>. */
export function territoryOptions(allowed, selected) {
  return territoryGroups({ only: allowed }).map(g => ({
    ...g, territories: g.territories.map(t => ({ ...t, selected: t.id === selected }))
  }));
}
