import { FORTIFICATION_EXPAND_COST } from "../config.mjs";
import { fail, ok } from "./result.mjs";
import { areAdjacent, territory, turnFlags, turnLog } from "./state.mjs";
import { hasPower, POWERS, territoryEffects, territoryHas } from "./powers.mjs";
import { checkTurnAction } from "./turn.mjs";

/**
 * Expand, attack and maneuver (rulebook pp.10–12).
 */

/** Highest number of attack dice a territory can roll (3, and one troop stays behind). */
export function maxAttackDice(state, from) {
  const t = territory(state, from);
  return Math.max(0, Math.min(3, (t?.troops ?? 0) - 1));
}

/** Highest number of defence dice (2, or 1 with a single troop). */
export function defenderMaxDice(state, territoryId) {
  const t = territory(state, territoryId);
  return Math.max(0, Math.min(2, t?.troops ?? 0));
}

/**
 * Troops lost when troops *enter* a territory with an `enterLoss` effect (Fallout Zone: half, rounded up).
 * @param {object} state
 * @param {string} factionId
 * @param {string} territoryId
 * @param {number} entering   troops arriving
 * @returns {{troops: number, source: string}[]}
 */
export function enterLosses(state, factionId, territoryId, entering) {
  const out = [];
  for ( const e of territoryEffects(state, territoryId, factionId) ) {
    if ( e.type !== "enterLoss" ) continue;
    const raw = entering * (e.fraction ?? 0.5);
    const troops = e.round === "down" ? Math.floor(raw) : Math.ceil(raw);
    if ( troops > 0 ) out.push({ source: e.id ?? e.source, troops });
  }
  return out;
}

/**
 * Troops lost by expanding `count` troops into an unoccupied territory.
 *   city: its population (not for `aliens_starter`), `unpopular` +1, `alien_collaborator` +2;
 *   fortified city: +2; Fallout Zone: half of the troops that arrive (round up).
 * @returns {{cost: number, parts: {source: string, troops: number}[]}}
 */
export function expandCost(state, factionId, to, count) {
  const t = territory(state, to);
  const parts = [];
  if ( !t ) return { cost: 0, parts };
  if ( t.city && (t.population > 0) ) {
    if ( !hasPower(state, factionId, POWERS.aliensStarter) ) parts.push({ source: "city", troops: t.population });
    if ( hasPower(state, factionId, POWERS.unpopular) ) parts.push({ source: POWERS.unpopular, troops: 1 });
    if ( hasPower(state, factionId, POWERS.alienCollaborator) ) parts.push({ source: POWERS.alienCollaborator, troops: 2 });
  }
  if ( t.fortified ) parts.push({ source: "fortification", troops: FORTIFICATION_EXPAND_COST });
  const before = parts.reduce((n, p) => n + p.troops, 0);
  parts.push(...enterLosses(state, factionId, to, Math.max(0, count - before)));
  return { cost: parts.reduce((n, p) => n + p.troops, 0), parts };
}

/**
 * May the faction expand `count` troops from `from` into the unoccupied territory `to`?
 * @param {object} state
 * @param {string} factionId
 * @param {string} from
 * @param {string} to
 * @param {number} count
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurn]  skip the turn-step check
 * @returns {import("./result.mjs").RuleResult}  data {cost, parts, remaining, city, fortified, hq, advance}
 */
export function checkExpand(state, factionId, from, to, count, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "expand");
  if ( !gate.ok ) return gate;
  const a = territory(state, from);
  const b = territory(state, to);
  if ( !a || !b ) return fail("RL.Rules.unknownTerritory", { id: !a ? from : to });
  const names = { from: a.name ?? from, to: b.name ?? to, name: b.name ?? to };
  if ( a.owner !== factionId ) return fail("RL.Rules.notYours", { name: names.from });
  if ( from === to ) return fail("RL.Rules.sameTerritory");
  if ( !areAdjacent(state, from, to) ) return fail("RL.Rules.notAdjacent", names);
  if ( b.owner === factionId ) return fail("RL.Rules.expand.alreadyYours", names);
  if ( b.owner ) return fail("RL.Rules.expand.occupied", { ...names, attack: true });
  if ( !Number.isInteger(count) || (count < 1) ) return fail("RL.Rules.badCount", { count });
  if ( count > a.troops - 1 ) return fail("RL.Rules.leaveOne", { ...names, max: Math.max(0, a.troops - 1) });
  const { cost, parts } = expandCost(state, factionId, to, count);
  const remaining = count - cost;
  if ( remaining < 1 ) return fail("RL.Rules.expand.cannotHold", { ...names, cost, needed: cost + 1, count });
  return ok({
    ...gate.data, cost, parts, remaining,
    city: !!b.city, fortified: !!b.fortified, hq: b.hq ?? null
  });
}

/**
 * May the faction attack `to` from `from` with `dice` dice?
 * @returns {import("./result.mjs").RuleResult}  data {defender, maxDice, defenderMaxDice, firstAttack, advance}
 */
export function checkAttack(state, factionId, from, to, dice, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "attack");
  if ( !gate.ok ) return gate;
  const a = territory(state, from);
  const b = territory(state, to);
  if ( !a || !b ) return fail("RL.Rules.unknownTerritory", { id: !a ? from : to });
  const names = { from: a.name ?? from, to: b.name ?? to, name: b.name ?? to };
  if ( a.owner !== factionId ) return fail("RL.Rules.notYours", { name: names.from });
  if ( !b.owner ) return fail("RL.Rules.attack.empty", names);
  if ( b.owner === factionId ) return fail("RL.Rules.attack.own", names);
  if ( !areAdjacent(state, from, to) ) return fail("RL.Rules.notAdjacent", names);
  if ( a.troops < 2 ) return fail("RL.Rules.attack.tooFew", names);
  const maxDice = maxAttackDice(state, from);
  if ( !Number.isInteger(dice) || (dice < 1) || (dice > 3) ) return fail("RL.Rules.attack.dice", { dice });
  if ( dice > maxDice ) return fail("RL.Rules.attack.diceTroops", { ...names, dice, max: maxDice });
  const log = turnLog(state);
  if ( (log.protected ?? []).includes(to) ) return fail("RL.Rules.attack.protected", names);
  return ok({
    ...gate.data, defender: b.owner, maxDice, defenderMaxDice: defenderMaxDice(state, to),
    firstAttack: !log.firstAttackTarget
  });
}

/**
 * Are two of the faction's territories connected through territories it controls? Territories with a
 * `noManeuverThrough` effect (Fallout Zone) can't be passed through.
 * @returns {boolean}
 */
export function connectedThroughOwned(state, factionId, from, to) {
  const start = territory(state, from);
  const goal = territory(state, to);
  if ( !start || !goal || (start.owner !== factionId) || (goal.owner !== factionId) ) return false;
  if ( from === to ) return true;
  const seen = new Set([from]);
  const queue = [from];
  while ( queue.length ) {
    const id = queue.shift();
    const t = territory(state, id);
    if ( (id !== from) && territoryHas(state, id, "noManeuverThrough", factionId) ) continue;
    for ( const n of t?.neighbors ?? [] ) {
      if ( seen.has(n) ) continue;
      const nt = territory(state, n);
      if ( nt?.owner !== factionId ) continue;
      if ( n === to ) return true;
      seen.add(n);
      queue.push(n);
    }
  }
  return false;
}

/**
 * May the faction maneuver `count` troops from `from` to `to`?
 *   - one maneuver per turn, leave at least one troop behind;
 *   - connected through own territories, or (`saharan_2`) any two own territories;
 *   - `short_sighted` (a weakness, which overrides `saharan_2`): adjacent territories only.
 * @returns {import("./result.mjs").RuleResult}  data {via: "connected"|"anywhere"|"adjacent", advance, anyTime}
 */
export function checkManeuver(state, factionId, from, to, count, { ignoreTurn = false } = {}) {
  const gate = ignoreTurn ? ok() : checkTurnAction(state, factionId, "maneuver");
  if ( !gate.ok ) return gate;
  const a = territory(state, from);
  const b = territory(state, to);
  if ( !a || !b ) return fail("RL.Rules.unknownTerritory", { id: !a ? from : to });
  const names = { from: a.name ?? from, to: b.name ?? to, name: b.name ?? to };
  if ( from === to ) return fail("RL.Rules.sameTerritory");
  if ( a.owner !== factionId ) return fail("RL.Rules.notYours", { name: names.from });
  if ( b.owner !== factionId ) return fail("RL.Rules.maneuver.notYours", names);
  if ( !Number.isInteger(count) || (count < 1) ) return fail("RL.Rules.badCount", { count });
  if ( count > a.troops - 1 ) return fail("RL.Rules.leaveOne", { ...names, max: Math.max(0, a.troops - 1) });
  let via;
  if ( hasPower(state, factionId, POWERS.shortSighted) ) {
    if ( !areAdjacent(state, from, to) ) return fail("RL.Rules.maneuver.adjacentOnly", names);
    via = "adjacent";
  }
  else if ( hasPower(state, factionId, POWERS.saharan2) ) via = "anywhere";
  else if ( connectedThroughOwned(state, factionId, from, to) ) via = "connected";
  else return fail("RL.Rules.maneuver.notConnected", names);
  return ok({ ...gate.data, via });
}

/**
 * Is moving more troops from `from` into `to` a follow-up of the expansion/conquest just made between them
 * (rulebook p.12: "You may also move in additional troops from the attacking territory at this time")? Such a move
 * is not a maneuver. Only valid right after that expansion/conquest (`turn.flags.lastAdvance`), in step 3.
 * @returns {import("./result.mjs").RuleResult}
 */
export function checkAdvance(state, factionId, from, to, count) {
  const last = turnFlags(state).lastAdvance;
  const turn = state?.turn;
  if ( !last || (last.from !== from) || (last.to !== to) || (turn?.faction !== factionId) || (turn?.phase !== "attack") ) {
    return fail("RL.Rules.advance.none");
  }
  const a = territory(state, from);
  const b = territory(state, to);
  if ( (a?.owner !== factionId) || (b?.owner !== factionId) ) return fail("RL.Rules.advance.none");
  if ( !Number.isInteger(count) || (count < 1) ) return fail("RL.Rules.badCount", { count });
  if ( count > a.troops - 1 ) return fail("RL.Rules.leaveOne", { from: a.name ?? from, max: Math.max(0, a.troops - 1) });
  return ok({ kind: last.kind });
}

/**
 * What kind of move is dragging the faction's troops from `from` to `to`?
 * @returns {"rearrange"|"advance"|"maneuver"|"expand"|"attack"|"invalid"}
 */
export function classifyMove(state, factionId, from, to) {
  if ( from === to ) return "rearrange";
  const a = territory(state, from);
  const b = territory(state, to);
  if ( !a || !b || (a.owner !== factionId) ) return "invalid";
  if ( b.owner === factionId ) {
    const last = turnFlags(state).lastAdvance;
    if ( last && (last.from === from) && (last.to === to) && (state.turn?.phase === "attack") ) return "advance";
    return "maneuver";
  }
  if ( !areAdjacent(state, from, to) ) return "invalid";
  return b.owner ? "attack" : "expand";
}

/** Territories the faction may expand into from `from` with `count` troops (for highlighting). */
export function expandTargets(state, factionId, from, count = null) {
  const a = territory(state, from);
  const n = count ?? Math.max(0, (a?.troops ?? 0) - 1);
  return (a?.neighbors ?? []).filter(id => checkExpand(state, factionId, from, id, n).ok);
}

/** Enemy territories the faction may attack from `from` (for highlighting). */
export function attackTargets(state, factionId, from) {
  const a = territory(state, from);
  const dice = Math.max(1, maxAttackDice(state, from));
  return (a?.neighbors ?? []).filter(id => checkAttack(state, factionId, from, id, dice).ok);
}

/** Own territories reachable by the maneuver from `from` (for highlighting). */
export function maneuverTargets(state, factionId, from) {
  return Object.keys(state?.territories ?? {}).filter(id => (id !== from) && checkManeuver(state, factionId, from, id, 1).ok);
}
