/**
 * The bot turn loop (BOTS.md §6.1), on the active GM only.
 *
 * Triggers: `risklegacy.turnStarted` (deferred with setTimeout), `updateCombat` (GM rewinds don't fire turnStarted),
 * `ready` (a turn interrupted by a reload) and `updateSetting` (resume). A bot acts only when
 * `war.combatant.actorId === fid && war.system.turn.faction === fid` and the stage is `playing`, one turn at a time.
 * Everything is re-derived from the documents (the turn record says what has been done), so a reload mid-turn just
 * carries on. Actions go through `RL.actions.run("turn.<verb>")`, which throws on refusal: the move is added to
 * `ctx.excluded` and the brain is asked again. Guards: 60 actions and 5 refusals per turn, then the turn ends.
 */
import { botOfFaction } from "../users.mjs";
import { buildContext } from "./context.mjs";
import { decide } from "./decide.mjs";
import { driveBattle, openBattleOf } from "./battle.mjs";
import {
  MAX_ACTIONS, MAX_REFUSALS, RL, SETTLE_MS, getWar, isCurrent, noteError, paceAfter, paceBefore, paceFor, plain, sleep,
  snapshot, status, waitFor, waitIfPaused, warPlaying
} from "./util.mjs";

const REFUSED = Symbol("refused");

/** Turn budget exceeded: end the turn now. */
class TurnGuard extends Error {}
/** The turn is no longer ours (war ended, GM moved the turn on): stop quietly. */
class TurnOver extends Error {}

/** Attempts per turn key; a turn that can't be finished in 3 runs is a stall. */
const attempts = new Map();
let current = null;     // Promise of the running turn
let recheck = false;
let timer = null;

const troopsAt = (state, fid, id) => state?.territories?.[id]?.pieces?.[fid]?.troops ?? 0;
const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(n) || 0)));
const turnKey = (war, fid) => `${war.id}:${war.round}:${war.turn}:${fid}`;

/* -------------------------------------------- */
/*  Scheduling                                  */
/* -------------------------------------------- */

/** Look for a bot turn to play soon (debounced). */
export function schedule(delay = 0) {
  if ( !game.user?.isActiveGM ) return;
  clearTimeout(timer);
  timer = setTimeout(() => tick().catch(err => console.error("risklegacy | bots: turn loop failed", err)), delay);
}

/** Start the current faction's turn if a bot plays it and it's ready. */
async function tick() {
  if ( !game.user.isActiveGM ) return;
  if ( current ) {
    recheck = true;
    return;
  }
  const war = getWar();
  if ( !war || (war.system.stage !== "playing") ) return;
  const fid = war.combatant?.actorId;
  if ( !fid || !isCurrent(fid) || !botOfFaction(fid) ) return;
  const key = turnKey(war, fid);
  const n = (attempts.get(key) ?? 0) + 1;
  if ( n > 3 ) {
    if ( n === 4 ) {
      attempts.set(key, n);
      status.stats.stalls += 1;
      const name = game.actors.get(fid)?.name ?? "?";
      noteError(game.i18n.format("RL.Bots.Driver.Notify.stalled", { faction: name }), fid);
      ui.notifications.warn(game.i18n.format("RL.Bots.Driver.Notify.stalled", { faction: name }));
    }
    return;
  }
  attempts.set(key, n);
  current = playBotTurn(fid, key).catch(err => {
    console.error("risklegacy | bots: turn failed", err);
    noteError(err.message, fid);
    status.stats.errors += 1;
  });
  try {
    await current;
  } finally {
    current = null;
    status.running = null;
    recheck = false;
    schedule(50);
  }
}

/**
 * Manual trigger or retry (`game.risklegacy.bots.playTurn`): forgets earlier failed attempts of the current turn.
 * @param {string} [fid]  the faction (default: whoever's turn it is)
 * @returns {Promise<void>} resolves when that turn's run ends
 */
export async function playTurn(fid) {
  const war = getWar();
  if ( !war ) return;
  fid ??= war.combatant?.actorId;
  if ( fid ) attempts.delete(turnKey(war, fid));
  if ( current ) await current;
  await tick();
}

/** The running turn's promise (tests). */
export const runningTurn = () => current;

/* -------------------------------------------- */
/*  One turn                                    */
/* -------------------------------------------- */

/**
 * Play a bot's turn from wherever its turn record says it is.
 * @param {string} fid
 * @param {string} key
 */
async function playBotTurn(fid, key) {
  const bot = botOfFaction(fid);
  const actor = game.actors.get(fid);
  const T = {
    fid, key, user: bot.user, difficulty: bot.difficulty, bot, actions: 0, refusals: 0, excluded: new Set(), situation: null,
    ctx: null, ended: false, lazyPace: bot.engine === "llm", paceUntil: 0
  };
  const started = Date.now();
  T.refresh = () => {
    T.ctx = buildContext(fid, { difficulty: T.difficulty, bot: T.bot });
    T.ctx.excluded = T.excluded;
    if ( T.situation ) T.ctx.situation = T.situation;
    return T.ctx;
  };
  const step = name => {
    status.running = { faction: fid, name: actor?.name ?? "", key, step: name };
    if ( !isCurrent(fid) ) throw new TurnOver();
  };

  try {
    await waitIfPaused();
    step("battle");
    T.refresh();
    const open = openBattleOf(fid);
    if ( open ) await driveBattle(T, open.id);

    step("situation");
    T.situation = await decide({
      kind: "situation", ctx: T.refresh(), user: T.user, fn: "assessSituation",
      fallback: () => ({ leader: null, leaderP: 0, threats: {}, hqDanger: 0, why: { reason: "situation" } })
    });

    step("start");
    await stepStart(T);
    step("recruit");
    await stepRecruit(T);
    step("place");
    await stepPlace(T);
    step("attack");
    await stepAttack(T);
    step("maneuver");
    await stepManeuver(T);
    step("end");
    await stepEnd(T);
  } catch(err) {
    if ( err instanceof TurnOver ) return;
    if ( err instanceof TurnGuard ) {
      status.stats.guards += 1;
      console.warn(`risklegacy | bots: ${actor?.name} hit the turn guard (${err.message}); ending the turn`);
    }
    else {
      console.error(`risklegacy | bots: ${actor?.name}'s turn failed`, err);
      noteError(err.message, fid);
      status.stats.errors += 1;
    }
    await endTurnSafely(T);
  } finally {
    status.stats.turnMs += Date.now() - started;
  }
}

/**
 * Run one turn action. Refusals are counted and the move excluded; the guards end the turn.
 * @returns {Promise<*>} the handler's result, or REFUSED
 */
async function act(T, name, payload, { move = null, settle = null, settleMs = SETTLE_MS } = {}) {
  await waitIfPaused();
  if ( !isCurrent(T.fid) ) throw new TurnOver();
  if ( T.actions >= MAX_ACTIONS ) throw new TurnGuard("actions");
  T.actions += 1;
  status.stats.actions += 1;
  try {
    await paceBefore(T);
    const result = await RL().actions.run(name, payload);
    if ( settle ) await waitFor(settle, settleMs);
    await paceAfter(T);
    return result;
  } catch(err) {
    T.refusals += 1;
    status.stats.refusals += 1;
    if ( move ) T.excluded.add(move);
    console.info(`risklegacy | bots: ${name} refused for ${game.actors.get(T.fid)?.name}: ${err.message}`);
    if ( T.refusals >= MAX_REFUSALS ) throw new TurnGuard("refusals");
    return REFUSED;
  }
}

const handIds = fid => new Set(RL().cards.getResourceCards(fid).map(c => c.id));

/** Step 1: Red Stars (4 cards each), then start-of-turn scar cards. */
async function stepStart(T) {
  const war = getWar();
  const log = war.system.turn;
  if ( (war.system.phase !== "start") || log.recruited || log.joinedWar ) return;
  for ( let i = 0; i < 4; i++ ) {
    const ctx = T.refresh();
    if ( ctx.view.hand.length < 4 ) break;
    const plan = await decide({ kind: "startOfTurn", ctx, user: T.user, fn: "planStartOfTurn", fallback: () => ({ buyRedStars: null }) });
    const hand = handIds(T.fid);
    const ids = [...new Set(plan?.buyRedStars ?? [])].filter(id => hand.has(id));
    const use = ids.slice(0, Math.floor(ids.length / 4) * 4);
    if ( !use.length ) break;
    const r = await act(T, "turn.buyRedStars", { faction: T.fid, cardIds: use }, { settle: () => !handIds(T.fid).has(use[0]) });
    if ( r === REFUSED ) break;
    status.stats.starsBought += r?.stars ?? 0;
    if ( !warPlaying() ) throw new TurnOver();
  }

  // Scar cards played at the start of a turn (Mercenary, Bio-hazard) or during your own turn (weakness scars).
  const ctx = T.refresh();
  const cards = ctx.view.scarCards.filter(c => ["startOfAnyTurn", "duringOwnTurn"].includes(c.timing));
  if ( !cards.length ) return;
  let targets = [];
  try {
    targets = RL().cards.scarTargets();
  } catch(err) { /* none */ }
  const plan = await decide({ kind: "scars", ctx, user: T.user, fn: "planScars", args: { cards, targets }, fallback: () => ({ plays: [] }) });
  for ( const p of (plan?.plays ?? []).slice(0, cards.length) ) {
    const card = cards.find(c => c.id === p.cardId);
    if ( !card ) continue;
    const payload = { faction: T.fid, cardId: card.id };
    if ( card.target === "faction" ) {
      const target = p.faction ?? p.target;
      if ( !target || (target === T.fid) || !game.actors.get(target) ) continue;
      payload.target = target;
    }
    else {
      if ( !targets.includes(p.territory) ) continue;
      payload.territory = p.territory;
    }
    await waitIfPaused();
    try {
      await paceBefore(T);
      await RL().cards.playScar(payload);
      status.stats.scarsPlayed += 1;
      await paceAfter(T);
    } catch(err) {
      console.info(`risklegacy | bots: scar ${card.name} refused: ${err.message}`);
    }
  }
}

/** Step 2: Join the War (knocked out) or recruit, with an optional trade for troops. */
async function stepRecruit(T) {
  const log = getWar().system.turn;
  if ( log.recruited || log.joinedWar ) return;
  const ctx = T.refresh();
  const actor = game.actors.get(T.fid);
  const me = ctx.state?.factions?.[T.fid];
  const mustJoin = (actor.system.war.status === "knockedOut") || !me?.territories?.length;
  if ( mustJoin ) {
    const legalJoin = RL().rules.legalStartingTerritories(ctx.state, T.fid, { joining: true });
    if ( !legalJoin.length ) return;
    const plan = await decide({
      kind: "join", ctx, user: T.user, fn: "planRecruit", args: { mustJoin: true, legalJoin },
      fallback: () => ({ join: legalJoin[0] })
    });
    const order = [plan?.join, ...legalJoin].filter((id, i, a) => id && legalJoin.includes(id) && (a.indexOf(id) === i));
    for ( const territory of order.slice(0, 3) ) {
      const r = await act(T, "turn.joinWar", { faction: T.fid, territory }, {
        move: `join:${territory}`, settle: () => snapshot()?.territories?.[territory]?.owner === T.fid
      });
      if ( r !== REFUSED ) {
        status.stats.joins += 1;
        return;
      }
    }
    return;
  }
  const plan = await decide({
    kind: "recruit", ctx, user: T.user, fn: "planRecruit", args: { mustJoin: false, legalJoin: [] },
    fallback: () => ({ recruit: true, tradeForTroops: null })
  });
  const hand = handIds(T.fid);
  const trade = [...new Set(plan?.tradeForTroops ?? [])].filter(id => hand.has(id));
  if ( trade.length >= 2 ) {
    await act(T, "turn.tradeForTroops", { faction: T.fid, cardIds: trade }, { move: "trade", settle: () => getWar().system.turn.tradedForTroops });
  }
  await act(T, "turn.recruit", { faction: T.fid }, { settle: () => getWar().system.turn.recruited });
}

/** Place the whole reserve (brain plan; anything left goes to the first legal territory). */
async function stepPlace(T) {
  const actor = game.actors.get(T.fid);
  for ( let round = 0; round < 6; round++ ) {
    const reserve = actor.system.war.reserve ?? 0;
    if ( reserve <= 0 ) return;
    const ctx = T.refresh();
    const plan = await decide({
      kind: "placement", ctx, user: T.user, fn: "planPlacement", args: { reserve },
      fallback: () => ({ placements: [] })
    });
    let placed = 0;
    for ( const p of plan?.placements ?? [] ) {
      const left = actor.system.war.reserve ?? 0;
      if ( left <= 0 ) break;
      const count = clampInt(p.count, 0, left);
      if ( !count ) continue;
      const state = snapshot();
      if ( !RL().rules.checkPlacement(state, T.fid, p.territory, count).ok ) continue;
      const before = troopsAt(state, T.fid, p.territory);
      const r = await act(T, "turn.placeReserve", { faction: T.fid, territory: p.territory, count }, {
        move: `place:${p.territory}`, settle: () => troopsAt(snapshot(), T.fid, p.territory) >= before + count
      });
      if ( r !== REFUSED ) placed += count;
    }
    if ( !placed ) await placeRemainder(T);
  }
}

/** Fallback: the rest of the reserve on the first territory that takes it. */
async function placeRemainder(T) {
  const actor = game.actors.get(T.fid);
  const reserve = actor.system.war.reserve ?? 0;
  if ( reserve <= 0 ) return;
  const state = snapshot();
  const target = RL().rules.placementTargets(state, T.fid).find(id => !T.excluded.has(`place:${id}`));
  if ( !target ) return;
  const before = troopsAt(state, T.fid, target);
  await act(T, "turn.placeReserve", { faction: T.fid, territory: target, count: reserve }, {
    move: `place:${target}`, settle: () => troopsAt(snapshot(), T.fid, target) >= before + reserve
  });
}

/** Step 3: attacks and expansions until the brain stops. */
async function stepAttack(T) {
  for ( let moves = 0; moves < 40; moves++ ) {
    if ( !isCurrent(T.fid) ) throw new TurnOver();
    const ctx = T.refresh();
    const move = await decide({ kind: "move", ctx, user: T.user, fn: "nextMove", fallback: () => ({ type: "stop" }) });
    if ( !move || !["attack", "expand"].includes(move.type) ) return;
    const tag = `${move.type}:${move.from}>${move.to}`;
    if ( T.excluded.has(tag) ) {
      // The brain offered a move the game already refused: count it like a refusal.
      T.refusals += 1;
      if ( T.refusals >= MAX_REFUSALS ) throw new TurnGuard("refusals");
      continue;
    }
    if ( move.type === "attack" ) {
      const max = RL().rules.maxAttackDice(ctx.state, move.from);
      const dice = clampInt(move.dice || max, 1, Math.max(1, Math.min(3, max)));
      const r = await act(T, "turn.attack", { faction: T.fid, from: move.from, to: move.to, dice }, { move: tag });
      if ( (r === REFUSED) || !r?.messageId ) continue;
      status.stats.battles += 1;
      await driveBattle(T, r.messageId);
      if ( !warPlaying() ) throw new TurnOver();
      continue;
    }
    // Expand, then maybe more troops in
    const count = clampInt(move.count, 1, Math.max(1, troopsAt(ctx.state, T.fid, move.from) - 1));
    const r = await act(T, "turn.expand", { faction: T.fid, from: move.from, to: move.to, count }, {
      move: tag, settle: () => snapshot()?.territories?.[move.to]?.owner === T.fid
    });
    if ( r === REFUSED ) continue;
    status.stats.expansions += 1;
    if ( !warPlaying() ) throw new TurnOver();
    const after = T.refresh();
    const max = troopsAt(after.state, T.fid, move.from) - 1;
    if ( (max > 0) && (after.state?.territories?.[move.to]?.owner === T.fid) ) {
      const d = await decide({
        kind: "moveIn", ctx: after, user: T.user, fn: "moveIn", args: { from: move.from, to: move.to, min: 0, max },
        fallback: () => ({ count: 0 })
      });
      const n = clampInt(d?.count, 0, max);
      if ( n > 0 ) {
        const before = troopsAt(after.state, T.fid, move.from);
        await act(T, "turn.advance", { faction: T.fid, from: move.from, to: move.to, count: n }, {
          move: `advance:${move.from}>${move.to}`, settle: () => troopsAt(snapshot(), T.fid, move.from) <= before - n
        });
      }
    }
  }
}

/** Step 4: the one maneuver. */
async function stepManeuver(T) {
  if ( getWar().system.turn.maneuver?.done ) return;
  const ctx = T.refresh();
  const m = await decide({ kind: "maneuver", ctx, user: T.user, fn: "planManeuver", fallback: () => null });
  if ( !m?.from || !m?.to ) return;
  const count = clampInt(m.count, 0, troopsAt(ctx.state, T.fid, m.from) - 1);
  if ( !count ) return;
  const r = await act(T, "turn.maneuver", { faction: T.fid, from: m.from, to: m.to, count }, {
    move: `maneuver:${m.from}>${m.to}`, settle: () => getWar().system.turn.maneuver?.done
  });
  if ( r !== REFUSED ) status.stats.maneuvers += 1;
}

/** A draw the game will accept, or null. */
function validDraw(draw, options) {
  if ( !draw || !options?.canDraw ) return null;
  if ( draw.coin ) return options.coinAllowed ? { coin: true } : null;
  if ( draw.cardId && (options.territoryCardIds ?? []).includes(draw.cardId) ) return { cardId: draw.cardId };
  return null;
}

/** Step 5: mission or card, then end the turn. */
async function stepEnd(T) {
  const ctx = T.refresh();
  const drawOptions = ctx.view.drawOptions;
  const missionStatus = ctx.view.missionStatus;
  const plan = await decide({
    kind: "endOfTurn", ctx, user: T.user, fn: "planEndOfTurn", args: { drawOptions, missionStatus },
    fallback: () => ({ draw: null, completeMission: false, powers: {} })
  });
  // A bot completes only a mission the code verifies ("manual" missions are claims a bot can't back up).
  const completeMission = !!plan?.completeMission && !!missionStatus?.canComplete && (missionStatus.status === "complete");
  let draw = completeMission ? null : validDraw(plan?.draw, drawOptions);
  if ( !completeMission && plan?.completeMission && !draw && drawOptions?.canDraw ) {
    draw = drawOptions.territoryCardIds?.[0] ? { cardId: drawOptions.territoryCardIds[0] } : (drawOptions.coinAllowed ? { coin: true } : null);
  }
  const powers = plain(plan?.powers ?? {}) ?? {};
  await finishTurn(T, { draw, completeMission, powers });
}

/** turn.end, then wait for the next turn to begin. Retries once without the draw if refused. */
async function finishTurn(T, { draw = null, completeMission = false, powers = {} } = {}) {
  const handBefore = RL().cards.getResourceCards(T.fid).length;
  const done = () => !isCurrent(T.fid) || !warPlaying();
  for ( const payload of [{ draw, completeMission, powers }, { draw: null, completeMission: false, powers: {} }] ) {
    await waitIfPaused();
    await paceBefore(T);
    if ( done() ) return;
    T.actions += 1;
    status.stats.actions += 1;
    try {
      await RL().actions.run("turn.end", { faction: T.fid, ...payload });
      await waitFor(done, 10_000);
      status.stats.turns += 1;
      if ( RL().cards.getResourceCards(T.fid).length > handBefore ) status.stats.cardsDrawn += 1;
      return;
    } catch(err) {
      status.stats.refusals += 1;
      console.warn(`risklegacy | bots: turn.end refused for ${game.actors.get(T.fid)?.name}: ${err.message}`);
    }
  }
  throw new Error(game.i18n.format("RL.Bots.Driver.Notify.endRefused", { faction: game.actors.get(T.fid)?.name ?? "?" }));
}

/** After a guard or an error: place what's left, then end the turn (taking a card if one is allowed). */
async function endTurnSafely(T) {
  try {
    if ( !isCurrent(T.fid) ) return;
    const open = openBattleOf(T.fid);
    if ( open && (open.system.status !== "resolved") ) await RL().battle.cancelBattle({ message: open.id }).catch(() => null);
    T.refusals = 0;
    T.actions = 0;
    await placeRemainder(T).catch(() => null);
    const options = RL().cards.drawOptions(T.fid);
    const draw = options?.canDraw ? (options.territoryCardIds?.[0] ? { cardId: options.territoryCardIds[0] } : (options.coinAllowed ? { coin: true } : null)) : null;
    await finishTurn(T, { draw });
  } catch(err) {
    if ( err instanceof TurnOver ) return;
    console.error("risklegacy | bots: could not end the turn", err);
    noteError(err.message, T.fid);
  }
}

/* -------------------------------------------- */
/*  Starting placement (scripted setups)        */
/* -------------------------------------------- */

/**
 * Place a bot faction's HQ and starting troops (stage `placement`, its pick). The setup wizard doesn't need this: it
 * asks the bot through the `territory` answer and places the pieces itself.
 * @param {string} fid
 * @returns {Promise<{territory: string}|null>}
 */
export async function placeStart(fid) {
  const bot = botOfFaction(fid);
  if ( !bot ) throw new Error(game.i18n.localize("RL.Bots.Driver.Error.notBot"));
  const war = getWar();
  if ( war?.system.stage !== "placement" ) throw new Error(game.i18n.localize("RL.Bots.Driver.Error.notPlacement"));
  if ( game.actors.get(fid)?.system.war.startingTerritory ) return null;
  const myPick = () => { const w = getWar(); return w?.system.placement.order[w.system.placement.index] === fid; };
  await waitFor(myPick, 10_000);
  await waitIfPaused();
  const ctx = buildContext(fid, { difficulty: bot.difficulty, bot });
  const legal = RL().rules.legalStartingTerritories(ctx.state, fid, { joining: false });
  if ( !legal.length ) throw new Error(game.i18n.format("RL.Bots.Driver.Error.noStart", { faction: game.actors.get(fid)?.name ?? "?" }));
  const d = await decide({
    kind: "startingTerritory", ctx, user: bot.user, fn: "chooseStartingTerritory", args: { legal, joining: false },
    fallback: () => ({ territory: legal[0] })
  });
  const territory = legal.includes(d?.territory) ? d.territory : legal[0];
  await RL().actions.run("turn.placeStartingForces", { faction: fid, territory });
  await waitFor(() => snapshot()?.territories?.[territory]?.owner === fid, 3000);
  await sleep(paceFor(ctx));
  return { territory };
}
