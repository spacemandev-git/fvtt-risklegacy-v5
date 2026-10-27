/**
 * Bot UI (owner: bots-ui; BOTS.md §7, BOTS-LLM.md §8): the Bot Manager (with the chat-model panel, the personality
 * gallery and the bots' notes), the Bot Log (Jev and chat-model exchanges), the chat narration and table talk.
 *
 * Entry points: Settings → "Bot players" (a settings menu), the War Room's Bots button (GM), the game-setup wizard's
 * "Add a bot player" control, and `game.risklegacy.bots.openBotManager()` / `openBotLog()` / `narrate(record)`.
 */
import { SYSTEM_ID } from "../../config.mjs";
import { isBotUser } from "../users.mjs";
import BotLog from "./bot-log.mjs";
import BotManager from "./bot-manager.mjs";
import { narrate as narrateRecord } from "./narration.mjs";
import { narrationLine } from "./text.mjs";

const { ApplicationV2 } = foundry.applications.api;

/**
 * Settings menus must be ApplicationV2 classes that core instantiates (`new type()`); this one hands over to the
 * single Bot Manager window instead of opening a second copy.
 */
class BotManagerMenu extends ApplicationV2 {
  /** @override */
  async render() {
    await BotManager.open();
    return this;
  }
}

/** Re-render the game-setup wizard when bot users come and go, so a new bot can be seated straight away. */
const refreshSetup = foundry.utils.debounce(() => {
  const app = foundry.applications.instances.get("rl-game-setup");
  if ( app?.rendered ) app.render();
}, 100);

function onUserChange(user, changes) {
  if ( !game.user.isGM ) return;
  // A new or removed user always changes the seat list; an update only when a bot's name or difficulty changed
  if ( changes && !isBotUser(user) && !("name" in changes) ) return;
  refreshSetup();
}

export function init() {
  game.settings.registerMenu(SYSTEM_ID, "bots.manager", {
    name: "RL.Bots.Menu.name",
    label: "RL.Bots.Menu.label",
    hint: "RL.Bots.Menu.hint",
    icon: "fa-solid fa-robot",
    type: BotManagerMenu,
    restricted: true
  });
  Hooks.on("createUser", user => onUserChange(user));
  Hooks.on("deleteUser", user => onUserChange(user));
  Hooks.on("updateUser", (user, changes) => onUserChange(user, changes));
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
}

/** Narration messages: a long bot name in the message header ends in an ellipsis (full name on hover). */
function onRenderChatMessageHTML(message, html) {
  if ( !message.flags?.[SYSTEM_ID]?.bot ) return;
  html.classList.add("rl-bot-message");
  const sender = html.querySelector(".message-sender");
  if ( sender && !sender.title ) sender.title = sender.textContent.trim();
}

export async function ready() {}

/** Open the Bot Manager (GM only). */
export function openBotManager() {
  return BotManager.open();
}

/** Open the Bot Log (GM only). */
export function openBotLog() {
  return BotLog.open();
}

/** Post the chat narration and table talk for a decision record (BOTS.md §7.3, BOTS-LLM.md §8). @returns {Promise<ChatMessage|null>} */
export async function narrate(record) {
  return narrateRecord(record);
}

export { BotLog, BotManager, narrationLine };
