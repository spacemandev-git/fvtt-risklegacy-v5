import { RED_STARS_TO_WIN, SYSTEM_ID, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import * as catalog from "./catalog.mjs";
import * as chat from "./chat.mjs";
import { topCard } from "./events.mjs";
import { drawOptions } from "./sideboard.mjs";
import { deleteCardEverywhere, recordRemoved } from "./stacks.mjs";
import {
  factionId, gate, isCurrentFaction, loc, requireActFor, requireFaction, requireGM, textToHTML
} from "./util.mjs";

/**
 * Mission cards (rulebook p. 13): one face up in the MISSION slot; at the end of your turn, if you completed it,
 * take its reward (Red Star tokens) instead of drawing a resource card, and reveal the next mission.
 *
 * `missionStatus(faction)` evaluates the catalog's structured `check` where the board state allows it:
 *   "complete" | "incomplete" | "manual" (can't be decided automatically: the player confirms) | "none" (no mission).
 * Turn-based checks read `war.system.turn` and these optional per-turn records in `war.system.turn.flags`
 * (written by the turn/battle areas when available): conqueredIds[], conqueredViaSeaLine, conqueredCities,
 * and `discards[]` (written here by discardResources: {purpose, cards: [{type, value}]}).
 */

/** The mission card face up in the MISSION slot, or null. */
export function currentMission() {
  return state.getCardStack("missionSlot")?.cards.contents[0] ?? null;
}

/** Territories connected to others only by sea lines (the "islands" of Explore the World). */
function islands(board) {
  if ( !board ) return [];
  const sea = new Set((board.seaLines ?? []).flatMap(l => [`${l.a}|${l.b}`, `${l.b}|${l.a}`]));
  return board.ids.filter(id => {
    const n = [...board.neighbors(id)];
    return n.length && n.every(o => sea.has(`${id}|${o}`));
  });
}

/**
 * Evaluate a structured mission check.
 * @returns {{complete: boolean|null, progress: string}}
 */
export function evaluateCheck(check, snapshot, fid, { drawOptions } = {}) {
  const fs = snapshot?.factions?.[fid];
  if ( !check || !snapshot || !fs ) return { complete: null, progress: "" };
  const count = check.count ?? 1;
  const turn = snapshot.turn;
  const myTurn = turn?.faction === fid;
  const log = myTurn ? (turn.log ?? {}) : {};
  const flags = log.flags ?? {};
  const T = snapshot.territories;
  const frac = (n, of) => `${n} / ${of}`;
  switch ( check.type ) {
    case "continentBonusTotal": {
      const playerId = fs.playerId;
      const total = fs.continents.reduce((n, c) => {
        const cont = snapshot.continents[c];
        return n + (cont?.value ?? 0) + ((playerId && (cont?.namedById === playerId)) ? 1 : 0);
      }, 0);
      return { complete: total >= count, progress: frac(total, count) };
    }
    case "controlTerritoriesWithCities": {
      const n = fs.territories.filter(t => T[t]?.city).length;
      return { complete: n >= count, progress: frac(n, count) };
    }
    case "controlAllCities": {
      const cities = Object.values(T).filter(t => t.city);
      const mine = cities.filter(t => t.owner === fid).length;
      return { complete: !!cities.length && (mine === cities.length), progress: frac(mine, cities.length) };
    }
    case "controlAllScarred": {
      const scarred = Object.values(T).filter(t => t.scar && (check.scars ?? []).includes(t.scar));
      const mine = scarred.filter(t => t.owner === fid).length;
      return { complete: !!scarred.length && (mine === scarred.length), progress: frac(mine, scarred.length) };
    }
    case "controlContinents": {
      const n = fs.continents.length;
      if ( check.when === "startOfTurn" ) {
        const start = flags.startContinents;
        if ( Array.isArray(start) ) return { complete: start.length >= count, progress: frac(start.length, count) };
        return { complete: null, progress: frac(n, count) };
      }
      return { complete: n >= count, progress: frac(n, count) };
    }
    case "controlIslands": {
      const isl = islands(snapshot.board);
      const n = isl.filter(t => T[t]?.owner === fid).length;
      return { complete: n >= count, progress: frac(n, count) };
    }
    case "conquerThisTurn": {
      let n;
      if ( check.via === "seaLine" ) n = flags.conqueredViaSeaLine;
      else if ( check.cities ) n = flags.conqueredCities;
      else n = log.conquered ?? 0;
      if ( !myTurn ) return { complete: false, progress: frac(0, count) };
      if ( !Number.isFinite(n) ) return { complete: null, progress: "" };
      return { complete: n >= count, progress: frac(n, count) };
    }
    case "conquerContinentThisTurn": {
      if ( !myTurn ) return { complete: false, progress: "" };
      const ids = flags.conqueredIds;
      if ( !Array.isArray(ids) ) return { complete: null, progress: "" };
      const set = new Set(ids);
      const n = Object.values(snapshot.continents).filter(c => c.territories.length && c.territories.every(t => set.has(t))).length;
      return { complete: n >= count, progress: frac(n, count) };
    }
    case "eligibleTerritoryCard": {
      if ( !drawOptions ) return { complete: null, progress: "" };
      const best = drawOptions.row.filter(r => r.allowed).reduce((m, r) => Math.max(m, r.value ?? 0), 0);
      return { complete: drawOptions.eligible && (best >= (check.minResources ?? 1)), progress: `${best}` };
    }
    case "turnInResources":
    case "turnInCards": {
      if ( !myTurn ) return { complete: false, progress: "" };
      const discards = (flags.discards ?? []).filter(d => d.purpose === "troops");
      if ( !Array.isArray(flags.discards) ) return { complete: null, progress: "" };
      const cards = discards.flatMap(d => d.cards ?? []);
      if ( check.type === "turnInResources" ) {
        const n = cards.reduce((s, c) => s + (c.value ?? 0), 0);
        return { complete: n >= count, progress: frac(n, count) };
      }
      const n = cards.filter(c => (!check.cardType || c.type === check.cardType) && ((c.value ?? 0) >= (check.minResourcesEach ?? 0))).length;
      return { complete: n >= count, progress: frac(n, count) };
    }
    default:
      return { complete: null, progress: "" };
  }
}

/**
 * Status of the face-up mission for a faction (sync).
 * @param {Actor|string} faction
 * @returns {{mission: Card|null, missionId: string|null, name: string, reward: number, check: object|null,
 *   status: "complete"|"incomplete"|"manual"|"none", progress: string, canComplete: boolean, reason: string}}
 */
export function missionStatus(faction) {
  const card = currentMission();
  const fid = factionId(faction);
  if ( !card ) return { mission: null, missionId: null, name: "", reward: 0, check: null, status: "none", progress: "", canComplete: false, reason: "" };
  const snapshot = state.buildSnapshot();
  const options = drawOptions(fid, { ignoreTurnLimits: true });
  const result = evaluateCheck(card.system.check, snapshot, fid, { drawOptions: options });
  // The rules engine's verdict wins when it can decide (it reads the turn record the turn area keeps)
  const engine = game.risklegacy?.rules?.missionCheck;
  if ( (typeof engine === "function") && snapshot && card.system.check ) {
    try {
      const verdict = engine(snapshot, fid, card.system.check);
      if ( (verdict === true) || (verdict === false) ) result.complete = verdict;
    } catch(err) { console.error("risklegacy | rules.missionCheck failed", err); }
  }
  const status = result.complete === true ? "complete" : (result.complete === false ? "incomplete" : "manual");
  const limits = turnLimits(fid);
  return {
    mission: card, missionId: card.id, name: card.name, reward: card.system.reward, check: card.system.check,
    status, progress: result.progress,
    canComplete: (status !== "incomplete") && limits.ok,
    reason: limits.ok ? "" : state.reasonText(limits)
  };
}

/**
 * The sea-line sticker a mission card carries (Explore the World: "Place the 2 sea-line start stickers…"): a catalog
 * sticker with a `seaLine` effect printed on the same card (same code), or the known mission id.
 * @param {Card} card
 * @returns {string|null} inventory sticker id
 */
function missionSeaLineSticker(card) {
  if ( card.system.catalogId === "explore_the_world" ) return "sea_line_start";
  const code = card.getFlag(SYSTEM_ID, "code");
  if ( !code ) return null;
  for ( const pack of state.allPacks() ) {
    const sticker = (pack.stickers ?? []).find(s => (s.code === code) && (s.effect?.type === "seaLine") && !s.effect?.to);
    if ( sticker ) return sticker.id;
  }
  return null;
}

/** Per-turn limits for completing a mission (your own turn, once, not after drawing a card). */
function turnLimits(fid) {
  const war = state.getWar();
  if ( !war || (war.system.stage !== "playing") ) return state.ok();
  if ( !isCurrentFaction(fid) ) return state.fail("RL.CardsUI.reason.notYourTurn");
  if ( war.system.turn.missionCompleted ) return state.fail("RL.CardsUI.reason.missionAlreadyCompleted");
  if ( war.system.turn.cardDrawn ) return state.fail("RL.CardsUI.reason.drewThisTurn");
  return state.ok();
}

/**
 * [GM] Put a mission face up in the MISSION slot.
 * @param {object} [options]
 * @param {boolean} [options.replace=false]  discard (box) the current mission and reshuffle the deck first
 * @param {string} [options.cardId]          a specific mission card from the deck (e.g. the lead faction's choice)
 * @returns {Promise<{cardId: string|null}>}
 */
export async function revealMission({ replace = false, cardId = null } = {}, { user } = {}) {
  requireGM(user ?? game.user);
  const deck = state.getCardStack("missionDeck");
  const slot = state.getCardStack("missionSlot");
  if ( !deck || !slot ) return { cardId: null };
  const current = slot.cards.contents[0];
  if ( current && !replace ) return { cardId: current.id };
  if ( current ) {
    await slot.deleteEmbeddedDocuments("Card", slot.cards.map(c => c.id));
    await deck.shuffle({ chatNotification: false });
  }
  const pick = cardId ? deck.availableCards.find(c => c.id === cardId) : topCard(deck);
  if ( !pick ) return { cardId: null };
  await deck.pass(slot, [pick.id], { chatNotification: false });
  await chat.post({
    kind: "mission",
    title: game.i18n.format("RL.Sideboard.chat.missionTitle", { name: pick.name }),
    sub: game.i18n.format("RL.Sideboard.chat.missionReward", { n: pick.system.reward }),
    images: [{ img: pick.currentFace?.img ?? pick.img, alt: pick.name, orientation: "landscape" }],
    text: textToHTML(pick.system.text),
    flags: { cardId: pick.id, catalogId: pick.system.catalogId }
  });
  return { cardId: pick.id };
}

/**
 * [GM] Complete the face-up mission: Red Star tokens, the card goes back in the box (or is destroyed), next mission.
 * @param {object} options
 * @param {string} options.faction
 * @returns {Promise<{missionCardId: string, reward: number, nextMissionId: string|null, sticker: string|null}>}
 */
export async function completeMission({ faction }, { user } = {}) {
  const actor = requireFaction(faction);
  requireActFor(user ?? game.user, actor);
  const card = currentMission();
  if ( !card ) throw new Error(loc("RL.CardsUI.error.noMission"));
  const status = missionStatus(actor);
  gate(turnLimits(actor.id));
  if ( status.status === "incomplete" ) gate(state.fail("RL.CardsUI.reason.missionIncomplete", { name: card.name }));

  const reward = card.system.reward ?? 1;
  await actor.update({ "system.war.redStarTokens": actor.system.war.redStarTokens + reward });

  // Where the card goes
  const after = card.getFlag(SYSTEM_ID, "afterComplete") ?? "box";
  const slot = state.getCardStack("missionSlot");
  let sticker = null;
  let destroy = after === "destroy";
  if ( after === "destroyIfStickerApplied" ) {
    const powerId = card.getFlag(SYSTEM_ID, "power");
    const hasMissionPower = actor.items.some(i => (i.type === "power") && (i.system.slot === "mission"));
    const power = powerId ? catalog.entry("powers", powerId) : null;
    if ( power && !hasMissionPower ) {
      await actor.createEmbeddedDocuments("Item", [{
        name: power.name, type: "power", img: power.img ? systemPath(power.img) : undefined,
        system: { slot: "mission", text: power.text ?? "", faction: actor.system.key, pack: card.system.pack, key: power.id, timing: power.timing ?? "" }
      }]);
      sticker = power.id;
      destroy = true;
    }
  }
  if ( destroy ) {
    await recordRemoved("mission", card.system.catalogId);
    await deleteCardEverywhere(card.id);
  }
  else await slot.deleteEmbeddedDocuments("Card", [card.id]);

  const war = state.getWar();
  if ( war && isCurrentFaction(actor) ) await war.update({ "system.turn.missionCompleted": true });

  await chat.post({
    kind: "missionComplete", faction: actor, token: true,
    title: game.i18n.format("RL.Sideboard.chat.missionCompleteTitle", { name: card.name }),
    sub: game.i18n.format("RL.Sideboard.chat.missionReward", { n: reward }),
    images: [{ img: card.currentFace?.img ?? card.img, alt: card.name, orientation: "landscape" }],
    result: [
      game.i18n.format("RL.Sideboard.chat.missionCompleted", { faction: actor.name, n: reward }),
      destroy ? loc("RL.Sideboard.chat.missionDestroyed") : loc("RL.Sideboard.chat.missionBoxed"),
      sticker ? loc("RL.Sideboard.chat.missionSticker") : ""
    ].filter(Boolean).join(" ")
  });

  // Sea-line start stickers carried by the mission (Explore the World): the completing faction's player draws the
  // new connection on their own screen. Not awaited: the player's choice must not hold the card queue.
  const seaLine = missionSeaLineSticker(card);
  if ( seaLine && (typeof game.risklegacy.campaign?.offerSeaLine === "function") ) {
    Promise.resolve(game.risklegacy.campaign.offerSeaLine({ faction: actor.id, sticker: seaLine, reason: card.name }))
      .catch(err => console.error("risklegacy | Explore the World sea line", err));
  }

  // Packs opened by the mission ("The world is ready" → World Capital)
  const opens = card.getFlag(SYSTEM_ID, "opens");
  if ( opens && (typeof game.risklegacy.campaign?.triggerPack === "function") ) {
    // Not awaited: the campaign asks the GM to open the package, which must not hold the card queue.
    Promise.resolve(game.risklegacy.campaign.triggerPack(opens, { reason: card.name })).catch(err => console.error(err));
  }

  // Next mission, unless the game is over
  let nextMissionId = null;
  const total = state.buildSnapshot()?.factions?.[actor.id]?.redStars?.total ?? 0;
  if ( (total < RED_STARS_TO_WIN) && (war?.system.stage !== "ended") ) {
    nextMissionId = (await revealMission({}, { user: game.user })).cardId;
  }
  return { missionCardId: card.id, reward, nextMissionId, sticker };
}
