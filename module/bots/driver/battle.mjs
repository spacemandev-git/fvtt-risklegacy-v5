/**
 * Battles for bots (BOTS.md §6.2).
 *
 * - Bot attacker (`driveBattle`, called from the turn loop): pre-roll scar decisions for every bot holding Bunker /
 *   Ammo Shortage, a reaction window only when a person could react, roll; once rolled, missile decisions (attacker,
 *   defender, then bystander bots), a reaction window only when a person holds a missile, wait for `hold` to clear,
 *   resolve; on a conquest, move in; stop.
 * - Person attacker (`onBattleMessage`, chat message hooks): the same scar and missile decisions for every bot, once
 *   per bot per window, as soon as the card reaches that status (the attacker may resolve at any time).
 * Bot defenders' dice come from the `defense` answer (battle/defense.mjs hook point).
 */
import { battleData, buildContext, scarCardsOf } from "./context.mjs";
import { decide } from "./decide.mjs";
import {
  RL, botFactions, botOfFaction, getWar, isPersonFaction, paceAfter, paceBefore, paceFor, reactionWindow, sleep, status,
  waitFor, waitIfPaused, warFactions
} from "./util.mjs";

const SIDES = ["attack", "defend"];

/** Decisions already taken: "<message>:scar:<faction>" / "<message>:missile:<faction>:<missiles so far>". */
const done = new Set();
/** Battles a bot attacker is driving (the reactive watcher leaves them alone). */
const driving = new Set();
/** Per-message queue for reactive decisions. */
const queues = new Map();

function remember(key) {
  if ( done.has(key) ) return false;
  done.add(key);
  if ( done.size > 2000 ) {
    const first = done.values().next().value;
    done.delete(first);
  }
  return true;
}

const msgOf = id => game.messages.get(id) ?? null;

/** Scar cards a faction could play before this roll (Bunker / Ammo Shortage on the defending territory). */
function preRollScars(fid, message) {
  const state = RL().turn.snapshot();
  const to = state?.territories?.[message.system.to];
  if ( !to || to.scar ) return [];
  return scarCardsOf(fid).filter(c => (c.target === "territory") && ((c.timing || "beforeAttackRoll") === "beforeAttackRoll")
    && (!c.where || (c.where === "defendingTerritory")));
}

/** Could a person still react before the roll (a scar card, or EMP)? */
function personCanReactPreRoll(message) {
  const war = getWar();
  const flags = war?.system.turn?.flags ?? {};
  const empUsed = flags.missilePowers ?? {};
  const empHere = (flags.emp ?? []).includes(message.system.to);
  for ( const actor of warFactions() ) {
    if ( !isPersonFaction(actor) ) continue;
    if ( preRollScars(actor.id, message).length ) return true;
    const emp = actor.items.some(i => (i.type === "power") && (i.system.key === "emp"));
    if ( emp && !empHere && !empUsed[actor.id] && ((actor.system.war?.missiles ?? 0) > 0) ) return true;
  }
  return false;
}

/** Does a person hold a missile they could fire on this roll? */
function personHoldsMissile(message) {
  const unmodifiable = message.system.rules?.unmodifiable ?? [];
  if ( SIDES.every(s => unmodifiable.includes(s)) ) return false;
  return warFactions().some(a => isPersonFaction(a) && ((a.system.war?.missiles ?? 0) > 0));
}

/** Bot factions in the order they decide: attacker, defender, then bystanders. */
function botOrder(message) {
  const bots = botFactions();
  const rank = ({ actor }) => (actor.id === message.system.attacker ? 0 : actor.id === message.system.defender ? 1 : 2);
  return bots.sort((a, b) => rank(a) - rank(b));
}

/**
 * Pre-roll scar decisions for every bot holding one (one card per territory: the first played scars it).
 * @param {string} id   message id
 */
export async function botScarReactions(id) {
  for ( const { actor, user, difficulty, bot } of botOrder(msgOf(id) ?? { system: {} }) ) {
    const message = msgOf(id);
    if ( !message || (message.system.status !== "declared") || !message.system.preRoll ) return;
    if ( actor.id === message.system.attacker ) continue;
    const cards = preRollScars(actor.id, message);
    if ( !cards.length || !remember(`${id}:scar:${actor.id}`) ) continue;
    await waitIfPaused();
    const ctx = buildContext(actor.id, { difficulty, bot });
    const d = await decide({
      kind: "scar", ctx, user, fn: "preRollScar", args: { battle: battleData(message), cards },
      fallback: () => null, quietIfNull: true
    });
    const card = d?.cardId ? cards.find(c => c.id === d.cardId) : null;
    if ( !card ) continue;
    try {
      await RL().battle.playScarBeforeRoll({ message: id, faction: actor.id, cardId: card.id });
      status.stats.scarsPlayed += 1;
      await sleep(paceFor(ctx));
      return;
    } catch(err) {
      console.warn(`risklegacy | bots: ${actor.name} could not play ${card.name}`, err);
    }
  }
}

/** Is this missile legal on this roll? */
function legalMissile(message, fid, d) {
  if ( !d?.fire || !SIDES.includes(d.side) ) return false;
  const sys = message.system;
  if ( (sys.rules?.unmodifiable ?? []).includes(d.side) ) return false;
  const die = (sys[d.side] ?? []).find(x => x.slot === Number(d.index));
  if ( !die || die.missile ) return false;
  return (game.actors.get(fid)?.system.war?.missiles ?? 0) > 0;
}

/**
 * Missile decisions for every bot holding a missile, once per bot per missile count; repeats while someone fires.
 * @param {string} id
 */
export async function botMissileReactions(id) {
  for ( let round = 0; round < 4; round++ ) {
    let fired = false;
    for ( const { actor, user, difficulty, bot } of botOrder(msgOf(id) ?? { system: {} }) ) {
      const message = msgOf(id);
      if ( !message || (message.system.status !== "rolled") ) return;
      if ( (actor.system.war?.missiles ?? 0) < 1 ) continue;
      const unmodifiable = message.system.rules?.unmodifiable ?? [];
      if ( SIDES.every(s => unmodifiable.includes(s)) ) return;
      if ( !remember(`${id}:missile:${actor.id}:${message.system.missiles.length}`) ) continue;
      await waitIfPaused();
      const ctx = buildContext(actor.id, { difficulty, bot });
      const d = await decide({
        kind: "missile", ctx, user, fn: "missileDecision", args: { battle: battleData(message) },
        fallback: () => ({ fire: false, why: { reason: "missileHold" } })
      });
      const current = msgOf(id);
      if ( !current || (current.system.status !== "rolled") || !legalMissile(current, actor.id, d) ) continue;
      try {
        await RL().battle.fireMissile({ message: id, faction: actor.id, side: d.side, index: Number(d.index) });
        status.stats.missilesFired += 1;
        fired = true;
        await sleep(paceFor(ctx));
      } catch(err) {
        console.warn(`risklegacy | bots: ${actor.name} could not fire a missile`, err);
      }
    }
    if ( !fired ) return;
  }
}

/** Run reactive work for one message in order. */
function enqueue(id, fn) {
  const prior = queues.get(id) ?? Promise.resolve();
  const next = prior.then(fn).catch(err => console.error("risklegacy | bots: battle reaction failed", err));
  queues.set(id, next);
  next.then(() => {
    if ( queues.get(id) === next ) queues.delete(id);
  });
  return next;
}

/** createChatMessage / updateChatMessage: bots react to battles a person started. */
export function onBattleMessage(message) {
  if ( !game.user.isActiveGM || (message?.type !== "battle") ) return;
  if ( driving.has(message.id) || botOfFaction(message.system.attacker) ) return;
  if ( !botFactions().length ) return;
  const sys = message.system;
  if ( (sys.status === "declared") && sys.preRoll ) enqueue(message.id, () => botScarReactions(message.id));
  else if ( sys.status === "rolled" ) enqueue(message.id, () => botMissileReactions(message.id));
}

/**
 * A bot attacker plays its battle to the end (also used to finish an open battle after a reload).
 * @param {{fid: string, ctx: object, refresh: Function, user: User, lazyPace?: boolean}} T   the turn state
 * @param {string} id   battle message id
 * @returns {Promise<object|null>} the battle result
 */
export async function driveBattle(T, id) {
  driving.add(id);
  try {
    let message = msgOf(id);
    if ( !message ) return null;

    // 1. Pre-roll window: bot scars, then (only if a person could react) a pause, then roll.
    if ( (message.system.status === "declared") && message.system.preRoll ) {
      await botScarReactions(id);
      if ( personCanReactPreRoll(msgOf(id)) && reactionWindow() ) await sleep(reactionWindow());
      await waitIfPaused();
      await paceBefore(T);
      message = msgOf(id);
      if ( message?.system.status === "declared" ) await RL().battle.rollBattle({ message: id });
    }
    else if ( message.system.status === "declared" ) {
      // Rolling by itself (no pre-roll window): make sure it isn't stuck after a reload.
      const rolled = await waitFor(() => msgOf(id)?.system.status !== "declared", 5000);
      if ( !rolled ) await RL().battle.rollBattle({ message: id }).catch(() => null);
    }

    // 2. Wait for the dice (a person defending with defenderChoice = prompt may take up to 35 s).
    await waitFor(() => ["rolled", "resolved", "cancelled"].includes(msgOf(id)?.system.status), 60_000, 150);
    message = msgOf(id);

    // 3. Missiles, then resolve.
    if ( message?.system.status === "rolled" ) {
      await botMissileReactions(id);
      if ( personHoldsMissile(msgOf(id)) && reactionWindow() ) {
        const before = msgOf(id)?.system.missiles.length ?? 0;
        await sleep(reactionWindow());
        if ( (msgOf(id)?.system.missiles.length ?? 0) > before ) await botMissileReactions(id);
      }
      // The third missile on a roll holds the battle while the GM opens Pocket 1.
      await waitFor(() => !msgOf(id)?.system.hold || (msgOf(id)?.system.status !== "rolled"), 10 * 60_000, 500);
      await waitIfPaused();
      if ( msgOf(id)?.system.status === "rolled" ) {
        try {
          await RL().battle.resolve({ message: id });
        } catch(err) {
          if ( msgOf(id)?.system.status === "rolled" ) throw err;
        }
      }
    }
    await waitFor(() => ["resolved", "cancelled"].includes(msgOf(id)?.system.status), 10_000, 100);
    message = msgOf(id);
    if ( message?.system.status !== "resolved" ) return message?.system.result ?? null;

    // 4. Conquest: more troops in?
    const result = message.system.result;
    if ( result.conquered ) {
      status.stats.conquests += 1;
      await waitFor(() => RL().turn.snapshot().territories[message.system.to]?.owner === T.fid, 3000);
      const state = RL().turn.snapshot();
      const max = (state.territories[message.system.from]?.pieces?.[T.fid]?.troops ?? 0) - 1;
      if ( (max > 0) && !message.system.closed && !result.moveInDone && (getWar()?.system.stage === "playing") ) {
        const ctx = T.refresh();
        const d = await decide({
          kind: "moveIn", ctx, user: T.user, fn: "moveIn", args: { from: message.system.from, to: message.system.to, min: 0, max },
          fallback: () => ({ count: 0, why: { reason: "holdBack" } })
        });
        const count = Math.min(max, Math.max(0, Math.trunc(Number(d?.count) || 0)));
        if ( count > 0 ) {
          await waitIfPaused();
          await paceBefore(T);
          try {
            await RL().battle.moveIn({ message: id, count });
            await waitFor(() => (RL().turn.snapshot().territories[message.system.from]?.pieces?.[T.fid]?.troops ?? 0) <= max + 1 - count, 3000);
          } catch(err) {
            console.warn("risklegacy | bots: move-in refused", err);
          }
        }
      }
    }
    if ( !msgOf(id)?.system.closed && (getWar()?.system.stage === "playing") ) {
      await RL().battle.stopBattle({ message: id }).catch(() => null);
    }
    await paceAfter(T);
    return msgOf(id)?.system.result ?? null;
  } finally {
    driving.delete(id);
  }
}

/** The bot attacker's battle left open by a reload (or a crash), if any. */
export function openBattleOf(fid) {
  const war = getWar();
  const message = war?.system.battle ? msgOf(war.system.battle) : null;
  if ( (message?.type !== "battle") || (message.system.attacker !== fid) ) return null;
  if ( message.system.status === "cancelled" ) return null;
  if ( (message.system.status === "resolved") && message.system.closed ) return null;
  return message;
}
