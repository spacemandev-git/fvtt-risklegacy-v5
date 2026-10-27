import { BOARD_VARIANTS, FACTIONS, STICKERS, SYSTEM_ID, systemPath } from "../config.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import * as state from "../state/_module.mjs";
import { assertGM, callArea, esc, getCatalog, logEntry, stickerId, today } from "./common.mjs";
import { buildRulebook } from "./rulebook.mjs";

/**
 * Creating a campaign: the campaign actor, the faction actors, the First Game Power stickers, the decks, the board
 * scene, the rulebook and the sticker inventory. Every step is idempotent (existing documents are reused), so a
 * failed or partial creation can simply be run again.
 */

const OBSERVER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

/**
 * Get or create a folder.
 * @param {string} type     "Actor" | "Item" | "JournalEntry"…
 * @param {string} name
 * @param {string} role     flag used to find it again
 */
export async function ensureFolder(type, name, role) {
  const existing = game.folders.find(f => (f.type === type) && (f.getFlag(SYSTEM_ID, "role") === role));
  if ( existing ) return existing;
  return Folder.implementation.create({ name, type, flags: { [SYSTEM_ID]: { role } } });
}

/**
 * Actor data for a faction from its catalog entry.
 * @param {object} entry  catalog faction {id, name, img, color, pieces}
 * @param {string} pack   pack id
 * @param {Folder} [folder]
 */
export function factionActorData(entry, pack, folder) {
  const pieces = {
    troop: systemPath(entry.pieces?.troop ?? ""),
    triple: systemPath(entry.pieces?.triple ?? ""),
    hq: systemPath(entry.pieces?.hq ?? "")
  };
  return {
    name: entry.name, type: "faction", img: systemPath(entry.img), folder: folder?.id ?? null,
    system: { key: entry.id, pack, color: entry.color ?? FACTIONS[entry.id]?.color ?? "#808285", pieces },
    prototypeToken: {
      name: entry.name, actorLink: true, texture: { src: pieces.troop },
      displayName: CONST.TOKEN_DISPLAY_MODES.NONE, displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
      lockRotation: true, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      flags: { [SYSTEM_ID]: { piece: "troop" } }
    },
    ownership: { default: OBSERVER() }
  };
}

/**
 * Item data for a power sticker from its catalog entry.
 * @param {object} entry  catalog power
 * @param {string} pack
 * @param {Folder} [folder]
 */
export function powerItemData(entry, pack, folder) {
  return {
    name: entry.name, type: "power", img: systemPath(entry.img ?? "assets/unlocks/base/powers/starter.png"),
    folder: folder?.id ?? null,
    system: {
      slot: entry.slot ?? "other", text: entry.text ?? "", faction: entry.faction ?? "", pack,
      key: entry.automation ?? entry.id, timing: entry.timing ?? ""
    },
    flags: { [SYSTEM_ID]: { catalogId: entry.id, cardImg: entry.cardImg ?? "" } },
    ownership: { default: OBSERVER() }
  };
}

/**
 * Create faction actors for catalog factions that don't exist yet.
 * @param {object[]} entries
 * @param {string} pack
 * @returns {Promise<Actor[]>} all faction actors for these entries
 */
export async function ensureFactions(entries, pack) {
  const folder = await ensureFolder("Actor", game.i18n.localize("RL.Legacy.Folder.factions"), "factions");
  const toCreate = entries.filter(e => !state.getFactionByKey(e.id)).map(e => factionActorData(e, pack, folder));
  if ( toCreate.length ) await Actor.implementation.createDocuments(toCreate);
  return entries.map(e => state.getFactionByKey(e.id)).filter(Boolean);
}

/** Initial sticker inventory: config STICKERS + the base catalog (catalog quantities win). */
export function initialStickers(baseCatalog) {
  const stickers = Object.fromEntries(Object.entries(STICKERS).map(([id, s]) => [id, s.qty]));
  for ( const s of baseCatalog?.stickers ?? [] ) stickers[stickerId(s.id)] = s.qty ?? 1;
  return stickers;
}

/**
 * [GM] Create the campaign.
 * @param {object} payload
 * @param {"original"|"advanced"} [payload.variant="original"]
 * @param {string} [payload.date]          the date the wars started (written on the box lid)
 * @param {string[]} [payload.signatures]  the names signed on the box lid
 * @returns {Promise<{campaign: string, factions: string[], powers: string[], decks: object|null,
 *   scene: string|null, rulebook: string|null, missing: string[]}>}
 */
async function createCampaignHandler({ variant = "original", date, signatures = [] } = {}, { user }) {
  assertGM(user);
  if ( !BOARD_VARIANTS[variant] ) throw new Error(game.i18n.format("RL.Wizard.New.badVariant", { variant }));
  const missing = [];
  date ||= today();
  signatures = signatures.map(s => String(s).trim()).filter(Boolean);
  const base = await getCatalog("base");
  if ( !base ) throw new Error(game.i18n.localize("RL.Wizard.New.noCatalog"));

  // 1. The campaign actor
  let campaign = state.getCampaign();
  const board = state.getBoard(variant);
  const continents = Object.fromEntries(Object.keys(board?.continents ?? {}).map(id => [id, {
    name: "", namedBy: "", namedById: "", modifier: 0, game: 0
  }]));
  const founding = { date, signatures };
  if ( !campaign ) {
    campaign = await Actor.implementation.create({
      name: game.i18n.localize("RL.Legacy.campaignName"), type: "campaign", img: systemPath("assets/icons/star.png"),
      system: {
        boardVariant: variant, founding, continents,
        stickers: initialStickers(base),
        packs: { base: { opened: true, game: 0, date } }
      },
      ownership: { default: OBSERVER() }
    });
  } else {
    const update = { "system.boardVariant": variant, "system.founding": founding };
    if ( !Object.keys(campaign.system.stickers ?? {}).length ) update["system.stickers"] = initialStickers(base);
    if ( !campaign.system.isPackOpen("base") ) update["system.packs.base"] = { opened: true, game: 0, date };
    if ( !Object.keys(campaign.system.continents ?? {}).length ) update["system.continents"] = continents;
    await campaign.update(update);
  }
  await game.settings.set(SYSTEM_ID, "campaignActorId", campaign.id);

  // 2. Faction actors
  const factions = await ensureFactions(base.factions ?? [], "base");

  // 3. The First Game Power stickers (world items, one folder)
  const powerFolder = await ensureFolder("Item", game.i18n.localize("RL.Legacy.Folder.firstGamePowers"), "firstGamePowers");
  const placed = new Set(factions.flatMap(f => f.items.filter(i => i.type === "power").map(i => i.system.key)));
  const existingPowers = new Set(game.items.filter(i => i.type === "power").map(i => i.system.key));
  const powerData = (base.powers ?? []).filter(p => !placed.has(p.automation ?? p.id) && !existingPowers.has(p.automation ?? p.id))
    .map(p => powerItemData(p, "base", powerFolder));
  // Only before the first game: once starting powers are chosen the rest are destroyed for good.
  const powers = campaign.system.firstGameReady ? [] : await Item.implementation.createDocuments(powerData);

  // 4. Decks, 5. the board scene, 6. the rulebook
  const decks = await callArea("cards", "buildDecks", { variant }, missing) ?? null;
  // Activate the board for everyone: worlds often already have an active scene (the default landing scene)
  const sceneResult = await callArea("board", "buildBoardScene", { variant, activate: true }, missing);
  const sceneId = sceneResult?.id ?? (typeof sceneResult === "string" ? sceneResult : null);
  if ( sceneId && !campaign.system.documents?.scene ) await campaign.update({ "system.documents.scene": sceneId });
  let rulebook = null;
  try {
    rulebook = (await buildRulebook())?.id ?? null;
  } catch(err) {
    console.error(`${SYSTEM_ID} | campaign: buildRulebook failed`, err);
    missing.push(`campaign.buildRulebook (${err.message})`);
  }

  // 7. The chronicle
  const names = signatures.length ? signatures.join(", ") : game.i18n.localize("RL.Legacy.Someone");
  const entries = [
    logEntry("founding", game.i18n.format("RL.Legacy.Log.founded", { date, names }), 0),
    logEntry("pack", game.i18n.format("RL.Legacy.Log.packOpened", { pack: base.label ?? "Base Game" }), 0)
  ];
  if ( !campaign.system.log.some(e => e.kind === "founding") ) {
    await campaign.update({ "system.log": [...campaign.system.toObject().log, ...entries] });
  }

  if ( missing.length ) {
    ui.notifications.warn(game.i18n.format("RL.Wizard.New.missing", { list: missing.join(", ") }));
  }
  await ChatMessage.implementation.create({
    content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
      <span class="rl-hazard rl-hazard--thin"></span>
      <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(game.i18n.localize("RL.Wizard.New.chatTitle"))}</h3>
        <span class="rl-chat-card__sub">${esc(date)}</span></div>
      <div class="rl-chat-card__body"><p>${esc(game.i18n.localize("RL.Wizard.New.lidText"))}</p>
        <p class="rl-hand">${signatures.map(esc).join(" · ")}</p></div>
    </div>`,
    flags: { [SYSTEM_ID]: { card: true } }
  });

  return {
    campaign: campaign.id, factions: factions.map(f => f.id), powers: powers.map(p => p.id),
    decks, scene: sceneId, rulebook, missing
  };
}

/** Register the GM action. */
export function registerActions() {
  registerAction("campaign.createCampaign", createCampaignHandler);
}

/** [GM] Create the campaign (see createCampaignHandler). */
export const createCampaign = payload => runAction("campaign.createCampaign", payload);
