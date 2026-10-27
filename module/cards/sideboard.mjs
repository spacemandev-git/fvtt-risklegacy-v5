import { CARD_STACKS, ROW_SLOTS } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as chat from "./chat.mjs";
import { resetEventDeck, revealEvent, topCard } from "./events.mjs";
import { revealMission } from "./missions.mjs";
import { addDeferredEvents, buildDecks, ensureHand } from "./stacks.mjs";
import {
  factionId, gate, isCurrentFaction, loc, requireActFor, requireCampaign, requireFaction, requireGM, requireHand,
  requireStack, territoryName
} from "./util.mjs";

/**
 * The sideboard (rulebook pp. 7 and 12): DRAW pile, Coin card pile, MISSION, EVENT, DISCARD, and the face-up
 * territory row (slots 1 → 4). Slot numbers live on the row copies in `card.system.slot`.
 */

const TOP = CONST.CARD_DRAW_MODES.TOP;

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/**
 * The face-up territory row (sync), sorted by slot: index 0 is slot 1 while all four slots are filled; use
 * `card.system.slot` when a slot can be empty (both the deck and the discard pile ran out).
 * @returns {Card[]}
 */
export function getRow() {
  const row = state.getCardStack("row");
  if ( !row ) return [];
  return row.cards.contents.filter(c => c.type === "territory").sort((a, b) => a.system.slot - b.system.slot);
}

/** Number of cards left in the coin pile. */
export function coinCount() {
  return state.getCardStack("coinDeck")?.availableCards.length ?? 0;
}

/** Is there an event deck (with or without cards left)? */
export function hasEventDeck() {
  return !!state.getCardStack("eventDeck")?.cards.size;
}

/* -------------------------------------------- */
/*  Draw rules                                  */
/* -------------------------------------------- */

/**
 * The faction's homeland continent when Rules addition F (Homeland, Second Win pack) is in the rulebook: the
 * continent it started in most often, this game included. Null otherwise (or on a tie).
 */
function homeland(fid) {
  const campaign = state.getCampaign();
  const rules = game.risklegacy?.rules;
  if ( !campaign?.system.rulesAdditions?.F || (typeof rules?.homelandContinent !== "function") ) return null;
  const actor = game.actors.get(fid);
  const board = state.getCampaignBoard();
  if ( !actor || !board ) return null;
  const history = [...actor.system.history];
  if ( actor.system.war.startingTerritory ) history.push({ startingTerritory: actor.system.war.startingTerritory });
  return rules.homelandContinent(history, id => board.continentOf(id));
}

/** Rulebook p. 12 eligibility, used when the rules engine doesn't provide resourceDrawEligibility. */
function fallbackEligibility(snapshot, fid) {
  const turn = snapshot?.turn;
  if ( !turn || (turn.stage !== "playing") ) return state.fail("RL.CardsUI.reason.noWar");
  if ( turn.faction !== fid ) return state.fail("RL.CardsUI.reason.notYourTurn");
  const log = turn.log ?? {};
  const powers = snapshot.factions?.[fid]?.powers ?? [];
  if ( (log.conquered ?? 0) >= 1 ) return state.ok();
  if ( powers.includes("balkania_2") && ((log.expanded ?? 0) >= 4) ) return state.ok({ power: "balkania_2" });
  if ( powers.includes("resourceful") && log.expandedIntoCity ) return state.ok({ power: "resourceful" });
  return state.fail("RL.CardsUI.reason.noConquest");
}

/** Rulebook p. 12 choices, used when the rules engine doesn't provide resourceDrawChoices. */
function fallbackChoices(snapshot, fid, row) {
  const controlled = new Set(snapshot?.factions?.[fid]?.territories ?? []);
  const territoryCardIds = row.filter(r => controlled.has(r.territory)).map(r => r.cardId);
  return { territoryCardIds, coinAllowed: !territoryCardIds.length };
}

/** Your own turn only; one card per turn, and not on a turn where a mission was completed. */
function drawLimits(fid) {
  const war = state.getWar();
  if ( !war || (war.system.stage !== "playing") ) return state.ok();
  if ( !isCurrentFaction(fid) ) return state.fail("RL.CardsUI.reason.notYourTurn");
  if ( war.system.turn.cardDrawn ) return state.fail("RL.CardsUI.reason.drewThisTurn");
  if ( war.system.turn.missionCompleted ) return state.fail("RL.CardsUI.reason.missionCompletedThisTurn");
  return state.ok();
}

/**
 * What a faction may draw right now (sync). Uses `game.risklegacy.rules.resourceDrawEligibility/resourceDrawChoices`
 * when the rules engine provides them, otherwise the rulebook rule.
 * @param {Actor|string} faction
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurnLimits=false]  skip the one-card-per-turn / mission checks
 * @returns {{faction: string, eligible: boolean, result: object, reason: string,
 *   row: {cardId: string, territory: string, slot: number, value: number, name: string, controlled: boolean, allowed: boolean}[],
 *   territoryCardIds: string[], coinAllowed: boolean, coinCount: number, canDraw: boolean}}
 */
export function drawOptions(faction, { ignoreTurnLimits = false } = {}) {
  const fid = factionId(faction);
  const snapshot = state.buildSnapshot();
  const row = getRow().map(c => ({
    cardId: c.id, territory: c.system.territory, slot: c.system.slot, value: c.system.value, name: c.name
  }));
  const rules = game.risklegacy?.rules ?? {};

  let eligibility;
  try {
    eligibility = ((typeof rules.resourceDrawEligibility === "function") && snapshot)
      ? rules.resourceDrawEligibility(snapshot, fid) : fallbackEligibility(snapshot, fid);
  } catch(err) {
    console.error("risklegacy | rules.resourceDrawEligibility failed", err);
    eligibility = fallbackEligibility(snapshot, fid);
  }
  if ( eligibility?.ok && !ignoreTurnLimits ) {
    const limits = drawLimits(fid);
    if ( !limits.ok ) eligibility = limits;
  }
  eligibility ??= state.fail("RL.CardsUI.reason.noWar");

  const coins = coinCount();
  let choices;
  try {
    choices = ((typeof rules.resourceDrawChoices === "function") && snapshot)
      ? rules.resourceDrawChoices(snapshot, fid, row, { coinPileEmpty: !coins, homeland: homeland(fid) })
      : fallbackChoices(snapshot, fid, row);
  } catch(err) {
    console.error("risklegacy | rules.resourceDrawChoices failed", err);
    choices = fallbackChoices(snapshot, fid, row);
  }
  const allowed = new Set(choices?.territoryCardIds ?? []);
  const coinAllowed = !!choices?.coinAllowed && (coins > 0);
  const controlled = new Set(snapshot?.factions?.[fid]?.territories ?? []);
  return {
    faction: fid,
    eligible: !!eligibility.ok,
    result: eligibility,
    reason: eligibility.ok ? "" : state.reasonText(eligibility),
    row: row.map(r => ({ ...r, controlled: controlled.has(r.territory), allowed: allowed.has(r.cardId) })),
    territoryCardIds: [...allowed],
    coinAllowed,
    coinCount: coins,
    canDraw: !!eligibility.ok && ((allowed.size > 0) || coinAllowed)
  };
}

/* -------------------------------------------- */
/*  Row mechanics                               */
/* -------------------------------------------- */

/** Slide every row card left of `emptySlot` one slot to the right. */
async function slideRight(row, emptySlot) {
  const updates = row.cards.filter(c => c.system.slot < emptySlot).map(c => ({ _id: c.id, "system.slot": c.system.slot + 1 }));
  if ( updates.length ) await row.updateEmbeddedDocuments("Card", updates);
}

/**
 * Turn over the top territory card into slot 1, reshuffling the discard pile into a new draw pile when the deck
 * is empty (rulebook p. 12).
 * @returns {Promise<{card: Card|null, reshuffled: boolean}>}
 */
async function refillSlot(slot = 1) {
  const deck = requireStack("territoryDeck");
  const row = requireStack("row");
  let reshuffled = false;
  if ( !deck.availableCards.length ) {
    const discard = state.getCardStack("discard");
    const ids = discard?.cards.filter(c => c.origin === deck).map(c => c.id) ?? [];
    if ( ids.length ) {
      await discard.pass(deck, ids, { chatNotification: false });
      await deck.shuffle({ chatNotification: false });
      reshuffled = true;
    }
  }
  const top = topCard(deck);
  if ( !top ) return { card: null, reshuffled };
  await deck.pass(row, [top.id], { chatNotification: false, updateData: { system: { slot } } });
  return { card: row.cards.get(top.id) ?? null, reshuffled };
}

/** First time the coin pile is depleted in a game: Red Star to the faction controlling the most territories. */
async function awardCoinPileStar() {
  const war = state.getWar();
  if ( !war || war.system.coinPileDepleted ) return { awarded: false, faction: null };
  await war.update({ "system.coinPileDepleted": true });
  const snapshot = state.buildSnapshot();
  const contenders = Object.values(snapshot?.factions ?? {}).filter(f => f.active && (f.status !== "eliminated"));
  const max = Math.max(0, ...contenders.map(f => f.territories.length));
  const leaders = contenders.filter(f => f.territories.length === max);
  let winner = ((max > 0) && (leaders.length === 1)) ? leaders[0].id : null;
  const recipient = game.risklegacy?.rules?.coinPileStarRecipient;
  if ( (typeof recipient === "function") && snapshot ) {
    try {
      winner = recipient(snapshot) ?? null;
    } catch(err) { console.error("risklegacy | rules.coinPileStarRecipient failed", err); }
  }
  if ( winner && (snapshot?.factions?.[winner]?.territories.length > 0) ) {
    const actor = game.actors.get(winner);
    await actor.update({ "system.war.redStarTokens": actor.system.war.redStarTokens + 1 });
    await chat.post({
      kind: "coinPile", faction: actor, token: true,
      title: loc("RL.Sideboard.chat.coinPileTitle"),
      text: loc("RL.Sideboard.coinNote"),
      result: game.i18n.format("RL.Sideboard.chat.coinPileAward", { faction: actor.name, n: max })
    });
    return { awarded: true, faction: actor.id };
  }
  await chat.post({
    kind: "coinPile", title: loc("RL.Sideboard.chat.coinPileTitle"), text: loc("RL.Sideboard.coinNote"),
    result: loc("RL.Sideboard.chat.coinPileTie")
  });
  return { awarded: false, faction: null };
}

/* -------------------------------------------- */
/*  GM actions                                  */
/* -------------------------------------------- */

/**
 * [GM] Lay out the sideboard for a new game (rulebook p. 7): recall every card, shuffle the territory deck, refill
 * the coin pile, deal four territory cards to slots 1–4 (no event is triggered), reveal a mission if the mission
 * deck exists, shuffle the events. Scar and draft cards are not touched (they're dealt by their own steps).
 * @returns {Promise<{row: string[], missionId: string|null}>}
 */
export async function setupSideboard(payload = {}, { user } = {}) {
  requireGM(user ?? game.user);
  requireCampaign();
  if ( !Object.keys(CARD_STACKS).every(role => state.getCardStack(role)) ) await buildDecks({});
  const deck = requireStack("territoryDeck");
  const coinDeck = requireStack("coinDeck");
  const missionDeck = state.getCardStack("missionDeck");
  const missionSlot = state.getCardStack("missionSlot");

  await deck.recall({ chatNotification: false });
  await coinDeck.recall({ chatNotification: false });
  if ( missionDeck ) await missionDeck.recall({ chatNotification: false });
  if ( missionSlot?.cards.size ) await missionSlot.deleteEmbeddedDocuments("Card", missionSlot.cards.map(c => c.id));
  await addDeferredEvents();          // events put aside by packages opened during the last game
  await resetEventDeck();
  await deck.shuffle({ chatNotification: false });

  const row = [];
  for ( let slot = 1; slot <= ROW_SLOTS; slot++ ) {
    const { card } = await refillSlot(slot);
    if ( card ) row.push(card);
  }

  let missionId = null;
  if ( missionDeck?.cards.size ) {
    await missionDeck.shuffle({ chatNotification: false });
    missionId = (await revealMission({}, { user: game.user })).cardId;
  }

  await chat.post({
    kind: "setup",
    title: loc("RL.Sideboard.chat.setupTitle"),
    sub: game.i18n.format("RL.Sideboard.chat.setupSub", { deck: deck.availableCards.length, coins: coinCount() }),
    images: row.map(c => ({ img: c.currentFace?.img ?? c.img, alt: c.name, orientation: "portrait", caption: `${c.system.slot}` })),
    text: loc("RL.Sideboard.chat.setupText")
  });
  return { row: row.map(c => c.id), missionId };
}

/**
 * [GM] Draw a resource card at the end of a turn (rulebook p. 12), with the full sideboard mechanics.
 * @param {object} options
 * @param {string} options.faction
 * @param {string|null} [options.cardId]   a row card id; null/omitted = take a Coin card
 * @param {boolean} [options.force=false]  GM only: skip the eligibility rules (event-directed draws)
 * @returns {Promise<{cardId: string, eventCardId: string|null, coinPile: object|null}>}
 */
export async function drawResourceCard({ faction, cardId = null, coin = false, force = false }, { user } = {}) {
  user ??= game.user;
  const actor = requireFaction(faction);
  requireActFor(user, actor);
  if ( force ) requireGM(user);
  if ( !state.getHand(actor) ) await ensureHand({ faction: actor.id });
  const hand = requireHand(actor);
  const row = requireStack("row");
  const coinDeck = requireStack("coinDeck");
  const takeCoin = !cardId || coin;
  const options = drawOptions(actor);

  // Physical constraints apply in every enforcement mode
  if ( takeCoin && !options.coinCount ) throw new Error(loc("RL.CardsUI.reason.coinPileEmpty"));
  const picked = takeCoin ? null : row.cards.get(cardId);
  if ( !takeCoin && !picked ) throw new Error(loc("RL.CardsUI.error.notInRow"));

  // Rules
  if ( !force ) {
    gate(options.result);
    if ( takeCoin ) gate(options.coinAllowed ? state.ok() : state.fail("RL.CardsUI.reason.mustTakeTerritory"));
    else if ( !options.territoryCardIds.includes(cardId) ) {
      gate(state.fail("RL.CardsUI.reason.notControlled", { territory: picked.name }));
    }
  }

  const lines = [];
  let drawn;
  if ( takeCoin ) {
    const coinCard = topCard(coinDeck);
    const [created] = await coinDeck.pass(hand, [coinCard.id], { chatNotification: false });
    drawn = created ?? hand.cards.get(coinCard.id);
    const slot4 = row.cards.find(c => c.system.slot === ROW_SLOTS);
    const discard = state.getCardStack("discard");
    if ( slot4 && discard ) {
      await row.pass(discard, [slot4.id], { chatNotification: false, updateData: { system: { slot: 0 } } });
      lines.push(game.i18n.format("RL.Sideboard.chat.slot4Discarded", { name: slot4.name }));
    }
    await slideRight(row, ROW_SLOTS);
  }
  else {
    const slot = picked.system.slot;
    const [created] = await row.pass(hand, [picked.id], { chatNotification: false, updateData: { system: { slot: 0 } } });
    drawn = created ?? hand.cards.get(picked.id);
    await slideRight(row, slot);
  }

  // Refill slot 1
  const { card: revealed, reshuffled } = await refillSlot(1);
  if ( reshuffled ) lines.push(loc("RL.Sideboard.chat.reshuffled"));
  const triggersEvent = !!revealed && (revealed.system.value % 2 === 0) && hasEventDeck();
  if ( revealed ) {
    lines.push(game.i18n.format(triggersEvent ? "RL.Sideboard.chat.newSlot1Even" : "RL.Sideboard.chat.newSlot1", {
      name: revealed.name, n: revealed.system.value
    }));
  }
  else lines.push(loc("RL.Sideboard.chat.slot1Empty"));

  // Turn bookkeeping
  const war = state.getWar();
  if ( war && isCurrentFaction(actor) && !war.system.turn.cardDrawn ) await war.update({ "system.turn.cardDrawn": true });

  await chat.post({
    kind: takeCoin ? "coin" : "draw", faction: actor,
    title: takeCoin
      ? game.i18n.format("RL.Sideboard.chat.drawCoinTitle", { faction: actor.name })
      : game.i18n.format("RL.Sideboard.chat.drawTitle", { faction: actor.name, name: drawn.name }),
    sub: takeCoin
      ? game.i18n.format("RL.Sideboard.chat.coinsLeft", { n: coinCount() })
      : game.i18n.format("RL.Sideboard.chat.resources", { n: drawn.system.value }),
    images: [
      { img: drawn.currentFace?.img ?? drawn.img, alt: drawn.name, orientation: "portrait" },
      ...(revealed ? [{ img: revealed.currentFace?.img ?? revealed.img, alt: revealed.name, orientation: "portrait", caption: loc("RL.Sideboard.slot1"), even: triggersEvent }] : [])
    ],
    result: lines.join("<br>"),
    flags: { faction: actor.id, cardId: drawn.id, coin: takeCoin }
  });

  Hooks.callAll("risklegacy.cardDrawn", actor, drawn);

  // Coin pile depleted (first time this game)
  let coinPile = null;
  if ( takeCoin && !coinCount() ) coinPile = await awardCoinPileStar();

  // Even value in slot 1 → event
  let eventCardId = null;
  if ( triggersEvent ) eventCardId = (await revealEvent({ faction: actor.id })).eventCardId;

  return { cardId: drawn.id, eventCardId, coinPile };
}

/**
 * Close a gap in the row (a row card was destroyed): slide the cards on its left to the right and refill slot 1.
 * No event is triggered (events only follow a resource draw).
 * @param {number} slot  the emptied slot
 */
export async function closeRowGap(slot) {
  const row = state.getCardStack("row");
  if ( !row || !slot ) return;
  await slideRight(row, slot);
  await refillSlot(1);
}

/** Territory card names in the row, for messages. */
export function rowSummary() {
  return getRow().map(c => `${c.system.slot}: ${territoryName(c.system.territory)} (${c.system.value})`).join(", ");
}

