import { BOARD_VARIANTS, LEGACY_GAMES, PACKS, SYSTEM_ID, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { tpl } from "../common.mjs";
import { openPack, packInfo } from "../packs.mjs";
import { buildRulebook, openRulebook } from "../rulebook.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The campaign landing page (GM): "Begin a Campaign" when the world is empty; otherwise the state of the world and
 * the next thing to do (before your first game, set up the next game, finish the end of a game), the rulebook,
 * and the sealed packages.
 */
export default class CampaignLanding extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-campaign-landing",
    classes: ["risklegacy", "rl-campaign", "rl-camp-landing"],
    window: { title: "RL.Wizard.Landing.title", icon: "fa-solid fa-earth-americas", resizable: true },
    position: { width: 640, height: "auto", left: 110, top: 60 },
    actions: {
      begin: CampaignLanding.#onBegin,
      firstGame: CampaignLanding.#onFirstGame,
      setup: CampaignLanding.#onSetup,
      endGame: CampaignLanding.#onEndGame,
      rulebook: CampaignLanding.#onRulebook,
      rebuildRulebook: CampaignLanding.#onRebuildRulebook,
      openPack: CampaignLanding.#onOpenPack,
      campaignSheet: CampaignLanding.#onCampaignSheet,
      stickerSheet: CampaignLanding.#onStickerSheet
    }
  };

  static PARTS = { body: { template: tpl("landing"), scrollable: [""] } };

  #hook = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const campaign = state.getCampaign();
    const war = state.getWar();
    const endGame = campaign?.getFlag(SYSTEM_ID, "endGame");
    const setup = campaign?.getFlag(SYSTEM_ID, "setup");
    const c = campaign?.system;
    Object.assign(context, {
      isGM: game.user.isGM,
      campaign: !!campaign,
      hero: systemPath("assets/board/board_sign.jpg"),
      boardArt: systemPath(state.getCampaignBoard()?.scene?.background ?? "assets/board/original.webp")
    });
    if ( !campaign ) return context;
    const endPending = !!endGame && !endGame.finished;
    const warStage = war?.system.stage ?? "";
    Object.assign(context, {
      worldName: c.worldName,
      board: game.i18n.localize(BOARD_VARIANTS[c.boardVariant]?.label ?? c.boardVariant),
      founded: c.founding.date, signatures: c.founding.signatures.join(", "),
      gamesPlayed: c.gamesPlayed, legacyLeft: Math.max(0, LEGACY_GAMES - c.gamesPlayed),
      nextGame: c.nextGameNumber,
      victors: c.victors.slice(-3).reverse().map(g => ({ number: g.number, player: g.winner.player, faction: g.winner.factionName, motto: g.winner.motto })),
      firstGameReady: c.firstGameReady,
      warInProgress: !!war && (warStage !== "ended"),
      warStage: warStage ? game.i18n.localize(`RL.Stage.${warStage}`) : "",
      warGame: war?.system.game ?? null,
      setupPending: !!setup && (setup.game === c.nextGameNumber) && !setup.finished,
      endPending: endPending || (warStage === "ended"),
      packs: Object.keys(PACKS).filter(id => id !== "base").map(id => {
        const info = packInfo(id);
        const p = c.packs?.[id];
        return { ...info, openedGame: p?.game ?? 0 };
      }),
      rulebook: !!state.getCampaignDocument("rulebook"),
      log: c.log.slice(-6).reverse()
    });
    // The next thing to do
    if ( context.endPending ) context.next = "endGame";
    else if ( !c.firstGameReady ) context.next = "firstGame";
    else if ( !context.warInProgress ) context.next = "setup";
    return context;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hook = Hooks.on("updateActor", actor => {
      if ( actor.type === "campaign" ) this.render();
    });
  }

  _onClose(options) {
    if ( this.#hook !== null ) Hooks.off("updateActor", this.#hook);
    super._onClose(options);
  }

  static async #onBegin() {
    const { openNewCampaign } = await import("./new-campaign.mjs");
    this.close();
    openNewCampaign();
  }

  static async #onFirstGame() {
    const { openFirstGame } = await import("./first-game.mjs");
    this.close();
    openFirstGame();
  }

  static async #onSetup() {
    const { openGameSetup } = await import("./game-setup.mjs");
    this.close();
    openGameSetup();
  }

  static async #onEndGame() {
    const { openEndGame } = await import("./end-game.mjs");
    this.close();
    openEndGame();
  }

  static #onRulebook() {
    this.close();
    openRulebook();
  }

  static async #onRebuildRulebook() {
    const ok = await DialogV2.confirm({
      window: { title: "RL.Rulebook.rebuild" },
      content: `<p>${game.i18n.localize("RL.Rulebook.rebuildConfirm")}</p>`,
      classes: ["risklegacy"]
    });
    if ( !ok ) return;
    await buildRulebook({ rebuild: true });
    this.render();
  }

  static async #onOpenPack(event, target) {
    const packId = target.dataset.pack;
    const info = packInfo(packId);
    const ok = await DialogV2.confirm({
      window: { title: info.label },
      content: `<div class="rl-callout">${game.i18n.format("RL.Legacy.Pack.manualConfirm", { pack: info.label })}</div>
        <p class="rl-hand rl-hand--red">${game.i18n.localize("RL.Legacy.Pack.justDont")}</p>`,
      classes: ["risklegacy", "rl-hazard-header"]
    });
    if ( !ok ) return;
    this.close();
    await openPack(packId);
  }

  static async #onStickerSheet() {
    const { openStickerSheet } = await import("./sticker-sheet.mjs");
    openStickerSheet();
  }

  static #onCampaignSheet() {
    this.close();
    state.getCampaign()?.sheet?.render({ force: true });
  }
}

/** Open the landing page. */
export function openLanding() {
  if ( !game.user.isGM ) return null;
  const app = foundry.applications.instances.get("rl-campaign-landing") ?? new CampaignLanding();
  return app.render({ force: true });
}
