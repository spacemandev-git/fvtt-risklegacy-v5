/**
 * Chat narration (BOTS.md §7.3) and table talk (BOTS-LLM.md §8).
 *
 * Narration: a compact chat card saying what a bot did and why, spoken by the bot user, according to the
 * `bots.narration` setting (all / gm = whispered to GMs / off). Narrated: attacks, expansions, placements, end of turn,
 * missiles fired, scar cards played and prompt/event choices (including board picks made for a bot). Skipped: situation
 * assessments and "stop" decisions (the Bot Log keeps everything). Several placements in one turn become a single line,
 * and so do a turn's expansions: the turn's card is updated and keeps the first (main) decision's reason. A decision
 * made with the built-in judgment (Jev or the chat model unavailable) is marked on its card; if it isn't otherwise
 * narrated, one notice per bot per turn says so.
 *
 * Table talk: a chat bot's in-character line (`record.say`) according to `bots.tableTalk` (all / gm / off), at most one
 * per decision. It joins the decision's own narration card when that card is new and has the same audience; otherwise
 * it is a speech card of its own (the bot's portrait, name, personality title and the quote). The same line twice in
 * one turn is posted once.
 */
import { SYSTEM_ID } from "../../config.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";
import { NARRATED, categoryLabel, categoryOf, mergePlacements, narrationLine, recordBot, sayOf, t, tpl } from "./text.mjs";

const TEMPLATE = tpl("bots/narration.hbs");
const TALK_TEMPLATE = tpl("bots/talk.hbs");

/** Categories whose decisions of one turn share a single card: the flag that keeps them and how to add one. */
const MERGED = {
  placement: {
    field: "placements",
    items: d => d?.placements ?? [],
    merge: (a, b) => mergePlacements(a, b)
  },
  expand: {
    field: "expansions",
    items: d => (d?.to ? [{ from: d.from ?? null, to: d.to, count: d.count ?? null }] : []),
    merge: (a, b) => [...a, ...b]
  }
};

/** The last line each bot said this turn (`${bot}|${turnKey}` → text), so a repeated line is posted once. */
const lastSaid = new Map();

/** The current turn, so placements and notices of one turn can be grouped. */
function turnKey() {
  const war = game.risklegacy?.state?.getWar?.();
  return war ? `${war.id}:${war.round ?? 0}:${war.turn ?? 0}` : "none";
}

/** Our narration message of a category for this faction and turn, if any. */
function findCard(category, faction, key) {
  return game.messages.contents.findLast(m => {
    const f = m.flags?.[SYSTEM_ID]?.bot;
    return f && (f.category === category) && (f.faction === faction) && (f.turnKey === key);
  }) ?? null;
}

const engineKey = (bot, key) => (bot.engine === "llm" ? `${key}LLM` : key);

/** Render the card HTML. */
async function renderCard({ record, category, line, heuristic, notice, say = "" }) {
  const actor = game.actors.get(record.faction);
  const bot = recordBot(record);
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    category, line, heuristic, notice,
    title: notice ? t(engineKey(bot, "RL.Bots.Narration.noticeTitle")) : categoryLabel(category),
    sub: [actor?.name ?? record.factionName, bot.difficultyLabel].filter(Boolean).join(" · "),
    heuristicNote: t(engineKey(bot, "RL.Bots.Narration.heuristic")),
    factionClass: actor?.system?.key ? `rl-faction--${actor.system.key}` : "",
    color: actor?.system?.color?.css ?? "",
    quote: say ? { text: t("RL.Bots.Talk.quote", { say }), portrait: bot.portrait, by: bot.title || bot.name } : null
  });
}

/**
 * Post (or update) the narration card for a decision record, and its table talk.
 * @param {object} record  a DecisionRecord (module/bots/log.mjs)
 * @returns {Promise<ChatMessage|null>}  the narration card, else the speech card
 */
export async function narrate(record) {
  if ( !record || !game.user.isGM ) return null;
  const key = turnKey();
  let say = sayOf(record);
  let talk = "off";
  if ( say ) {
    talk = getSetting(SETTINGS.tableTalk) ?? "all";
    const who = `${record.user || record.faction || "?"}|${key}`;
    if ( (talk === "off") || (lastSaid.get(who) === say) ) say = "";
    else {
      lastSaid.set(who, say);
      if ( lastSaid.size > 200 ) lastSaid.delete(lastSaid.keys().next().value);
    }
  }
  let message = null;
  let quoted = false;
  try {
    ({ message, quoted } = await narrateDecision(record, key, { say, talk }));
  } catch(err) {
    console.error(`${SYSTEM_ID} | bot narration failed`, err);
  }
  if ( say && !quoted ) {
    try {
      const speech = await postTalk(record, key, say, talk);
      message ??= speech;
    } catch(err) {
      console.error(`${SYSTEM_ID} | bot table talk failed`, err);
    }
  }
  return message;
}

/**
 * The narration card for a decision. A new card also carries the table-talk line when it has the same audience.
 * @returns {Promise<{message: ChatMessage|null, quoted: boolean}>}
 */
async function narrateDecision(record, key, { say, talk }) {
  const none = { message: null, quoted: false };
  const mode = getSetting(SETTINGS.narration);
  if ( mode === "off" ) return none;
  const category = categoryOf(record);
  if ( ["situation", "stop", "none"].includes(category) ) return none;
  const heuristic = !!record.heuristic;
  // Same audience: everyone for both, or GMs only for both
  const quote = (say && (talk === mode)) ? say : "";

  // Not a narrated kind of decision: only a once-per-turn notice when it ran on the built-in judgment
  if ( !NARRATED.has(category) ) {
    if ( !heuristic || findCard("notice", record.faction, key) ) return none;
    const bot = recordBot(record);
    const content = await renderCard({ record, category: "notice", notice: true,
      line: t(engineKey(bot, "RL.Bots.Narration.noticeLine"), { name: bot.name }) });
    return { message: await post(record, { category: "notice", key, content }, mode), quoted: false };
  }

  // Placements and expansions: one card per turn, updated as the turn goes on (a line said now gets its own card)
  const merge = MERGED[category];
  const existing = merge ? findCard(category, record.faction, key) : null;
  if ( existing ) {
    const flags = existing.flags[SYSTEM_ID].bot;
    const items = merge.merge(flags[merge.field] ?? [], merge.items(record.decision));
    const anyHeuristic = heuristic || !!flags.heuristic;
    const first = flags.why ? { ...record, decision: { ...record.decision, why: flags.why } } : record;
    const content = await renderCard({ record, category, heuristic: anyHeuristic, say: flags.say ?? "",
      line: narrationLine(first, { [merge.field]: items }) });
    await existing.update({
      content,
      [`flags.${SYSTEM_ID}.bot.${merge.field}`]: items,
      [`flags.${SYSTEM_ID}.bot.heuristic`]: anyHeuristic,
      [`flags.${SYSTEM_ID}.bot.records`]: [...(flags.records ?? []), record.id]
    });
    return { message: existing, quoted: false };
  }

  const content = await renderCard({ record, category, heuristic, line: narrationLine(record), say: quote });
  const extra = merge ? { [merge.field]: merge.merge([], merge.items(record.decision)) } : {};
  if ( quote ) extra.say = quote;
  return { message: await post(record, { category, key, content, extra }, mode), quoted: !!quote };
}

/** Create the chat message, spoken by the bot user. */
async function post(record, { category, key, content, extra = {} }, mode) {
  const bot = recordBot(record);
  const data = {
    content,
    speaker: { alias: bot.name },
    flags: {
      [SYSTEM_ID]: {
        card: true,
        bot: {
          category, faction: record.faction ?? null, reason: record.decision?.why?.reason ?? null,
          turnKey: key, records: [record.id], heuristic: !!record.heuristic, why: record.decision?.why ?? null,
          ...extra
        }
      }
    }
  };
  if ( bot.user ) data.author = bot.user.id;
  return ChatMessage.implementation.create(data, { messageMode: mode === "gm" ? "gm" : "public" });
}

/** A speech card: the bot says its line (its portrait, name and personality title). */
async function postTalk(record, key, say, talk) {
  const bot = recordBot(record);
  const actor = game.actors.get(record.faction);
  const content = await foundry.applications.handlebars.renderTemplate(TALK_TEMPLATE, {
    name: bot.name, title: bot.title, portrait: bot.portrait,
    sub: [actor?.name ?? record.factionName, bot.difficultyLabel].filter(Boolean).join(" · "),
    quote: t("RL.Bots.Talk.quote", { say }),
    factionClass: actor?.system?.key ? `rl-faction--${actor.system.key}` : "",
    color: actor?.system?.color?.css ?? ""
  });
  return post(record, { category: "talk", key, content, extra: { say } }, talk);
}
