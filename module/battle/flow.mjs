/**
 * Battle flow: the GM action handlers behind the battle area's API (ARCHITECTURE §5.3).
 *
 * Every handler runs on the active GM (module/gm/actions.mjs), re-checks permissions with `canActFor`, and the
 * rules with `enforce`. Read-modify-write steps on one battle message are serialized with `withLock`, so two
 * missiles fired at the same moment are applied one after the other (first come, first served).
 */
import { FORTIFICATION_USES, SYSTEM_ID } from "../config.mjs";
import {
  canActFor, enforce, enforcementLevel, fail, getBoardScene, getCampaign, getFactions, getHand, getWar, reasonText
} from "../state/_module.mjs";
import {
  applySources, collectSources, enterLossDue, enterLossFor, normalizeKey, resolveDice
} from "./modifiers.mjs";
import { api, lookup, requireFn, requireSnapshot, rulesApi, setting } from "./services.mjs";
import { rollCombatDice } from "./dice.mjs";
import { playerOf, requestDefense, settleDefense } from "./defense.mjs";

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const error = (key, data) => new Error(loc(key, data));
const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(n) || 0)));
const SIDES = ["attack", "defend"];

/** Serialize work on one message id. */
const chains = new Map();
function withLock(id, fn) {
  const run = (chains.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chains.set(id, tail);
  tail.then(() => {
    if ( chains.get(id) === tail ) chains.delete(id);
  });
  return run;
}

/** Battles currently being rolled on this GM (guards against double rolls). */
const rolling = new Set();

/** @returns {string} a message id from an id or a ChatMessage */
export const messageIdOf = message => (typeof message === "string" ? message : message?.id ?? "");

/** The battle ChatMessage, or throw. */
function getBattleMessage(message) {
  const msg = game.messages.get(messageIdOf(message));
  if ( !msg || (msg.type !== "battle") ) throw error("RL.Battle.Error.notBattle");
  return msg;
}

/** A faction actor, or throw. */
function factionActor(id) {
  const actor = game.actors.get(typeof id === "string" ? id : id?.id);
  if ( !actor || (actor.type !== "faction") ) throw error("RL.Battle.Error.notFaction");
  return actor;
}

/** Throw unless the user may act for the faction (GMs always may). */
function assertActsFor(user, faction) {
  if ( !canActFor(user, faction) ) {
    const actor = typeof faction === "string" ? game.actors.get(faction) : faction;
    throw error("RL.Battle.Error.notYours", { faction: actor?.name ?? "?" });
  }
}

/** Territory display name from a snapshot. */
const territoryName = (snap, id) => snap?.territories?.[id]?.name ?? id;

/** Troops a faction has in a territory (snapshot). */
const troopsIn = (snap, territory, faction) => snap?.territories?.[territory]?.pieces?.[faction]?.troops ?? 0;

/** Factions taking part in the war (all factions when no war is running, e.g. in tests). */
function warFactions() {
  const active = getFactions({ active: true });
  return active.length ? active : getFactions();
}

/** @returns {boolean} does any faction in the war hold a missile? */
export function anyMissiles() {
  return warFactions().some(f => (f.system.war?.missiles ?? 0) > 0);
}

/** The modifier battle descriptor for collectSources. */
function battleDescriptor(sys) {
  return {
    attacker: sys.attacker, defender: sys.defender, from: sys.from, to: sys.to,
    activeEvents: [...(getWar()?.system.activeEvents ?? [])]
  };
}

/** Maximum dice for each side (rules engine when available). */
function maxAttackDice(snap, from, attacker) {
  const fromRules = api("rules")?.maxAttackDice?.(snap, from);
  return clampInt(Number.isFinite(fromRules) ? fromRules : troopsIn(snap, from, attacker) - 1, 0, 3);
}
function maxDefendDice(snap, to, defender) {
  const fromRules = api("rules")?.defenderMaxDice?.(snap, to);
  return clampInt(Number.isFinite(fromRules) ? fromRules : troopsIn(snap, to, defender), 0, 2);
}

/**
 * Run rule checks through `enforce`. Blocked → throws; advisory → returns notes for the card.
 * @param {RuleResult[]} checks
 * @returns {{key: string, data: object}[]}
 */
function enforceAll(checks) {
  const notes = [];
  for ( const check of checks ) {
    if ( !check || check.ok ) continue;
    const reason = reasonText(check);
    if ( !enforce(check, { notify: false }) ) throw new Error(loc("RL.Enforce.blocked", { reason }));
    if ( enforcementLevel() === "advisory" ) notes.push({ key: "RL.Battle.Note.advisory", data: { reason } });
  }
  return notes;
}

/** Move the war to another turn step (turn.setPhase when the turn area provides it). Returns card notes. */
async function advancePhase(phase) {
  const war = getWar();
  if ( !war || (war.system.phase === phase) ) return [];
  try {
    const turn = api("turn");
    if ( typeof turn?.setPhase === "function" ) await turn.setPhase({ phase });
    else await war.update({ "system.phase": phase });
    return [];
  } catch(err) {
    console.warn("risklegacy | could not advance the turn step", err);
    return [{ key: "RL.Battle.Note.error", data: { error: err.message } }];
  }
}

/** The battle message recorded on the war (latest battle). */
export function currentBattleMessage() {
  const war = getWar();
  const msg = war?.system.battle ? game.messages.get(war.system.battle) : null;
  return (msg?.type === "battle") ? msg : null;
}

/**
 * The latest battle that hasn't been decided yet (blocks a new attack under strict enforcement). A battle left open
 * by an earlier turn (the attacker never rolled) doesn't block anyone: the turn area cancels it at end of turn.
 */
function openBattle() {
  const msg = currentBattleMessage();
  if ( !msg ) return null;
  if ( ["resolved", "cancelled"].includes(msg.system.status) ) return null;
  const turnFaction = getWar()?.system.turn.faction;
  if ( turnFaction && (msg.system.attacker !== turnFaction) ) return null;
  return msg;
}

/** Close the follow-up controls (move in, attack again) of earlier resolved battles. */
async function closeFollowUps(except = null) {
  const updates = game.messages.contents.slice(-100)
    .filter(m => (m.type === "battle") && (m.id !== except) && !m.system.closed
      && ["resolved", "cancelled"].includes(m.system.status))
    .map(m => ({ _id: m.id, "system.closed": true }));
  if ( updates.length ) await ChatMessage.implementation.updateDocuments(updates);
}

/** Record a note on a battle card (and log errors). */
async function addNote(id, key, data = {}) {
  const msg = game.messages.get(id);
  if ( !msg ) return;
  await msg.update({ "system.notes": [...msg.system.toObject().notes, { key, data }] });
}

/** Report an unexpected error on the card and in the console. */
async function reportError(id, err) {
  console.error("risklegacy | battle error", err);
  try {
    await addNote(id, "RL.Battle.Note.error", { error: err?.message ?? String(err) });
  } catch(e) { /* the message may be gone */ }
}

/* -------------------------------------------- */
/*  Pre-roll reactions (EMP, scar cards)        */
/* -------------------------------------------- */

/** Does a faction hold a power (by normalized key)? */
const hasPower = (actor, key) => actor.items.some(i => (i.type === "power") && (normalizeKey(i.system.key) === key));

/** Factions that could activate EMP on this territory now. */
export function empCandidates(to) {
  const war = getWar();
  if ( !war ) return [];
  const flags = war.system.turn?.flags ?? {};
  if ( (flags.emp ?? []).includes(to) ) return [];
  const used = flags.missilePowers ?? {};   // {factionId: power} (missile powers: once per turn), as the turn area keeps it
  return warFactions().filter(f => (f.system.war?.missiles > 0) && !used[f.id] && hasPower(f, "emp"));
}

/** Scar cards that may be played before this attack roll: [{faction, card, scar, entry}]. GM sees every hand. */
export function scarCandidates(snap, to) {
  if ( typeof api("cards")?.playScar !== "function" ) return [];
  const territory = snap?.territories?.[to];
  if ( !territory || territory.scar ) return [];
  const out = [];
  for ( const faction of warFactions() ) {
    const hand = getHand(faction);
    for ( const card of hand?.cards ?? [] ) {
      if ( card.type !== "scar" ) continue;
      const scarId = card.system?.scar || card.system?.catalogId;
      const entry = lookup("scars", scarId);
      if ( (entry?.play?.timing ?? "beforeAttackRoll") !== "beforeAttackRoll" ) continue;
      if ( entry?.play?.where && (entry.play.where !== "defendingTerritory") ) continue;
      out.push({ faction, card, scar: scarId, entry });
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Start                                       */
/* -------------------------------------------- */

/**
 * battle.start: validate the attack, post the card, then roll (or wait for pre-roll reactions).
 * @param {{attacker: string, from: string, to: string, dice?: number, round?: number}} payload
 * @param {{user: User}} context
 * @returns {Promise<string>} the battle message id
 */
export async function handleStart({ attacker, from, to, dice, round } = {}, { user }) {
  const atk = factionActor(attacker);
  assertActsFor(user, atk);
  const rules = rulesApi();
  const snap = requireSnapshot();
  const fromT = snap.territories[from];
  const toT = snap.territories[to];
  if ( !fromT || !toT ) throw error("RL.Battle.Error.unknownTerritory");
  const defenderId = toT.owner;
  if ( !defenderId ) throw error("RL.Battle.Error.noDefender", { territory: toT.name });
  if ( defenderId === atk.id ) throw error("RL.Battle.Error.ownTerritory", { territory: toT.name });
  const defender = factionActor(defenderId);

  const maxDice = maxAttackDice(snap, from, atk.id);
  const requested = Number(dice) || maxDice || 1;
  const attackDice = clampInt(requested, 1, 3);

  // Rule checks: the rules engine (turn, adjacency, troops), protection, one battle at a time.
  const checks = [rules.checkAttack(snap, atk.id, from, to, attackDice)];
  if ( (snap.turn?.log?.protected ?? []).includes(to) ) {
    checks.push(fail("RL.Battle.Error.protected", { territory: toT.name }));
  }
  if ( openBattle() ) checks.push(fail("RL.Battle.Error.inProgress"));
  const notes = enforceAll(checks);
  // Attacking from step 2 moves the turn on to step 3 (the rules engine says where to go).
  if ( checks[0]?.ok && checks[0].data?.advance ) notes.push(...await advancePhase(checks[0].data.advance));

  // Consecutive battles between the same territories this turn are numbered (Attack again).
  const previous = currentBattleMessage();
  const again = previous && (previous.system.attacker === atk.id) && (previous.system.from === from)
    && (previous.system.to === to) && (previous.system.status === "resolved") && !previous.system.result.conquered;
  round = Math.max(1, Number(round) || (again ? previous.system.round + 1 : 1));

  await closeFollowUps();
  const preRoll = (empCandidates(to).length > 0) || (scarCandidates(snap, to).length > 0);
  const message = await ChatMessage.implementation.create({
    type: "battle",
    speaker: { scene: getBoardScene()?.id ?? null, actor: atk.id, token: null, alias: atk.name },
    system: {
      attacker: atk.id, defender: defender.id, from, to, attackDice, defendDice: 0,
      status: "declared", preRoll, round, notes,
      troops: { attacker: troopsIn(snap, from, atk.id), defender: troopsIn(snap, to, defender.id) }
    },
    flags: { [SYSTEM_ID]: { card: true } }
  });

  // War bookkeeping: the battle in progress, and the first territory attacked this turn (Enclave power 1) when
  // nobody recorded it yet. turn.attack counts the attacks.
  const war = getWar();
  if ( war ) {
    const updates = { "system.battle": message.id };
    const turn = war.system.turn;
    const isCurrent = (war.combatant?.actorId === atk.id) || (turn.faction === atk.id);
    if ( isCurrent && !turn.firstAttackTarget ) updates["system.turn.firstAttackTarget"] = to;
    await war.update(updates);
  }

  if ( !preRoll ) rollBattle(message.id).catch(err => reportError(message.id, err));
  return message.id;
}

/* -------------------------------------------- */
/*  Roll                                        */
/* -------------------------------------------- */

/**
 * battle.roll: the attacker rolls after the pre-roll window.
 * @param {{message: string}} payload
 */
export async function handleRoll({ message } = {}, { user }) {
  const msg = getBattleMessage(message);
  assertActsFor(user, msg.system.attacker);
  if ( msg.system.status !== "declared" ) return msg.id;
  rollBattle(msg.id).catch(err => reportError(msg.id, err));
  return msg.id;
}

/**
 * Get the defender's dice, roll, apply modifiers and reveal the dice on the card. Auto-resolves when the world
 * setting allows it and nobody can fire a missile.
 * @param {string} id  message id
 */
export async function rollBattle(id) {
  const claimed = await withLock(id, async () => {
    const msg = game.messages.get(id);
    if ( !msg || (msg.system.status !== "declared") || rolling.has(id) ) return false;
    rolling.add(id);
    return true;
  });
  if ( !claimed ) return;
  let rolled = false;
  try {
    let msg = game.messages.get(id);
    const sys = msg.system;
    let snap = requireSnapshot();

    // 1. Defender's dice: maximum, or ask the defending player.
    let defendDice = sys.defendDice;
    if ( !defendDice ) {
      const max = Math.max(1, maxDefendDice(snap, sys.to, sys.defender));
      defendDice = max;
      if ( (setting("defenderChoice") === "prompt") && (max > 1) ) {
        await msg.update({ "system.status": "awaitingDefender", "system.preRoll": false });
        defendDice = await requestDefense(msg, max, {
          attacker: game.actors.get(sys.attacker)?.name ?? "", from: territoryName(snap, sys.from),
          to: territoryName(snap, sys.to), attackDice: sys.attackDice
        });
        msg = game.messages.get(id);
        if ( !msg || (msg.system.status === "cancelled") ) return;
        snap = requireSnapshot();
      }
    }

    // 2. Modifiers in effect for this roll (fixed now; missiles re-apply them later).
    const { sources, rules, notes } = collectSources(snap, battleDescriptor(sys), { lookup });

    // 3. Roll (Dice So Nice shows it to everyone; the card reveals the result once the dice have landed).
    const attackerUser = playerOf(game.actors.get(sys.attacker));
    const dice = await rollCombatDice({
      attackDice: sys.attackDice, defendDice, rerollOnes: rules.rerollOnes, message: msg,
      user: attackerUser?.active ? attackerUser : game.user
    });
    if ( dice.rerolled ) notes.push({ key: "RL.Battle.Note.rerolled", data: { count: dice.rerolled } });

    await withLock(id, async () => {
      const current = game.messages.get(id);
      if ( !current || (current.system.status === "cancelled") ) return;
      await current.update({
        "system.status": "rolled", "system.preRoll": false, "system.defendDice": defendDice,
        "system.attack": applySources(dice.attack, sources, "attack"),
        "system.defend": applySources(dice.defend, sources, "defend"),
        "system.sources": sources, "system.rules": rules,
        "system.notes": [...current.system.toObject().notes, ...notes]
      });
      rolled = true;
    });
  } finally {
    rolling.delete(id);
  }

  // 4. Auto-resolve when nobody can fire a missile (world setting).
  if ( rolled && (setting("battleAutoResolve") !== "never") ) {
    const msg = game.messages.get(id);
    const modifiable = SIDES.some(s => !msg.system.rules.unmodifiable.includes(s));
    if ( !(anyMissiles() && modifiable) ) await handleResolve({ message: id }, { user: game.user, auto: true });
  }
}

/**
 * battle.defend: the defender (or GM) picks the defence dice from the card.
 * @param {{message: string, dice: number}} payload
 */
export async function handleDefend({ message, dice } = {}, { user }) {
  const msg = getBattleMessage(message);
  assertActsFor(user, msg.system.defender);
  if ( msg.system.status !== "awaitingDefender" ) throw error("RL.Battle.Error.notAwaiting");
  if ( !settleDefense(msg.id, Number(dice) || null) ) {
    // Nothing pending on this GM (e.g. after a reload): roll now with the chosen dice.
    await msg.update({ "system.status": "declared", "system.defendDice": clampInt(dice, 1, 2) });
    rollBattle(msg.id).catch(err => reportError(msg.id, err));
  }
  return msg.id;
}

/* -------------------------------------------- */
/*  Missiles                                    */
/* -------------------------------------------- */

/**
 * battle.fireMissile: one missile turns one die into an unmodifiable 6. The third missile on one roll opens
 * Pocket 1 (threemissiles) before the battle can be resolved.
 * @param {{message: string, faction: string, side: "attack"|"defend", index: number}} payload  index = die slot
 * @returns {Promise<{count: number}>}
 */
export async function handleFireMissile({ message, faction, side, index } = {}, { user }) {
  const id = messageIdOf(message);
  const fired = await withLock(id, async () => {
    const msg = getBattleMessage(id);
    const data = msg.system.toObject();
    if ( data.status !== "rolled" ) throw error("RL.Battle.Error.notRolled");
    if ( !SIDES.includes(side) ) throw error("RL.Battle.Error.badDie");
    if ( data.rules.unmodifiable.includes(side) ) throw error("RL.Battle.Error.unmodifiable");
    const actor = factionActor(faction);
    assertActsFor(user, actor);
    const left = actor.system.war?.missiles ?? 0;
    if ( left < 1 ) throw error("RL.Battle.Error.noMissiles", { faction: actor.name });
    const dice = data[side];
    const die = dice.find(d => d.slot === Number(index));
    if ( !die ) throw error("RL.Battle.Error.badDie");
    if ( die.missile ) throw error("RL.Battle.Error.alreadyMissile");
    die.missile = true;
    die.missileBy = actor.id;
    const missiles = [...data.missiles, { by: actor.id, userId: user.id, side, index: die.slot }];
    const count = missiles.length;
    const opened = !!getCampaign()?.system.packs?.threemissiles?.opened;
    const canTrigger = typeof api("campaign")?.triggerPack === "function";
    const openPack = (count === 3) && !opened && canTrigger;
    await actor.update({ "system.war.missiles": left - 1 });
    const notes = openPack ? [...data.notes, { key: "RL.Battle.Note.pack", data: {} }] : data.notes;
    await msg.update({
      [`system.${side}`]: applySources(dice, data.sources, side),
      "system.missiles": missiles,
      "system.hold": openPack ? "threemissiles" : data.hold,
      "system.notes": notes
    });
    Hooks.callAll("risklegacy.missileFired", game.messages.get(id), count, actor);
    return {
      count, openPack, territory: data.to, faction: actor.id,
      context: { from: data.from, to: data.to, attacker: data.attacker, defender: data.defender }
    };
  });

  // Pocket 1 opens as soon as the third missile is played and BEFORE resolving combat.
  if ( fired.openPack ) {
    try {
      const snap = requireSnapshot();
      await api("campaign").triggerPack("threemissiles", {
        reason: loc("RL.Battle.PackReason", { territory: territoryName(snap, fired.territory) }),
        faction: fired.faction, context: fired.context
      });
    } catch(err) {
      console.error("risklegacy | could not open Pocket 1 (threemissiles)", err);
    } finally {
      await withLock(id, async () => {
        const msg = game.messages.get(id);
        if ( msg?.system.hold === "threemissiles" ) await msg.update({ "system.hold": "" });
      });
    }
  }
  return { count: fired.count };
}

/* -------------------------------------------- */
/*  Resolve                                     */
/* -------------------------------------------- */

/**
 * battle.resolve: compare the dice, remove casualties, wear the fortification, and conquer.
 * @param {{message: string}} payload
 * @param {{user: User, auto?: boolean}} context
 * @returns {Promise<object|null>} the stored result (null if it was already resolved)
 */
export async function handleResolve({ message } = {}, { user, auto = false }) {
  const id = messageIdOf(message);
  const result = await withLock(id, async () => {
    const msg = getBattleMessage(id);
    const data = msg.system.toObject();
    if ( data.status === "resolved" ) return null;
    if ( data.status !== "rolled" ) throw error("RL.Battle.Error.notRolled");
    if ( !auto ) assertActsFor(user, data.attacker);
    if ( data.hold ) throw error("RL.Battle.Error.onHold");
    return applyResolution(msg, data);
  });
  if ( result ) Hooks.callAll("risklegacy.battleResolved", game.messages.get(id));
  return result;
}

/**
 * Apply a rolled battle to the board and record the result on the message.
 * @param {ChatMessage} msg
 * @param {object} data  msg.system.toObject()
 */
async function applyResolution(msg, data) {
  const outcome = resolveDice(data);
  const snap = requireSnapshot();
  const toT = snap.territories[data.to];
  const attackerTroops = troopsIn(snap, data.from, data.attacker);
  const defenderTroops = troopsIn(snap, data.to, data.defender);
  const attackerLosses = Math.min(outcome.attackerLosses, attackerTroops);
  const defenderLosses = outcome.conquerAll ? defenderTroops : Math.min(outcome.defenderLosses, defenderTroops);
  const notes = [];
  const result = {
    attackerLosses, defenderLosses, conquered: false, conqueredAll: false, movedIn: 0, moveInDone: false,
    enterLosses: 0, fortificationWorn: 0, protected: false, cloned: false, pairs: outcome.pairs,
    fromLeft: attackerTroops - attackerLosses, toLeft: defenderTroops - defenderLosses
  };

  // Casualties
  const removeTroops = requireFn("board", "removeTroops");
  if ( attackerLosses > 0 ) await removeTroops({ faction: data.attacker, territory: data.from, count: attackerLosses });
  if ( defenderLosses > 0 ) await removeTroops({ faction: data.defender, territory: data.to, count: defenderLosses });

  // A 3-troop attack wears down a (real) fortification by one box.
  if ( (data.attackDice === 3) && toT?.fortified ) {
    result.fortificationWorn = (await wearFortification(data.to)) ? 1 : 0;
  }

  result.conquered = (defenderTroops - defenderLosses) <= 0;
  if ( result.conquered ) {
    result.conqueredAll = outcome.conquerAll;
    const survivors = Math.max(0, data.attackDice - attackerLosses);
    const moveIn = Math.min(survivors, Math.max(0, result.fromLeft - 1));
    if ( moveIn > 0 ) {
      await requireFn("board", "moveTroops")({ faction: data.attacker, from: data.from, to: data.to, count: moveIn });
    }
    result.movedIn = moveIn;
    result.fromLeft -= moveIn;
    result.toLeft = moveIn;
    const conquest = await conquer(data, snap, moveIn);
    result.enterLosses = conquest.enterLosses;
    result.toLeft -= conquest.enterLosses;
    notes.push(...conquest.notes);
  }
  else {
    if ( outcome.protect ) {
      await protectTerritory(data.to);
      result.protected = true;
    }
    if ( outcome.clone ) {
      const spawn = api("board")?.spawnPieces;
      if ( typeof spawn === "function" ) {
        await spawn.call(api("board"), { faction: data.defender, territory: data.to, troops: 1 });
        result.cloned = true;
        result.toLeft += 1;
      }
    }
  }

  const closed = result.conquered ? (result.fromLeft < 2) : !((result.fromLeft >= 2) && (result.toLeft >= 1) && !result.protected);
  await msg.update({
    "system.status": "resolved", "system.result": result, "system.closed": closed,
    "system.notes": [...data.notes, ...notes]
  });
  return result;
}

/** Mark one fortification box on a territory. */
async function wearFortification(territory) {
  const campaign = getCampaign();
  if ( !campaign ) return false;
  const used = campaign.system.territories?.[territory]?.fortification?.used ?? 0;
  await campaign.update({ [`system.territories.${territory}.fortification.used`]: Math.min(FORTIFICATION_USES, used + 1) });
  return true;
}

/** Die Mechaniker: the territory can't be attacked again this turn. */
async function protectTerritory(territory) {
  const turn = api("turn");
  if ( typeof turn?.protect === "function" ) {
    try {
      await turn.protect({ territory, source: "mechaniker_2" });
      return;
    } catch(err) {
      console.warn("risklegacy | turn.protect failed; recording the protection directly", err);
    }
  }
  const war = getWar();
  if ( !war ) return;
  const list = new Set(war.system.turn?.protected ?? []);
  list.add(territory);
  await war.update({ "system.turn.protected": [...list] });
}

/**
 * Troops lost entering a territory with an enterLoss effect (Fallout Zone), on the running total moved in.
 * @returns {Promise<{count: number, source: string}|null>}
 */
async function applyEnterLoss(data, snap, movedInTotal, alreadyLost) {
  let due = 0;
  let source = "";
  const rules = api("rules");
  if ( typeof rules?.enterLosses === "function" ) {
    // The rules engine knows every enterLoss effect and exemption (same numbers as for expanding).
    const parts = rules.enterLosses(snap, data.attacker, data.to, movedInTotal) ?? [];
    due = parts.reduce((n, p) => n + (p.troops ?? 0), 0) - alreadyLost;
    source = parts.map(p => lookup("marks", p.source)?.name ?? lookup("scars", p.source)?.name ?? p.source).join(", ");
  }
  else {
    const effect = enterLossFor(snap.territories[data.to], snap.factions?.[data.attacker]?.key, lookup);
    if ( effect ) {
      due = enterLossDue(movedInTotal, alreadyLost, effect);
      source = effect.source;
    }
  }
  if ( due <= 0 ) return null;
  await requireFn("board", "removeTroops")({ faction: data.attacker, territory: data.to, count: due });
  return { count: due, source };
}

/**
 * After the survivors moved in: tell the turn area (log, HQ capture, Fallout Zone losses, knock-out, victory check).
 * Without the turn area, apply the enterLoss effect here. Returns the troops lost entering and notes for the card.
 * @param {object} data      battle data
 * @param {object} snap      snapshot from before the conquest
 * @param {number} movedIn   troops moved in
 * @returns {Promise<{enterLosses: number, notes: object[]}>}
 */
async function conquer(data, snap, movedIn) {
  const notes = [];
  const turn = api("turn");
  if ( typeof turn?.recordConquest !== "function" ) {
    notes.push({ key: "RL.Battle.Note.missingApi", data: { api: "game.risklegacy.turn.recordConquest" } });
    const loss = await applyEnterLoss(data, snap, movedIn, 0);
    if ( loss ) notes.push({ key: "RL.Battle.Note.enterLoss", data: { count: loss.count, source: loss.source } });
    return { enterLosses: loss?.count ?? 0, notes };
  }
  try {
    await turn.recordConquest({ faction: data.attacker, from: data.from, to: data.to, defender: data.defender });
  } catch(err) {
    console.error("risklegacy | turn.recordConquest failed", err);
    notes.push({ key: "RL.Battle.Note.error", data: { error: err.message } });
  }
  // turn.recordConquest removes Fallout Zone losses itself: measure them for the card.
  const after = troopsIn(requireSnapshot(), data.to, data.attacker);
  const lost = Math.max(0, movedIn - after);
  if ( lost > 0 ) notes.push({ key: "RL.Battle.Note.enterLoss", data: { count: lost, source: enterLossSource(snap, data) } });
  return { enterLosses: lost, notes };
}

/** Name(s) of the enterLoss effects of the conquered territory. */
function enterLossSource(snap, data) {
  const rules = api("rules");
  const parts = (typeof rules?.enterLosses === "function") ? (rules.enterLosses(snap, data.attacker, data.to, 2) ?? []) : [];
  const names = parts.map(p => lookup("marks", p.source)?.name ?? lookup("scars", p.source)?.name ?? p.source);
  return names.join(", ") || territoryName(snap, data.to);
}

/* -------------------------------------------- */
/*  Follow-ups                                  */
/* -------------------------------------------- */

/**
 * battle.moveIn: move more troops into the conquered territory (leave at least one behind).
 * @param {{message: string, count: number}} payload
 */
export async function handleMoveIn({ message, count } = {}, { user }) {
  const id = messageIdOf(message);
  return withLock(id, async () => {
    const msg = getBattleMessage(id);
    const data = msg.system.toObject();
    assertActsFor(user, data.attacker);
    if ( (data.status !== "resolved") || !data.result.conquered ) throw error("RL.Battle.Error.notConquered");
    if ( data.closed || data.result.moveInDone ) throw error("RL.Battle.Error.closed");
    const snap = requireSnapshot();
    if ( snap.territories[data.to]?.owner !== data.attacker ) throw error("RL.Battle.Error.lostTerritory");
    const available = troopsIn(snap, data.from, data.attacker) - 1;
    if ( available < 1 ) throw error("RL.Battle.Error.nothingToMove");
    const n = clampInt(count, 1, available);
    await requireFn("board", "moveTroops")({ faction: data.attacker, from: data.from, to: data.to, count: n });
    const result = data.result;
    const loss = await applyEnterLoss(data, snap, result.movedIn + n, result.enterLosses);
    result.movedIn += n;
    result.moveInDone = true;
    result.fromLeft = available + 1 - n;
    result.toLeft += n - (loss?.count ?? 0);
    const notes = [...data.notes];
    if ( loss ) {
      result.enterLosses += loss.count;
      notes.push({ key: "RL.Battle.Note.enterLoss", data: { count: loss.count, source: loss.source } });
    }
    await msg.update({ "system.result": result, "system.closed": true, "system.notes": notes });
    return { movedIn: result.movedIn };
  });
}

/**
 * battle.attackAgain: same territories, maximum dice, a new card.
 * @param {{message: string}} payload
 * @returns {Promise<string>} the new battle message id
 */
export async function handleAttackAgain({ message } = {}, { user }) {
  const id = messageIdOf(message);
  const data = await withLock(id, async () => {
    const msg = getBattleMessage(id);
    const d = msg.system.toObject();
    assertActsFor(user, d.attacker);
    if ( (d.status !== "resolved") || d.result.conquered ) throw error("RL.Battle.Error.cannotAttackAgain");
    if ( d.closed ) throw error("RL.Battle.Error.closed");
    return d;
  });
  // Through the turn area when it exists (it validates, keeps the turn log and counts the attack). The new battle
  // closes this card's controls once it is accepted (closeFollowUps in handleStart).
  const turn = api("turn");
  if ( typeof turn?.attack === "function" ) {
    const out = await turn.attack({ faction: data.attacker, from: data.from, to: data.to });
    return out?.messageId ?? (typeof out === "string" ? out : null);
  }
  return handleStart({ attacker: data.attacker, from: data.from, to: data.to, round: data.round + 1 }, { user });
}

/**
 * battle.stop: close the card's follow-up controls.
 * @param {{message: string}} payload
 */
export async function handleStop({ message } = {}, { user }) {
  const id = messageIdOf(message);
  return withLock(id, async () => {
    const msg = getBattleMessage(id);
    assertActsFor(user, msg.system.attacker);
    if ( !msg.system.closed ) await msg.update({ "system.closed": true });
    return id;
  });
}

/**
 * battle.cancel (GM): abandon a battle that hasn't been resolved (e.g. stuck after a reload).
 * @param {{message: string}} payload
 */
export async function handleCancel({ message } = {}, { user }) {
  if ( !user.isGM ) throw error("RL.Battle.Error.gmOnly");
  const id = messageIdOf(message);
  settleDefense(id, null);
  return withLock(id, async () => {
    const msg = getBattleMessage(id);
    if ( msg.system.status === "resolved" ) throw error("RL.Battle.Error.alreadyResolved");
    await msg.update({ "system.status": "cancelled", "system.closed": true, "system.hold": "" });
    return id;
  });
}

/* -------------------------------------------- */
/*  Pre-roll reactions                          */
/* -------------------------------------------- */

/**
 * battle.emp: a faction with the EMP missile power discards a missile before the roll; dice rolled for combat in
 * that territory can't be modified for the rest of the turn (also blocks missiles there).
 * @param {{message: string, faction: string}} payload
 */
export async function handleEmp({ message, faction } = {}, { user }) {
  const id = messageIdOf(message);
  return withLock(id, async () => {
    const msg = getBattleMessage(id);
    const data = msg.system.toObject();
    if ( (data.status !== "declared") || !data.preRoll ) throw error("RL.Battle.Error.notPreRoll");
    const actor = factionActor(faction);
    assertActsFor(user, actor);
    if ( !empCandidates(data.to).some(f => f.id === actor.id) ) throw error("RL.Battle.Error.noEmp", { faction: actor.name });
    const war = getWar();
    const flags = war.system.turn?.flags ?? {};
    await actor.update({ "system.war.missiles": actor.system.war.missiles - 1 });
    await war.update({
      "system.turn.flags.emp": [...new Set([...(flags.emp ?? []), data.to])],
      "system.turn.flags.missilePowers": { ...(flags.missilePowers ?? {}), [actor.id]: "emp" }
    });
    await msg.update({ "system.notes": [...data.notes, { key: "RL.Battle.Note.empActivated", data: { faction: actor.name } }] });
    return id;
  });
}

/**
 * battle.scar: play a scar card on the defending territory before the roll (cards.playScar).
 * @param {{message: string, faction: string, cardId: string}} payload
 */
export async function handleScar({ message, faction, cardId } = {}, { user }) {
  const id = messageIdOf(message);
  return withLock(id, async () => {
    const msg = getBattleMessage(id);
    const data = msg.system.toObject();
    if ( (data.status !== "declared") || !data.preRoll ) throw error("RL.Battle.Error.notPreRoll");
    const actor = factionActor(faction);
    assertActsFor(user, actor);
    const snap = requireSnapshot();
    const candidate = scarCandidates(snap, data.to).find(c => (c.faction.id === actor.id) && (c.card.id === cardId));
    if ( !candidate ) throw error("RL.Battle.Error.noScar");
    await requireFn("cards", "playScar")({ faction: actor.id, cardId, territory: data.to });
    const scar = candidate.entry?.name ?? candidate.card.name;
    await msg.update({
      "system.notes": [...data.notes, {
        key: "RL.Battle.Note.scarPlayed", data: { faction: actor.name, scar, territory: territoryName(snap, data.to) }
      }]
    });
    return id;
  });
}

/* -------------------------------------------- */
/*  Blitz                                       */
/* -------------------------------------------- */

/**
 * battle.blitz: keep attacking between the same territories (maximum dice both sides, no Dice So Nice) until the
 * territory is conquered or the attacker is down to `stopAt` troops. Only when nobody in the war holds a missile and
 * nobody could play a scar card before a roll. Posts one card with every round.
 * @param {{message: string, stopAt?: number}} payload  the resolved battle the blitz continues from
 * @returns {Promise<string>} the blitz message id
 */
export async function handleBlitz({ message, stopAt = 1 } = {}, { user }) {
  const id = messageIdOf(message);
  const prev = await withLock(id, async () => {
    const msg = getBattleMessage(id);
    const d = msg.system.toObject();
    assertActsFor(user, d.attacker);
    if ( (d.status !== "resolved") || d.result.conquered || d.closed ) throw error("RL.Battle.Error.cannotAttackAgain");
    if ( anyMissiles() ) throw error("RL.Battle.Error.blitzMissiles");
    if ( scarCandidates(requireSnapshot(), d.to).length ) throw error("RL.Battle.Error.blitzReactions");
    return d;
  });
  return runBlitz({ attacker: prev.attacker, from: prev.from, to: prev.to, stopAt, round: prev.round + 1 }, { user });
}

/**
 * Run a blitz from scratch (also usable without a previous card).
 * @param {{attacker: string, from: string, to: string, stopAt?: number, round?: number}} payload
 */
export async function runBlitz({ attacker, from, to, stopAt = 1, round = 1 }, { user }) {
  const atk = factionActor(attacker);
  assertActsFor(user, atk);
  const rules = rulesApi();
  let snap = requireSnapshot();
  const toT = snap.territories[to];
  if ( !toT?.owner || (toT.owner === atk.id) ) throw error("RL.Battle.Error.noDefender", { territory: territoryName(snap, to) });
  const defenderId = toT.owner;
  const notes = enforceAll([
    rules.checkAttack(snap, atk.id, from, to, Math.max(1, maxAttackDice(snap, from, atk.id))),
    (snap.turn?.log?.protected ?? []).includes(to) ? fail("RL.Battle.Error.protected", { territory: toT.name }) : null,
    openBattle() ? fail("RL.Battle.Error.inProgress") : null
  ]);
  const limit = Math.max(1, clampInt(stopAt, 1, 999));

  // Turn bookkeeping first (so Enclave power 1 sees the first territory attacked).
  const war = getWar();
  if ( war && ((war.combatant?.actorId === atk.id) || (war.system.turn.faction === atk.id)) ) {
    const turn = war.system.turn;
    if ( !turn.firstAttackTarget ) await war.update({ "system.turn.firstAttackTarget": to });
    snap = requireSnapshot();
  }

  const startAttack = troopsIn(snap, from, atk.id);
  const startDefend = troopsIn(snap, to, defenderId);
  let attackTroops = startAttack;
  let defendTroops = startDefend;
  let fortified = !!snap.territories[to].fortified;
  let fortUsed = getCampaign()?.system.territories?.[to]?.fortification?.used ?? 0;
  let worn = 0;
  let protect = false;
  let clones = 0;
  let conquerAll = false;
  let attackerLosses = 0;
  let defenderLosses = 0;
  const rounds = [];
  let last = null;
  const descriptor = battleDescriptor({ attacker: atk.id, defender: defenderId, from, to });

  while ( (rounds.length < 200) && (attackTroops > limit) && (attackTroops >= 2) && (defendTroops > 0) && !protect ) {
    const aDice = Math.min(3, attackTroops - 1);
    const dDice = Math.min(2, defendTroops);
    const state = { ...snap, territories: { ...snap.territories, [to]: { ...snap.territories[to], fortified } } };
    const { sources, rules: r, notes: n } = collectSources(state, descriptor, { lookup });
    const dice = await rollCombatDice({ attackDice: aDice, defendDice: dDice, rerollOnes: r.rerollOnes, show: false });
    const attack = applySources(dice.attack, sources, "attack");
    const defend = applySources(dice.defend, sources, "defend");
    const res = resolveDice({ attack, defend, rules: r });
    const aLoss = res.attackerLosses;
    const dLoss = res.conquerAll ? defendTroops : res.defenderLosses;
    attackTroops -= aLoss;
    defendTroops -= dLoss;
    attackerLosses += aLoss;
    defenderLosses += dLoss;
    if ( (aDice === 3) && fortified ) {
      fortUsed += 1;
      worn += 1;
      if ( fortUsed >= FORTIFICATION_USES ) fortified = false;
    }
    if ( defendTroops > 0 ) {
      if ( res.protect ) protect = true;
      if ( res.clone && (typeof api("board")?.spawnPieces === "function") ) {
        defendTroops += 1;
        clones += 1;
      }
    }
    else if ( res.conquerAll ) conquerAll = true;
    rounds.push({ attack: attack.map(d => d.value), defend: defend.map(d => d.value), attackerLosses: aLoss, defenderLosses: dLoss });
    last = { attack, defend, sources, rules: r, notes: n, aDice, dDice, res, aLoss };
  }
  if ( !last ) throw error("RL.Battle.Error.blitzNothing");
  await closeFollowUps();

  // Apply to the board
  const board = api("board");
  const removeTroops = requireFn("board", "removeTroops");
  if ( attackerLosses > 0 ) await removeTroops({ faction: atk.id, territory: from, count: attackerLosses });
  const defendDelta = Math.max(0, defendTroops) - startDefend;
  if ( defendDelta < 0 ) await removeTroops({ faction: defenderId, territory: to, count: -defendDelta });
  else if ( defendDelta > 0 ) await board.spawnPieces({ faction: defenderId, territory: to, troops: defendDelta });
  if ( worn ) {
    await getCampaign()?.update({ [`system.territories.${to}.fortification.used`]: Math.min(FORTIFICATION_USES, fortUsed) });
  }
  if ( protect ) await protectTerritory(to);

  const result = {
    attackerLosses, defenderLosses, conquered: defendTroops <= 0, conqueredAll: conquerAll, movedIn: 0,
    moveInDone: false, enterLosses: 0, fortificationWorn: worn, protected: protect, cloned: clones > 0,
    pairs: last.res.pairs, fromLeft: attackTroops, toLeft: Math.max(0, defendTroops)
  };
  const data = { attacker: atk.id, defender: defenderId, from, to, attackDice: last.aDice };
  if ( result.conquered ) {
    const moveIn = Math.min(Math.max(0, last.aDice - last.aLoss), Math.max(0, attackTroops - 1));
    if ( moveIn > 0 ) await requireFn("board", "moveTroops")({ faction: atk.id, from, to, count: moveIn });
    result.movedIn = moveIn;
    result.fromLeft -= moveIn;
    result.toLeft = moveIn;
    const conquest = await conquer(data, snap, moveIn);
    result.enterLosses = conquest.enterLosses;
    result.toLeft -= conquest.enterLosses;
    notes.push(...conquest.notes);
  }

  const closed = result.conquered ? (result.fromLeft < 2) : true;
  const message = await ChatMessage.implementation.create({
    type: "battle",
    speaker: { scene: getBoardScene()?.id ?? null, actor: atk.id, token: null, alias: atk.name },
    system: {
      ...data, defendDice: last.dDice, status: "resolved", preRoll: false, round,
      troops: { attacker: startAttack, defender: startDefend },
      attack: last.attack, defend: last.defend, sources: last.sources, rules: last.rules,
      result, closed, notes: [...notes, ...last.notes],
      blitz: { active: true, stopAt: limit, rounds }
    },
    flags: { [SYSTEM_ID]: { card: true } }
  });
  if ( war ) {
    const turn = getWar()?.system.turn;
    const isCurrent = (war.combatant?.actorId === atk.id) || (turn?.faction === atk.id);
    const updates = { "system.battle": message.id };
    if ( isCurrent ) updates["system.turn.attacks"] = (turn?.attacks ?? 0) + rounds.length;
    await war.update(updates);
  }
  Hooks.callAll("risklegacy.battleResolved", message);
  return message.id;
}

/* -------------------------------------------- */
/*  Turn changes                                */
/* -------------------------------------------- */

/**
 * After the active GM (re)loads: holds and rolls in progress were lost with the old page. Clear stale holds so the
 * battle can be resolved (the GM's card also offers Roll / Cancel for battles stuck before their roll).
 */
export async function recoverBattles() {
  if ( !game.user.isActiveGM ) return;
  const stale = game.messages.contents.slice(-100)
    .filter(m => (m.type === "battle") && m.system.hold && (m.system.status === "rolled"))
    .map(m => ({ _id: m.id, "system.hold": "" }));
  if ( stale.length ) await ChatMessage.implementation.updateDocuments(stale);
}

/** When the turn passes, close the follow-up controls of resolved battles (active GM only). */
export async function onTurnChange() {
  if ( !game.user.isActiveGM ) return;
  try {
    await closeFollowUps();
  } catch(err) {
    console.warn("risklegacy | could not close battle cards", err);
  }
}
