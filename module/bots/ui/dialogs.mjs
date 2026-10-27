/**
 * Bot Manager dialogs for chat-model bots (BOTS-LLM.md §8): the personality gallery ("Add chat bot", or picking a new
 * personality for a bot) and the Notes viewer (a bot's memory between games, with Clear).
 */
import { PERSONALITIES, personalityById } from "../llm/personalities.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";
import { DIFFICULTIES, botInfo, botUsers, clearBotMemory, difficultyLabel } from "../users.mjs";
import { loadModels, modelName, modelOptions } from "./llm.mjs";
import { RANKS, esc, list, portraitOf, t, tpl } from "./text.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

/** Personality knobs shown as bars (BOTS-LLM.md §5.2), in display order. */
export const KNOBS = Object.freeze(["risk", "aggression", "chattiness", "vengeance", "patience"]);

const CANCEL = { action: "cancel", label: "RL.UI.Cancel", type: "button", class: "rl-ui-dialog__cancel" };

/** Render a template into an attribute-less <div> (DialogV2 then inserts it as is: trusted markup). */
async function body(template, data) {
  const div = document.createElement("div");
  div.innerHTML = await foundry.applications.handlebars.renderTemplate(tpl(template), data);
  return div;
}

const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * The gallery's cards: "Random" first, then every personality with its knobs and the bots already using it.
 * @param {{current?: string|null, except?: User|null}} options
 */
function personaCards({ current = null, except = null } = {}) {
  const usedBy = new Map();
  for ( const u of botUsers() ) {
    if ( u === except ) continue;
    const id = botInfo(u)?.personality;
    if ( id ) usedBy.set(id, [...(usedBy.get(id) ?? []), u.name]);
  }
  const cards = [{
    id: "random", random: true, checked: !current,
    name: t("RL.Bots.Gallery.random"), title: t("RL.Bots.Gallery.randomTitle"), blurb: t("RL.Bots.Gallery.randomBlurb")
  }];
  for ( const p of PERSONALITIES ) {
    const names = usedBy.get(p.id) ?? [];
    cards.push({
      id: p.id, name: p.name, title: p.title, blurb: p.blurb, portrait: p.portrait,
      checked: p.id === current, current: p.id === current,
      usedBy: names.length ? t("RL.Bots.Gallery.usedBy", { names: list(names) }) : "",
      knobs: KNOBS.map(k => ({
        key: k, label: t(`RL.Bots.Knob.${k}`), pct: Math.round(clamp01(p.knobs?.[k]) * 100),
        tip: t("RL.Bots.Knob.tip", { label: t(`RL.Bots.Knob.${k}`), pct: Math.round(clamp01(p.knobs?.[k]) * 100), hint: t(`RL.Bots.Knob.${k}Hint`) })
      }))
    });
  }
  return cards;
}

/**
 * The personality gallery.
 * - `mode: "add"`: pick a personality (or Random), a level and a model for a new chat bot.
 * - `mode: "pick"`: pick a new personality for `user`.
 * @param {{mode?: "add"|"pick", user?: User}} [options]
 * @returns {Promise<{personality: string, difficulty: string, model: string|null}|null>}  personality: an id or "random"
 */
export async function choosePersonality({ mode = "add", user = null } = {}) {
  const add = mode !== "pick";
  // The model list is usually cached already; don't hold the dialog up for long if it isn't
  if ( add ) await Promise.race([loadModels().catch(() => null), new Promise(r => setTimeout(r, 2500))]);
  const info = user ? botInfo(user) : null;
  const level = info?.difficulty ?? "normal";
  const data = {
    add,
    lead: add ? t("RL.Bots.Gallery.leadAdd") : t("RL.Bots.Gallery.leadPick", { name: user?.name ?? "" }),
    cards: personaCards({ current: info?.personality ?? null, except: user }),
    levels: DIFFICULTIES.map(d => ({
      value: d, label: difficultyLabel(d), hint: t(`RL.Bots.Gallery.levelHint.${d}`), checked: d === level,
      rank: Array(RANKS[d]).fill(0)
    })),
    models: modelOptions("", { defaultLabel: t("RL.Bots.LLM.default", { model: modelName(getSetting(SETTINGS.llmModel)) }) })
  };
  const content = await body("bots/personality-gallery.hbs", data);
  const result = await DialogV2.wait({
    window: { title: add ? "RL.Bots.Gallery.titleAdd" : "RL.Bots.Gallery.titlePick", icon: "fa-solid fa-masks-theater", resizable: true },
    classes: ["risklegacy", "rl-ui-dialog", "rl-bot-app", "rl-bot-gallery-app"],
    position: { width: 820 },
    content,
    buttons: [CANCEL, {
      action: "ok", default: true, icon: add ? "fa-solid fa-user-plus" : "fa-solid fa-check",
      label: add ? "RL.Bots.Gallery.add" : "RL.Bots.Gallery.use",
      callback: (event, button) => new FormDataExtended(button.form).object
    }],
    render: (event, dialog) => {
      // Double-click a card to choose it straight away
      dialog.element.querySelectorAll(".rl-bot-pcard").forEach(card => card.addEventListener("dblclick", () => {
        dialog.element.querySelector(".form-footer button[data-action='ok']")?.click();
      }));
      dialog.element.querySelector(".rl-bot-pcard input:checked")?.closest(".rl-bot-pcard")?.scrollIntoView({ block: "nearest" });
    }
  });
  if ( !result || (typeof result !== "object") ) return null;
  const personality = String(result.personality ?? "random");
  return {
    personality: (personality === "random") || personalityById(personality) ? personality : "random",
    difficulty: DIFFICULTIES.includes(result.difficulty) ? result.difficulty : level,
    model: result.model ? String(result.model) : null
  };
}

/* -------------------------------------------- */
/*  Notes                                       */
/* -------------------------------------------- */

/** Does a memory hold anything worth showing? */
export const hasMemory = m => !!m && (!!String(m.notes ?? "").trim() || !!m.grudges?.length || !!m.lessons?.length || !!m.games?.length);

/** A short count for the Notes button: games remembered, else notes/lessons/grudges. */
export function memoryCount(m) {
  if ( !hasMemory(m) ) return 0;
  return m.games?.length || ((m.lessons?.length ?? 0) + (m.grudges?.length ?? 0) + (String(m.notes ?? "").trim() ? 1 : 0));
}

/**
 * Show what a chat bot remembers between games (BOTS-LLM.md §3 BotMemory), with Clear.
 * @param {User} user
 */
export async function openNotes(user) {
  const info = botInfo(user);
  if ( !info ) return;
  const memory = info.memory ?? null;
  const p = personalityById(info.personality);
  const games = (memory?.games ?? []).slice().sort((a, b) => (Number(b.game) || 0) - (Number(a.game) || 0));
  const data = {
    name: user.name, title: p?.title ?? "", portrait: portraitOf(user, p),
    level: difficultyLabel(info.difficulty),
    easy: info.difficulty === "easy",
    empty: !hasMemory(memory),
    updated: Number.isFinite(Number(memory?.updated)) && memory?.updated ? t("RL.Bots.Notes.updated", { game: memory.updated }) : "",
    notes: String(memory?.notes ?? "").trim(),
    grudges: (memory?.grudges ?? []).map(g => ({
      who: game.users.get(g.user)?.name ?? t("RL.Bots.Notes.formerPlayer"),
      text: g.text ?? "", game: g.game ? t("RL.Bots.Notes.game", { game: g.game }) : ""
    })),
    lessons: (memory?.lessons ?? []).map(String).filter(Boolean),
    games: games.map(g => ({
      game: g.game ?? "", faction: game.actors.get(g.faction)?.name ?? g.faction ?? "", result: g.result ?? "",
      summary: g.summary ?? ""
    })),
    raw: memory ? JSON.stringify(memory, null, 2) : ""
  };
  const content = await body("bots/notes.hbs", data);
  const result = await DialogV2.wait({
    window: { title: t("RL.Bots.Notes.title", { name: user.name }), icon: "fa-solid fa-book-open", resizable: true },
    classes: ["risklegacy", "rl-ui-dialog", "rl-bot-app", "rl-bot-notes-app"],
    position: { width: 560 },
    content,
    buttons: [
      { action: "clear", label: "RL.Bots.Notes.clear", icon: "fa-solid fa-eraser", type: "button", disabled: !memory,
        class: "rl-ui-dialog__cancel" },
      { action: "close", label: "RL.Bots.Notes.close", default: true }
    ]
  });
  if ( result !== "clear" ) return;
  const confirm = game.risklegacy.apps?.confirmAction;
  const title = t("RL.Bots.Notes.clearTitle", { name: user.name });
  const html = `<p>${esc(t("RL.Bots.Notes.clearBody", { name: user.name }))}</p>`;
  const ok = confirm
    ? await confirm({ title, content: html, destructive: true, yes: "RL.Bots.Notes.clearYes", icon: "fa-solid fa-eraser" })
    : await DialogV2.confirm({ window: { title }, content: html });
  if ( !ok ) return;
  try {
    await clearBotMemory(user);
    ui.notifications.info(t("RL.Bots.Notes.cleared", { name: user.name }));
  } catch(err) {
    ui.notifications.warn(err.message);
  }
}
