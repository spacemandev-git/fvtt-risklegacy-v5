import { PHASE_ORDER, PHASES, SYSTEM_ID } from "../config.mjs";
import { getCampaignBoard, getHand, pieceKind } from "../state/_module.mjs";
import * as rules from "../rules/_module.mjs";
import { continentName, factionText, postCard, powerName, territoryName } from "./chat.mjs";
import { advanceTurn, continentLine, endWarInternal } from "./war.mjs";
import {
  activeFactionId, api, assertCanAct, assertGM, callApi, esc, gate, handCards, requireWar, safely, settle, snapshot, t,
  troopsAt
} from "./util.mjs";

/**
 * Turn-step GM handlers (ARCHITECTURE §5.2). Each receives `(payload, {user})` on the active GM, re-checks the
 * user's right to act for the faction and the rules (`gate`), applies the change and returns plain data.
 * `faction` defaults to the faction whose turn it is.
 */

/* -------------------------------------------- */
/*  Shared                                      */
/* -------------------------------------------- */

/**
 * Common preamble: the war (playing), the acting faction, a fresh snapshot.
 * @returns {{war: Combat, actor: Actor, fid: string, snap: object}}
 */
function context(payload, user) {
  const war = requireWar({ stage: "playing" });
  const fid = payload?.faction || activeFactionId(war);
  const actor = assertCanAct(user, fid);
  if ( (war.combatant?.actorId === actor.id) && (war.system.turn.faction !== actor.id) ) {
    throw new Error(t("RL.Turn.Error.turnStarting"));
  }
  return { war, actor, fid: actor.id, snap: snapshot() };
}

/** Set the phase (no rules check) and fire the hook. */
export async function setPhaseInternal(war, phase, extra = {}) {
  const changed = war.system.phase !== phase;
  await war.update({ ...extra, ...(changed ? { "system.phase": phase } : {}) });
  if ( changed ) Hooks.callAll("risklegacy.phaseChanged", war, phase);
}

/** Apply an auto-advance hint from a RuleResult. */
async function maybeAdvance(war, result) {
  const target = result?.data?.advance;
  if ( target && (PHASE_ORDER.indexOf(target) > PHASE_ORDER.indexOf(war.system.phase)) ) await setPhaseInternal(war, target);
}

/** `system.turn.*` / `system.turn.flags.*` update. */
async function updateTurn(war, changes = {}, flags = {}) {
  const update = {};
  for ( const [k, v] of Object.entries(changes) ) update[`system.turn.${k}`] = v;
  for ( const [k, v] of Object.entries(flags) ) update[`system.turn.flags.${k}`] = v;
  if ( Object.keys(update).length ) await war.update(update);
}

/** The turn's flags (a plain copy). */
const flagsOf = war => foundry.utils.deepClone(war.system.turn.flags ?? {});

/** Victory check after a change; ends the war when someone has won. */
async function checkVictory(war) {
  const win = rules.victoryCheck(snapshot());
  if ( !win ) return null;
  return endWarInternal(war, win.winner, win.reason);
}

/** Is the move between these two territories over a sea line? */
function isSeaLine(snap, a, b) {
  const lines = snap.board?.seaLines ?? getCampaignBoard()?.seaLines ?? [];
  return lines.some(l => ((l.a === a) && (l.b === b)) || ((l.a === b) && (l.b === a)));
}

/* -------------------------------------------- */
/*  Phases                                      */
/* -------------------------------------------- */

/**
 * [GM] Move the turn to a phase (forward only; never past step 2 with troops left to place). `force: true` lets a
 * GM set any phase.
 * @param {{faction?: string, phase: string, force?: boolean}} payload
 */
export async function setPhase(payload, { user }) {
  const { war, fid, snap } = context(payload, user);
  const phase = payload.phase;
  if ( !(phase in PHASES) ) throw new Error(t("RL.Rules.phase.unknown", { phase }));
  if ( !(payload.force && user.isGM) ) await gate(rules.checkPhaseChange(snap, fid, phase));
  await setPhaseInternal(war, phase);
  return { phase };
}

/** [GM] Move the turn to the next phase. */
export async function advancePhase(payload, ctx) {
  const war = requireWar({ stage: "playing" });
  const next = rules.nextPhase(war.system.phase);
  if ( !next ) return { phase: war.system.phase };
  return setPhase({ ...payload, phase: next }, ctx);
}

/* -------------------------------------------- */
/*  Step 1: Red Stars                           */
/* -------------------------------------------- */

/**
 * [GM] Turn in resource cards for Red Star tokens (4 cards each, any number of times, at the start of the turn).
 * Fourth Red Star = immediate win.
 * @param {{faction?: string, cardIds: string[]}} payload
 */
export async function buyRedStars(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  const cards = handCards(fid, payload.cardIds ?? []);
  await gate(rules.checkBuyRedStars(snap, fid, cards.length));
  const stars = Math.floor(cards.length / 4);
  if ( !stars ) throw new Error(t("RL.Rules.stars.multiple", { per: 4, count: cards.length }));
  const used = cards.slice(0, stars * 4).map(c => c.id);
  await callApi("cards", "discardResources", { faction: fid, cardIds: used, purpose: "redStar" });
  const tokens = actor.system.war.redStarTokens + stars;
  await actor.update({ "system.war.redStarTokens": tokens });
  await updateTurn(war, { starsBought: war.system.turn.starsBought + stars });
  Hooks.callAll("risklegacy.redStarTokenGained", actor, stars, "purchase");
  const total = rules.redStarTotal(snapshot(), fid);
  await postCard({
    faction: actor, kind: "starsBought", token: "star", title: t("RL.Turn.Chat.starsTitle", { n: stars }),
    text: t("RL.Turn.Chat.starsText", { cards: used.length }),
    note: total >= 4 ? "" : t("RL.Turn.Chat.starsNote", { total })
  });
  const win = await checkVictory(war);
  return { stars, tokens, total, winner: win?.winner ?? null };
}

/* -------------------------------------------- */
/*  Step 2: Join the War or Recruit             */
/* -------------------------------------------- */

/** Recruit (shared by the action and the auto-recruit of placeReserve). */
async function recruitInternal(war, actor, snap) {
  const fid = actor.id;
  const result = rules.checkRecruit(snap, fid);
  await gate(result);
  const breakdown = result.data?.breakdown ?? rules.recruitBreakdown(snap, fid);
  const turn = war.system.turn;
  const reserve = actor.system.war.reserve + breakdown.total;
  const recruitTotal = turn.recruitTotal + breakdown.total;
  await actor.update({ "system.war.reserve": reserve });
  await setPhaseInternal(war, war.system.phase === "start" ? "recruit" : war.system.phase, {
    "system.turn.recruited": true, "system.turn.recruitTotal": recruitTotal
  });
  const detail = { ...breakdown, source: "recruit", cards: recruitTotal - breakdown.total };
  Hooks.callAll("risklegacy.recruited", actor, recruitTotal, detail);

  const rows = [
    { label: t("RL.Turn.Chat.recruitTerritories"), value: breakdown.territories },
    ...(breakdown.population || breakdown.populationIgnored
      ? [{ label: t("RL.Turn.Chat.recruitPopulation"), value: breakdown.populationIgnored ? t("RL.Turn.Chat.ignored") : breakdown.population }]
      : []),
    { label: t("RL.Turn.Chat.recruitBase", { sum: breakdown.sum }), value: breakdown.base },
    ...breakdown.continents.map(c => ({ label: t("RL.Turn.Chat.recruitContinent"), value: continentLine(c, snap) })),
    ...breakdown.extras.map(e => ({ label: powerName(e.source), value: `+${e.troops}` }))
  ];
  let note = "";
  if ( breakdown.roundedUp ) note = t("RL.Turn.Chat.roundedUp");
  else if ( breakdown.minimumApplied ) note = t("RL.Turn.Chat.minimum");
  await postCard({
    faction: actor, kind: "recruited", title: t("RL.Turn.Chat.recruitTitle"), rows, note,
    result: t("RL.Turn.Chat.recruitResult", { faction: actor.name, total: breakdown.total })
  });
  return { ...breakdown, reserve, recruitTotal };
}

/**
 * [GM] Recruit troops: adds the recruit total to the reserve (once per turn) and fires `risklegacy.recruited`
 * (the campaign area checks the *30 troops + missile* pocket there, before anything is placed).
 * @param {{faction?: string}} payload
 * @returns {Promise<object>} the recruit breakdown, plus `reserve` and `recruitTotal`
 */
export async function recruit(payload, { user }) {
  const { war, actor, snap } = context(payload, user);
  return recruitInternal(war, actor, snap);
}

/**
 * [GM] Turn in resource cards for troops (2–10 resources, board chart), once per turn, in step 2.
 * @param {{faction?: string, cardIds: string[]}} payload
 */
export async function tradeForTroops(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  const cards = handCards(fid, payload.cardIds ?? []);
  const coins = cards.reduce((n, c) => n + (c.system.coins ?? (c.type === "coin" ? 1 : c.system.value ?? 0)), 0);
  const result = rules.checkTrade(snap, fid, coins);
  await gate(result);
  const troops = result.ok ? result.data.troops : rules.troopsForCoins(Math.min(rules.MAX_TRADE_COINS, coins));
  await maybeAdvance(war, result);
  await callApi("cards", "discardResources", { faction: fid, cardIds: cards.map(c => c.id), purpose: "troops" });
  const reserve = actor.system.war.reserve + troops;
  await actor.update({ "system.war.reserve": reserve });
  const recruitTotal = war.system.turn.recruitTotal + troops;
  const trade = {
    coins, effective: result.data?.effective ?? coins, troops,
    cards: cards.map(c => ({ type: c.type, value: c.system.coins ?? 1, territory: c.system.territory ?? "" }))
  };
  await updateTurn(war, { tradedForTroops: true, recruitTotal }, { trade });
  Hooks.callAll("risklegacy.recruited", actor, recruitTotal, { source: "trade", coins, troops, cards: troops });
  await postCard({
    faction: actor, kind: "traded", title: t("RL.Turn.Chat.tradeTitle"),
    text: t("RL.Turn.Chat.tradeText", { cards: cards.length, coins }),
    note: result.data?.bonus ? powerName("alien_collaborator") : "",
    result: t("RL.Turn.Chat.tradeResult", { troops })
  });
  return { coins, troops, reserve, recruitTotal };
}

/**
 * [GM] Join the War: half the starting troops (no HQ) in a legal starting territory.
 * @param {{faction?: string, territory: string}} payload
 */
export async function joinWar(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  const territory = payload.territory;
  await gate(rules.checkJoinWar(snap, fid, territory));
  const troops = rules.joinWarTroops(war.system.startingTroopsOf(fid));
  const tokens = await callApi("board", "spawnPieces", { faction: fid, territory, troops, hq: false });
  await actor.update({ "system.war.status": "playing" });
  await setPhaseInternal(war, "attack", { "system.turn.joinedWar": true });
  await postCard({
    faction: actor, kind: "joined", title: t("RL.Turn.Chat.joinTitle"), sub: territoryName(territory),
    text: t("RL.Turn.Chat.joinText", { faction: factionText(actor), troops, territory: esc(territoryName(territory)) })
  });
  return { territory, troops, tokens };
}

/**
 * [GM] Place recruited troops from the reserve. From step 1 it recruits first.
 * @param {{faction?: string, territory: string, count?: number}} payload  count default 1
 */
export async function placeReserve(payload, { user }) {
  let { war, actor, fid, snap } = context(payload, user);
  const turn = war.system.turn;
  if ( (war.system.phase === "start") && !turn.recruited && !turn.joinedWar && snap.factions[fid]?.territories?.length ) {
    await recruitInternal(war, actor, snap);
    snap = snapshot();
  }
  const territory = payload.territory;
  const count = Number.isInteger(payload.count) ? payload.count : 1;
  const result = rules.checkPlacement(snap, fid, territory, count);
  await gate(result);
  await maybeAdvance(war, result);
  const tokens = await callApi("board", "spawnPieces", { faction: fid, territory, troops: count });
  const reserve = Math.max(0, actor.system.war.reserve - count);
  await actor.update({ "system.war.reserve": reserve });
  const flags = flagsOf(war);
  const placedIn = [...new Set([...(flags.placedIn ?? []), territory])];
  await updateTurn(war, {}, { placedIn, ...(result.data?.stealthy ? { stealthy: territory } : {}) });
  return { territory, count, reserve, tokens, stealthy: !!result.data?.stealthy };
}

/* -------------------------------------------- */
/*  Step 3: Expand & Attack                     */
/* -------------------------------------------- */

/** Put dragged troops back after a refused move. */
async function undoDrag(fid, from, to, count) {
  await safely("undo move", () => callApi("board", "moveTroops", { faction: fid, from: to, to: from, count }));
}

/**
 * [GM] Expand into an unoccupied territory. City territories cost their population (+2 if fortified); the
 * expansion is refused if no troop would be left. `moved: true` = the player already dragged the tokens.
 * Expanding never enables the resource draw by itself.
 * @param {{faction?: string, from: string, to: string, count: number, moved?: boolean}} payload
 */
export async function expand(payload, { user }) {
  const ctx = context(payload, user);
  const { war, actor, fid } = ctx;
  let snap = ctx.snap;
  const { from, to } = payload;
  const count = Number(payload.count) || 1;
  // A dragged move may still be landing on this client: wait for it before reading the board.
  if ( payload.moved ) snap = await settle(s => s.territories[to]?.owner === fid, { timeout: 3000 });
  const dragged = !!payload.moved && (snap.territories[to]?.owner === fid);
  const state = dragged ? rules.revertMove(snap, fid, from, to, count) : snap;
  const result = rules.checkExpand(state, fid, from, to, count);
  try {
    await gate(result);
  } catch(err) {
    if ( dragged ) await undoDrag(fid, from, to, count);
    throw err;
  }
  await maybeAdvance(war, result);
  if ( !payload.moved ) {
    await callApi("board", "moveTroops", { faction: fid, from, to, count });
    await settle(s => troopsAt(s, fid, to) >= count);
  }
  const { cost, parts } = (result.ok ? result.data : rules.expandCost(state, fid, to, count));
  const lost = Math.min(cost, count);
  if ( lost > 0 ) await callApi("board", "removeTroops", { faction: fid, territory: to, count: lost });

  const target = state.territories[to];
  const flags = flagsOf(war);
  const turn = war.system.turn;
  await updateTurn(war, {
    expanded: turn.expanded + 1, expandedIntoCity: turn.expandedIntoCity || !!target?.city
  }, {
    lastAdvance: { from, to, kind: "expand" },
    expansions: [...(flags.expansions ?? []), { from, to, cost: lost, city: !!target?.city }]
  });

  const rows = parts.filter(p => p.troops).map(p => ({ label: partLabel(p.source), value: `−${p.troops}` }));
  const hq = target?.hq && (target.hq !== fid) ? game.actors.get(target.hq) : null;
  await postCard({
    faction: actor, kind: "expanded", title: t("RL.Turn.Chat.expandTitle"), sub: territoryName(to),
    text: t("RL.Turn.Chat.expandText", { count, from: esc(territoryName(from)) }), rows,
    note: hq ? t("RL.Turn.Chat.hqTaken", { faction: hq.name }) : "",
    result: lost ? t("RL.Turn.Chat.expandResult", { remaining: count - lost }) : ""
  });
  const win = hq ? await checkVictory(war) : null;
  return { cost: lost, remaining: count - lost, winner: win?.winner ?? null };
}

/** Label of an expansion cost part. */
function partLabel(source) {
  if ( source === "city" ) return t("RL.Turn.Chat.costCity");
  if ( source === "fortification" ) return t("RL.Turn.Chat.costFortification");
  const mark = `RL.Turn.Chat.costMark.${source}`;
  return game.i18n.has(mark) ? t(mark) : powerName(source);
}

/**
 * [GM] Attack: validates (dice, troops, adjacency, protected territories), records the first attack target (Enclave
 * of the Bear), then hands over to `battle.startBattle`.
 * @param {{faction?: string, from: string, to: string, dice?: number}} payload  dice default: the most allowed
 * @returns {Promise<{messageId: string}>}
 */
export async function attack(payload, { user }) {
  const { war, fid, snap } = context(payload, user);
  const { from, to } = payload;
  const dice = Number(payload.dice) || rules.maxAttackDice(snap, from);
  const result = rules.checkAttack(snap, fid, from, to, dice);
  await gate(result);
  await maybeAdvance(war, result);
  const startBattle = api("battle", "startBattle");
  const turn = war.system.turn;
  await updateTurn(war, turn.firstAttackTarget ? {} : { firstAttackTarget: to }, { lastAdvance: null });
  const messageId = await startBattle({ attacker: fid, from, to, dice });
  await updateTurn(war, { attacks: war.system.turn.attacks + 1 });
  return { messageId: messageId ?? null };
}

/**
 * [GM] Record a conquest (called by the battle area after the survivors moved in): log it, HQ capture, Fallout Zone
 * losses, knock-out (the defender's resource cards go to the conqueror), victory check.
 * @param {{faction: string, from: string, to: string, defender: string}} payload
 */
export async function recordConquest({ faction, from, to, defender } = {}, { user }) {
  assertGM(user);
  const war = requireWar({ stage: "playing" });
  const actor = game.actors.get(faction);
  const loser = game.actors.get(defender);
  if ( !actor ) throw new Error(t("RL.Turn.Error.noFaction", { id: faction ?? "" }));
  // The survivors' move may still be landing on this client.
  let snap = await settle(s => s.territories[to]?.owner === faction);
  const target = snap.territories[to];

  // Fallout Zone: the conquering troops lose half (round up)
  const losses = rules.enterLosses(snap, faction, to, target?.pieces?.[faction]?.troops ?? target?.troops ?? 0);
  for ( const loss of losses ) {
    await safely("enterLoss", () => callApi("board", "removeTroops", { faction, territory: to, count: loss.troops }));
  }

  const flags = flagsOf(war);
  const conquest = { from, to, defender: defender ?? "", city: !!target?.city, seaLine: isSeaLine(snap, from, to) };
  await updateTurn(war, { conquered: war.system.turn.conquered + 1 }, {
    conquests: [...(flags.conquests ?? []), conquest], lastAdvance: { from, to, kind: "conquest" },
    conqueredIds: [...(flags.conqueredIds ?? []), to],
    conqueredViaSeaLine: (flags.conqueredViaSeaLine ?? 0) + (conquest.seaLine ? 1 : 0),
    conqueredCities: (flags.conqueredCities ?? 0) + (conquest.city ? 1 : 0)
  });
  Hooks.callAll("risklegacy.conquered", actor, to, loser ?? null);

  const hqCaptured = !!(target?.hq && (target.hq !== faction));
  if ( hqCaptured ) {
    const owner = game.actors.get(target.hq);
    await postCard({
      faction: actor, kind: "hqCaptured", title: t("RL.Turn.Chat.hqCapturedTitle"), sub: territoryName(to),
      text: t("RL.Turn.Chat.hqCapturedText", { faction: factionText(actor), owner: esc(owner?.name ?? ""), territory: esc(territoryName(to)) })
    });
  }

  // Knock-out: the defender's last troop is gone
  snap = snapshot();
  let knockedOut = false;
  if ( loser && (loser.system.war.status === "playing") && ((snap.factions[defender]?.troops ?? 0) <= 0) ) {
    knockedOut = true;
    const handCount = snap.factions[defender]?.hand?.count ?? 0;
    await loser.update({ "system.war.status": "knockedOut", "system.war.reserve": 0 });
    await actor.update({ "system.war.knockedOut": [...new Set([...actor.system.war.knockedOut, defender])] });
    await updateTurn(war, {}, { knockouts: [...(flagsOf(war).knockouts ?? []), { faction: defender, handCount }] });
    if ( handCount ) await safely("cards.transferHand", () => callApi("cards", "transferHand", { from: defender, to: faction }));
    Hooks.callAll("risklegacy.factionKnockedOut", loser, actor);
    await postCard({
      faction: loser, kind: "knockedOut", hazard: true, title: t("RL.Turn.Chat.knockedOutTitle"),
      text: t("RL.Turn.Chat.knockedOutText", { faction: factionText(loser), by: factionText(actor), cards: handCount })
    });
  }
  const win = await checkVictory(war);
  return { conquered: war.system.turn.conquered, hqCaptured, knockedOut, winner: win?.winner ?? null };
}

/* -------------------------------------------- */
/*  Step 4: Maneuver                            */
/* -------------------------------------------- */

/**
 * [GM] Maneuver troops between two connected own territories (one per turn). Moving more troops into the
 * territory just expanded into / conquered from the same origin is a follow-up, not a maneuver.
 * @param {{faction?: string, from: string, to: string, count: number, moved?: boolean}} payload
 */
export async function maneuver(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  const { from, to } = payload;
  const count = Number(payload.count) || 1;
  const dragged = !!payload.moved;
  const state = dragged ? rules.revertMove(snap, fid, from, to, count) : snap;

  const moveNow = async () => {
    const before = troopsAt(snap, fid, from);
    await callApi("board", "moveTroops", { faction: fid, from, to, count });
    await settle(s => troopsAt(s, fid, from) <= before - count);
  };
  const advance = rules.checkAdvance(state, fid, from, to, count);
  if ( advance.ok ) {
    if ( !dragged ) await moveNow();
    return { advance: true, kind: advance.data.kind };
  }

  const result = rules.checkManeuver(state, fid, from, to, count);
  try {
    await gate(result);
  } catch(err) {
    if ( dragged ) await undoDrag(fid, from, to, count);
    throw err;
  }
  await maybeAdvance(war, result);
  if ( !dragged ) await moveNow();
  await updateTurn(war, { maneuver: { done: true, from, to } }, { lastAdvance: null });
  await postCard({
    faction: actor, kind: "maneuvered", title: t("RL.Turn.Chat.maneuverTitle"),
    text: t("RL.Turn.Chat.maneuverText", { count, from: esc(territoryName(from)), to: esc(territoryName(to)) }),
    note: result.data?.via === "anywhere" ? powerName("saharan_2") : ""
  });
  return { advance: false, via: result.data?.via ?? null };
}

/* -------------------------------------------- */
/*  Step 5: End of turn                         */
/* -------------------------------------------- */

/**
 * [GM] End the turn. The player's client has already chosen (see client.endTurn):
 *   end-of-turn scars/marks → mission *or* resource card (+ khan_2) → events (inside the cards area's draw) →
 *   victory check → next faction.
 * @param {object} payload
 * @param {string} [payload.faction]
 * @param {{cardId?: string, coin?: boolean}|null} [payload.draw]
 * @param {boolean} [payload.completeMission]
 * @param {{khan_2?: boolean}} [payload.powers]   optional power choices made with the draw
 */
export async function end(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  await gate(rules.checkTurnAction(snap, fid, "endTurn"));
  await cancelOpenBattle(war);
  await setPhaseInternal(war, "end", { "system.turn.flags.lastAdvance": null });

  // 1. Scars and marks that trigger at the end of your turn
  const rows = [];
  for ( const e of rules.endOfTurnEffects(snap, fid) ) {
    const name = territoryName(e.territory);
    const ok = await safely("endOfTurnTroops", () => (e.delta > 0
      ? callApi("board", "spawnPieces", { faction: fid, territory: e.territory, troops: e.delta })
      : callApi("board", "removeTroops", { faction: fid, territory: e.territory, count: -e.delta })));
    if ( ok !== undefined ) {
      rows.push({ label: e.sources.map(s => partLabel(s.id)).join(", "), value: `${e.delta > 0 ? "+" : "−"}${Math.abs(e.delta)} ${name}` });
    }
  }
  if ( rows.length && ((snapshot().factions[fid]?.troops ?? 0) <= 0) ) {
    await actor.update({ "system.war.status": "knockedOut" });
  }

  // 2. Mission or resource card (never both)
  let drawn = null;
  let mission = false;
  if ( payload.completeMission ) {
    await callApi("cards", "completeMission", { faction: fid }, { required: false });
    mission = true;
    await updateTurn(war, { missionCompleted: true });
  }
  else if ( payload.draw ) {
    const eligible = rules.resourceDrawEligibility(snapshot(), fid);
    await gate(eligible);
    const cardId = payload.draw.coin ? null : (payload.draw.cardId ?? null);
    const rowCard = cardId ? (game.risklegacy?.state?.getCardStack?.("row")?.cards.get(cardId) ?? null) : null;
    const rowTerritory = rowCard?.type === "territory" ? rowCard.system.territory : null;
    drawn = await callApi("cards", "drawResourceCard", { faction: fid, cardId });
    await updateTurn(war, { cardDrawn: true, events: war.system.turn.events + (drawn?.eventCardId ? 1 : 0) });
    // Khan Industries: may place one troop into the drawn territory if controlled
    if ( payload.powers?.khan_2 && rules.hasPower(snap, fid, rules.POWERS.khan2) && drawn?.cardId ) {
      const card = getHand(fid)?.cards.get(drawn.cardId);
      const territory = (card?.type === "territory" ? card.system.territory : null) ?? rowTerritory;
      if ( territory && (snapshot().territories[territory]?.owner === fid) ) {
        const placed = await safely("khan_2", () => callApi("board", "spawnPieces", { faction: fid, territory, troops: 1 }));
        if ( placed !== undefined ) rows.push({ label: powerName("khan_2"), value: `+1 ${territoryName(territory)}` });
      }
    }
  }
  if ( rows.length ) await postCard({ faction: actor, kind: "endOfTurn", title: t("RL.Turn.Chat.endTitle"), rows });

  // 3. Victory, then the next faction
  const win = await checkVictory(war);
  if ( win ) return { drawn, mission, winner: win.winner };
  await advanceTurn(war);
  return { drawn, mission, winner: null, next: war.combatant?.actorId ?? null };
}

/* -------------------------------------------- */
/*  Protections and powers                      */
/* -------------------------------------------- */

/**
 * [GM] Make a territory impossible to attack for the rest of the turn (Die Mechaniker's two natural 6s, events), or
 * until the start of `until`'s next turn.
 * @param {{territory: string, until?: string, source?: string}} payload
 */
export async function protect({ territory, until = "", source = "" } = {}, { user }) {
  assertGM(user);
  const war = requireWar({ stage: "playing" });
  const list = [...new Set([...war.system.turn.protected, territory])];
  const update = { "system.turn.protected": list };
  if ( until ) update["system.protections"] = [...war.system.protections, { territory, until, source }];
  await war.update(update);
  return { protected: list };
}

/**
 * Activatable powers the faction could use right now (for the War Room).
 * @param {object} snap
 * @param {string} factionId
 * @returns {{power: string, name: string, result: object, needs: string[]}[]}
 */
export function powerOptions(snap, factionId) {
  const out = [];
  const add = (power, result, needs = []) => out.push({ power, name: powerName(power), result, needs });
  for ( const power of ["rally", "mobile", "recon", "bad_intel"] ) {
    if ( rules.hasPower(snap, factionId, power) ) add(power, checkPower(snap, factionId, power), power === "mobile" ? ["from", "to"] : power === "bad_intel" ? ["continent"] : []);
  }
  return out;
}

/** Can the faction use this activatable power now (without the per-power target)? */
export function checkPower(snap, factionId, power) {
  const turn = snap.turn;
  if ( !turn || (turn.stage !== "playing") ) return rules.fail("RL.Rules.turn.notPlaying");
  const f = snap.factions[factionId];
  if ( !f || !rules.hasPower(snap, factionId, power) ) return rules.fail("RL.Rules.power.notYours", { power: powerName(power) });
  const flags = turn.log?.flags ?? {};
  const own = turn.faction === factionId;
  if ( rules.MISSILE_POWERS.includes(power) ) {
    if ( (f.missiles ?? 0) < 1 ) return rules.fail("RL.Rules.power.noMissile");
    if ( flags.missilePowers?.[factionId] ) return rules.fail("RL.Rules.power.oncePerTurn");
  }
  switch ( power ) {
    case "rally":
    case "mobile":
      if ( !own ) return rules.fail("RL.Rules.turn.notYourTurn");
      if ( turn.phase !== "start" ) return rules.fail("RL.Rules.power.startOnly", { power: powerName(power) });
      if ( (power === "mobile") && flags.mobile ) return rules.fail("RL.Rules.power.oncePerTurn");
      if ( !f.hqs?.length ) return rules.fail("RL.Rules.mobile.noHQ", { name: "" });
      return rules.ok();
    case "recon":
      if ( !own ) return rules.fail("RL.Rules.turn.notYourTurn");
      if ( flags.recon ) return rules.fail("RL.Rules.power.oncePerTurn");
      return rules.resourceDrawEligibility(snap, factionId);
    case "bad_intel": {
      if ( own ) return rules.fail("RL.Rules.power.otherPlayersTurn");
      const target = snap.factions[turn.faction];
      if ( (turn.phase !== "start") || turn.log?.recruited ) return rules.fail("RL.Rules.power.startOnly", { power: powerName(power) });
      if ( !target?.continents?.length ) return rules.fail("RL.Rules.power.noContinent", { faction: target?.name ?? "" });
      return rules.ok({ continents: target.continents.filter(c => !(flags.deniedContinents ?? []).includes(c)) });
    }
    default:
      return rules.fail("RL.Rules.power.manual", { power: powerName(power) });
  }
}

/**
 * [GM] Use an activatable power. Automated: `rally` (missile: 2 troops in every HQ you control), `mobile` (move one
 * HQ to an adjacent own territory), `recon` (missile: take any face-up territory card instead of a coin),
 * `bad_intel` (missile, on another player's start of turn: deny one continent bonus).
 * @param {{faction?: string, power: string, from?: string, to?: string, continent?: string}} payload
 */
export async function usePower(payload, { user }) {
  const war = requireWar({ stage: "playing" });
  const fid = payload.faction || activeFactionId(war);
  const actor = assertCanAct(user, fid);
  const power = payload.power;
  const snap = snapshot();
  await gate(checkPower(snap, fid, power));
  const flags = flagsOf(war);
  const spend = async () => {
    if ( !rules.MISSILE_POWERS.includes(power) ) return {};
    await actor.update({ "system.war.missiles": Math.max(0, actor.system.war.missiles - 1) });
    return { missilePowers: { ...(flags.missilePowers ?? {}), [fid]: power } };
  };
  let text = "";
  switch ( power ) {
    case "rally": {
      const placements = rules.hqPlacements(snap, fid, 2);
      const extra = await spend();
      for ( const p of placements ) await callApi("board", "spawnPieces", { faction: fid, territory: p.territory, troops: p.troops });
      await updateTurn(war, {}, { ...extra, rally: true });
      text = t("RL.Turn.Chat.rallyText", { territories: placements.map(p => esc(territoryName(p.territory))).join(", ") });
      break;
    }
    case "mobile":
      await mobileInternal(war, snap, fid, payload.from, payload.to, { moved: false });
      text = t("RL.Turn.Chat.mobileText", { from: esc(territoryName(payload.from)), to: esc(territoryName(payload.to)) });
      break;
    case "recon": {
      const extra = await spend();
      await updateTurn(war, {}, { ...extra, recon: true });
      text = t("RL.Turn.Chat.reconText");
      break;
    }
    case "bad_intel": {
      const continent = payload.continent;
      const target = snap.factions[snap.turn.faction];
      if ( !target?.continents?.includes(continent) ) throw new Error(t("RL.Rules.power.noContinent", { faction: target?.name ?? "" }));
      const extra = await spend();
      await updateTurn(war, {}, {
        ...extra,
        deniedContinents: [...new Set([...(flags.deniedContinents ?? []), continent])],
        deniedBy: { ...(flags.deniedBy ?? {}), [continent]: fid }
      });
      text = t("RL.Turn.Chat.badIntelText", { faction: esc(target.name), continent: esc(continentName(continent, snap)) });
      break;
    }
    default:
      throw new Error(t("RL.Rules.power.manual", { power: powerName(power) }));
  }
  await postCard({ faction: actor, kind: "power", title: powerName(power), text, token: rules.MISSILE_POWERS.includes(power) ? "missile" : null });
  return { power };
}

/**
 * Mobile: move one HQ the faction controls to an adjacent territory it controls (start of turn, once).
 * With `moved`, the HQ token has already been dragged: validate on the board as it was, put it back if refused.
 */
async function mobileInternal(war, snap, fid, from, to, { moved = false } = {}) {
  let state = snap;
  if ( moved ) {
    const a = snap.territories[from];
    const b = snap.territories[to];
    state = { ...snap, territories: { ...snap.territories, [from]: { ...a, hq: b?.hq ?? null }, [to]: { ...b, hq: null } } };
  }
  try {
    await gate(checkPower(state, fid, "mobile"));
    await gate(rules.checkMoveHQ(state, fid, from, to));
  } catch(err) {
    if ( moved ) await safely("undo HQ move", () => moveHQToken(snap, to, from));
    throw err;
  }
  if ( !moved ) await moveHQToken(snap, from, to);
  await updateTurn(war, {}, { mobile: { from, to } });
}

/**
 * [GM] Report an HQ the player dragged to another territory (the Mobile power; canvas area, `moved: true`).
 * @param {{faction?: string, from: string, to: string, moved?: boolean}} payload
 */
export async function moveHQ(payload, { user }) {
  const { war, actor, fid, snap } = context(payload, user);
  const { from, to } = payload;
  await mobileInternal(war, snap, fid, from, to, { moved: payload.moved !== false });
  await postCard({
    faction: actor, kind: "power", title: powerName("mobile"),
    text: t("RL.Turn.Chat.mobileText", { from: esc(territoryName(from)), to: esc(territoryName(to)) })
  });
  return { from, to };
}

/**
 * [GM] Report more troops following the last expansion/conquest from the same territory (canvas area, `moved:
 * true`). Not a maneuver.
 * @param {{faction?: string, from: string, to: string, count: number, moved?: boolean}} payload
 */
export async function advance(payload, { user }) {
  const { fid, snap } = context(payload, user);
  const { from, to } = payload;
  const count = Number(payload.count) || 1;
  const dragged = !!payload.moved;
  const state = dragged ? rules.revertMove(snap, fid, from, to, count) : snap;
  const result = rules.checkAdvance(state, fid, from, to, count);
  try {
    await gate(result);
  } catch(err) {
    if ( dragged ) await undoDrag(fid, from, to, count);
    throw err;
  }
  if ( !dragged ) {
    const before = troopsAt(snap, fid, from);
    await callApi("board", "moveTroops", { faction: fid, from, to, count });
    await settle(s => troopsAt(s, fid, from) <= before - count);
  }
  return { advance: true, kind: result.data?.kind ?? null };
}

/** Move the HQ token standing in `from` to the centre of `to`. */
async function moveHQToken(snap, from, to) {
  const scene = game.risklegacy?.state?.getBoardScene?.();
  const t0 = snap.territories[from];
  const hqFaction = t0?.hq ?? snap.territories[to]?.hq;
  const ids = [...(t0?.pieces?.[hqFaction]?.tokens ?? [])];
  const tokenId = ids.find(id => pieceKind(scene?.tokens.get(id)) === "hq");
  const token = scene?.tokens.get(tokenId);
  if ( !token ) throw new Error(t("RL.Rules.mobile.noHQ", { name: territoryName(from) }));
  const center = getCampaignBoard()?.territories?.[to]?.center;
  if ( !center ) throw new Error(t("RL.Rules.unknownTerritory", { id: to }));
  const size = scene.grid?.size ?? 100;
  await token.update({ x: center[0] - ((token.width * size) / 2), y: center[1] - ((token.height * size) / 2) }, { [SYSTEM_ID]: { turnMove: true } });
  const arrange = api("board", "arrangeTerritory", { optional: true });
  if ( arrange ) {
    await safely("arrangeTerritory", () => arrange({ territory: to }));
    await safely("arrangeTerritory", () => arrange({ territory: from }));
  }
}


/**
 * A battle the attacker declared but never rolled/resolved must not outlive the turn: cancel it so the next player
 * can attack (the card shows it as cancelled).
 * @param {Combat} war
 */
async function cancelOpenBattle(war) {
  const msg = war.system.battle ? game.messages.get(war.system.battle) : null;
  if ( !msg || (msg.type !== "battle") || ["resolved", "cancelled"].includes(msg.system.status) ) return;
  await safely("cancelOpenBattle", () => msg.update({ "system.status": "cancelled", "system.closed": true, "system.hold": "" }));
}
