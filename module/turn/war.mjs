import { STARTING_TROOPS, SYSTEM_ID } from "../config.mjs";
import { buildSnapshot, getBoardScene, getCampaign, getFactions, getWar } from "../state/_module.mjs";
import * as rules from "../rules/_module.mjs";
import WarData from "../data/combat-war.mjs";
import { continentName, factionText, postCard, territoryName } from "./chat.mjs";
import {
  activeFactionId, api, assertCanAct, assertGM, callApi, esc, gate, isOut, replaceTurn, requireWar, safely, snapshot, t
} from "./util.mjs";

/**
 * War lifecycle (ARCHITECTURE §5.2): create → placement → playing (turns) → ended.
 * Handlers run on the active GM (registered as GM actions in _module.mjs).
 */

/* -------------------------------------------- */
/*  Create                                      */
/* -------------------------------------------- */

/**
 * [GM] Create the war for the next game.
 * @param {object} payload
 * @param {{faction: string, userId: string, seat?: number}[]} payload.participants
 * @param {boolean} [payload.replace=false]  end a war still in progress instead of refusing
 * @param {{user: User}} context
 * @returns {Promise<{war: string, game: number}>}
 */
export async function createWar({ participants = [], replace = false } = {}, { user }) {
  assertGM(user);
  const campaign = getCampaign();
  if ( !campaign ) throw new Error(t("RL.Error.noCampaign"));
  const current = getWar();
  if ( current && (current.system.stage !== "ended") ) {
    if ( !replace ) throw new Error(t("RL.Turn.Error.warInProgress"));
    await current.update({ "system.stage": "ended", active: false });
  }

  // Participants, in seat order
  const seen = new Set();
  const list = participants.map((p, i) => {
    const actor = game.actors.get(p.faction);
    if ( !actor || (actor.type !== "faction") ) throw new Error(t("RL.Turn.Error.noFaction", { id: p.faction ?? "" }));
    if ( seen.has(actor.id) ) throw new Error(t("RL.Turn.Error.duplicateFaction", { faction: actor.name }));
    seen.add(actor.id);
    const player = p.userId ? game.users.get(p.userId) : null;
    return { actor, userId: player?.id ?? "", playerName: player?.name ?? p.playerName ?? "", seat: p.seat ?? i };
  }).sort((a, b) => a.seat - b.seat);
  if ( !list.length ) throw new Error(t("RL.Turn.Error.noParticipants"));
  list.forEach((p, i) => p.seat = i);

  const gameNumber = campaign.system.nextGameNumber;
  const mutantsPlaying = list.some(p => p.actor.system.key === "mutants");

  // Faction war state: Red Star token or one Missile per signature (rulebook p.7)
  for ( const actor of getFactions() ) {
    const p = list.find(l => l.actor === actor);
    const update = {};
    if ( p ) {
      const signatures = campaign.system.signaturesOf(p.userId, p.playerName);
      let missiles = signatures;
      const bringer = actor.items.some(i => (i.type === "power") && (i.system.key === "bringer_of_nuclear_fire"));
      if ( bringer && mutantsPlaying ) missiles += 2;
      update.system = { war: {
        active: true, playerId: p.userId, playerName: p.playerName, seat: p.seat,
        redStarTokens: signatures ? 0 : 1, missiles, reserve: 0, startingTerritory: "", status: "playing", knockedOut: []
      } };
      if ( p.userId && !actor.testUserPermission(game.users.get(p.userId), "OWNER") ) {
        update[`ownership.${p.userId}`] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      }
    }
    else {
      update.system = { war: {
        active: false, playerId: "", playerName: "", seat: 0, redStarTokens: 0, missiles: 0, reserve: 0,
        startingTerritory: "", status: "playing", knockedOut: []
      } };
    }
    await actor.update(update);
    // One-shot powers are fresh every game
    const used = actor.items.filter(i => (i.type === "power") && i.system.used).map(i => ({ _id: i.id, "system.used": false }));
    if ( used.length ) await actor.updateEmbeddedDocuments("Item", used);
  }

  const war = await CONFIG.Combat.documentClass.create({
    type: "war", name: t("RL.Turn.warName", { game: gameNumber }), scene: null, active: true,
    system: {
      game: gameNumber, stage: "setup", phase: "start",
      placement: { order: list.map(p => p.actor.id), index: 0 },
      startingTroops: Object.fromEntries(list.map(p => [p.actor.id, STARTING_TROOPS]))
    },
    combatants: list.map(p => ({
      actorId: p.actor.id, name: p.actor.name, img: p.actor.img, initiative: p.seat + 1, hidden: false,
      flags: { [SYSTEM_ID]: { seat: p.seat } }
    }))
  });
  for ( const other of game.combats.filter(c => c.active && (c !== war)) ) await other.update({ active: false });
  await campaign.update({ "system.documents.war": war.id });
  // Each player's faction is their character (default chat speaker; also stops core's "pick a character" prompt)
  for ( const p of list ) {
    const u = game.users.get(p.userId);
    if ( u && !u.isGM && (u.character?.id !== p.actor.id) ) await safely("assignCharacter", () => u.update({ character: p.actor.id }));
  }
  // Everyone plays on the board: make it the active scene (players see the active scene, not the GM's view)
  const board = getBoardScene();
  if ( board && !board.active ) await safely("activateBoard", () => board.activate());
  for ( const p of list ) await safely("cards.ensureHand", () => api("cards", "ensureHand", { optional: true })?.({ faction: p.actor.id }));

  Hooks.callAll("risklegacy.warCreated", war);
  await postCard({
    kind: "warCreated", title: t("RL.Turn.Chat.warCreated", { game: gameNumber }),
    rows: list.map(p => ({
      label: p.actor.name,
      value: [p.playerName || "—",
        p.actor.system.war.missiles ? t("RL.Turn.Chat.missiles", { n: p.actor.system.war.missiles }) : t("RL.Turn.Chat.redStarToken")
      ].join(" · ")
    })),
    result: t("RL.Turn.Chat.warCreatedResult")
  });
  return { war: war.id, game: gameNumber };
}

/* -------------------------------------------- */
/*  Placement                                   */
/* -------------------------------------------- */

/**
 * [GM] Begin choosing starting territories, in pick order.
 * @param {{order?: string[]}} payload  faction ids (default: seat order)
 */
export async function beginPlacement({ order } = {}, { user }) {
  assertGM(user);
  const war = requireWar({ stage: ["setup", "placement"] });
  const ids = war.turns.map(c => c.actorId);
  const list = (order?.length ? order : ids).filter(id => ids.includes(id));
  for ( const id of ids ) if ( !list.includes(id) ) list.push(id);
  const index = Math.max(0, list.findIndex(id => !game.actors.get(id)?.system.war.startingTerritory));
  await war.update({ "system.stage": "placement", "system.placement": { order: list, index } });
  await postCard({
    kind: "placement", title: t("RL.Turn.Chat.placementTitle"),
    text: t("RL.Turn.Chat.placementText", { order: list.map(id => esc(game.actors.get(id)?.name)).join(", ") }),
    result: t("RL.Turn.Chat.placementResult")
  });
  return { order: list, index };
}

/**
 * [GM] Place a faction's HQ and starting troops in a legal starting territory, then hand over to the next pick.
 * Calls beginPlay() once everyone is placed.
 * @param {{faction: string, territory: string, troops?: number}} payload  troops default: the war's starting troops (8)
 */
export async function placeStartingForces({ faction, territory, troops } = {}, { user }) {
  const war = requireWar({ stage: "placement" });
  const actor = assertCanAct(user, faction);
  const { order, index } = war.system.placement;
  if ( order[index] !== actor.id ) {
    await gate(rules.fail("RL.Rules.start.notYourPick", { faction: actor.name }));
  }
  if ( actor.system.war.startingTerritory ) await gate(rules.fail("RL.Rules.start.alreadyPlaced", { faction: actor.name }));
  const snap = snapshot();
  await gate(rules.checkStartingTerritory(snap, actor.id, territory, { joining: false }));

  const n = Number.isInteger(troops) && (troops >= 0) ? troops : war.system.startingTroopsOf(actor.id);
  const tokens = await callApi("board", "spawnPieces", { faction: actor.id, territory, troops: n, hq: true });
  await actor.update({ "system.war.startingTerritory": territory });
  const next = order.findIndex(id => !game.actors.get(id)?.system.war.startingTerritory);
  const nextIndex = next === -1 ? order.length : next;
  await war.update({ "system.placement.index": nextIndex, [`system.startingTroops.${actor.id}`]: n });

  await postCard({
    faction: actor, kind: "startingForces", title: t("RL.Turn.Chat.hqTitle"), sub: territoryName(territory),
    text: t("RL.Turn.Chat.hqText", { faction: factionText(actor), troops: n, territory: esc(territoryName(territory)) })
  });
  if ( nextIndex >= order.length ) await beginPlay({}, { user: game.user });
  return { tokens, next: order[nextIndex] ?? null };
}

/**
 * [GM] Start the turns. The faction that placed first takes the first turn (rulebook p.7), then clockwise.
 * @param {{first?: string}} payload
 */
export async function beginPlay({ first } = {}, { user }) {
  assertGM(user);
  const war = requireWar({ stage: ["setup", "placement"] });
  if ( !war.turns.length ) throw new Error(t("RL.Turn.Error.noParticipants"));
  first ??= war.system.placement.order[0] ?? war.turns[0].actorId;
  let idx = war.turns.findIndex(c => c.actorId === first);
  if ( idx < 0 ) idx = 0;
  const factionId = war.turns[idx].actorId;
  const updateData = {
    round: 1, turn: idx, "system.stage": "playing", "system.phase": "start", "system.turn": replaceTurn(factionId)
  };
  Hooks.callAll("combatStart", war, updateData);
  await war.update(updateData);
  await postCard({
    kind: "warBegins", title: t("RL.Turn.Chat.warBeginsTitle"),
    text: t("RL.Turn.Chat.warBeginsText", { faction: factionText(game.actors.get(factionId)) })
  });
  return { first: factionId };
}

/* -------------------------------------------- */
/*  Turns                                       */
/* -------------------------------------------- */

/**
 * Move to the next faction that is still in the war (eliminated factions are skipped).
 * @param {Combat} war
 */
export async function advanceTurn(war) {
  const turns = war.turns;
  const n = turns.length;
  if ( !n ) return war;
  const cur = war.turn ?? -1;
  for ( let step = 1; step <= n; step++ ) {
    const pos = cur + step;
    const idx = pos % n;
    const c = turns[idx];
    if ( isOut(c.actor) ) continue;
    const round = Math.max(1, war.round) + Math.floor(pos / n);
    const updateData = { round, turn: idx };
    const updateOptions = { direction: 1 };
    Hooks.callAll(round !== war.round ? "combatRound" : "combatTurn", war, updateData, updateOptions);
    return war.update(updateData, updateOptions);
  }
  return war;
}

/**
 * Start-of-turn automation, run by RLCombat#_onStartTurn on the active GM (serialized with the GM actions):
 * reset the turn record, Join-the-War / elimination check, start-of-turn powers (khan_1), turn card.
 * @param {Combat} war
 * @param {Combatant} combatant
 */
export async function startTurn(war, combatant) {
  if ( (war.system.stage !== "playing") || (war.combatant?.id !== combatant.id) ) return;
  const actor = combatant.actor;
  if ( !actor ) return;
  if ( isOut(actor) ) return advanceTurn(war);

  const snap = snapshot();
  const f = snap.factions[actor.id];
  const fresh = WarData.freshTurn(actor.id);
  fresh.flags.startContinents = [...(f?.continents ?? [])];
  const protections = war.system.protections.filter(p => p.until !== actor.id);
  fresh.protected = [...new Set(protections.map(p => p.territory))];
  await war.update({
    "system.phase": "start",
    "system.turn": foundry.data.operators.ForcedReplacement.create(fresh),
    "system.protections": protections
  });

  const rows = [];
  let note = "";
  if ( !f?.territories?.length ) {
    // Knocked out (or lost the last troop some other way): Join the War, or be eliminated.
    const legal = rules.legalStartingTerritories(snap, actor.id, { joining: true });
    if ( !legal.length ) {
      await eliminateFaction(war, actor, { reason: "noStart" });
      const win = rules.victoryCheck(snapshot());
      if ( win ) return endWarInternal(war, win.winner, win.reason);
      return advanceTurn(war);
    }
    if ( actor.system.war.status !== "knockedOut" ) await actor.update({ "system.war.status": "knockedOut" });
    note = t("RL.Turn.Chat.mustJoin", { n: legal.length });
  }
  else if ( rules.hasPower(snap, actor.id, rules.POWERS.khan1) ) {
    // Khan Industries: one troop in each territory with an HQ you control.
    const placements = rules.hqPlacements(snap, actor.id, 1);
    const done = [];
    for ( const p of placements ) {
      const ok = await safely("khan_1", () => callApi("board", "spawnPieces", { faction: actor.id, territory: p.territory, troops: p.troops }));
      if ( ok !== undefined ) done.push({ source: "khan_1", ...p });
    }
    if ( done.length ) {
      await war.update({ "system.turn.flags.startOfTurn": done });
      rows.push({ label: t("RL.Turn.Power.khan_1"), value: done.map(p => `+${p.troops} ${territoryName(p.territory)}`).join(", ") });
    }
  }

  Hooks.callAll("risklegacy.turnStarted", war, actor);
  const redStars = rules.redStarTotal(snapshot(), actor.id);
  await postCard({
    faction: actor, kind: "turnStarted",
    title: actor.name, sub: t("RL.Turn.Chat.turnSub", { round: war.round }),
    rows: [...rows, { label: t("RL.Turn.Chat.redStars"), value: `${redStars} / 4` }],
    note
  });
}

/* -------------------------------------------- */
/*  Elimination and the end of the war          */
/* -------------------------------------------- */

/**
 * Mark a faction eliminated (rulebook p.9): status, `war.eliminated`, defeated combatant, hook, card.
 * @param {Combat} war
 * @param {Actor} actor
 * @param {{reason?: string}} [options]
 */
export async function eliminateFaction(war, actor, { reason = "noStart" } = {}) {
  if ( actor.system.war.status === "eliminated" ) return;
  await actor.update({ "system.war.status": "eliminated", "system.war.reserve": 0 });
  await war.update({ "system.eliminated": [...new Set([...war.system.eliminated, actor.id])] });
  const combatant = war.combatants.find(c => c.actorId === actor.id);
  if ( combatant && !combatant.defeated ) await combatant.update({ defeated: true });
  Hooks.callAll("risklegacy.factionEliminated", actor);
  await postCard({
    faction: actor, kind: "eliminated", hazard: true, title: t("RL.Turn.Chat.eliminatedTitle"),
    text: t(reason === "manual" ? "RL.Turn.Chat.eliminatedManual" : "RL.Turn.Chat.eliminatedText", { faction: factionText(actor) }),
    note: t("RL.Turn.Chat.eliminatedNote")
  });
}

/**
 * [GM] Eliminate a faction by hand.
 * @param {{faction: string}} payload
 */
export async function eliminate({ faction } = {}, { user }) {
  assertGM(user);
  const war = requireWar({ stage: ["playing", "placement", "setup"] });
  const actor = game.actors.get(faction);
  if ( !actor ) throw new Error(t("RL.Turn.Error.noFaction", { id: faction ?? "" }));
  const wasCurrent = activeFactionId(war) === actor.id;
  await eliminateFaction(war, actor, { reason: "manual" });
  if ( war.system.stage !== "playing" ) return { eliminated: actor.id };
  const win = rules.victoryCheck(snapshot());
  if ( win ) return { eliminated: actor.id, ...(await endWarInternal(war, win.winner, win.reason)) };
  if ( wasCurrent ) await advanceTurn(war);
  return { eliminated: actor.id };
}

/**
 * End the war: stage `ended`, winner, hook, victory card, then the campaign's end-of-game wizard.
 * @param {Combat} war
 * @param {string|null} winnerId
 * @param {string} [reason]  "redStars" | "lastStanding" | "manual"
 */
export async function endWarInternal(war, winnerId, reason = "manual") {
  if ( war.system.stage === "ended" ) return { winner: war.system.winner || null, reason: "alreadyEnded" };
  await war.update({ "system.stage": "ended", "system.phase": "end", "system.winner": winnerId ?? "" });
  const winner = winnerId ? game.actors.get(winnerId) : null;
  Hooks.callAll("risklegacy.warEnded", war, winner);
  await postCard({
    faction: winner, kind: "victory", token: winner ? "star" : null,
    title: t("RL.Turn.Chat.victoryTitle"),
    text: winner
      ? t(`RL.Turn.Chat.victory.${reason}`, { faction: factionText(winner), stars: rules.redStarTotal(buildSnapshot() ?? {}, winnerId) })
      : t("RL.Turn.Chat.victory.none"),
    result: t("RL.Turn.Chat.victoryResult")
  });
  const open = api("campaign", "openEndGame", { optional: true });
  if ( open ) {
    // Not awaited: the wizard stays open while players choose rewards.
    Promise.resolve().then(() => open()).catch(err => console.error(`${SYSTEM_ID} | campaign.openEndGame failed`, err));
  }
  return { winner: winnerId ?? null, reason };
}

/**
 * [GM] End the war (normally called automatically on victory).
 * @param {{winner?: string}} payload
 */
export async function endWar({ winner = null } = {}, { user }) {
  assertGM(user);
  const war = requireWar();
  return endWarInternal(war, winner, "manual");
}

/**
 * Results for the end-of-game wizard (sync): `[{faction, result: won|heldOn|eliminated, name, playerId, playerName,
 * startingTerritory}]` in seat order. A faction with no troops on the board at the end is eliminated.
 * @param {Combat} [war]
 */
export function computeResults(war = getWar()) {
  if ( !war ) return [];
  const snap = buildSnapshot();
  const ids = war.turns.map(c => c.actorId);
  const winner = war.system.winner || null;
  const results = snap ? rules.gameResults(snap, winner) : [];
  return ids.map(id => {
    const actor = game.actors.get(id);
    const r = results.find(x => x.faction === id);
    const result = r?.result ?? (id === winner ? "won" : (isOut(actor) ? "eliminated" : "heldOn"));
    return {
      faction: id, result, name: actor?.name ?? "", playerId: actor?.system.war.playerId ?? "",
      playerName: actor?.system.war.playerName ?? "", startingTerritory: actor?.system.war.startingTerritory ?? ""
    };
  });
}

/** For chat rows: "Asia 7 (+1)". */
export function continentLine(c, snap) {
  const bonus = c.namerBonus ? ` (+${c.namerBonus})` : "";
  return c.denied ? `${continentName(c.id, snap)} ✕` : `${continentName(c.id, snap)} ${c.value}${bonus}`;
}
