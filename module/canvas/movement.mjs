import { PIECES, SYSTEM_ID } from "../config.mjs";
import {
  buildSnapshot, enforce, enforcementLevel, fail, getWar, ok, pieceKind, reasonText, territoryAtPoint
} from "../state/_module.mjs";
import { runAction } from "../gm/actions.mjs";
import { boardForScene, centerOf, isBoardScene } from "./geometry.mjs";

/**
 * Movement interception for piece tokens.
 *
 * When a user drags (or nudges with the keyboard) their own pieces, `RLTokenDocument#_preUpdateMovement` asks
 * `guardMovement()` whether each token may move. All tokens moved by one update operation are classified together
 * (once per operation): they are grouped by faction, origin territory and destination territory, and each group is
 *   - **rearrange**  same territory → allowed
 *   - **outside**    dropped in the sea / off the map → snapped back (strict), warned (advisory)
 *   - **expand**     empty territory → `rules.checkExpand` → enforce → after the move `turn.expand({moved: true})`
 *   - **maneuver**   own territory → `rules.checkManeuver` → enforce → after the move `turn.maneuver({moved: true})`
 *   - **advance**    more troops into the territory just conquered/expanded into (`rules.checkAdvance`), reported to
 *                    `turn.advance({moved: true})` when the turn controller has it
 *   - **attack**     enemy territory → the move is cancelled and `turn.attack({faction, from, to, dice})` is called
 * HQ pieces stay in their territory unless `rules.checkMoveHQ` allows it (the "mobile" power) or enforcement is off.
 * GMs moving pieces of a faction they don't play move freely (no turn bookkeeping), and so does everyone while no
 * war is in progress (sandbox). If the rules engine or the turn controller isn't available, moves are allowed and
 * nothing is reported.
 */

/** Movement methods that come from a user gesture and are therefore checked. */
const CHECKED_METHODS = new Set(["dragging", "keyboard", "hud", "config", "undo"]);

/** Classification per update operation (the `options` object shared by every token's _preUpdate). */
const plans = new WeakMap();

/** Allowed groups waiting for their movement to land, keyed by movement id. */
const pending = new Map();

/** @returns {object} game.risklegacy.<area> or {} */
const area = name => game.risklegacy?.[name] ?? {};

/** Call an optional rules function; a missing function or an exception counts as "allowed". */
function rule(name, ...args) {
  const fn = area("rules")[name];
  if ( typeof fn !== "function" ) return null;
  try {
    return fn(...args) ?? null;
  } catch(err) {
    console.error(`${SYSTEM_ID} | rules.${name} failed`, err);
    return null;
  }
}

/**
 * Decide whether one token may move. Called from RLTokenDocument#_preUpdateMovement.
 * @param {TokenDocument} token
 * @param {object} movement     TokenPreMovementOperation
 * @param {object} operation    the update operation options
 * @returns {boolean}
 */
export function guardMovement(token, movement, operation) {
  if ( !pieceKind(token) || !isBoardScene(token.parent) ) return true;
  // Moves made by the canvas GM actions (internal) or by the turn controller (turnMove, e.g. the Mobile power)
  if ( operation?.[SYSTEM_ID]?.internal || operation?.[SYSTEM_ID]?.turnMove ) return true;
  if ( !CHECKED_METHODS.has(movement.method) ) return true;
  if ( movement.chain?.length ) return true;   // continuation of a movement validated when it started

  let plan = plans.get(operation);
  if ( !plan ) {
    plan = planOperation(token.parent, operation, token, movement);
    plans.set(operation, plan);
  }
  const decision = plan.get(token.id);
  if ( !decision ) return true;

  // A dropped piece appears where it was dropped. Besides, while a token animates Foundry writes interpolated
  // values into document.x/y, so rules evaluated during the animation (on any client) would see it mid-way.
  if ( decision.allow ) operation.animate = false;
  if ( decision.allow && decision.group ) {
    pending.set(movement.id, decision.group);
    setTimeout(() => pending.delete(movement.id), 120_000);
  }
  return decision.allow;
}

/**
 * After a piece movement landed (initiating client only): report it to the turn controller and tidy the pieces.
 * Called from RLTokenDocument#_onUpdateMovement.
 * @param {TokenDocument} token
 * @param {object} movement     TokenMovementOperation
 * @param {User} user
 */
export function afterMovement(token, movement, user) {
  if ( !user?.isSelf ) return;
  const rootId = movement.chain?.[0] ?? movement.id;
  const group = pending.get(rootId);
  if ( !group ) return;
  if ( movement.pending?.waypoints?.length ) return;   // more segments to come
  for ( const [id, g] of pending ) if ( g === group ) pending.delete(id);
  if ( group.scheduled ) return;
  group.scheduled = true;
  setTimeout(() => reportGroup(group), 0);
}

/* -------------------------------------------- */
/*  Classification                              */
/* -------------------------------------------- */

/**
 * @typedef {object} MoveGroup
 * @property {string} faction
 * @property {string|null} from
 * @property {string|null} to
 * @property {TokenDocument[]} tokens     troop pieces
 * @property {TokenDocument[]} hqs
 * @property {number} troops
 * @property {string} type                rearrange | outside | free | expand | maneuver | advance | attack
 * @property {boolean} report             report troops to the turn controller after moving
 * @property {boolean} reportHQ           report an HQ move (mobile power)
 * @property {number} [dice]
 * @property {Object<string, {x: number, y: number}>} origins   token id → origin top-left
 */

/**
 * Classify every piece token moved by an update operation.
 * @returns {Map<string, {allow: boolean, group: MoveGroup|null}>}
 */
function planOperation(scene, operation, token, movement) {
  const board = boardForScene(scene);
  const instructions = { ...(operation.movement ?? {}) };
  if ( !instructions[token.id] ) {
    instructions[token.id] = { waypoints: [movement.pending?.waypoints?.at(-1) ?? movement.destination] };
  }

  // Group the moving pieces by faction, origin and destination
  const groups = new Map();
  for ( const [id, instruction] of Object.entries(instructions) ) {
    const doc = scene.tokens.get(id);
    const kind = pieceKind(doc);
    if ( !kind ) continue;
    const from = territoryAtPoint(centerOf(doc), scene, board);
    const to = territoryAtPoint(centerOf(doc, finalPosition(doc, instruction)), scene, board);
    const key = `${doc.actorId}|${from}|${to}`;
    let group = groups.get(key);
    if ( !group ) {
      group = { faction: doc.actorId, from, to, tokens: [], hqs: [], troops: 0, type: "free", report: false,
        reportHQ: false, origins: {} };
      groups.set(key, group);
    }
    group.origins[id] = { x: doc._source.x, y: doc._source.y };
    if ( kind === "hq" ) group.hqs.push(doc);
    else {
      group.tokens.push(doc);
      group.troops += PIECES[kind]?.value ?? 0;
    }
  }

  const decisions = new Map();
  const set = (docs, allow, group) => docs.forEach(d => decisions.set(d.id, { allow, group }));
  const level = enforcementLevel();

  // One move at a time: several origin/destination pairs in one drag is ambiguous
  const crossing = [...groups.values()].filter(g => g.from && g.to && (g.from !== g.to) && g.tokens.length);
  const restricted = crossing.filter(g => !isFree(g.faction));
  if ( (restricted.length > 1) && !enforce(fail("RL.Canvas.Reason.oneGroup")) ) {
    for ( const g of crossing ) set([...g.tokens, ...g.hqs], false, null);
  }

  for ( const group of groups.values() ) {
    const all = [...group.tokens, ...group.hqs];
    if ( decisions.has(all[0]?.id) ) continue;

    // Same territory: rearranging pieces on the table
    if ( (group.from === group.to) && group.to ) {
      group.type = "rearrange";
      set(all, true, null);
      continue;
    }

    // Dropped into the sea or off the map
    if ( !group.to ) {
      group.type = "outside";
      set(all, enforce(fail("RL.Canvas.Reason.outside")), null);
      continue;
    }

    // Troops
    if ( group.tokens.length ) {
      const verdict = classify(group);
      Object.assign(group, { type: verdict.type, report: verdict.report, dice: verdict.dice });
      if ( verdict.type === "attack" ) {
        set(all, false, null);
        if ( verdict.attack ) setTimeout(() => startAttack(group), 0);
        continue;
      }
      set(group.tokens, verdict.allow, verdict.allow ? group : null);
    }

    // HQs (moved along with the troops or alone)
    if ( group.hqs.length ) {
      const hq = classifyHQ(group, { notify: !group.tokens.length });
      group.reportHQ = hq.report;
      set(group.hqs, hq.allow, hq.allow ? group : null);
    }
  }
  return decisions;
}

/**
 * Final top-left position of a token's movement instruction.
 * @param {TokenDocument} doc
 * @param {{waypoints?: object[]}} instruction
 */
function finalPosition(doc, instruction) {
  let x = doc._source.x;
  let y = doc._source.y;
  for ( const w of instruction?.waypoints ?? [] ) {
    if ( Number.isFinite(w?.x) ) x = w.x;
    if ( Number.isFinite(w?.y) ) y = w.y;
  }
  return { x, y };
}

/**
 * Pieces of this faction move without turn bookkeeping: no war in progress, or a GM moving a faction they don't
 * play this war.
 * @param {string} factionId
 */
function isFree(factionId) {
  if ( !getWar() ) return true;
  if ( !game.user.isGM ) return false;
  return game.actors.get(factionId)?.system?.war?.playerId !== game.user.id;
}

/**
 * Classify a cross-territory move of a faction's troops and validate it.
 * @param {{faction: string, from: string|null, to: string, troops: number}} group
 * @param {object} [options]
 * @param {boolean} [options.notify=true]   show enforcement notifications
 * @returns {{type: string, allow: boolean, report: boolean, attack?: boolean, dice?: number, result?: object}}
 */
export function classify(group, { notify = true } = {}) {
  const { faction, from, to, troops } = group;
  const free = { type: "free", allow: true, report: false };
  if ( !from || isFree(faction) ) return free;
  const state = buildSnapshot();
  const target = state?.territories?.[to];
  if ( !target ) return free;
  const check = result => enforce(result, { notify });

  const owner = target.owner ?? null;
  let type = rule("classifyMove", state, faction, from, to);
  if ( !type || (type === "invalid") ) type = !owner ? "expand" : (owner === faction ? "maneuver" : "attack");

  if ( type === "rearrange" ) return { type, allow: true, report: false };
  if ( type === "attack" ) {
    const available = Math.max(1, (state.territories[from]?.pieces?.[faction]?.troops ?? troops) - 1);
    const dice = Math.max(1, Math.min(3, troops, available));
    const result = rule("checkAttack", state, faction, from, to, dice) ?? ok();
    return { type, allow: false, report: false, attack: check(result), dice, result };
  }
  const name = { expand: "checkExpand", maneuver: "checkManeuver", advance: "checkAdvance" }[type];
  const result = (name && rule(name, state, faction, from, to, troops)) ?? ok();
  return { type, allow: check(result), report: true, result };
}

/**
 * May HQ pieces leave their territory? Only with the "mobile" power (`rules.checkMoveHQ`) or enforcement off.
 * @param {MoveGroup} group
 * @param {object} [options]
 * @param {boolean} [options.notify]
 * @returns {{allow: boolean, report: boolean}}
 */
function classifyHQ(group, { notify = true } = {}) {
  if ( !group.from || isFree(group.faction) ) return { allow: true, report: false };
  if ( enforcementLevel() === "off" ) return { allow: true, report: false };
  const state = buildSnapshot();
  const mobile = !!state && (rule("hasPower", state, group.faction, "mobile") === true);
  const result = (mobile ? rule("checkMoveHQ", state, group.faction, group.from, group.to) : null)
    ?? fail("RL.Canvas.Reason.hqFixed");
  if ( result.ok ) return { allow: true, report: true };
  return { allow: enforce(result, { notify }), report: false };
}

/**
 * Preview classification for the drag hint (no notifications, no side effects).
 * @param {string} faction
 * @param {string|null} from
 * @param {string|null} to
 * @param {number} troops
 * @returns {{type: string, allow: boolean, reason: string}}
 */
export function previewMove(faction, from, to, troops) {
  const strict = enforcementLevel() === "strict";
  if ( !to ) return { type: "outside", allow: !strict, reason: game.i18n.localize("RL.Canvas.Reason.outside") };
  if ( from === to ) return { type: "rearrange", allow: true, reason: "" };
  if ( !troops ) return { type: "hq", allow: !strict, reason: "" };
  const verdict = classify({ faction, from, to, troops }, { notify: false });
  const legal = verdict.type === "attack" ? verdict.attack : verdict.allow;
  const reason = verdict.result && !verdict.result.ok ? reasonText(verdict.result) : "";
  return { type: verdict.type, allow: legal, reason, dice: verdict.dice };
}

/* -------------------------------------------- */
/*  Follow-ups                                  */
/* -------------------------------------------- */

/**
 * Start a battle for a cancelled drag onto an enemy territory.
 * @param {MoveGroup} group
 */
async function startAttack(group) {
  const turn = area("turn");
  if ( typeof turn.attack !== "function" ) {
    ui.notifications.warn("RL.Canvas.Notify.noBattle", { localize: true });
    return;
  }
  try {
    await turn.attack({ faction: group.faction, from: group.from, to: group.to, dice: group.dice });
  } catch(err) {
    console.error(`${SYSTEM_ID} | turn.attack failed`, err);
  }
}

/**
 * Report a move that already happened, then tidy both territories.
 * @param {MoveGroup} group
 */
async function reportGroup(group) {
  const turn = area("turn");
  const calls = [];
  if ( group.report ) calls.push([group.type, { count: group.troops }]);
  if ( group.reportHQ ) calls.push(["moveHQ", {}]);
  for ( const [verb, extra] of calls ) {
    const fn = turn[verb];
    if ( typeof fn !== "function" ) continue;
    try {
      await fn({ faction: group.faction, from: group.from, to: group.to, ...extra, moved: true });
    } catch(err) {
      console.error(`${SYSTEM_ID} | turn.${verb} failed`, err);
      if ( enforcementLevel() === "strict" ) await revert(group);
      return;
    }
  }
  if ( game.settings.get(SYSTEM_ID, "canvas.autoArrange") ) {
    try {
      await runAction("pieces.arrange", { territories: [group.from, group.to].filter(Boolean) });
    } catch(err) {
      console.error(`${SYSTEM_ID} | arranging pieces failed`, err);
    }
  }
}

/**
 * Put the pieces of a rejected move back where they were.
 * @param {MoveGroup} group
 */
async function revert(group) {
  const docs = [...group.tokens, ...group.hqs];
  const scene = docs[0]?.parent;
  if ( !scene ) return;
  const updates = docs.filter(t => scene.tokens.has(t.id)).map(t => ({ _id: t.id, ...group.origins[t.id] }));
  if ( updates.length ) {
    await scene.updateEmbeddedDocuments("Token", updates, { [SYSTEM_ID]: { internal: true }, animate: false });
  }
}
