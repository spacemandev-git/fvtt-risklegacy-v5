import { SYSTEM_ID } from "../config.mjs";
import { TEMPLATES, factionActor } from "./util.mjs";

/**
 * Styled chat messages for card actions (core `chatNotification` is always off). Messages carry
 * `flags[SYSTEM_ID].card = true` (the apps area adds the `risklegacy` class to the <li>) and
 * `flags[SYSTEM_ID].cards = {kind, ...}` for anything that needs to find them later.
 */

/**
 * Post a card chat message.
 * @param {object} options
 * @param {string} options.kind               message kind (draw, coin, event, mission, scar, setup…)
 * @param {string} options.title
 * @param {string} [options.sub]
 * @param {Actor|string} [options.faction]    speaker
 * @param {{img: string, alt: string, orientation?: string, caption?: string}[]} [options.images]
 * @param {string} [options.text]             HTML body (already escaped)
 * @param {string} [options.result]           HTML footer (cream result strip)
 * @param {object[]} [options.buttons]        GM buttons [{action, label, icon, data: {k: v}}]
 * @param {boolean} [options.token]           show a Red Star token in the body
 * @param {object} [options.flags]            extra flags under flags[SYSTEM_ID].cards
 * @param {string[]} [options.whisper]        user ids
 * @returns {Promise<ChatMessage>}
 */
export async function post({ kind, title, sub, faction, images = [], text, result, buttons = [], token = false, flags = {}, whisper }) {
  const actor = factionActor(faction);
  const content = await foundry.applications.handlebars.renderTemplate(`${TEMPLATES}/chat-card.hbs`, {
    kind, title, sub, images, text, result, buttons, token,
    faction: actor ? { name: actor.name, key: actor.system.key, color: actor.system.color?.css ?? "" } : null
  });
  const speaker = actor
    ? foundry.documents.ChatMessage.implementation.getSpeaker({ actor })
    : { alias: game.i18n.localize("RL.Sideboard.title") };
  const data = {
    content, speaker,
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    flags: { [SYSTEM_ID]: { card: true, cards: { kind, ...flags } } }
  };
  if ( whisper?.length ) data.whisper = whisper;
  return foundry.documents.ChatMessage.implementation.create(data);
}

/**
 * Wire GM buttons in our chat cards (event "after resolving" choices).
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderChatMessageHTML(message, html) {
  if ( !message.getFlag(SYSTEM_ID, "cards") ) return;
  const buttons = html.querySelectorAll("[data-rl-cards-action]");
  for ( const button of buttons ) {
    if ( !game.user.isGM ) {
      button.remove();
      continue;
    }
    button.addEventListener("click", async event => {
      event.preventDefault();
      const { rlCardsAction, ...dataset } = button.dataset;
      button.disabled = true;
      try {
        await game.risklegacy.cards.chatAction(rlCardsAction, { ...dataset });
      } catch(err) {
        ui.notifications.error(err.message);
        button.disabled = false;
      }
    });
  }
}
