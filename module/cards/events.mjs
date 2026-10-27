import { SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as chat from "./chat.mjs";
import * as effects from "./event-effects.mjs";
import { deleteCardEverywhere, recordRemoved } from "./stacks.mjs";
import { TEMPLATES, factionActor, loc, requireGM, textToHTML } from "./util.mjs";

/**
 * Event cards (rulebook p. 13). An event is revealed when the new slot-1 territory card has an even value, after
 * a resource draw. Where the card goes afterwards (`afterResolve`):
 *   box     → back in the box: out of this game (the home card stays drawn), back in the deck next game
 *   destroy → deleted permanently
 *   keep    → kept "in play" in the eventDiscard pile (never reshuffled) and listed in war.system.activeEvents
 *   deck    → shuffled back into the event deck
 *   other   → conditional (Fortify, Die Humans): decided by the automated outcome, or by the GM's chat buttons
 *
 * With the world setting `eventAutomation` on (default) and an automated catalog event (module/cards/event-effects.mjs),
 * the effect is carried out: the card is taken out of the deck (pending in the eventDiscard pile, so a second event
 * this turn can't turn it over again), the controlling player chooses on their own client, the chat card is updated
 * with what happened, and the card is disposed of per `afterResolve` and the chosen outcome. An event that does not
 * occur (tie, the noted faction knocked out / eliminated / not in the game) is DISCARDED. Otherwise the card is
 * posted with its scan and text and the players carry it out by hand (today's behaviour).
 */

/** Top available card of a deck (by shuffled sort order). */
export function topCard(deck) {
  return deck?.availableCards.sort((a, b) => a.sort - b.sort)[0] ?? null;
}

/** Add an event to war.system.activeEvents. */
async function addActiveEvent(catalogId) {
  const war = state.getWar();
  if ( !war ) return;
  const list = new Set(war.system.activeEvents ?? []);
  if ( list.has(catalogId) ) return;
  list.add(catalogId);
  await war.update({ "system.activeEvents": [...list] });
}

/**
 * [GM] Reveal the top card of the event deck and handle where it goes.
 * @param {object} [options]
 * @param {string} [options.faction]   faction whose draw triggered it (chat speaker)
 * @returns {Promise<{eventCardId: string|null, outcome: string|null}>}
 */
export async function revealEvent({ faction } = {}) {
  const deck = state.getCardStack("eventDeck");
  if ( !deck?.cards.size ) return { eventCardId: null, outcome: null };
  const card = topCard(deck);
  if ( !card ) {
    await chat.post({ kind: "eventEmpty", title: loc("RL.Sideboard.chat.eventEmptyTitle"), text: loc("RL.Sideboard.chat.eventEmpty") });
    return { eventCardId: null, outcome: "empty" };
  }
  if ( effects.automationEnabled() && effects.isAutomated(card.system.catalogId) ) {
    const { eventCardId, outcome } = await resolveAutomated({ card, faction });
    return { eventCardId, outcome };
  }
  const after = card.system.afterResolve || "box";
  const image = { img: card.currentFace?.img ?? card.img, alt: card.name, orientation: "portrait" };
  const pile = state.getCardStack("eventDiscard");
  let outcome = after;
  let resultKey;
  const buttons = [];

  switch ( after ) {
    case "destroy":
      await recordRemoved("event", card.system.catalogId);
      await deleteCardEverywhere(card.id);
      resultKey = "RL.Sideboard.chat.eventDestroy";
      break;
    case "keep":
      if ( pile ) {
        await deck.pass(pile, [card.id], { chatNotification: false, updateData: { flags: { [SYSTEM_ID]: { kept: true } } } });
      }
      else await deck.updateEmbeddedDocuments("Card", [{ _id: card.id, drawn: true }]);
      await addActiveEvent(card.system.catalogId);
      resultKey = "RL.Sideboard.chat.eventKeep";
      break;
    case "deck":
      await deck.shuffle({ chatNotification: false });
      resultKey = "RL.Sideboard.chat.eventDeck";
      break;
    case "box":
      await deck.updateEmbeddedDocuments("Card", [{ _id: card.id, drawn: true }]);
      resultKey = "RL.Sideboard.chat.eventBox";
      break;
    default:
      outcome = "pending";
      if ( pile ) {
        await deck.pass(pile, [card.id], { chatNotification: false, updateData: { flags: { [SYSTEM_ID]: { pending: true } } } });
      }
      else await deck.updateEmbeddedDocuments("Card", [{ _id: card.id, drawn: true }]);
      resultKey = "RL.Sideboard.chat.eventPending";
      buttons.push(...manualButtons(card.id, after));
  }

  const afterText = card.getFlag(SYSTEM_ID, "afterResolveText");
  await chat.post({
    kind: "event", faction,
    title: game.i18n.format("RL.Sideboard.chat.eventTitle", { name: card.name }),
    sub: loc("RL.Sideboard.chat.eventSub"),
    images: [image],
    text: textToHTML(card.system.text),
    result: `${loc(resultKey)}${afterText && (outcome === "pending") ? ` <em>${foundry.utils.escapeHTML(afterText)}</em>` : ""}`,
    buttons,
    flags: { cardId: card.id, catalogId: card.system.catalogId, outcome }
  });
  return { eventCardId: card.id, outcome };
}

/** GM chat buttons for deciding by hand where a pending event card goes. */
function manualButtons(cardId, after) {
  const choices = after === "keep" ? ["keep", "box"] : ["box", "destroy"];
  return choices.map(choice => ({
    action: "resolveEvent", label: loc(`RL.Sideboard.resolve.${choice}`), destroy: choice === "destroy",
    data: { "card-id": cardId, outcome: choice }
  }));
}

/**
 * Move an event card where it belongs after resolving (shared by the GM's buttons and the automation).
 * @param {string} cardId
 * @param {"box"|"destroy"|"keep"|"deck"} outcome
 * @returns {Promise<{catalogId: string, name: string, outcome: string, resultKey: string}>}
 */
async function disposeEvent(cardId, outcome) {
  const deck = state.getCardStack("eventDeck");
  const pile = state.getCardStack("eventDiscard");
  const copy = pile?.cards.get(cardId);
  const home = deck?.cards.get(cardId);
  if ( !home && !copy ) throw new Error(loc("RL.CardsUI.error.noCard"));
  const { catalogId } = (home ?? copy).system;
  const name = (home ?? copy).name;
  switch ( outcome ) {
    case "destroy":
      await recordRemoved("event", catalogId);
      await deleteCardEverywhere(cardId);
      break;
    case "keep":
      if ( copy ) await pile.updateEmbeddedDocuments("Card", [{ _id: cardId, [`flags.${SYSTEM_ID}.pending`]: false, [`flags.${SYSTEM_ID}.kept`]: true }]);
      else if ( home && !home.drawn ) await deck.updateEmbeddedDocuments("Card", [{ _id: cardId, drawn: true }]);
      await addActiveEvent(catalogId);
      break;
    case "deck":
      if ( copy ) await pile.deleteEmbeddedDocuments("Card", [cardId]);
      if ( home?.drawn ) await deck.updateEmbeddedDocuments("Card", [{ _id: cardId, drawn: false }]);
      await deck.shuffle({ chatNotification: false });
      break;
    default:
      outcome = "box";
      if ( copy ) await pile.deleteEmbeddedDocuments("Card", [cardId]);
      else if ( home && !home.drawn ) await deck.updateEmbeddedDocuments("Card", [{ _id: cardId, drawn: true }]);
  }
  return { catalogId, name, outcome, resultKey: `RL.Sideboard.chat.event${outcome.capitalize()}` };
}

/**
 * [GM] Decide where a pending event card goes after resolving.
 * @param {object} options
 * @param {string} options.cardId
 * @param {"box"|"destroy"|"keep"} options.outcome
 * @returns {Promise<{cardId: string, outcome: string}>}
 */
export async function resolveEvent({ cardId, outcome }, { user } = {}) {
  requireGM(user ?? game.user);
  const done = await disposeEvent(cardId, ["destroy", "keep"].includes(outcome) ? outcome : "box");
  await chat.post({
    kind: "eventResolved",
    title: game.i18n.format("RL.Sideboard.chat.eventResolvedTitle", { name: done.name }),
    result: loc(done.resultKey)
  });
  return { cardId, outcome: done.outcome };
}

/* -------------------------------------------- */
/*  Automated events                            */
/* -------------------------------------------- */

/**
 * The automated event's chat card: created when the first choice is asked (so everyone sees the event while the
 * player chooses) or, for events without a choice, once with the result (and the dice rolls, so Dice So Nice and the
 * dice sound play). Later calls update it in place.
 */
class EventCard {
  constructor(view, { faction, flags }) {
    this.view = view;
    this.faction = factionActor(faction);
    this.flags = flags;
    this.message = null;
  }

  get id() {
    return this.message?.id ?? null;
  }

  async show(data = {}, { rolls = [] } = {}) {
    const content = await foundry.applications.handlebars.renderTemplate(`${TEMPLATES}/event-card.hbs`, { ...this.view, ...data });
    const flags = { [SYSTEM_ID]: { card: true, cards: { kind: "event", automated: true, ...this.flags, ...(data.flags ?? {}) } } };
    if ( this.message ) {
      await this.message.update({ content, flags });
      return this.message;
    }
    const ChatMessage = foundry.documents.ChatMessage.implementation;
    const message = {
      content, flags,
      speaker: this.faction ? ChatMessage.getSpeaker({ actor: this.faction }) : { alias: game.i18n.localize("RL.Sideboard.title") },
      style: CONST.CHAT_MESSAGE_STYLES.OTHER
    };
    if ( rolls.length ) {
      message.rolls = rolls;
      message.sound = CONFIG.sounds.dice;
    }
    this.message = await ChatMessage.create(message);
    return this.message;
  }
}

/**
 * [GM] Carry out an automated event and dispose of its card.
 * @param {object} options
 * @param {Card|null} [options.card]       the event card (still available in the event deck), or null for a dry run
 * @param {string} [options.catalogId]     the catalog event (default: the card's)
 * @param {string} [options.faction]       faction whose draw triggered it (chat speaker)
 * @returns {Promise<{eventCardId: string|null, catalogId: string, outcome: string|null, occurred: boolean,
 *   messageId: string|null, result: object}>}
 */
async function resolveAutomated({ card = null, catalogId, faction } = {}) {
  catalogId ??= card?.system.catalogId;
  const entry = state.findEntry("events", catalogId) ?? null;
  const name = card?.name ?? entry?.name ?? catalogId;
  const after = card?.system.afterResolve || entry?.afterResolve || "box";
  const deck = state.getCardStack("eventDeck");
  const pile = state.getCardStack("eventDiscard");

  // Out of the deck first: a second event this turn (Mysterious Island) must turn over the next card.
  if ( card ) {
    if ( pile ) {
      await deck.pass(pile, [card.id], { chatNotification: false, updateData: { flags: { [SYSTEM_ID]: { pending: true } } } });
    }
    else await deck.updateEmbeddedDocuments("Card", [{ _id: card.id, drawn: true }]);
  }

  const view = {
    kind: "event", catalogId,
    title: game.i18n.format("RL.Sideboard.chat.eventTitle", { name }),
    sub: entry?.code ? `${loc("RL.Events.sub")} · ${entry.code}` : loc("RL.Events.sub"),
    images: [{
      img: card ? (card.currentFace?.img ?? card.img) : (entry?.img ? systemPath(entry.img) : ""), alt: name, orientation: "portrait"
    }].filter(i => i.img),
    text: textToHTML(card?.system.text ?? entry?.text ?? "")
  };
  const chatCard = new EventCard(view, { faction, flags: { cardId: card?.id ?? null, catalogId, outcome: "resolving" } });
  const ctx = {
    entry, card, name,
    onStatus: status => chatCard.show({ status, state: "resolving" })
  };

  let result;
  try {
    result = await effects.runEffect(catalogId, ctx);
  } catch(err) {
    console.error(`${SYSTEM_ID} | event "${catalogId}" failed`, err);
    result = { failed: true, error: err.message, rows: [], rolls: [] };
  }

  // Where the card goes: an event that did not occur is discarded; conditional cards follow the chosen option.
  let outcome = null;
  if ( !result.failed && !result.pending ) {
    if ( !result.occurred ) outcome = "box";
    else outcome = result.outcome ?? (["box", "destroy", "keep", "deck"].includes(after) ? after : null);
  }
  let disposal;
  let buttons = [];
  if ( !card ) {
    disposal = loc("RL.Events.status.noCard");
    outcome = null;
  }
  else if ( outcome ) {
    try {
      const done = await disposeEvent(card.id, outcome);
      outcome = done.outcome;
      disposal = loc(done.resultKey);
    } catch(err) {
      console.error(`${SYSTEM_ID} | event "${catalogId}": disposal failed`, err);
      disposal = err.message;
    }
  }
  else {
    outcome = "pending";
    const afterText = card.getFlag(SYSTEM_ID, "afterResolveText") ?? entry?.afterResolveText ?? "";
    disposal = `${loc("RL.Sideboard.chat.eventPending")}${afterText ? ` <em>${foundry.utils.escapeHTML(afterText)}</em>` : ""}`;
    buttons = manualButtons(card.id, after);
  }

  // ChatMessage creation serializes the Roll objects in place: keep the totals for the return value
  const rollTotals = (result.rolls ?? []).map(r => r.total);
  const status = [];
  let summary = result.summary ?? "";
  if ( result.failed ) summary = game.i18n.format("RL.Events.status.failed", { error: foundry.utils.escapeHTML(result.error ?? "") });
  else if ( !result.occurred ) summary = game.i18n.format("RL.Events.notOccur", { reason: foundry.utils.escapeHTML(result.reason ?? "") });
  if ( result.chosenBy ) status.push(game.i18n.format("RL.Events.status.chosenBy", { user: foundry.utils.escapeHTML(result.chosenBy) }));
  status.push(disposal);

  await chatCard.show({
    state: result.failed ? "failed" : (result.occurred ? "done" : "notOccurred"),
    stamp: (!result.failed && !result.occurred) ? loc("RL.Events.stamp") : "",
    hazard: !!result.hazard,
    lead: result.lead ?? "", leadValue: result.leadValue ?? "",
    rows: result.rows ?? [], summary, note: result.note ?? "", token: !!result.token,
    status: status.filter(Boolean).join(" "),
    buttons,
    flags: { outcome, occurred: !!result.occurred, faction: result.faction ?? null }
  }, { rolls: result.rolls ?? [] });

  return {
    eventCardId: card?.id ?? null, catalogId, outcome, occurred: !!result.occurred, messageId: chatCard.id,
    result: {
      occurred: !!result.occurred, reason: result.reason ?? "", failed: !!result.failed, error: result.error ?? "",
      faction: result.faction ?? null, chosenBy: result.chosenBy ?? "", outcome: result.outcome ?? null,
      rows: (result.rows ?? []).map(r => ({ label: r.label, value: r.value, die: r.die ?? null, mod: r.mod ?? null })),
      rolls: rollTotals
    }
  };
}

/**
 * [GM] Carry out an event now through the automation (testing, or replaying an event the table skipped). Runs even
 * when the `eventAutomation` setting is off.
 * @param {object} options
 * @param {string} [options.catalogId]  catalog event id; the first copy still in the event deck is used (and
 *                                      disposed of). Without a copy in the deck (or with `dryRun`) the effect runs
 *                                      without a card.
 * @param {string} [options.cardId]     a specific event card still in the event deck
 * @param {string} [options.faction]    chat speaker
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<object>} see resolveAutomated
 */
export async function runEvent({ catalogId, cardId, faction, dryRun = false } = {}, { user } = {}) {
  requireGM(user ?? game.user);
  const deck = state.getCardStack("eventDeck");
  let card = null;
  if ( cardId ) {
    card = deck?.availableCards.find(c => c.id === cardId) ?? null;
    if ( !card ) throw new Error(loc("RL.CardsUI.error.noCard"));
  }
  else if ( !dryRun ) card = deck?.availableCards.find(c => c.system.catalogId === catalogId) ?? null;
  const id = card?.system.catalogId ?? catalogId;
  if ( !effects.isAutomated(id) ) throw new Error(game.i18n.format("RL.Events.error.notAutomated", { id: String(id ?? "") }));
  return resolveAutomated({ card, catalogId: id, faction });
}

/**
 * Return the event deck for a new game: every card back in the deck except those kept in play.
 */
export async function resetEventDeck() {
  const deck = state.getCardStack("eventDeck");
  if ( !deck ) return;
  const kept = new Set();
  for ( const stack of game.cards ) {
    if ( stack === deck ) continue;
    const remove = [];
    for ( const c of stack.cards ) {
      if ( c.origin !== deck ) continue;
      if ( c.getFlag(SYSTEM_ID, "kept") ) kept.add(c.id);
      else remove.push(c.id);
    }
    if ( remove.length ) await stack.deleteEmbeddedDocuments("Card", remove);
  }
  const updates = deck.cards.filter(c => c.drawn && !kept.has(c.id)).map(c => ({ _id: c.id, drawn: false }));
  if ( updates.length ) await deck.updateEmbeddedDocuments("Card", updates);
  if ( deck.cards.size ) await deck.shuffle({ chatNotification: false });
}
