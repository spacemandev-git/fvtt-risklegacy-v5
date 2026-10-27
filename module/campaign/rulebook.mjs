import { SYSTEM_ID, systemPath } from "../config.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import * as state from "../state/_module.mjs";
import { assertGM, logEntry, requireCampaign } from "./common.mjs";

/**
 * The rulebook: a JournalEntry "Risk Legacy Rulebook" with the original PDF and one Markdown text page per chapter
 * of `rules/*.md`. Blank rule-sticker boxes become legacy brackets (`.rl-rule-slot`); `applyRuleAddition` fills a
 * bracket with the sticker image and its transcription when its package is opened.
 *
 * Markdown is converted to HTML by the server on save (v14 core, `text.format = MARKDOWN`). The bracket blocks are
 * raw HTML `<div markdown="1">` wrappers (showdown parses Markdown inside them), delimited by
 * `<!-- rl-slot:X -->` … `<!-- /rl-slot:X -->` markers in the stored Markdown so they can be found and replaced.
 */

export const CHAPTERS = [
  "01-introduction.md",
  "02-components.md",
  "03-before-your-first-game.md",
  "04-setup-before-every-game.md",
  "05-goal-and-turn-overview.md",
  "06-turn-steps-1-2-start-join-recruit.md",
  "07-turn-step-3-expand-and-attack.md",
  "08-turn-steps-4-5-maneuver-and-end-of-turn.md",
  "09-other-types-of-cards-or-marks.md",
  "10-end-of-game.md",
  "11-opening-new-packages.md",
  "12-legal-and-credits.md"
];

/** Images the transcription references that don't exist in rules/images → a replacement asset. */
const IMAGE_FALLBACKS = {
  "p15-world-capital-mark-icon.png": "assets/unlocks/secondwin/stickersheet/images/scar_capital.png"
};

const MARKDOWN = () => CONST.JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN;

/**
 * Markdown → HTML with core's own converter (the same showdown options the Markdown page editor uses). The server
 * only converts Markdown when a page is created on its own, not for pages embedded in the journal's creation, so
 * we store both `markdown` (for editing) and `content` (what the page shows).
 */
function markdownToHTML(markdown) {
  const converter = foundry.applications.sheets.journal?.JournalEntryPageTextSheet?._converter;
  if ( converter ) return converter.makeHtml(markdown);
  const fallback = new showdown.Converter();
  for ( const [k, v] of Object.entries(CONST.SHOWDOWN_OPTIONS) ) fallback.setOption(k, v);
  return fallback.makeHtml(markdown);
}

/** Page text data for a Markdown chapter. */
const textData = markdown => ({ format: MARKDOWN(), markdown, content: markdownToHTML(markdown) });

/* -------------------------------------------- */
/*  Markdown preprocessing                      */
/* -------------------------------------------- */

/** Rewrite relative image links to system URLs. */
function rewriteImages(md) {
  return md.replace(/\]\(images\/([^)\s]+)\)/g, (match, file) => {
    const fallback = IMAGE_FALLBACKS[file];
    return `](${fallback ? systemPath(fallback) : systemPath(`rules/images/${file}`)})`;
  });
}

/** The empty bracket block for a letter, with the printed default text (if any) inside. */
export function emptySlotBlock(letter, inner) {
  const label = game.i18n.format("RL.Rulebook.slotLabel", { letter });
  return [
    `<!-- rl-slot:${letter} -->`,
    `<div class="risklegacy rl-rulebook-slot" data-addition="${letter}" markdown="1">`,
    "",
    `<div class="rl-slot rl-rule-slot" markdown="1">`,
    "",
    `<span class="rl-rule-slot__label">${label}</span>`,
    "",
    inner.trim(),
    "",
    "</div>",
    "",
    "</div>",
    `<!-- /rl-slot:${letter} -->`
  ].join("\n");
}

/** The filled bracket block: the sticker image and its transcription (and the printed text it replaces). */
export function filledSlotBlock(letter, rule) {
  const label = game.i18n.format("RL.Rulebook.slotLabel", { letter });
  const paragraphs = text => String(text ?? "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const lines = [
    `<!-- rl-slot:${letter} -->`,
    `<div class="risklegacy rl-rulebook-slot" data-addition="${letter}" data-rule="${rule.id}" markdown="1">`,
    "",
    `<div class="rl-slot rl-rule-slot is-filled" markdown="1">`,
    "",
    `<span class="rl-rule-slot__label">${label}</span>`,
    ""
  ];
  if ( rule.img ) {
    lines.push(`<div class="rl-rule-sticker" markdown="1">`, "", `![${rule.title ?? label}](${systemPath(rule.img)})`, "", "</div>", "");
  }
  lines.push(`<div class="rl-rule-text" markdown="1">`, "");
  if ( rule.title ) lines.push(`**${rule.title}**`, "");
  for ( const p of paragraphs(rule.text) ) lines.push(p, "");
  lines.push("</div>", "");
  if ( rule.replaces ) {
    lines.push(`<div class="rl-rule-replaced" markdown="1">`, "", `*${game.i18n.localize("RL.Rulebook.replaced")}*`, "");
    for ( const p of paragraphs(rule.replaces) ) lines.push(`~~${p}~~`, "");
    lines.push("</div>", "");
  }
  lines.push("</div>", "", "</div>", `<!-- /rl-slot:${letter} -->`);
  return lines.join("\n");
}

/**
 * Turn the transcription's placeholder blockquotes (`> **[Rule sticker space …]**`) into bracket blocks.
 * @param {string} md
 * @returns {{markdown: string, letters: string[]}}
 */
export function convertPlaceholders(md) {
  const lines = md.split("\n");
  const out = [];
  const letters = [];
  for ( let i = 0; i < lines.length; i++ ) {
    const line = lines[i];
    if ( !/^>\s*\*\*\[Rule sticker space/.test(line) ) {
      out.push(line);
      continue;
    }
    const block = [];
    while ( (i < lines.length) && lines[i].startsWith(">") ) {
      block.push(lines[i].replace(/^>\s?/, ""));
      i++;
    }
    i--;
    const whole = block.join("\n");
    const letter = whole.match(/Rules addition ([A-N])\b/)?.[1];
    if ( !letter ) {
      out.push(...block.map(l => `> ${l}`));
      continue;
    }
    letters.push(letter);
    // Drop the editorial first line and the grey "will go here" line; keep the printed default rules.
    const inner = block.slice(1)
      .filter(l => !/^\*Rules addition [A-N] will go here.*\*$/.test(l.trim()))
      .join("\n").trim();
    const placeholder = game.i18n.format("RL.Rulebook.willGoHere", { letter });
    out.push(emptySlotBlock(letter, `${inner}${inner ? "\n\n" : ""}<span class="rl-rule-slot__hint">${placeholder}</span>`));
  }
  return { markdown: out.join("\n"), letters };
}

/**
 * Fetch and convert one chapter.
 * @param {string} file
 * @returns {Promise<{name: string, markdown: string, letters: string[]}>}
 */
async function loadChapter(file) {
  const response = await fetch(systemPath(`rules/${file}`));
  if ( !response.ok ) throw new Error(`Could not load rules/${file} (${response.status})`);
  let md = await response.text();
  const titleMatch = md.match(/^#\s+(.+)\s*$/m);
  const name = titleMatch?.[1]?.trim() ?? file;
  if ( titleMatch ) md = md.replace(titleMatch[0], "").trimStart();
  md = rewriteImages(md);
  const { markdown, letters } = convertPlaceholders(md);
  return { name, markdown, letters };
}

/* -------------------------------------------- */
/*  Build                                       */
/* -------------------------------------------- */

/**
 * Create (or rebuild) the rulebook journal.
 * @param {object} [payload]
 * @param {boolean} [payload.rebuild=false]  delete and recreate an existing rulebook
 * @returns {Promise<{id: string}>}
 */
async function buildRulebookHandler({ rebuild = false } = {}, { user }) {
  assertGM(user);
  const campaign = state.getCampaign();
  const existing = state.getCampaignDocument("rulebook")
    ?? game.journal.find(j => j.getFlag(SYSTEM_ID, "role") === "rulebook");
  if ( existing && !rebuild ) {
    if ( campaign && (campaign.system.documents?.rulebook !== existing.id) ) {
      await campaign.update({ "system.documents.rulebook": existing.id });
    }
    return { id: existing.id };
  }
  if ( existing ) await existing.delete();

  const pages = [{
    name: game.i18n.localize("RL.Rulebook.pdfPage"), type: "pdf", src: systemPath("assets/rules.pdf"),
    title: { show: true, level: 1 }, sort: 0
  }];
  let sort = 100000;
  for ( const file of CHAPTERS ) {
    try {
      const chapter = await loadChapter(file);
      pages.push({
        name: chapter.name, type: "text", sort: sort += 100000,
        title: { show: true, level: 1 },
        text: textData(chapter.markdown),
        flags: { [SYSTEM_ID]: { chapter: file, additions: chapter.letters } }
      });
    } catch(err) {
      console.error(`${SYSTEM_ID} | campaign: rulebook chapter ${file}`, err);
    }
  }
  const journal = await JournalEntry.implementation.create({
    name: game.i18n.localize("RL.Rulebook.name"),
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    flags: { [SYSTEM_ID]: { role: "rulebook" } },
    pages
  });
  if ( campaign ) {
    await campaign.update({ "system.documents.rulebook": journal.id });
    // Re-apply stickers already placed (rebuilds).
    for ( const [letter, ruleId] of Object.entries(campaign.system.rulesAdditions ?? {}) ) {
      if ( ruleId ) await fillSlot(journal, letter, ruleId);
    }
  }
  return { id: journal.id };
}

/** Find the rulebook page holding a bracket letter. */
function pageForLetter(journal, letter) {
  const marker = `<!-- rl-slot:${letter} -->`;
  return journal.pages.find(p => (p.type === "text") && p.text?.markdown?.includes(marker)) ?? null;
}

/** Replace the bracket block for a letter in the page markdown. */
async function fillSlot(journal, letter, ruleId) {
  const rule = state.findEntry("rules", ruleId);
  if ( !rule ) throw new Error(game.i18n.format("RL.Rulebook.unknownRule", { rule: ruleId }));
  const page = pageForLetter(journal, letter);
  if ( !page ) return false;
  const start = `<!-- rl-slot:${letter} -->`;
  const end = `<!-- /rl-slot:${letter} -->`;
  const md = page.text.markdown;
  const a = md.indexOf(start);
  const b = md.indexOf(end, a);
  if ( (a < 0) || (b < 0) ) return false;
  const updated = md.slice(0, a) + filledSlotBlock(letter, rule) + md.slice(b + end.length);
  await page.update({ text: textData(updated) });
  return true;
}

/**
 * Put a rule sticker into the rulebook bracket for its letter and record it on the campaign.
 * @param {object} payload
 * @param {string} payload.letter  A–N
 * @param {string} payload.ruleId  content catalog rule id
 */
async function applyRuleAdditionHandler({ letter, ruleId } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  letter = String(letter ?? "").toUpperCase();
  if ( !/^[A-N]$/.test(letter) ) throw new Error(game.i18n.format("RL.Rulebook.badLetter", { letter }));
  const rule = state.findEntry("rules", ruleId);
  if ( !rule ) throw new Error(game.i18n.format("RL.Rulebook.unknownRule", { rule: ruleId }));
  const journal = state.getCampaignDocument("rulebook");
  let filled = false;
  if ( journal ) filled = await fillSlot(journal, letter, ruleId);
  const text = game.i18n.format("RL.Legacy.Log.ruleAdded", { letter, title: rule.title ?? ruleId });
  await campaign.update({
    [`system.rulesAdditions.${letter}`]: ruleId,
    "system.log": [...campaign.system.toObject().log, logEntry("rules", text)]
  });
  return { letter, ruleId, filled };
}

/** Register the GM actions. */
export function registerActions() {
  registerAction("campaign.buildRulebook", buildRulebookHandler);
  registerAction("campaign.applyRuleAddition", applyRuleAdditionHandler);
}

/** [GM] Create the rulebook journal (idempotent unless `{rebuild: true}`). */
export const buildRulebook = (payload = {}) => runAction("campaign.buildRulebook", payload);

/** [GM] Fill a rulebook bracket with a rule sticker. */
export const applyRuleAddition = payload => runAction("campaign.applyRuleAddition", payload);

/** Open the rulebook journal (any client). */
export function openRulebook({ letter } = {}) {
  const journal = state.getCampaignDocument("rulebook")
    ?? game.journal.find(j => j.getFlag(SYSTEM_ID, "role") === "rulebook");
  if ( !journal ) {
    ui.notifications.warn("RL.Rulebook.missing", { localize: true });
    return null;
  }
  const page = letter ? pageForLetter(journal, letter) : null;
  return journal.sheet.render({ force: true, pageId: page?.id });
}
