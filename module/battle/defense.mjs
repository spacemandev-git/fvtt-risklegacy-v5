/**
 * The defender's dice choice (world setting `defenderChoice` = "prompt").
 *
 * The active GM asks the defending player with a User query (`fvtt-risklegacy-v5.battle.askDefense`), which opens a
 * small dialog on their client. The battle card also shows "Defend with 1/2" buttons to the defender (and the GM),
 * so whichever answers first wins (`settleDefense`). If the player is offline, doesn't answer within
 * DEFENSE_TIMEOUT, or the query fails, the defender rolls the maximum allowed.
 */
import { SYSTEM_ID } from "../config.mjs";

export const DEFENSE_QUERY = `${SYSTEM_ID}.battle.askDefense`;

/** How long the defender has to choose (ms). */
export const DEFENSE_TIMEOUT = 30_000;

/** Pending choices on the GM, by message id. */
const pending = new Map();

/**
 * The user who plays a faction (falls back to an active non-GM owner of the actor).
 * @param {Actor} faction
 * @returns {User|null}
 */
export function playerOf(faction) {
  if ( !faction ) return null;
  const assigned = game.users.get(faction.system?.war?.playerId ?? "");
  if ( assigned ) return assigned;
  return game.users.find(u => !u.isGM && faction.testUserPermission(u, "OWNER")) ?? null;
}

/**
 * GM side: get the defender's dice count. Resolves with 1..max.
 * @param {ChatMessage} message   the battle message (status awaitingDefender)
 * @param {number} max
 * @param {object} data           display data for the prompt
 * @returns {Promise<number>}
 */
export function requestDefense(message, max, data = {}) {
  return new Promise(resolve => {
    let timer = null;
    const done = value => {
      if ( !pending.has(message.id) ) return;
      clearTimeout(timer);
      pending.delete(message.id);
      const n = Number(value);
      resolve(Number.isInteger(n) && (n >= 1) && (n <= max) ? n : max);
    };
    timer = setTimeout(() => done(max), DEFENSE_TIMEOUT + 5_000);
    pending.set(message.id, { done, max });

    const defender = game.actors.get(message.system.defender);
    const user = playerOf(defender);
    const query = { messageId: message.id, max, timeout: DEFENSE_TIMEOUT, ...data };
    // Bot players answer here (module/bots)
    const bot = game.risklegacy.bots?.answer?.("defense", { user, data: query });
    if ( bot !== undefined ) {
      Promise.resolve(bot).then(done, () => done(max));
      return;
    }
    if ( !user?.active ) return done(max);
    if ( user.isSelf ) {
      promptDefense(query).then(done, () => done(max));
      return;
    }
    user.query(DEFENSE_QUERY, query, { timeout: DEFENSE_TIMEOUT + 2_000 }).then(done, () => done(max));
  });
}

/**
 * GM side: answer a pending defence choice (from the card buttons). Returns false if nothing was pending.
 * @param {string} messageId
 * @param {number|null} dice  null = use the maximum
 */
export function settleDefense(messageId, dice) {
  const entry = pending.get(messageId);
  if ( !entry ) return false;
  entry.done(dice ?? entry.max);
  return true;
}

/** @returns {boolean} whether the GM is waiting for this battle's defence choice */
export function isAwaitingDefense(messageId) {
  return pending.has(messageId);
}

/**
 * Player side: ask how many troops defend. Closes itself after `timeout` (→ max) or when the battle moves on.
 * @param {object} data  {messageId, max, timeout, attacker, defender, from, to, attackDice}
 * @returns {Promise<number>}
 */
export async function promptDefense(data) {
  const { DialogV2 } = foundry.applications.api;
  const max = Math.max(1, Math.min(2, Number(data.max) || 1));
  const seconds = Math.round((Number(data.timeout) || DEFENSE_TIMEOUT) / 1000);
  const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
  const content = document.createElement("div");
  content.innerHTML = `
    <div class="rl-callout rl-battle-defense">
      <p>${game.i18n.format("RL.Battle.Defense.prompt", {
        attacker: `<b>${esc(data.attacker)}</b>`, territory: `<b>${esc(data.to)}</b>`, from: esc(data.from),
        dice: Number(data.attackDice) || 1
      })}</p>
      <p class="rl-battle-defense__hint">${game.i18n.format("RL.Battle.Defense.auto", { max, seconds })}</p>
    </div>`;
  let timer = null;
  let hookId = null;
  const buttons = Array.fromRange(max, 1).reverse().map(n => ({
    action: `defend${n}`, label: game.i18n.format(n === 1 ? "RL.Battle.Defense.oneShort" : "RL.Battle.Defense.manyShort", { n }),
    icon: "fa-solid fa-dice", default: n === max, callback: () => n
  }));
  try {
    const result = await DialogV2.wait({
      window: { title: game.i18n.format("RL.Battle.Defense.title", { territory: data.to ?? "" }), icon: "fa-solid fa-shield-halved" },
      classes: ["risklegacy", "rl-hazard-header"],
      position: { width: 400 },   // room for "Defend Eastern United States" in the title bar
      content,
      buttons,
      rejectClose: false,
      render: (event, dialog) => {
        timer ??= setTimeout(() => dialog.close(), (Number(data.timeout) || DEFENSE_TIMEOUT));
        hookId ??= Hooks.on("updateChatMessage", message => {
          if ( (message.id === data.messageId) && (message.system?.status !== "awaitingDefender") ) dialog.close();
        });
      }
    });
    return Number.isInteger(result) ? result : max;
  } finally {
    clearTimeout(timer);
    if ( hookId !== null ) Hooks.off("updateChatMessage", hookId);
  }
}

/** Register the query handler (init). */
export function registerDefenseQuery() {
  CONFIG.queries[DEFENSE_QUERY] = async data => promptDefense(data ?? {});
}
