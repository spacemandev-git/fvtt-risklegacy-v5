import { SYSTEM_ID } from "../config.mjs";
import { augmentBoard, getBoard } from "./boards.mjs";

/**
 * Synchronous lookups of the world documents the system works with. Safe to call any time after `ready`.
 * None of these create documents; the campaign builder (module/campaign/) does that and records ids in
 * `campaign.system.documents` and the `campaignActorId` setting.
 */

/** @returns {Actor|null} the campaign actor */
export function getCampaign() {
  const id = game.settings.get(SYSTEM_ID, "campaignActorId");
  return (id && game.actors.get(id)) || game.actors.find(a => a.type === "campaign") || null;
}

/** @returns {string} the campaign's board variant ("original" if there is no campaign yet) */
export function getBoardVariant() {
  return getCampaign()?.system.boardVariant ?? "original";
}

/**
 * The campaign's board: the loaded board definition for its variant, plus the territories and sea lines added during
 * the campaign (Alien Island, Explore the World…). Use this, not getBoard(), for anything about the world in play.
 * @returns {object|null}
 */
export function getCampaignBoard() {
  const campaign = getCampaign();
  const base = getBoard(getBoardVariant());
  if ( !campaign || !base ) return base;
  return augmentBoard(base, {
    seaLines: campaign.system.seaLines ?? [],
    customTerritories: campaign.system.customTerritories ?? {}
  });
}

/**
 * A world document created for the campaign, by role.
 * @param {string} role  a CARD_STACKS key, "scene", "rulebook" or "war"
 * @returns {Document|null}
 */
export function getCampaignDocument(role) {
  const id = getCampaign()?.system.documents?.[role];
  if ( !id ) return null;
  switch ( role ) {
    case "scene": return game.scenes.get(id) ?? null;
    case "rulebook": return game.journal.get(id) ?? null;
    case "war": return game.combats.get(id) ?? null;
    default: return game.cards.get(id) ?? null;
  }
}

/** @returns {Scene|null} the world board scene */
export function getBoardScene() {
  return getCampaignDocument("scene") ?? game.scenes.find(s => s.getFlag(SYSTEM_ID, "board")) ?? null;
}

/**
 * A Cards stack by role (CARD_STACKS key).
 * @param {string} role
 * @returns {Cards|null}
 */
export function getCardStack(role) {
  return getCampaignDocument(role) ?? game.cards.find(c => c.getFlag(SYSTEM_ID, "role") === role) ?? null;
}

/**
 * A faction's hand of cards.
 * @param {Actor|string} faction  actor or actor id
 * @returns {Cards|null}
 */
export function getHand(faction) {
  const id = typeof faction === "string" ? faction : faction?.id;
  return game.cards.find(c => (c.type === "hand") && (c.getFlag(SYSTEM_ID, "faction") === id)) ?? null;
}

/**
 * Faction actors.
 * @param {object} [options]
 * @param {boolean} [options.active]  only factions taking part in the current war
 * @returns {Actor[]} sorted by seat when active, otherwise by name
 */
export function getFactions({ active = false } = {}) {
  const all = game.actors.filter(a => a.type === "faction");
  if ( !active ) return all.sort((a, b) => a.name.localeCompare(b.name));
  return all.filter(a => a.system.war.active).sort((a, b) => a.system.war.seat - b.system.war.seat);
}

/** @returns {Actor|null} the faction actor with this catalog key */
export function getFactionByKey(key) {
  return game.actors.find(a => (a.type === "faction") && (a.system.key === key)) ?? null;
}

/**
 * The current war: the one in progress, or one that has ended but whose results the end-game wizard hasn't recorded
 * yet (the campaign clears `system.documents.war` when it records the game). Check `war.system.stage`.
 * @returns {Combat|null}
 */
export function getWar() {
  const recorded = getCampaignDocument("war");
  if ( recorded && (recorded.type === "war") ) return recorded;
  return game.combats.find(c => (c.type === "war") && (c.system.stage !== "ended")) ?? null;
}

/** @returns {Actor|null} the faction whose turn it is */
export function currentFaction() {
  const war = getWar();
  if ( !war || (war.system.stage !== "playing") ) return null;
  return war.combatant?.actor ?? null;
}

/**
 * The faction a user plays in the current war.
 * @param {User} [user]
 * @returns {Actor|null}
 */
export function factionOfUser(user = game.user) {
  return getFactions({ active: true }).find(a => a.system.war.playerId === user.id) ?? null;
}

/**
 * May this user act for this faction? GMs may act for anyone (hot-seat and corrections).
 * @param {User} user
 * @param {Actor|string} faction
 */
export function canActFor(user, faction) {
  const actor = typeof faction === "string" ? game.actors.get(faction) : faction;
  if ( !actor ) return false;
  return user.isGM || (actor.system.war?.playerId === user.id) || actor.testUserPermission(user, "OWNER");
}

/** Is it this user's faction's turn (GMs: is anyone's turn in progress)? */
export function isMyTurn(user = game.user) {
  const faction = currentFaction();
  return !!faction && canActFor(user, faction);
}

/** The piece kind of a token ("troop" | "triple" | "hq") or null if it isn't a piece. */
export function pieceKind(tokenDoc) {
  return tokenDoc?.getFlag?.(SYSTEM_ID, "piece") ?? tokenDoc?.flags?.[SYSTEM_ID]?.piece ?? null;
}
