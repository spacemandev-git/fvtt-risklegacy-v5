import { systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { packLabel, tpl } from "../common.mjs";
import CampaignPrompt from "./prompt-base.mjs";

/**
 * "OPEN WHEN …": the sealed-package prompt, wrapped in hazard tape. On the GM it asks whether to open the package
 * now (resolves true/false); on players' screens it is a notice that closes itself once the package is opened.
 */
export default class PackPromptApp extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-pack-prompt", "rl-hazard-header"],
    position: { width: 560 },
    window: { title: "RL.Legacy.Pack.title", icon: "fa-solid fa-box-archive" },
    actions: { openNow: PackPromptApp.#onOpen }
  };

  static PARTS = { body: { template: tpl("pack-prompt") } };

  #hook = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const pack = state.getPack(this.data.packId);
    const campaign = state.getCampaign();
    return Object.assign(context, {
      gm: this.data.gm && game.user.isGM,
      label: packLabel(this.data.packId),
      kind: game.i18n.localize(pack?.kind === "pocket" ? "RL.Legacy.Pack.pocket" : "RL.Legacy.Pack.package"),
      sealed: pack?.trigger?.sealedText ?? pack?.trigger?.text ?? "",
      rulebook: pack?.trigger?.rulebook ?? "",
      reason: this.data.reason ?? "",
      opened: !!campaign?.system.isPackOpen(this.data.packId),
      tape: systemPath("styles/assets/svg/hazard-stripes.svg")
    });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hook = Hooks.on("updateActor", actor => {
      if ( (actor.type !== "campaign") || !actor.system.isPackOpen(this.data.packId) ) return;
      this.render();
      if ( !this.data.gm ) setTimeout(() => this.close(), 4000);
    });
  }

  _onClose(options) {
    if ( this.#hook !== null ) Hooks.off("updateActor", this.#hook);
    super._onClose(options);
  }

  static #onOpen() {
    this.finish(true);
  }

  _getResult() {
    return true;
  }
}
