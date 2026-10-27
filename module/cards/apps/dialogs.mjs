import { CARDS_PER_RED_STAR, ROW_SLOTS, TROOP_TRADE, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { getResourceCards } from "../resources.mjs";
import { drawOptions, getRow } from "../sideboard.mjs";
import { TEMPLATES, factionActor, loc, territoryName } from "../util.mjs";
import { cardView } from "../views.mjs";

const { DialogV2 } = foundry.applications.api;
const { renderTemplate } = foundry.applications.handlebars;

/**
 * Client-side choosers. They only choose: the GM actions do (and re-check) the work.
 */

const COIN_IMG = "assets/unlocks/base/territories/images/coin_card.jpg";

/* -------------------------------------------- */
/*  Pending draw prompt (shared with the Sideboard app)                    */
/* -------------------------------------------- */

let pending = null;

/** The draw prompt open on this client, if any: {faction, options, dialog}. */
export function pendingPrompt() {
  return pending;
}

/**
 * Choose from the Sideboard instead of the dialog: select the choice in the open prompt and submit it.
 * @param {string} choice  a row card id or "coin"
 * @returns {boolean} whether a prompt took the choice
 */
export function choosePending(choice) {
  const dialog = pending?.dialog;
  const form = dialog?.element?.querySelector("form") ?? dialog?.element;
  const input = form?.querySelector(`input[name="choice"][value="${choice}"]`);
  if ( !input || input.disabled ) return false;
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  form.querySelector('button[data-action="draw"]')?.click();
  return true;
}

function refreshSideboard() {
  foundry.applications.instances.get("rl-sideboard")?.render();
}

/** Convert a dialog's string content into an attribute-less div (trusted markup, skips cleanHTML). */
function contentElement(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

/**
 * Show the face-up row and the coin pile with the legal choices enabled, and return the choice. Does not draw.
 * @param {Actor|string} faction
 * @param {object} [options]
 * @param {string} [options.title]
 * @returns {Promise<{cardId: string}|{coin: true}|null>}
 */
export async function promptResourceDraw(faction, { title } = {}) {
  const actor = factionActor(faction);
  if ( !actor ) return null;
  const options = drawOptions(actor);
  const row = getRow();
  const slots = Array.from({ length: ROW_SLOTS }, (_, i) => {
    const slot = i + 1;
    const card = row.find(c => c.system.slot === slot);
    const opt = options.row.find(r => r.slot === slot);
    return {
      slot, card: cardView(card),
      allowed: options.eligible && !!opt?.allowed,
      controlled: !!opt?.controlled,
      territory: card ? territoryName(card.system.territory) : ""
    };
  });
  const content = await renderTemplate(`${TEMPLATES}/prompt-draw.hbs`, {
    faction: { id: actor.id, name: actor.name, key: actor.system.key },
    options, slots,
    coin: { count: options.coinCount, allowed: options.eligible && options.coinAllowed, img: systemPath(COIN_IMG) },
    reason: options.reason,
    noChoice: options.eligible && !options.canDraw
  });

  const buttons = options.canDraw ? [
    { action: "skip", label: "RL.CardsUI.dontDraw", icon: "fa-solid fa-xmark", type: "button" },
    { action: "draw", label: "RL.CardsUI.drawCard", icon: "fa-solid fa-hand-holding", default: true, disabled: true,
      callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.choice ?? null }
  ] : [{ action: "ok", label: "RL.CardsUI.continue", icon: "fa-solid fa-check", default: true }];

  const promise = DialogV2.wait({
    window: { title: title ?? game.i18n.format("RL.CardsUI.drawTitle", { faction: actor.name }), icon: "fa-solid fa-layer-group" },
    classes: ["risklegacy", "rl-cards-dialog", "rl-draw-dialog"],
    position: { width: 620 },
    content: contentElement(content),
    buttons,
    rejectClose: false,
    render: (event, dialog) => {
      pending = { faction: actor.id, options, dialog };
      refreshSideboard();
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const drawButton = form.querySelector('button[data-action="draw"]');
      const sync = () => {
        const chosen = form.querySelector('input[name="choice"]:checked');
        if ( drawButton ) drawButton.disabled = !chosen;
        for ( const label of form.querySelectorAll(".rl-pick") ) label.classList.toggle("is-selected", !!label.querySelector("input:checked"));
      };
      form.addEventListener("change", sync);
      sync();
    }
  });
  let result;
  try {
    result = await promise;
  } finally {
    pending = null;
    refreshSideboard();
  }
  if ( !result || ["skip", "ok", "draw"].includes(result) ) return null;
  if ( result === "coin" ) return { coin: true };
  return { cardId: result };
}

/* -------------------------------------------- */
/*  Choose resource cards to turn in            */
/* -------------------------------------------- */

/** Troops for a number of coins (rules engine if available, else the board chart). */
export function troopsForCoins(coins) {
  const fn = game.risklegacy?.rules?.troopsForCoins;
  if ( typeof fn === "function" ) {
    try {
      return fn(coins);
    } catch(err) { /* chart */ }
  }
  return TROOP_TRADE[coins] ?? 0;
}

/**
 * Is a selection legal for the purpose, and what does it buy?
 * @param {"redStar"|"troops"} purpose
 * @param {{coins: number}[]} cards
 * @returns {{legal: boolean, stars: number, troops: number, coins: number, count: number, message: string}}
 */
export function evaluateSelection(purpose, cards) {
  const count = cards.length;
  const coins = cards.reduce((n, c) => n + (c.coins ?? 0), 0);
  if ( purpose === "redStar" ) {
    const legal = (count > 0) && (count % CARDS_PER_RED_STAR === 0);
    const stars = legal ? count / CARDS_PER_RED_STAR : 0;
    const message = legal ? game.i18n.format("RL.CardsUI.pick.buysStars", { count, n: stars })
      : game.i18n.format("RL.CardsUI.pick.needStars", { count, per: CARDS_PER_RED_STAR });
    return { legal, stars, troops: 0, coins, count, message };
  }
  const troops = (coins >= 2) && (coins <= 10) ? troopsForCoins(coins) : 0;
  const legal = troops > 0;
  let message;
  if ( legal ) message = game.i18n.format("RL.CardsUI.pick.buysTroops", { coins, n: troops });
  else if ( coins > 10 ) message = game.i18n.format("RL.CardsUI.pick.tooMany", { coins });
  else message = game.i18n.format("RL.CardsUI.pick.needCoins", { coins });
  return { legal, stars: 0, troops, coins, count, message };
}

/**
 * Pick resource cards from a faction's hand to turn in. Shows the faces, the coin total and what it buys, and only
 * allows a legal selection (4, 8, 12… cards for Red Stars; 2–10 coins for troops).
 * @param {object} options
 * @param {Actor|string} options.faction
 * @param {"redStar"|"troops"} options.purpose
 * @param {string} [options.title]
 * @returns {Promise<string[]|null>} card ids, or null if cancelled
 */
export async function chooseResourceCards({ faction, purpose = "troops", title } = {}) {
  const actor = factionActor(faction);
  if ( !actor ) return null;
  const cards = getResourceCards(actor).map(c => cardView(c));
  const chart = Object.entries(TROOP_TRADE).map(([coins, troops]) => ({ coins: Number(coins), troops }));
  const content = await renderTemplate(`${TEMPLATES}/choose-resources.hbs`, {
    faction: { id: actor.id, name: actor.name }, cards, purpose, chart,
    isStars: purpose === "redStar",
    total: cards.reduce((n, c) => n + (c.coins ?? 0), 0),
    per: CARDS_PER_RED_STAR
  });
  const byId = new Map(cards.map(c => [c.id, c]));
  const result = await DialogV2.wait({
    window: {
      title: title ?? loc(purpose === "redStar" ? "RL.CardsUI.pick.titleStars" : "RL.CardsUI.pick.titleTroops"),
      icon: purpose === "redStar" ? "fa-solid fa-star" : "fa-solid fa-person-military-rifle"
    },
    classes: ["risklegacy", "rl-cards-dialog", "rl-pick-dialog"],
    position: { width: 640 },
    content: contentElement(content),
    buttons: [
      { action: "cancel", label: "RL.CardsUI.cancel", icon: "fa-solid fa-xmark", type: "button" },
      { action: "confirm", label: purpose === "redStar" ? "RL.CardsUI.pick.confirmStars" : "RL.CardsUI.pick.confirmTroops",
        icon: "fa-solid fa-check", default: true, disabled: true,
        callback: (event, button) => [...button.form.querySelectorAll('input[name="card"]:checked')].map(i => i.value) }
    ],
    rejectClose: false,
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const confirm = form.querySelector('button[data-action="confirm"]');
      const summary = form.querySelector(".rl-pick-summary");
      const sync = () => {
        const chosen = [...form.querySelectorAll('input[name="card"]:checked')].map(i => byId.get(i.value)).filter(Boolean);
        const r = evaluateSelection(purpose, chosen);
        if ( confirm ) confirm.disabled = !r.legal;
        if ( summary ) {
          summary.textContent = r.message;
          summary.classList.toggle("is-legal", r.legal);
        }
        for ( const label of form.querySelectorAll(".rl-pick") ) label.classList.toggle("is-selected", !!label.querySelector("input:checked"));
        for ( const tr of form.querySelectorAll("[data-coins]") ) tr.classList.toggle("is-current", Number(tr.dataset.coins) === r.coins);
      };
      form.addEventListener("change", sync);
      sync();
    }
  });
  return Array.isArray(result) && result.length ? result : null;
}

/* -------------------------------------------- */
/*  Targets for scars                           */
/* -------------------------------------------- */

/**
 * Pick a territory: the canvas picker when the board area provides one, else a list.
 * @param {object} options
 * @param {string[]} options.allowed
 * @param {string} options.prompt
 * @param {string} [options.faction]
 * @returns {Promise<string|null>}
 */
export async function pickTerritory({ allowed, prompt, faction }) {
  const board = game.risklegacy?.board;
  if ( (typeof board?.pickTerritory === "function") && canvas?.ready && state.getBoardScene() ) {
    try {
      return await board.pickTerritory({ prompt, allowed, faction });
    } catch(err) {
      console.warn("risklegacy | board.pickTerritory failed; using the list", err);
    }
  }
  const options = allowed.map(id => ({ id, name: territoryName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  const select = `<select name="territory">${options.map(o => `<option value="${o.id}">${foundry.utils.escapeHTML(o.name)}</option>`).join("")}</select>`;
  const content = `<p>${foundry.utils.escapeHTML(prompt)}</p><div class="form-group"><label>${loc("RL.CardsUI.territory")}</label><div class="form-fields">${select}</div></div>`;
  return DialogV2.wait({
    window: { title: prompt, icon: "fa-solid fa-map-location-dot" },
    classes: ["risklegacy", "rl-cards-dialog"],
    position: { width: 480 },   // the title repeats the scar's name: leave room before the header controls
    content: contentElement(content),
    buttons: [
      { action: "cancel", label: "RL.CardsUI.cancel", type: "button" },
      { action: "ok", label: "RL.CardsUI.choose", default: true,
        callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.territory }
    ],
    rejectClose: false
  }).then(r => ((r && r !== "cancel") ? r : null));
}

/**
 * Pick a faction (weakness scars).
 * @param {object} options
 * @param {string} options.prompt
 * @param {Actor[]} options.factions
 * @returns {Promise<string|null>}
 */
export async function pickFaction({ prompt, factions }) {
  const select = `<select name="faction">${factions.map(f => `<option value="${f.id}">${foundry.utils.escapeHTML(f.name)}</option>`).join("")}</select>`;
  const content = `<p>${foundry.utils.escapeHTML(prompt)}</p><div class="form-group"><label>${loc("RL.CardsUI.faction")}</label><div class="form-fields">${select}</div></div>`;
  return DialogV2.wait({
    window: { title: prompt, icon: "fa-solid fa-flag" },
    classes: ["risklegacy", "rl-cards-dialog"],
    position: { width: 480 },
    content: contentElement(content),
    buttons: [
      { action: "cancel", label: "RL.CardsUI.cancel", type: "button" },
      { action: "ok", label: "RL.CardsUI.choose", default: true,
        callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.faction }
    ],
    rejectClose: false
  }).then(r => ((r && r !== "cancel") ? r : null));
}

