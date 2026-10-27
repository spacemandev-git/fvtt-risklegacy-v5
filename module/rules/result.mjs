/**
 * RuleResult builders for the pure rules engine. Same shape as `module/state/enforce.mjs` (`ok` / `fail`), kept local
 * so the engine never imports anything that touches the Foundry runtime and runs under plain `node --test`.
 *
 * @typedef {object} RuleResult
 * @property {boolean} ok
 * @property {string} [reason]   localization key (format data in `data`)
 * @property {object} data       computed values (costs, limits, advance hints…) and format data for the reason
 */

/** @returns {RuleResult} a passing result */
export const ok = (data = {}) => ({ ok: true, data });

/** @returns {RuleResult} a failing result */
export const fail = (reason, data = {}) => ({ ok: false, reason, data });
