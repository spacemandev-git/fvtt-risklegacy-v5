import { SYSTEM_ID } from "../config.mjs";

/**
 * Rules enforcement. Every rules check returns a `RuleResult`; callers pass it through `enforce()` to decide whether
 * the action goes ahead under the world's enforcement level (setting `enforcement`):
 *   strict   → illegal actions are blocked, with the reason as an error notification
 *   advisory → illegal actions warn (notification + whisper to GM) but proceed
 *   off      → nothing is checked
 *
 * @typedef {object} RuleResult
 * @property {boolean} ok
 * @property {string} [reason]   localization key (or already-localized text) explaining why not
 * @property {object} [data]     format data for the reason, and any computed values (costs, losses…)
 */

/** @returns {"strict"|"advisory"|"off"} */
export function enforcementLevel() {
  return game.settings.get(SYSTEM_ID, "enforcement");
}

/** Build a passing result. */
export const ok = (data = {}) => ({ ok: true, data });

/** Build a failing result. */
export const fail = (reason, data = {}) => ({ ok: false, reason, data });

/** Localize a RuleResult's reason. */
export function reasonText(result) {
  if ( !result?.reason ) return "";
  return game.i18n.has(result.reason) ? game.i18n.format(result.reason, result.data ?? {}) : result.reason;
}

/**
 * Decide whether an action may proceed.
 * @param {RuleResult} result
 * @param {object} [options]
 * @param {boolean} [options.notify=true]  show a notification when blocked or warned
 * @returns {boolean} true if the action should go ahead
 */
export function enforce(result, { notify = true } = {}) {
  if ( !result || result.ok ) return true;
  const level = enforcementLevel();
  if ( level === "off" ) return true;
  const text = reasonText(result);
  if ( level === "advisory" ) {
    if ( notify ) ui.notifications.warn(game.i18n.format("RL.Enforce.advisory", { reason: text }));
    return true;
  }
  if ( notify ) ui.notifications.error(game.i18n.format("RL.Enforce.blocked", { reason: text }));
  return false;
}
