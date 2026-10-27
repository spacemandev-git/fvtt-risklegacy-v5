import { SYSTEM_PATH, SYSTEM_ID } from "../config.mjs";
import { getCampaignBoard } from "../state/_module.mjs";
import { esc, t } from "./util.mjs";

/**
 * Short chat cards for turn events, in the design system's chat-card markup (`.rl-chat-card`, DESIGN.md §6) and
 * flagged `flags[SYSTEM_ID].card = true` so the apps area adds the `risklegacy` class to the message frame.
 */

const TEMPLATE = `${SYSTEM_PATH}/templates/turn/chat-card.hbs`;

/** Display name of a territory. */
export function territoryName(id) {
  if ( !id ) return "";
  return getCampaignBoard()?.territories?.[id]?.name ?? id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/** Display name of a continent (the name a winner gave it, else the printed label). */
export function continentName(id, snap) {
  const c = snap?.continents?.[id];
  return c?.name || c?.label || getCampaignBoard()?.continents?.[id]?.label || id;
}

/** A faction's name, escaped, for card text. */
export const factionText = actor => `<b>${esc(actor?.name ?? "")}</b>`;

/** Display name of a power key (catalog name if loaded). */
export function powerName(key) {
  const loc = `RL.Turn.Power.${key}`;
  if ( game.i18n.has(loc) ) return t(loc);
  for ( const pack of game.risklegacy?.state?.allPacks?.() ?? [] ) {
    const p = (pack.powers ?? []).find(e => e.id === key);
    if ( p?.name ) return p.name;
  }
  return key;
}

/**
 * Post a turn chat card.
 * @param {object} card
 * @param {Actor|string} [card.faction]  speaker and colour
 * @param {string} card.kind             machine-readable kind (flags[SYSTEM_ID].turn)
 * @param {string} card.title
 * @param {string} [card.sub]
 * @param {string} [card.text]           trusted HTML (escape names with esc())
 * @param {{label: string, value: string|number}[]} [card.rows]
 * @param {string} [card.note]           marker note
 * @param {string} [card.result]         cream footer
 * @param {boolean} [card.hazard]        hazard tape on top (eliminations, knock-outs)
 * @param {"star"|"missile"} [card.token]
 * @param {string[]} [card.whisper]      user ids
 * @returns {Promise<ChatMessage|null>}
 */
export async function postCard({ faction, kind, title, sub, text, rows = [], note, result, hazard, token, whisper } = {}) {
  const actor = typeof faction === "string" ? game.actors.get(faction) : faction;
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    kind, title, sub, text, rows, note, result, hazard,
    hasBody: !!(text || rows.length || note || token),
    tokenClass: token ? (token === "missile" ? "rl-token rl-token--missile" : "rl-token") : "",
    factionClass: actor?.system?.key ? `rl-faction--${actor.system.key}` : ""
  });
  const data = {
    content,
    speaker: actor
      ? { alias: actor.name, actor: actor.id }
      : { alias: t("RL.Turn.Chat.warRoom") },
    flags: { [SYSTEM_ID]: { card: true, turn: kind, faction: actor?.id ?? null } }
  };
  if ( whisper?.length ) data.whisper = whisper;
  try {
    return await ChatMessage.implementation.create(data);
  } catch(err) {
    console.error(`${SYSTEM_ID} | could not post the ${kind} chat card`, err);
    return null;
  }
}
