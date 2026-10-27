import { SYSTEM_ID, WAR_STAGES } from "../config.mjs";
import {
  allPacks, buildSnapshot, canActFor, enforcementLevel, getCampaign, getHand, getWar, reasonText
} from "../state/_module.mjs";
import WarData from "../data/combat-war.mjs";

/** Localize (format when data is given). */
export const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Escape text for chat HTML. */
export const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/** A fresh per-turn record, wrapped so an update replaces it instead of merging (old flags must go). */
export const replaceTurn = factionId => foundry.data.operators.ForcedReplacement.create(WarData.freshTurn(factionId));

/* -------------------------------------------- */
/*  Other areas                                 */
/* -------------------------------------------- */

/**
 * A function of another area's runtime API (`game.risklegacy.<area>.<fn>`), looked up at call time so missing or
 * half-finished areas fail with a clear message instead of a TypeError.
 * @param {string} area   "board" | "cards" | "battle" | "campaign" | "apps"
 * @param {string} fn
 * @param {object} [options]
 * @param {boolean} [options.optional=false]  return null instead of throwing
 * @returns {Function|null}
 */
export function api(area, fn, { optional = false } = {}) {
  const f = game.risklegacy?.[area]?.[fn];
  if ( typeof f === "function" ) return f;
  if ( optional ) return null;
  throw new Error(t("RL.Turn.Error.missingApi", { api: `game.risklegacy.${area}.${fn}` }));
}

/**
 * Call another area's function. Its wrappers may resolve `null` on failure instead of throwing; treat that as an
 * error when `required`.
 */
export async function callApi(area, fn, payload, { required = true } = {}) {
  const result = await api(area, fn)(payload);
  if ( required && (result === null) ) throw new Error(t("RL.Turn.Error.apiFailed", { api: `${area}.${fn}` }));
  return result;
}

/**
 * Run a side step that must not abort the turn (start-of-turn powers, end-of-turn scars, hand transfer): errors
 * are logged and whispered to the GMs.
 * @returns {Promise<*>} the result, or undefined on error
 */
export async function safely(label, fn) {
  try {
    return await fn();
  } catch(err) {
    console.error(`${SYSTEM_ID} | ${label}`, err);
    await whisperGM(t("RL.Turn.Error.stepFailed", { step: label, error: err.message }));
    return undefined;
  }
}

/* -------------------------------------------- */
/*  Snapshot                                    */
/* -------------------------------------------- */

let effectsCache = null;

/** Scar / mark / power effects from the loaded content catalog, in the shape the rules engine reads. */
export function catalogEffects() {
  if ( effectsCache ) return effectsCache;
  const out = { scars: {}, marks: {}, powers: {} };
  for ( const pack of allPacks() ) {
    for ( const s of pack.scars ?? [] ) out.scars[s.id] = s.effect ?? null;
    for ( const m of pack.marks ?? [] ) out.marks[m.id] = m.effect ?? null;
    for ( const p of [...(pack.powers ?? []), ...(pack.secretPowers ?? [])] ) out.powers[p.id] = p.effect ?? null;
  }
  if ( !Object.keys(out.scars).length && !Object.keys(out.marks).length ) return null;
  effectsCache = out;
  return out;
}

/**
 * The board snapshot with catalog effects attached. When the turn record still belongs to the previous player
 * (the start-of-turn reset hasn't landed yet), `turn.log` is replaced by a fresh one so checks don't see stale data.
 * @returns {object} BoardState
 */
export function snapshot() {
  const snap = buildSnapshot();
  if ( !snap ) throw new Error(t(getCampaign() ? "RL.Turn.Error.noBoard" : "RL.Error.noCampaign"));
  const effects = catalogEffects();
  if ( effects ) snap.effects = effects;
  if ( snap.turn && snap.turn.faction && (snap.turn.log?.faction !== snap.turn.faction) ) {
    snap.turn.log = WarData.freshTurn(snap.turn.faction);
    snap.turn.stale = true;
  }
  return snap;
}

/**
 * Wait until the board shows what a piece operation should have produced. In v14 an animated token update resolves
 * before the token document has its new position, so a snapshot taken right after `board.moveTroops` can still show
 * the old board. Polls the snapshot until `predicate(snap)` holds or the timeout passes.
 * @param {(snap: object) => boolean} predicate
 * @param {object} [options]
 * @param {number} [options.timeout=4000]
 * @returns {Promise<object>} the last snapshot
 */
export async function settle(predicate, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  for ( ;; ) {
    let snap = null;
    try { snap = snapshot(); } catch(err) { /* keep waiting */ }
    if ( snap && predicate(snap) ) return snap;
    if ( Date.now() - start >= timeout ) return snap;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** A faction's troops in a territory of a snapshot. */
export const troopsAt = (snap, factionId, territoryId) => snap?.territories?.[territoryId]?.pieces?.[factionId]?.troops ?? 0;

/* -------------------------------------------- */
/*  Guards                                      */
/* -------------------------------------------- */

/**
 * Apply the world's enforcement level to a RuleResult on the GM. Strict: throw (the requesting client shows the
 * reason). Advisory: whisper a warning to the GMs and go ahead. Off: go ahead.
 * @param {import("../rules/result.mjs").RuleResult} result
 * @returns {Promise<string|null>} the warning text in advisory mode
 */
export async function gate(result) {
  if ( !result || result.ok ) return null;
  const level = enforcementLevel();
  if ( level === "off" ) return null;
  const text = reasonText(result);
  if ( level === "advisory" ) {
    await whisperGM(t("RL.Enforce.advisory", { reason: text }));
    return text;
  }
  throw new Error(text);
}

/** Throw unless the user is a GM. */
export function assertGM(user) {
  if ( !user?.isGM ) throw new Error(t("RL.Turn.Error.gmOnly"));
}

/**
 * The faction actor, if the user may act for it.
 * @returns {Actor}
 */
export function assertCanAct(user, factionId) {
  const actor = game.actors.get(factionId);
  if ( !actor || (actor.type !== "faction") ) throw new Error(t("RL.Turn.Error.noFaction", { id: factionId ?? "" }));
  if ( !canActFor(user, actor) ) throw new Error(t("RL.Turn.Error.cannotAct", { faction: actor.name }));
  return actor;
}

/**
 * The war in progress, optionally in one of the given stages.
 * @param {object} [options]
 * @param {string|string[]} [options.stage]
 * @returns {Combat}
 */
export function requireWar({ stage } = {}) {
  const war = getWar();
  if ( !war ) throw new Error(t("RL.Turn.Error.noWar"));
  if ( stage && ![].concat(stage).includes(war.system.stage) ) {
    throw new Error(t("RL.Turn.Error.wrongStage", { stage: t(WAR_STAGES[war.system.stage] ?? war.system.stage) }));
  }
  return war;
}

/** The faction whose turn it is (playing) or who is choosing a starting territory (placement). */
export function activeFactionId(war = getWar()) {
  if ( !war ) return null;
  if ( war.system.stage === "playing" ) return war.combatant?.actorId ?? null;
  if ( war.system.stage === "placement" ) {
    const { order, index } = war.system.placement;
    return order[index] ?? null;
  }
  return null;
}

/** Has the faction been eliminated (or isn't in the war)? */
export function isOut(actor) {
  return !actor || (actor.system.war?.status === "eliminated");
}

/** Resource cards of a faction's hand, by id; throws if one isn't there. */
export function handCards(factionId, cardIds = []) {
  const hand = getHand(factionId);
  const ids = [...new Set(cardIds)];
  const cards = ids.map(id => hand?.cards.get(id));
  if ( !hand || cards.some(c => !c) ) throw new Error(t("RL.Turn.Error.notInHand"));
  if ( cards.some(c => !["territory", "coin"].includes(c.type)) ) throw new Error(t("RL.Turn.Error.notResource"));
  return cards;
}

/* -------------------------------------------- */
/*  Messages                                    */
/* -------------------------------------------- */

/** Whisper a plain note to the GMs. */
export async function whisperGM(text) {
  const gms = game.users.filter(u => u.isGM).map(u => u.id);
  if ( !gms.length ) return;
  try {
    await ChatMessage.implementation.create({
      content: `<div class="risklegacy rl-chat-card"><div class="rl-chat-card__body">${esc(text)}</div></div>`,
      whisper: gms, speaker: { alias: t("RL.Turn.Chat.rulesCheck") },
      flags: { [SYSTEM_ID]: { card: true, turn: "notice" } }
    });
  } catch(err) {
    console.warn(`${SYSTEM_ID} | ${text}`, err);
  }
}

/* -------------------------------------------- */
/*  Serialization                               */
/* -------------------------------------------- */

let queue = Promise.resolve();
const LOCK_TIMEOUT = 20_000;

/**
 * Run GM handlers one at a time, so rapid requests (click-to-place) don't read and write the same counters
 * concurrently. A handler that waits more than 20 s for its turn runs anyway (guards against re-entrant calls).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function serialize(fn) {
  const prior = queue;
  const run = Promise.race([prior, new Promise(r => setTimeout(r, LOCK_TIMEOUT))]).then(() => fn());
  queue = run.catch(() => {});
  return run;
}
