/**
 * Access to the other areas' runtime APIs (game.risklegacy.<area>) and to shared state, with clear errors when a
 * required function isn't there yet. Tests can swap an area for a stub with `setServiceOverride(area, impl)`
 * (exported from the battle area as a dev seam; never used in play).
 */
import { SYSTEM_ID } from "../config.mjs";
import { buildSnapshot, findEntry } from "../state/_module.mjs";

const overrides = {};

/**
 * Replace an area's API (or the snapshot builder, key "snapshot") for testing. Pass `null` to remove the override.
 * @param {string} name   "rules" | "board" | "turn" | "campaign" | "cards" | "snapshot"
 * @param {object|Function|null} impl
 */
export function setServiceOverride(name, impl) {
  if ( impl ) overrides[name] = impl;
  else delete overrides[name];
}

/** @returns {object|null} an area's runtime API */
export function api(area) {
  return overrides[area] ?? game.risklegacy?.[area] ?? null;
}

/**
 * An area's function, or throw a localized error naming what's missing.
 * @param {string} area
 * @param {string} fn
 * @returns {Function}
 */
export function requireFn(area, fn) {
  const target = api(area);
  if ( typeof target?.[fn] !== "function" ) {
    throw new Error(game.i18n.format("RL.Battle.Error.missingApi", { api: `game.risklegacy.${area}.${fn}` }));
  }
  return target[fn].bind(target);
}

/** The rules engine (ARCHITECTURE §5.1); throws if checkAttack isn't available. */
export function rulesApi() {
  requireFn("rules", "checkAttack");
  return api("rules");
}

/** @returns {object|null} the board snapshot */
export function snapshot() {
  return overrides.snapshot ? overrides.snapshot() : buildSnapshot();
}

/** The board snapshot, or throw if there is no campaign/board definition. */
export function requireSnapshot() {
  const snap = snapshot();
  if ( !snap ) throw new Error(game.i18n.localize("RL.Battle.Error.noBoard"));
  return snap;
}

/** Content catalog lookup that never throws (for modifiers.mjs). */
export function lookup(category, id) {
  try { return findEntry(category, id); } catch(err) { return null; }
}

/** World setting helper. */
export function setting(key) {
  try { return game.settings.get(SYSTEM_ID, key); } catch(err) { return undefined; }
}
