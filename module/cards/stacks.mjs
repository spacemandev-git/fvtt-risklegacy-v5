import { CARD_STACKS, SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as catalog from "./catalog.mjs";
import * as data from "./carddata.mjs";
import { LEVELS, SECRET_STACKS, factionActor, loc, requireCampaign, requireFaction } from "./util.mjs";

/**
 * Building and maintaining the Cards stacks (ARCHITECTURE §5.5 buildDecks / addPackCards / ensureHand).
 *
 * Persistent card facts that must survive a deck rebuild live on the campaign actor:
 *   - territory card values: system.cards.values.<territoryId> (upgrades, pre-game coin stickers)
 *   - permanently removed cards: system.cards.removed["<type>:<catalogId>"] = count (played scars,
 *     destroyed missions/events).
 * Worlds created before the schema field existed kept these in flags[SYSTEM_ID].cards; reads merge both. Destroyed territory cards use campaign.system.territories.<id>.cardDestroyed.
 */

const STACK_IMAGES = {
  territoryDeck: "assets/unlocks/base/territories/images/resource_card.jpg",
  coinDeck: "assets/unlocks/base/territories/images/coin_card.jpg",
  row: "assets/unlocks/base/territories/images/resource_card.jpg",
  discard: "assets/unlocks/base/territories/images/resource_card.jpg",
  missionSlot: "assets/icons/star.png",
  missionDeck: "assets/icons/star.png"
};

const FOLDER_FLAG = "cardsFolder";

/* -------------------------------------------- */
/*  Campaign records                            */
/* -------------------------------------------- */

/** @returns {{values: Object<string, number>, removed: Object<string, number>}} */
export function campaignRecord(campaign = state.getCampaign()) {
  const legacy = campaign?.flags?.[SYSTEM_ID]?.cards ?? {};
  const rec = campaign?.system?.cards ?? {};
  return {
    values: { ...(legacy.values ?? {}), ...(rec.values ?? {}) },
    removed: { ...(legacy.removed ?? {}), ...(rec.removed ?? {}) }
  };
}

/** Recorded current value of a territory card, or null. */
export function recordedValue(territory, campaign = state.getCampaign()) {
  const v = campaignRecord(campaign).values[territory];
  return Number.isFinite(v) ? v : null;
}

/** Record a territory card's value on the campaign. */
export async function recordValue(territory, value, campaign = requireCampaign()) {
  await campaign.update({ [`system.cards.values.${territory}`]: value });
}

/** Record that `count` copies of a catalog card were permanently removed (played scar, destroyed card…). */
export async function recordRemoved(type, catalogId, count = 1, campaign = requireCampaign()) {
  const key = `${type}:${catalogId}`;
  const current = campaignRecord(campaign).removed[key] ?? 0;
  await campaign.update({ [`system.cards.removed.${key}`]: current + count });
}

/* -------------------------------------------- */
/*  Stacks                                      */
/* -------------------------------------------- */

/** The Cards folder for the campaign's stacks (created on demand). */
async function ensureFolder() {
  const existing = game.folders.find(f => (f.type === "Cards") && f.getFlag(SYSTEM_ID, FOLDER_FLAG));
  if ( existing ) return existing;
  return foundry.documents.Folder.implementation.create({
    name: loc("RL.CardsUI.folder"), type: "Cards", color: "#b11116", flags: { [SYSTEM_ID]: { [FOLDER_FLAG]: true } }
  });
}

/** Default ownership of a sideboard stack. */
function stackOwnership(role) {
  const L = LEVELS();
  return { default: SECRET_STACKS.has(role) ? L.LIMITED : L.OBSERVER };
}

/** Find the stack for a role, or create it. */
async function ensureStack(role, folder) {
  const existing = state.getCardStack(role);
  if ( existing ) return existing;
  const def = CARD_STACKS[role];
  return foundry.documents.Cards.implementation.create({
    name: loc(def.label),
    type: def.type,
    img: STACK_IMAGES[role] ? systemPath(STACK_IMAGES[role]) : undefined,
    folder: folder?.id ?? null,
    displayCount: true,
    ownership: stackOwnership(role),
    flags: { [SYSTEM_ID]: { role } }
  });
}

/** Count the home cards of a deck per catalog id. */
function countByCatalog(deck) {
  const counts = {};
  for ( const card of deck.cards ) {
    const id = card.system?.catalogId;
    if ( id ) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/**
 * Create the cards of one pack that are missing from their decks.
 * @returns {Promise<Object<string, number>>} cards added per role
 */
/**
 * Packages opened in the middle of a game whose event cards are "put aside" and only join the event deck at the next
 * game's setup (war progresses: Pocket 1's 8 Mutant events, Pocket 2's 7 Alien events).
 */
const EVENTS_NEXT_GAME = new Set(["threemissiles", "thirtytroops"]);
const DEFERRED_FLAG = "deferredEventPacks";

/** @returns {string[]} packs whose event cards are waiting for the next game */
export function deferredEventPacks(campaign = state.getCampaign()) {
  return [...(campaign?.getFlag(SYSTEM_ID, DEFERRED_FLAG) ?? [])];
}

/**
 * [GM] At a game's setup: add the event cards that were put aside when their package opened mid-game.
 * @returns {Promise<string[]>} the packs whose events were added
 */
export async function addDeferredEvents(campaign = state.getCampaign()) {
  const packs = deferredEventPacks(campaign);
  if ( !packs.length ) return [];
  for ( const pack of packs ) {
    await fillFromPack(pack, { variant: campaign.system.boardVariant ?? "original", campaign, deferEvents: false });
  }
  await campaign.unsetFlag(SYSTEM_ID, DEFERRED_FLAG);
  return packs;
}

async function fillFromPack(packId, { variant, campaign, deferEvents = true }) {
  const p = catalog.pack(packId);
  if ( !p ) return {};
  // Opened during a game: its events wait for the next game (see EVENTS_NEXT_GAME)
  const stage = state.getWar()?.system.stage;
  const skipEvents = deferEvents && EVENTS_NEXT_GAME.has(packId) && ["placement", "playing"].includes(stage)
    && !!p.events?.length;
  if ( skipEvents ) {
    const deferred = new Set(deferredEventPacks(campaign));
    deferred.add(packId);
    await campaign.setFlag(SYSTEM_ID, DEFERRED_FLAG, [...deferred]);
  }
  const removed = campaignRecord(campaign).removed;
  const added = {};
  const create = async (role, list) => {
    if ( !list.length ) return;
    const deck = state.getCardStack(role);
    if ( !deck ) return;
    const sortBase = deck.cards.size;
    list.forEach((c, i) => c.sort = sortBase + i);
    await deck.createEmbeddedDocuments("Card", list);
    added[role] = (added[role] ?? 0) + list.length;
  };

  // Territory cards (one each; destroyed cards never come back)
  if ( p.territoryCards?.length ) {
    const deck = state.getCardStack("territoryDeck");
    const have = new Set(deck?.cards.map(c => c.system.territory) ?? []);
    const list = p.territoryCards
      .filter(t => !have.has(t.id) && !campaign.system.territories?.[t.id]?.cardDestroyed)
      .map(t => data.territoryCard(t, { variant, value: recordedValue(t.id, campaign) ?? t.value, pack: packId }));
    await create("territoryDeck", list);
  }

  // Coin cards
  if ( p.coinCards?.count ) {
    const deck = state.getCardStack("coinDeck");
    const have = deck?.cards.filter(c => c.type === "coin").length ?? 0;
    const need = p.coinCards.count - (removed["coin:coin"] ?? 0) - have;
    await create("coinDeck", Array.from({ length: Math.max(0, need) }, () => data.coinCard(p.coinCards, packId)));
  }

  // Quantity-based decks
  const byQty = [
    ["scars", "scarDeck", "scar", data.scarCard],
    ["missions", "missionDeck", "mission", data.missionCard],
    ["events", "eventDeck", "event", data.eventCard],
    ["draft", "draftDeck", "draft", data.draftCard]
  ];
  for ( const [category, role, type, build] of byQty ) {
    const entries = p[category] ?? [];
    if ( !entries.length ) continue;
    if ( (category === "events") && skipEvents ) continue;
    const deck = state.getCardStack(role);
    if ( !deck ) continue;
    const have = countByCatalog(deck);
    const list = [];
    for ( const e of entries ) {
      const qty = Math.max(0, (e.qty ?? 1) - (removed[`${type}:${e.id}`] ?? 0) - (have[e.id] ?? 0));
      for ( let i = 0; i < qty; i++ ) list.push(build(e, packId));
    }
    await create(role, list);
  }
  return added;
}

/** Bring territory card faces in line with the board variant (when the campaign's variant changed). */
async function refreshTerritoryFaces(variant) {
  const deck = state.getCardStack("territoryDeck");
  if ( !deck ) return;
  const updates = [];
  for ( const card of deck.cards ) {
    if ( card.type !== "territory" ) continue;
    const e = catalog.entry("territoryCards", card.system.territory);
    if ( !e ) continue;
    const faces = catalog.territoryFaces(e, variant).map(img => systemPath(img));
    const source = card.toObject().faces;
    if ( faces.every((img, i) => source[i]?.img === img) ) continue;
    updates.push({ _id: card.id, faces: faces.map((img, i) => ({ ...(source[i] ?? { name: card.name, text: "" }), img })) });
  }
  if ( !updates.length ) return;
  await deck.updateEmbeddedDocuments("Card", updates);
  for ( const stack of game.cards ) {
    if ( stack === deck ) continue;
    const copies = updates.filter(u => stack.cards.has(u._id));
    if ( copies.length ) await stack.updateEmbeddedDocuments("Card", copies);
  }
}

/**
 * [GM] Create every CARD_STACKS stack (missing ones only) and fill them from the opened packs.
 * @param {object} [options]
 * @param {string} [options.variant]  board variant for territory card faces (default: the campaign's)
 * @returns {Promise<Object<string, string>>} {role: id}
 */
export async function buildDecks({ variant } = {}) {
  const campaign = requireCampaign();
  variant ??= campaign.system.boardVariant ?? "original";
  const folder = await ensureFolder();
  const ids = {};
  const updates = {};
  for ( const role of Object.keys(CARD_STACKS) ) {
    const stack = await ensureStack(role, folder);
    ids[role] = stack.id;
    if ( campaign.system.documents?.[role] !== stack.id ) updates[`system.documents.${role}`] = stack.id;
  }
  if ( !foundry.utils.isEmpty(updates) ) await campaign.update(updates);

  let added = 0;
  for ( const packId of catalog.openedPackIds(campaign) ) {
    const result = await fillFromPack(packId, { variant, campaign });
    added += Object.values(result).reduce((a, b) => a + b, 0);
  }
  await refreshTerritoryFaces(variant);
  if ( added ) {
    for ( const role of ["territoryDeck", "scarDeck", "missionDeck", "eventDeck"] ) {
      const deck = state.getCardStack(role);
      if ( deck?.cards.size ) await deck.shuffle({ chatNotification: false });
    }
  }
  return ids;
}

/**
 * [GM] Add a newly opened pack's cards to the decks. New events and territory cards are shuffled into what is
 * left of their deck (rulebook p. 13).
 * @param {object} options
 * @param {string} options.pack
 * @returns {Promise<{added: Object<string, number>}>}
 */
export async function addPackCards({ pack }) {
  const campaign = requireCampaign();
  if ( !Object.keys(CARD_STACKS).every(role => state.getCardStack(role)) ) await buildDecks({});
  const added = await fillFromPack(pack, { variant: campaign.system.boardVariant ?? "original", campaign });
  for ( const role of Object.keys(added) ) {
    const deck = state.getCardStack(role);
    if ( deck?.type === "deck" ) await deck.shuffle({ chatNotification: false });
  }
  return { added };
}

/* -------------------------------------------- */
/*  Hands                                       */
/* -------------------------------------------- */

/**
 * Hand ownership: OWNER for the faction's player (and the actor's owners), LIMITED for everyone else, so the
 * hand's size is public and its faces are not.
 * @param {Actor} actor  faction
 */
export function handOwnership(actor) {
  const L = LEVELS();
  const ownership = { default: L.LIMITED };
  for ( const user of game.users ) {
    if ( user.isGM ) continue;
    const owns = (actor.system.war?.playerId === user.id) || (actor.getUserLevel(user) >= L.OWNER);
    ownership[user.id] = owns ? L.OWNER : L.LIMITED;
  }
  return ownership;
}

/** Update a faction hand's ownership if it changed. */
export async function syncHandOwnership(actor) {
  const hand = state.getHand(actor);
  if ( !hand ) return;
  const wanted = handOwnership(actor);
  const changed = Object.entries(wanted).some(([k, v]) => hand.ownership[k] !== v);
  if ( changed ) await hand.update({ ownership: wanted });
}

/**
 * [GM] Find or create a faction's hand.
 * @param {object} options
 * @param {string} options.faction  faction actor id
 * @returns {Promise<string>} hand id
 */
export async function ensureHand({ faction }) {
  const actor = requireFaction(faction);
  const existing = state.getHand(actor);
  if ( existing ) {
    await syncHandOwnership(actor);
    return existing.id;
  }
  const folder = await ensureFolder();
  const hand = await foundry.documents.Cards.implementation.create({
    name: game.i18n.format("RL.Cards.hand", { faction: actor.name }),
    type: "hand",
    img: actor.img,
    folder: folder?.id ?? null,
    displayCount: true,
    ownership: handOwnership(actor),
    flags: { [SYSTEM_ID]: { role: "hand", faction: actor.id } }
  });
  return hand.id;
}

/** Keep hand ownership in sync with the faction's player (active GM only). */
export function onUpdateActor(actor, changed) {
  if ( !game.user.isActiveGM || (actor.type !== "faction") ) return;
  const relevant = foundry.utils.hasProperty(changed, "system.war.playerId") || ("ownership" in changed);
  if ( relevant ) syncHandOwnership(actor).catch(err => console.error(err));
  if ( ("name" in changed) ) {
    const hand = state.getHand(actor);
    if ( hand ) hand.update({ name: game.i18n.format("RL.Cards.hand", { faction: actor.name }) }).catch(() => {});
  }
}

/* -------------------------------------------- */
/*  Card helpers                                */
/* -------------------------------------------- */

/** Every stack holding a card with this id (the home deck first). */
export function stacksWithCard(cardId) {
  return game.cards.filter(s => s.cards.has(cardId)).sort((a, b) => (b.type === "deck") - (a.type === "deck"));
}

/** Update a card in its home deck and every copy of it. */
export async function updateCardEverywhere(cardId, update) {
  for ( const stack of stacksWithCard(cardId) ) {
    await stack.updateEmbeddedDocuments("Card", [{ _id: cardId, ...update }]);
  }
}

/** Delete a card everywhere (copies first, then the home card). */
export async function deleteCardEverywhere(cardId) {
  const stacks = stacksWithCard(cardId).reverse();
  for ( const stack of stacks ) await stack.deleteEmbeddedDocuments("Card", [cardId]);
}

/** The faction actor owning a hand stack. */
export function handFaction(stack) {
  return factionActor(stack?.getFlag(SYSTEM_ID, "faction"));
}
