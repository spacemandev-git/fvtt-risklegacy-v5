import { SYSTEM_ID } from "../config.mjs";

/**
 * GM action bus.
 *
 * Everything that changes shared game state (other factions' tokens, the war, the campaign, the decks) runs on the
 * **active GM's client**. Players call `runAction(name, payload)`: on the GM it runs locally, elsewhere it is sent
 * to the active GM with a User query (CONFIG.queries) and the promise resolves with the handler's return value.
 *
 * Register handlers at `init` from your area: `registerAction("cards.draw", handler)`.
 * A handler receives `(payload, {user})` where `user` is the requesting User, and must:
 *   - re-validate permissions (`canActFor(user, factionId)` from state/accessors.mjs) and rules (enforce()),
 *   - return JSON-serializable data (ids, numbers, plain objects), or throw an Error with a localized message.
 *
 * Name actions "<area>.<verb>", e.g. "turn.end", "pieces.move", "battle.fireMissile".
 */

const QUERY = `${SYSTEM_ID}.action`;
const handlers = new Map();

/**
 * @callback ActionHandler
 * @param {object} payload
 * @param {{user: User}} context
 * @returns {Promise<*>|*}
 */

/**
 * Register a GM action.
 * @param {string} name
 * @param {ActionHandler} handler
 */
export function registerAction(name, handler) {
  if ( handlers.has(name) ) console.warn(`risklegacy | GM action "${name}" registered twice; replacing it`);
  handlers.set(name, handler);
}

/** @returns {boolean} whether an action with this name exists */
export function hasAction(name) {
  return handlers.has(name);
}

/**
 * Run a GM action from any client.
 * @param {string} name
 * @param {object} [payload]
 * @returns {Promise<*>} the handler's return value
 */
export async function runAction(name, payload = {}) {
  const handler = handlers.get(name);
  if ( !handler ) throw new Error(`Unknown GM action "${name}"`);
  if ( game.user.isActiveGM ) return handler(payload, { user: game.user });
  const gm = game.users.activeGM;
  if ( !gm ) {
    const message = game.i18n.localize("RL.Error.noGM");
    ui.notifications.error(message);
    throw new Error(message);
  }
  try {
    return await gm.query(QUERY, { name, payload }, { timeout: 120_000 });
  } catch(err) {
    ui.notifications.error(err.message);
    throw err;
  }
}

/** Register the query handler. Called from the system's init hook. */
export function init() {
  CONFIG.queries[QUERY] = async ({ name, payload }, { user }) => {
    if ( !game.user.isActiveGM ) throw new Error("Only the active GM executes Risk Legacy actions");
    const handler = handlers.get(name);
    if ( !handler ) throw new Error(`Unknown GM action "${name}"`);
    return handler(payload ?? {}, { user });
  };
}
