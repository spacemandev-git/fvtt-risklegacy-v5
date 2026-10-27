import { CARDS_PER_RED_STAR } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { getResourceCards } from "../resources.mjs";
import { scarTargets } from "../scars.mjs";
import { TEMPLATES, factionActor, isCurrentFaction, loc } from "../util.mjs";
import { cardView } from "../views.mjs";
import { chooseResourceCards, pickFaction, pickTerritory } from "./dialogs.mjs";
import { attachZoom } from "./zoom.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { renderTemplate } = foundry.applications.handlebars;

/**
 * A faction's hand: card faces for its owners (backs and a count for everyone else), the coin total, and the
 * "Trade for Red Star" / "Trade for troops" buttons wired to game.risklegacy.turn.buyRedStars / tradeForTroops.
 *
 * Three ways to show it:
 *   - `renderHand(faction, options)` → HTML string (static; buttons work anywhere through a delegated listener),
 *   - `<rl-hand faction="<actor id>" [compact] [readonly]></rl-hand>`: a live element that re-renders itself
 *     when the cards or the war change (the easiest thing for a sheet to embed),
 *   - `openHand(faction)`: a small window.
 */

/**
 * Template context for a hand.
 * @param {Actor|string} faction
 * @param {object} [options]
 */
export function handContext(faction, { interactive = true, compact = false } = {}) {
  const actor = factionActor(faction);
  if ( !actor ) return null;
  const hand = state.getHand(actor);
  const reveal = !!hand && (hand.isOwner || game.user.isGM);
  const resources = getResourceCards(actor);
  const scars = hand?.cards.filter(c => c.type === "scar") ?? [];
  const others = hand?.cards.filter(c => !["territory", "coin", "scar"].includes(c.type)) ?? [];
  const coins = resources.reduce((n, c) => n + (c.system.coins ?? 0), 0);
  const war = state.getWar();
  const myTurn = isCurrentFaction(actor);
  const phase = war?.system.phase;
  const canAct = reveal && state.canActFor(game.user, actor);
  const turnApi = game.risklegacy?.turn ?? {};
  return {
    faction: { id: actor.id, name: actor.name, key: actor.system.key },
    exists: !!hand,
    reveal,
    compact,
    interactive: interactive && canAct,
    count: resources.length,
    total: hand?.cards.size ?? 0,
    coins,
    cards: resources.map(c => cardView(c, { reveal })),
    scars: scars.map(c => ({ ...cardView(c, { reveal }), canPlay: canAct })),
    others: others.map(c => cardView(c, { reveal })),
    canBuyStar: canAct && (resources.length >= CARDS_PER_RED_STAR) && (typeof turnApi.buyRedStars === "function")
      && (!war || (myTurn && ["start", "recruit"].includes(phase))),
    canTrade: canAct && (coins >= 2) && (typeof turnApi.tradeForTroops === "function")
      && (!war || (myTurn && (phase === "recruit"))),
    starHint: loc("RL.CardsUI.hand.starHint"),
    troopHint: loc("RL.CardsUI.hand.troopHint")
  };
}

/**
 * Render a faction's hand as an HTML string (async).
 * @param {Actor|string} faction
 * @param {object} [options]
 * @param {boolean} [options.interactive=true]  show the trade/play buttons (only for users who may act for it)
 * @param {boolean} [options.compact=false]     smaller cards
 * @returns {Promise<string>}
 */
export async function renderHand(faction, options = {}) {
  const context = handContext(faction, options);
  if ( !context ) return "";
  return renderTemplate(`${TEMPLATES}/hand.hbs`, context);
}

/* -------------------------------------------- */
/*  Button handling                             */
/* -------------------------------------------- */

const handled = new WeakSet();

/** Run a hand button. */
async function runHandAction(button) {
  const root = button.closest("[data-rl-hand]");
  const actor = factionActor(root?.dataset.rlHand);
  if ( !actor ) return;
  const action = button.dataset.rlHandAction;
  const turn = game.risklegacy?.turn ?? {};
  const cards = game.risklegacy.cards;
  try {
    switch ( action ) {
      case "redStar": {
        if ( typeof turn.buyRedStars !== "function" ) return ui.notifications.warn("RL.CardsUI.turnUnavailable", { localize: true });
        const cardIds = await chooseResourceCards({ faction: actor.id, purpose: "redStar" });
        if ( cardIds ) await turn.buyRedStars({ faction: actor.id, cardIds });
        break;
      }
      case "troops": {
        if ( typeof turn.tradeForTroops !== "function" ) return ui.notifications.warn("RL.CardsUI.turnUnavailable", { localize: true });
        const cardIds = await chooseResourceCards({ faction: actor.id, purpose: "troops" });
        if ( cardIds ) await turn.tradeForTroops({ faction: actor.id, cardIds });
        break;
      }
      case "playScar": {
        const cardId = button.closest("[data-card-id]")?.dataset.cardId;
        const card = state.getHand(actor)?.cards.get(cardId);
        if ( !card ) return;
        if ( card.system.target === "faction" ) {
          const factions = state.getFactions({ active: !!state.getWar() })
            .filter(f => !f.items.some(i => (i.type === "power") && (i.system.slot === "weakness")));
          const target = await pickFaction({ prompt: game.i18n.format("RL.CardsUI.scar.pickFaction", { name: card.name }), factions });
          if ( target ) await cards.playScar({ faction: actor.id, cardId, target });
        }
        else {
          const territory = await pickTerritory({
            prompt: game.i18n.format("RL.CardsUI.scar.pickTerritory", { name: card.name }), allowed: scarTargets(), faction: actor.id
          });
          if ( territory ) await cards.playScar({ faction: actor.id, cardId, territory });
        }
        break;
      }
    }
  } catch(err) {
    console.error(err);
    if ( game.user.isActiveGM ) ui.notifications.error(err.message);
  }
}

/** Delegated click listener for hands rendered as HTML strings anywhere in a document. */
export function onDocumentClick(event) {
  const button = event.target.closest?.("[data-rl-hand-action]");
  if ( !button || handled.has(event) ) return;
  handled.add(event);
  event.preventDefault();
  runHandAction(button);
}

/* -------------------------------------------- */
/*  <rl-hand> live element                      */
/* -------------------------------------------- */

export class RLHandElement extends HTMLElement {
  static tagName = "rl-hand";

  #hooks = [];

  #refresh = foundry.utils.debounce(() => this.refresh(), 50);

  connectedCallback() {
    this.classList.add("rl-hand-host");
    this.addEventListener("click", this.#onClick);
    for ( const name of ["createCard", "updateCard", "deleteCard", "updateCards", "createCards", "deleteCards", "updateCombat", "updateActor"] ) {
      this.#hooks.push([name, Hooks.on(name, () => this.#refresh())]);
    }
    this.refresh();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.#onClick);
    for ( const [name, id] of this.#hooks ) Hooks.off(name, id);
    this.#hooks = [];
  }

  #onClick = event => {
    const button = event.target.closest?.("[data-rl-hand-action]");
    if ( !button || handled.has(event) ) return;
    handled.add(event);
    event.preventDefault();
    runHandAction(button);
  };

  async refresh() {
    const faction = this.getAttribute("faction");
    if ( !faction || !game.ready ) return;
    this.innerHTML = await renderHand(faction, { interactive: !this.hasAttribute("readonly"), compact: this.hasAttribute("compact") });
    attachZoom(this.querySelector(".rl-hand-view"));
  }
}

/* -------------------------------------------- */
/*  Standalone window                           */
/* -------------------------------------------- */

export class HandApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-hand-app"],
    window: { icon: "fa-solid fa-hand-holding", resizable: true },
    position: { width: 560, height: "auto" }
  };

  static PARTS = {
    hand: { template: `${TEMPLATES}/hand-app.hbs` }
  };

  /** @override */
  get title() {
    return game.i18n.format("RL.Cards.hand", { faction: factionActor(this.options.faction)?.name ?? "" });
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.faction = this.options.faction;
    return context;
  }

  /** Open a faction's hand window. */
  static open(faction) {
    const actor = factionActor(faction);
    if ( !actor ) return null;
    const id = `rl-hand-${actor.id}`;
    const app = foundry.applications.instances.get(id) ?? new this({ id, faction: actor.id });
    return app.render({ force: true });
  }
}
