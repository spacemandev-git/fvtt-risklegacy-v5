import { ROW_SLOTS, SYSTEM_ID, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { missionStatus } from "../missions.mjs";
import { drawOptions, getRow } from "../sideboard.mjs";
import { TEMPLATES, loc, territoryName } from "../util.mjs";
import { backImage, cardView } from "../views.mjs";
import { choosePending, pendingPrompt } from "./dialogs.mjs";
import { attachZoom } from "./zoom.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * Slot frames on the sideboard photo (assets/board/sideboard.jpg, 2789 × 1496), in % of the board.
 * Measured from the white bracket frames.
 */
const GEOMETRY = {
  draw: { x: 2.7, y: 5.8, w: 14.2, h: 37.7 },
  coin: { x: 21.9, y: 5.7, w: 14.2, h: 37.6 },
  mission: { x: 40.4, y: 10.6, w: 19.4, h: 27.2 },
  event: { x: 64.0, y: 5.2, w: 14.2, h: 37.3 },
  discard: { x: 82.9, y: 4.6, w: 14.3, h: 37.6 },
  1: { x: 2.9, y: 52.2, w: 14.3, h: 37.7 },
  2: { x: 29.9, y: 51.5, w: 14.1, h: 37.7 },
  3: { x: 56.5, y: 51.0, w: 14.1, h: 37.7 },
  4: { x: 83.1, y: 50.8, w: 14.3, h: 37.7 }
};
const style = g => `left:${g.x}%;top:${g.y}%;width:${g.w}%;height:${g.h}%`;
const RESOURCE_BACK = "assets/unlocks/base/territories/images/resource_card.jpg";
const COIN_IMG = "assets/unlocks/base/territories/images/coin_card.jpg";

/**
 * The Sideboard: a live view of the physical sideboard. DRAW pile, the coin pile with its printed Red Star note,
 * MISSION, EVENT, DISCARD, and the face-up territory row 1 → 4. Draw controls appear for the player whose draw is
 * pending (an open draw prompt on this client, or the current player at the End of Turn step).
 */
export default class SideboardApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-sideboard",
    classes: ["risklegacy", "rl-sideboard-app"],
    window: {
      title: "RL.Sideboard.title",
      icon: "fa-solid fa-layer-group",
      resizable: true,
      controls: [
        { icon: "fa-solid fa-table-cells-large", label: "RL.Sideboard.control.setup", action: "setup", visible: () => game.user.isGM },
        { icon: "fa-solid fa-bolt", label: "RL.Sideboard.control.revealEvent", action: "revealEvent", visible: () => game.user.isGM },
        { icon: "fa-solid fa-flag-checkered", label: "RL.Sideboard.control.revealMission", action: "revealMission", visible: () => game.user.isGM },
        { icon: "fa-solid fa-hammer", label: "RL.Sideboard.control.buildDecks", action: "buildDecks", visible: () => game.user.isGM }
      ]
    },
    position: { width: 900, height: "auto" },
    actions: {
      take: SideboardApp.#onTake,
      takeCoin: SideboardApp.#onTakeCoin,
      browse: SideboardApp.#onBrowse,
      completeMission: SideboardApp.#onCompleteMission,
      setup: SideboardApp.#onSetup,
      revealEvent: SideboardApp.#onRevealEvent,
      revealMission: SideboardApp.#onRevealMission,
      buildDecks: SideboardApp.#onBuildDecks
    }
  };

  static PARTS = {
    board: { template: `${TEMPLATES}/sideboard.hbs` }
  };

  /** Open (or bring to front) the single Sideboard window. */
  static open() {
    const app = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? new this();
    return app.render({ force: true });
  }

  #hooks = [];

  #refresh = foundry.utils.debounce(() => {
    if ( this.rendered ) this.render();
  }, 60);

  /* -------------------------------------------- */

  /** Who may draw now, and how: "prompt" (a draw dialog is open here) or "draw" (End of Turn, act directly). */
  #drawState() {
    const prompt = pendingPrompt();
    if ( prompt ) return { mode: "prompt", faction: prompt.faction, options: drawOptions(prompt.faction) };
    const war = state.getWar();
    const current = state.currentFaction();
    if ( current && state.canActFor(game.user, current) && (war?.system.phase === "end")
      && !war.system.turn.cardDrawn && !war.system.turn.missionCompleted ) {
      const options = drawOptions(current);
      if ( options.canDraw ) return { mode: "draw", faction: current.id, options };
      return { mode: null, faction: current.id, options };
    }
    const mine = state.factionOfUser(game.user) ?? (current && state.canActFor(game.user, current) ? current : null);
    return { mode: null, faction: mine?.id ?? null, options: mine ? drawOptions(mine) : null };
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const stack = role => state.getCardStack(role);
    const deck = stack("territoryDeck");
    const coinDeck = stack("coinDeck");
    const discard = stack("discard");
    const missionDeck = stack("missionDeck");
    const eventDeck = stack("eventDeck");
    const eventDiscard = stack("eventDiscard");
    const war = state.getWar();
    const draw = this.#drawState();
    const faction = draw.faction ? game.actors.get(draw.faction) : null;
    const opts = draw.options;
    const active = !!draw.mode;

    // Row
    const row = getRow();
    const slots = Array.from({ length: ROW_SLOTS }, (_, i) => {
      const slot = i + 1;
      const card = row.find(c => c.system.slot === slot);
      const opt = opts?.row.find(r => r.slot === slot);
      return {
        slot, style: style(GEOMETRY[slot]),
        card: cardView(card),
        territory: card ? territoryName(card.system.territory) : "",
        allowed: active && !!opt?.allowed,
        controlled: !!opt?.controlled,
        dimmed: active && !opt?.allowed
      };
    });

    // Piles
    const discardTop = discard?.cards.contents.sort((a, b) => b.sort - a.sort)[0];
    const pendingEvents = eventDiscard?.cards.filter(c => c.getFlag(SYSTEM_ID, "pending")).length ?? 0;
    const mission = stack("missionSlot")?.cards.contents[0] ?? null;
    const status = (mission && faction) ? missionStatus(faction) : null;
    const coinCount = coinDeck?.availableCards.length ?? 0;
    const eventExists = !!eventDeck?.cards.size;

    Object.assign(context, {
      board: systemPath("assets/board/sideboard.jpg"),
      ready: !!deck,
      isGM: game.user.isGM,
      slots,
      drawPile: { style: style(GEOMETRY.draw), count: deck?.availableCards.length ?? 0, img: systemPath(RESOURCE_BACK) },
      coin: {
        style: style(GEOMETRY.coin), count: coinCount, img: systemPath(COIN_IMG),
        allowed: active && !!opts?.coinAllowed, dimmed: active && !opts?.coinAllowed,
        depleted: !!war?.system.coinPileDepleted
      },
      mission: {
        style: style(GEOMETRY.mission),
        exists: !!missionDeck?.cards.size,
        card: cardView(mission),
        deckCount: missionDeck?.availableCards.length ?? 0,
        status: status?.status ?? null,
        progress: status?.progress ?? "",
        canComplete: !!status?.canComplete && !!faction && state.canActFor(game.user, faction) && (war?.system.phase === "end"),
        statusLabel: status ? loc(`RL.Sideboard.missionStatus.${status.status}`) : ""
      },
      event: {
        style: style(GEOMETRY.event), exists: eventExists,
        count: eventDeck?.availableCards.length ?? 0,
        inPlay: eventDiscard?.cards.size ?? 0, pending: pendingEvents
      },
      discard: {
        style: style(GEOMETRY.discard), count: discard?.cards.size ?? 0,
        top: cardView(discardTop), back: discardTop ? backImage(discardTop) : null
      },
      evenHint: eventExists,
      slot1Even: !!slots[0].card?.even,
      draw: {
        mode: draw.mode,
        active,
        faction: faction ? { id: faction.id, name: faction.name, key: faction.system.key } : null,
        reason: opts?.reason ?? "",
        eligible: !!opts?.eligible,
        canDraw: !!opts?.canDraw
      }
    });
    return context;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const hooks = ["createCard", "updateCard", "deleteCard", "createCards", "updateCards", "deleteCards",
      "createCombat", "updateCombat", "deleteCombat", "updateActor", "createToken", "updateToken", "deleteToken"];
    for ( const name of hooks ) this.#hooks.push([name, Hooks.on(name, () => this.#refresh())]);
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
    attachZoom(this.element.querySelector(".rl-sb-board"));
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** Draw (or choose for the open prompt). */
  async #take(choice) {
    if ( pendingPrompt() ) {
      if ( !choosePending(choice) ) ui.notifications.warn("RL.Sideboard.notAllowed", { localize: true });
      return;
    }
    const draw = this.#drawState();
    if ( draw.mode !== "draw" ) return;
    const actor = game.actors.get(draw.faction);
    const label = choice === "coin" ? loc("RL.CardsUI.coinCard") : (state.getCardStack("row")?.cards.get(choice)?.name ?? "");
    const confirmed = await DialogV2.confirm({
      window: { title: "RL.Sideboard.confirmDrawTitle" },
      classes: ["risklegacy", "rl-cards-dialog"],
      content: `<p>${game.i18n.format("RL.Sideboard.confirmDraw", { faction: foundry.utils.escapeHTML(actor.name), card: foundry.utils.escapeHTML(label) })}</p>`,
      rejectClose: false
    });
    if ( !confirmed ) return;
    try {
      await game.risklegacy.cards.drawResourceCard({ faction: actor.id, cardId: choice === "coin" ? null : choice });
    } catch(err) {
      if ( game.user.isActiveGM ) ui.notifications.error(err.message);
    }
  }

  static async #onTake(event, target) {
    const cardId = target.closest("[data-card-id]")?.dataset.cardId;
    if ( cardId ) await this.#take(cardId);
  }

  static async #onTakeCoin() {
    await this.#take("coin");
  }

  static #onBrowse(event, target) {
    const role = target.closest("[data-role]")?.dataset.role;
    if ( role ) game.risklegacy.cards.browsePile(role);
  }

  static async #onCompleteMission() {
    const draw = this.#drawState();
    const actor = draw.faction ? game.actors.get(draw.faction) : null;
    if ( !actor ) return;
    const mission = state.getCardStack("missionSlot")?.cards.contents[0];
    const confirmed = await DialogV2.confirm({
      window: { title: "RL.Sideboard.completeMission" },
      classes: ["risklegacy", "rl-cards-dialog"],
      content: `<p>${game.i18n.format("RL.Sideboard.confirmComplete", { faction: foundry.utils.escapeHTML(actor.name), name: foundry.utils.escapeHTML(mission?.name ?? "") })}</p>`,
      rejectClose: false
    });
    if ( !confirmed ) return;
    try {
      await game.risklegacy.cards.completeMission({ faction: actor.id });
    } catch(err) {
      if ( game.user.isActiveGM ) ui.notifications.error(err.message);
    }
  }

  static async #onSetup() {
    const confirmed = await DialogV2.confirm({
      window: { title: "RL.Sideboard.control.setup" },
      classes: ["risklegacy", "rl-cards-dialog", "rl-hazard-header"],
      content: `<div class="rl-callout">${loc("RL.Sideboard.confirmSetup")}</div>`,
      rejectClose: false
    });
    if ( confirmed ) await guard(() => game.risklegacy.cards.setupSideboard());
  }

  static async #onRevealEvent() {
    await guard(() => game.risklegacy.cards.revealEvent());
  }

  static async #onRevealMission() {
    const hasMission = !!state.getCardStack("missionSlot")?.cards.size;
    await guard(() => game.risklegacy.cards.revealMission({ replace: hasMission }));
  }

  static async #onBuildDecks() {
    await guard(() => game.risklegacy.cards.buildDecks({}));
  }
}

async function guard(fn) {
  try {
    return await fn();
  } catch(err) {
    console.error(err);
    if ( game.user.isActiveGM ) ui.notifications.error(err.message);
  }
}
