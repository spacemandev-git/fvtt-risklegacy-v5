import { SYSTEM_ID } from "../config.mjs";

/**
 * Asking a player to make a choice on their own screen.
 *
 * The GM-side wizards call `ask(user, kind, data)`. If that user is this client, isn't connected, or the GM is
 * playing hot-seat, the prompt opens here. Otherwise it is sent to the player's client as a User query
 * (`fvtt-risklegacy-v5.campaign`), which opens the same prompt there and returns the answer. While a remote prompt
 * is open the GM can take over (`overrideAsk(promptId)`): the player's prompt is closed and the GM chooses.
 *
 * Prompt kinds are registered by module/campaign/apps/prompts.mjs with `registerPrompt(kind, fn)`.
 */

export const QUERY = `${SYSTEM_ID}.campaign`;

/** kind → async (data) => result */
const PROMPTS = new Map();

/** promptId → {user, kind, data, overridden, resolveOverride} (on the asking client) */
const pending = new Map();

/** promptId → cleanup functions run when the GM takes the prompt over (on the player's client). */
const cancelHandlers = new Map();

/**
 * Register cleanup for a prompt that isn't a window (e.g. a board pick): run if the GM takes it over.
 * @param {string} promptId
 * @param {Function} fn
 */
export function onPromptCancel(promptId, fn) {
  if ( !promptId ) return;
  if ( !cancelHandlers.has(promptId) ) cancelHandlers.set(promptId, []);
  cancelHandlers.get(promptId).push(fn);
}

/** Listeners notified when the pending list changes (wizards re-render). */
const listeners = new Set();

/** Remote prompt timeout: a player may take their time choosing a faction. */
const TIMEOUT = 30 * 60 * 1000;

/**
 * Register a prompt implementation.
 * @param {string} kind
 * @param {(data: object) => Promise<*>} fn  resolves with the answer, or null if the user cancelled
 */
export function registerPrompt(kind, fn) {
  PROMPTS.set(kind, fn);
}

/** Display-only notices (`notify`) and cancellation are handled here too. */
const CONTROL = {
  /** Close an open prompt (the GM took over). */
  cancel: async ({ promptId }) => {
    const app = foundry.applications.instances.get(`rl-prompt-${promptId}`);
    await app?.close();
    // A reward being claimed from the Sticker Sheet, and any board pick in progress, end with it
    await foundry.applications.instances.get("rl-sticker-sheet-claim")?.close();
    for ( const fn of cancelHandlers.get(promptId) ?? [] ) {
      try {
        fn();
      } catch(err) {
        console.error(err);
      }
    }
    cancelHandlers.delete(promptId);
    return true;
  }
};

/** Register the User query. Called from the area's init(). */
export function registerQuery() {
  CONFIG.queries[QUERY] = async ({ kind, data = {}, promptId } = {}, { user } = {}) => {
    if ( CONTROL[kind] ) return CONTROL[kind](data);
    const fn = PROMPTS.get(kind);
    if ( !fn ) throw new Error(`Unknown campaign prompt "${kind}"`);
    return fn({ ...data, promptId, askedBy: user?.id ?? "" });
  };
}

/** Run a prompt on this client. */
export function askHere(kind, data = {}) {
  const fn = PROMPTS.get(kind);
  if ( !fn ) throw new Error(`Unknown campaign prompt "${kind}"`);
  return fn({ promptId: foundry.utils.randomID(), ...data });
}

function changed() {
  for ( const fn of listeners ) {
    try {
      fn();
    } catch(err) {
      console.error(err);
    }
  }
}

/**
 * Subscribe to changes of the pending remote prompts.
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
export function onPendingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @returns {{promptId: string, userId: string, userName: string, kind: string}[]} remote prompts awaiting an answer */
export function pendingPrompts() {
  return [...pending.entries()].map(([promptId, p]) => ({
    promptId, userId: p.user.id, userName: p.user.name, kind: p.kind
  }));
}

/**
 * Ask a user to choose.
 * @param {User|string|null} userOrId  who chooses (null: this client)
 * @param {string} kind                 registered prompt kind
 * @param {object} data                 JSON-serializable prompt data
 * @returns {Promise<*>} the answer (null when cancelled)
 */
export async function ask(userOrId, kind, data = {}) {
  const user = typeof userOrId === "string" ? game.users.get(userOrId) : userOrId;
  // Bot players answer here (module/bots)
  const bot = await game.risklegacy.bots?.answer?.(kind, { user, data });
  if ( bot !== undefined ) return bot;
  const promptId = foundry.utils.randomID();
  const hotSeat = !!user && !user.isSelf;
  if ( !user || user.isSelf || !user.active ) {
    return askHere(kind, { ...data, promptId, forUserId: user?.id ?? "", forUserName: user?.name ?? "", hotSeat });
  }
  const entry = { user, kind, data, overridden: false, resolveOverride: null };
  const override = new Promise(resolve => entry.resolveOverride = resolve);
  pending.set(promptId, entry);
  changed();
  try {
    const remote = user.query(QUERY, { kind, data, promptId }, { timeout: TIMEOUT }).then(
      value => (entry.overridden ? new Promise(() => {}) : { value }),
      error => (entry.overridden ? new Promise(() => {}) : { error })
    );
    const result = await Promise.race([remote, override]);
    if ( result.error ) {
      console.warn(`${SYSTEM_ID} | campaign: prompt "${kind}" for ${user.name} failed`, result.error);
      ui.notifications.warn(game.i18n.format("RL.Wizard.Ask.failed", { name: user.name }));
      return askHere(kind, { ...data, promptId, forUserId: user.id, forUserName: user.name, hotSeat: true });
    }
    return result.value;
  } finally {
    pending.delete(promptId);
    changed();
  }
}

/**
 * Take over a remote prompt: close it on the player's screen and choose here.
 * @param {string} promptId
 */
export async function overrideAsk(promptId) {
  const entry = pending.get(promptId);
  if ( !entry || entry.overridden ) return;
  entry.overridden = true;
  if ( entry.user.active ) entry.user.query(QUERY, { kind: "cancel", data: { promptId } }).catch(() => null);
  const value = await askHere(entry.kind, {
    ...entry.data, promptId, forUserId: entry.user.id, forUserName: entry.user.name, hotSeat: true
  });
  entry.resolveOverride({ value });
}

/**
 * Tell other clients something without waiting for an answer (e.g. show the package prompt).
 * @param {string} kind
 * @param {object} data
 * @param {object} [options]
 * @param {boolean} [options.gms=false]  include other GMs
 */
export function broadcast(kind, data = {}, { gms = false } = {}) {
  for ( const user of game.users ) {
    if ( user.isSelf || !user.active || (user.isGM && !gms) ) continue;
    user.query(QUERY, { kind, data, promptId: foundry.utils.randomID() }, { timeout: TIMEOUT }).catch(err => {
      console.debug(`${SYSTEM_ID} | campaign: broadcast "${kind}" to ${user.name} failed`, err);
    });
  }
}
