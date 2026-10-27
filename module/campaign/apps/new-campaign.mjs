import { BOARD_VARIANTS, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { today, tpl } from "../common.mjs";
import { createCampaign } from "../create.mjs";
import CampaignWizard from "./wizard.mjs";

/** Fallback thumbnails when a board definition isn't loaded. */
const BOARD_ART = { original: "assets/board/original.webp", advanced: "assets/board/advanced.jpg" };

/**
 * "Begin a Campaign": choose the board, sign the inside of the box lid, and create the world.
 */
export default class NewCampaignWizard extends CampaignWizard {
  static DEFAULT_OPTIONS = {
    id: "rl-new-campaign",
    classes: ["rl-wizard--new"],
    window: { title: "RL.Wizard.New.title", icon: "fa-solid fa-earth-americas" },
    actions: {
      selectBoard: NewCampaignWizard.#onSelectBoard,
      addSignature: NewCampaignWizard.#onAddSignature,
      signAs: NewCampaignWizard.#onSignAs,
      removeSignature: NewCampaignWizard.#onRemoveSignature,
      create: NewCampaignWizard.#onCreate,
      firstGame: NewCampaignWizard.#onFirstGame
    }
  };

  static STEPS = [
    { id: "board", label: "RL.Wizard.New.stepBoard", template: tpl("new/board") },
    { id: "sign", label: "RL.Wizard.New.stepSign", template: tpl("new/sign") },
    { id: "begin", label: "RL.Wizard.New.stepBegin", template: tpl("new/begin") }
  ];

  static PARTS = CampaignWizard.basePARTS(NewCampaignWizard.STEPS.map(s => s.template));

  variant = "original";

  signatures = [];

  date = today();

  result = null;

  async _prepareStep(stepId) {
    switch ( stepId ) {
      case "board": return {
        boards: Object.entries(BOARD_VARIANTS).map(([id, b]) => {
          const def = state.getBoard(id);
          return {
            id, label: game.i18n.localize(b.label), selected: id === this.variant,
            img: systemPath(def?.scene?.background ?? BOARD_ART[id]),
            credits: def?.credits ?? "", ready: !!def,
            continents: def ? Object.keys(def.continents).length : null
          };
        })
      };
      case "sign": {
        const signed = new Set(this.signatures);
        return {
          lid: foundry.utils.getRoute(systemPath("assets/board/board_sign.jpg")),
          signatures: this.signatures.map((name, i) => ({
            name, index: i,
            // Scatter the signatures a little, like a real lid.
            rotate: (((i * 37) % 9) - 4) / 2, offset: ((i * 53) % 24) - 6
          })),
          users: game.users.filter(u => !signed.has(u.name)).map(u => ({ name: u.name, gm: u.isGM })),
          date: this.date
        };
      }
      case "begin": return {
        variantLabel: game.i18n.localize(BOARD_VARIANTS[this.variant].label),
        signatureList: this.signatures.join(", "),
        date: this.date,
        result: this.result,
        boardReady: !!state.getBoard(this.variant),
        exists: !!state.getCampaign()
      };
      default: return {};
    }
  }

  _canAdvance(stepId) {
    if ( stepId === "sign" ) return this.signatures.length > 0;
    return true;
  }

  _canGoBack() {
    return !this.result;
  }

  _footerButtons(stepId) {
    if ( stepId !== "begin" ) return [];
    if ( this.result ) {
      return [{ action: "firstGame", label: "RL.Wizard.First.title", icon: "fa-solid fa-flag-checkered", primary: true }];
    }
    return [{ action: "create", label: "RL.Wizard.New.create", icon: "fa-solid fa-signature", primary: true }];
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const date = this.element.querySelector('input[name="date"]');
    date?.addEventListener("change", () => this.date = date.value);
    const input = this.element.querySelector('input[name="signature"]');
    input?.addEventListener("keydown", event => {
      if ( event.key !== "Enter" ) return;
      event.preventDefault();
      this.#addSignature(input.value);
    });
  }

  #addSignature(name) {
    name = String(name ?? "").trim();
    if ( !name || this.signatures.includes(name) ) return;
    this.signatures.push(name);
    this.render();
  }

  static #onSelectBoard(event, target) {
    this.variant = target.dataset.variant;
    this.render();
  }

  static #onAddSignature() {
    this.#addSignature(this.element.querySelector('input[name="signature"]')?.value);
  }

  static #onSignAs(event, target) {
    this.#addSignature(target.dataset.name);
  }

  static #onRemoveSignature(event, target) {
    this.signatures.splice(Number(target.dataset.index), 1);
    this.render();
  }

  static async #onCreate() {
    if ( !game.user.isGM ) return;
    await this.run(async () => {
      this.note(game.i18n.localize("RL.Wizard.New.creating"));
      this.result = await createCampaign({ variant: this.variant, date: this.date, signatures: this.signatures });
    });
  }

  static async #onFirstGame() {
    const { openFirstGame } = await import("./first-game.mjs");
    await this.close();
    openFirstGame();
  }
}

/** Open the New Campaign wizard (GM). */
export function openNewCampaign() {
  if ( !game.user.isGM ) return ui.notifications.warn("RL.Legacy.Error.gmOnly", { localize: true });
  const app = foundry.applications.instances.get("rl-new-campaign") ?? new NewCampaignWizard();
  return app.render({ force: true });
}
