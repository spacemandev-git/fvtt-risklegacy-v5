import { SYSTEM_ID } from "../../config.mjs";
import { onPendingChange, overrideAsk, pendingPrompts } from "../ask.mjs";
import { tpl } from "../common.mjs";
import { PARTIALS } from "./prompts.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Base class for the campaign wizards: a stepper of red numbered discs, one body per step (a Handlebars partial
 * picked by the step's `template`), and a footer with Back / Next and the step's own buttons.
 *
 * Subclasses define `static STEPS = [{id, label, template, when?}]` and `static PARTS` (with every step template in
 * the body part's `templates` so they are registered as partials), and implement `_prepareStep(stepId, context)`,
 * `_canAdvance(stepId)` and optionally `_footerButtons(stepId, context)`.
 */
export default class CampaignWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-campaign", "rl-wizard"],
    tag: "div",
    window: { resizable: true, minimizable: true },
    // Off-centre (left, under the scene controls) so the middle of the board stays free for pieces.
    position: { width: 920, height: 740, left: 110, top: 60 },
    actions: {
      next: CampaignWizard.#onNext,
      back: CampaignWizard.#onBack,
      goto: CampaignWizard.#onGoto,
      takeOver: CampaignWizard.#onTakeOver
    }
  };

  /** Shared parts; subclasses spread these and add their step templates to `body.templates`. */
  static basePARTS(stepTemplates = []) {
    return {
      steps: { template: tpl("wizard/steps") },
      body: { template: tpl("wizard/body"), templates: [...stepTemplates, ...PARTIALS], scrollable: [".rl-wizard-scroll"] },
      footer: { template: tpl("wizard/footer") }
    };
  }

  /** @type {{id: string, label: string, template: string, when?: Function}[]} */
  static STEPS = [];

  /** Index into the visible steps. */
  stepIndex = 0;

  /** A long-running operation is in progress (buttons disabled). */
  busy = false;

  /** Progress lines shown while busy. */
  progress = [];

  #unsubscribe = null;

  /** The step shown by the last render: a different step starts scrolled to the top. */
  #shownStep = null;

  /** @returns {object[]} the visible steps */
  get steps() {
    return this.constructor.STEPS.filter(s => !s.when || s.when.call(this));
  }

  /** @returns {object} the current step */
  get currentStep() {
    const steps = this.steps;
    this.stepIndex = Math.clamp(this.stepIndex, 0, Math.max(steps.length - 1, 0));
    return steps[this.stepIndex];
  }

  /** Go to a step by id. */
  goTo(stepId) {
    const index = this.steps.findIndex(s => s.id === stepId);
    if ( index >= 0 ) this.stepIndex = index;
    return this.render();
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const steps = this.steps;
    const current = this.currentStep;
    context.stepList = steps.map((s, i) => ({
      id: s.id, n: i + 1, label: game.i18n.localize(s.label),
      current: i === this.stepIndex, done: i < this.stepIndex
    }));
    context.step = current;
    context.stepTemplate = current?.template;
    context.busy = this.busy;
    context.progress = this.progress;
    context.waiting = pendingPrompts();
    context.isGM = game.user.isGM;
    Object.assign(context, await this._prepareStep(current?.id, context));
    const canAdvance = this._canAdvance(current?.id, context);
    context.footer = {
      back: (this.stepIndex > 0) && !this.busy && this._canGoBack(current?.id, context),
      next: (this.stepIndex < steps.length - 1) ? {
        label: game.i18n.localize("RL.Wizard.next"), disabled: this.busy || !canAdvance
      } : null,
      buttons: (this._footerButtons(current?.id, context) ?? []).map(b => ({
        ...b, label: game.i18n.localize(b.label), disabled: b.disabled || this.busy
      }))
    };
    return context;
  }

  /**
   * Step-specific context.
   * @param {string} stepId
   * @param {object} context
   * @returns {Promise<object>|object}
   * @protected
   */
  async _prepareStep(stepId, context) {
    return {};
  }

  /** May the user leave this step with Next? */
  _canAdvance(stepId, context) {
    return true;
  }

  /** May the user go back from this step? */
  _canGoBack(stepId, context) {
    return true;
  }

  /**
   * Extra footer buttons: [{action, label, icon, primary, destroy, disabled}].
   * @protected
   */
  _footerButtons(stepId, context) {
    return [];
  }

  /**
   * Run a long operation with the wizard locked and errors reported.
   * @param {Function} fn
   * @returns {Promise<*>}
   */
  async run(fn) {
    if ( this.busy ) return undefined;
    this.busy = true;
    this.progress = [];
    await this.render();
    try {
      return await fn();
    } catch(err) {
      console.error(`${SYSTEM_ID} | campaign wizard`, err);
      ui.notifications.error(err.message);
      return undefined;
    } finally {
      this.busy = false;
      if ( this.rendered ) await this.render();
    }
  }

  /** Add a progress line (shown while busy). */
  note(text) {
    this.progress.push(text);
    if ( this.rendered ) this.render();
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#unsubscribe = onPendingChange(() => this.rendered && this.render());
  }

  /** @override */
  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    // Keep the scroll position when the same step re-renders, not when moving to another step.
    if ( (partId === "body") && (this.#shownStep !== this.currentStep?.id) ) state.scrollPositions = [];
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#shownStep = this.currentStep?.id ?? null;
  }

  /** @override */
  _onClose(options) {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    super._onClose(options);
  }

  static async #onNext() {
    const current = this.currentStep;
    if ( this.busy || !this._canAdvance(current?.id, {}) ) return;
    await this._onLeaveStep?.(current?.id);
    this.stepIndex += 1;
    this.render();
  }

  static #onBack() {
    if ( this.busy ) return;
    this.stepIndex = Math.max(0, this.stepIndex - 1);
    this.render();
  }

  static #onGoto(event, target) {
    if ( this.busy ) return;
    const index = Number(target.dataset.index);
    if ( index < this.stepIndex ) {
      this.stepIndex = index;
      this.render();
    }
  }

  static #onTakeOver(event, target) {
    overrideAsk(target.dataset.prompt);
  }
}
