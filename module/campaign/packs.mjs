import { PACKS, SYSTEM_ID, systemPath } from "../config.mjs";
import { registerAction, runAction } from "../gm/actions.mjs";
import * as state from "../state/_module.mjs";
import { ask, broadcast, registerPrompt } from "./ask.mjs";
import {
  api, assertGM, callArea, currentGame, esc, getCatalog, logEntry, packLabel, requireCampaign, stickerId, territoryName, today, tpl
} from "./common.mjs";
import { ensureFactions, ensureFolder, powerItemData } from "./create.mjs";
import { applyRuleAddition } from "./rulebook.mjs";
import PackPromptApp from "./apps/pack-prompt.mjs";

/**
 * Sealed packages.
 *
 * - `triggerPack(packId, {reason, faction, context})` shows the hazard-tape "OPEN WHEN …" prompt to everyone; the
 *   GM decides. During the end-of-game wizard, triggers are deferred to its last step (the rulebook says Packs 1
 *   and 3 are opened after the rewards).
 * - `openPack(packId, {faction, context})` [GM] imports the pack: factions, power stickers, cards, stickers,
 *   rulebook stickers, board reference stickers; marks it opened; reads "The War Progresses" into chat; then runs
 *   the guided steps that need a choice (comeback power, Bringer of Nuclear Fire, the Fallout Zone…).
 * - Unlock conditions are detected from the §8 hooks (and `rules.packTriggers` when the rules area provides it).
 */

/** Packs currently being prompted on this (GM) client: packId → Promise<decision>. */
const prompting = new Map();

/** Triggers deferred while the end-of-game wizard runs. */
const deferred = new Map();
let deferring = false;

/** Start/stop deferring triggers (the end-of-game wizard). */
export function setDeferring(on) {
  deferring = !!on;
}

/** @returns {{packId: string, reason: string, faction: string}[]} deferred triggers (cleared) */
export function takeDeferred() {
  const list = [...deferred.entries()].map(([packId, o]) => ({ packId, ...o }));
  deferred.clear();
  return list;
}

/** @returns {{packId: string, reason: string, faction: string}[]} deferred triggers (kept) */
export function peekDeferred() {
  return [...deferred.entries()].map(([packId, o]) => ({ packId, ...o }));
}

/** Pack data for the prompt and the landing page. */
export function packInfo(packId) {
  const pack = state.getPack(packId);
  return {
    id: packId, label: packLabel(packId), kind: pack?.kind ?? "package",
    sealed: pack?.trigger?.sealedText ?? pack?.trigger?.text ?? "",
    rulebook: pack?.trigger?.rulebook ?? "",
    when: pack?.trigger?.when ?? "",
    opened: !!state.getCampaign()?.system.isPackOpen(packId)
  };
}

/* -------------------------------------------- */
/*  Triggering                                  */
/* -------------------------------------------- */

/**
 * Show the "OPEN WHEN …" prompt (on the GM; players see it too). Resolves with the GM's decision.
 * @returns {Promise<"opened"|"later"|"already"|"deferred">}
 */
async function promptPack(packId, { reason = "", faction = "", context = {} } = {}) {
  const campaign = state.getCampaign();
  if ( !campaign || !PACKS[packId] || (packId === "base") ) return "already";
  if ( campaign.system.isPackOpen(packId) ) return "already";
  if ( deferring ) {
    if ( !deferred.has(packId) ) deferred.set(packId, { reason, faction, context });
    return "deferred";
  }
  if ( prompting.has(packId) ) return prompting.get(packId);
  const decision = (async () => {
    broadcast("showPack", { packId, reason });
    const open = await PackPromptApp.ask({ packId, reason, gm: true });
    if ( !open ) return "later";
    await openPack(packId, { faction, context });
    return "opened";
  })();
  prompting.set(packId, decision);
  try {
    return await decision;
  } finally {
    prompting.delete(packId);
  }
}

/**
 * Prompt to open a package if it isn't open yet. Any client may call this; on a player's client the request is
 * forwarded to the GM and resolves once the prompt is shown ({prompted: true}); on the GM it resolves with the
 * decision ("opened" | "later" | "already" | "deferred").
 * @param {string} packId
 * @param {object} [options]
 * @param {string} [options.reason]   why it triggered (shown on the prompt)
 * @param {string} [options.faction]  faction actor id involved (third missile, 30+ troops, eliminated…)
 * @param {object} [options.context]  extra data, e.g. {from, to} territories of the battle
 */
export async function triggerPack(packId, options = {}) {
  if ( game.user.isActiveGM ) return promptPack(packId, options);
  return runAction("campaign.triggerPack", { packId, ...options });
}

/* -------------------------------------------- */
/*  Unlock detection                            */
/* -------------------------------------------- */

const REASONS = {
  minorcities: "RL.Legacy.Trigger.minorcities",
  eliminated: "RL.Legacy.Trigger.eliminated",
  secondwin: "RL.Legacy.Trigger.secondwin",
  worldcapital: "RL.Legacy.Trigger.worldcapital",
  threemissiles: "RL.Legacy.Trigger.threemissiles",
  thirtytroops: "RL.Legacy.Trigger.thirtytroops"
};

/** Our own reading of the unlock conditions (used when the rules area has no packTriggers). */
function ownTriggers(event) {
  const campaign = state.getCampaign();
  if ( !campaign ) return [];
  switch ( event.type ) {
    case "cityFounded":
      if ( event.cityType === "capital" ) return ["worldcapital"];
      if ( (event.cityType === "minor")
        && ((campaign.system.cityCount("minor") >= 9) || (campaign.system.stickersLeft("minor_city") <= 0)) ) {
        return ["minorcities"];
      }
      return [];
    case "factionEliminated": return ["eliminated"];
    case "victorSigned": return event.count >= 2 ? ["secondwin"] : [];
    case "worldCapitalPlaced": return ["worldcapital"];
    case "missilesInRoll": return event.count >= 3 ? ["threemissiles"] : [];
    case "recruit": {
      const faction = game.actors.get(event.faction);
      return ((event.total >= 30) && ((faction?.system.war.missiles ?? 0) > 0)) ? ["thirtytroops"] : [];
    }
    default: return [];
  }
}

/** Which packs does this event unlock? */
export function packsForEvent(event) {
  let ids = null;
  const fn = api("rules", "packTriggers");
  if ( fn ) {
    try {
      const snapshot = state.buildSnapshot();
      if ( snapshot ) ids = fn(snapshot, event);
    } catch(err) {
      console.warn(`${SYSTEM_ID} | campaign: rules.packTriggers failed`, err);
    }
  }
  ids = Array.isArray(ids) ? ids : ownTriggers(event);
  const campaign = state.getCampaign();
  return ids.filter(id => PACKS[id] && !campaign?.system.isPackOpen(id));
}

function onEvent(event) {
  if ( !game.user.isActiveGM ) return;
  for ( const packId of packsForEvent(event) ) {
    triggerPack(packId, {
      reason: game.i18n.format(REASONS[packId] ?? "RL.Legacy.Trigger.generic", event.reasonData ?? {}),
      faction: event.faction ?? "", context: event.context ?? {}
    }).catch(err => console.error(`${SYSTEM_ID} | campaign: triggerPack(${packId})`, err));
  }
}

const idOf = doc => (typeof doc === "string" ? doc : doc?.id ?? "");

/** Listen to the §8 hooks. Called from init(). */
export function registerHooks() {
  Hooks.on("risklegacy.cityFounded", (territory, type) => onEvent({ type: "cityFounded", territory, cityType: type }));
  Hooks.on("risklegacy.factionEliminated", faction => {
    onEvent({ type: "factionEliminated", faction: idOf(faction) });
    offerComebackPower(idOf(faction)).catch(err => console.error(err));
  });
  Hooks.on("risklegacy.factionKnockedOut", faction => {
    offerComebackPower(idOf(faction)).catch(err => console.error(err));
  });
  Hooks.on("risklegacy.victorSigned", (number, playerId, count) => onEvent({ type: "victorSigned", playerId, count }));
  Hooks.on("risklegacy.missileFired", (message, count, faction) => {
    const battle = message?.system ?? {};
    onEvent({
      type: "missilesInRoll", count, faction: idOf(faction),
      context: { from: battle.from ?? "", to: battle.to ?? "", attacker: battle.attacker ?? "", defender: battle.defender ?? "" }
    });
  });
  Hooks.on("risklegacy.recruited", (faction, total) => onEvent({ type: "recruit", faction: idOf(faction), total }));
  Hooks.on("risklegacy.redStarTokenGained", (faction, count, source) => {
    if ( ["start", "setup"].includes(source) ) return;
    offerMissilePower(idOf(faction)).catch(err => console.error(err));
  });
}

/* -------------------------------------------- */
/*  Opening                                     */
/* -------------------------------------------- */

/** Post "The War Progresses" cards to chat, in order. */
async function postWarProgresses(pack) {
  const cards = [...(pack.warProgresses ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const render = foundry.applications.handlebars.renderTemplate;
  const messages = [];
  let index = 0;
  for ( const card of cards ) {
    index += 1;
    const content = await render(tpl("chat/war-progresses"), {
      pack: pack.label ?? pack.id, first: index === 1, index, total: cards.length,
      title: card.title, img: card.img ? systemPath(card.img) : "", code: card.code ?? "",
      paragraphs: String(card.text ?? "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    });
    messages.push({ content, flags: { [SYSTEM_ID]: { card: true, warProgresses: card.id } } });
  }
  if ( !messages.length ) {
    messages.push({
      content: await render(tpl("chat/war-progresses"), { pack: pack.label ?? pack.id, first: true, paragraphs: [] }),
      flags: { [SYSTEM_ID]: { card: true } }
    });
  }
  return ChatMessage.implementation.createDocuments(messages);
}

/**
 * [GM] Open a package.
 * @param {object} payload
 * @param {string} payload.packId
 * @param {string} [payload.faction]  the faction involved (gets faction-specific stickers)
 * @returns {Promise<object>} what was imported
 */
async function openPackHandler({ packId, faction = "" } = {}, { user }) {
  assertGM(user);
  const campaign = requireCampaign();
  if ( !PACKS[packId] ) throw new Error(game.i18n.format("RL.Legacy.Error.unknownPack", { pack: packId }));
  if ( campaign.system.isPackOpen(packId) ) return { packId, already: true };
  const pack = await getCatalog(packId);
  if ( !pack ) throw new Error(game.i18n.format("RL.Legacy.Error.noPackCatalog", { pack: packId }));
  const missing = [];
  const result = { packId, factions: [], powers: [], embedded: [], rules: [], references: [], stickers: {}, missing };

  // Factions (Mutants, Aliens)
  result.factions = (await ensureFactions(pack.factions ?? [], packId)).map(a => a.id);

  // Power stickers: printed on a pack faction's card → embedded there; the faction-scar/weakness carried by a
  // War Progresses card → the faction involved; everything else → unassigned world items in the pack's folder.
  const stickerRefs = new Map((pack.warProgresses ?? []).filter(w => w.sticker?.ref).map(w => [w.sticker.ref, w.sticker.kind]));
  const involved = faction ? game.actors.get(faction) : null;
  const powers = [...(pack.powers ?? [])];
  const secret = [...(pack.secretPowers ?? [])];
  let folder = null;
  const worldItems = [];
  for ( const p of powers ) {
    const owner = p.faction ? state.getFactionByKey(p.faction) : null;
    const viaCard = stickerRefs.has(`powers:${p.id}`) ? involved : null;
    const target = owner ?? viaCard;
    const key = p.automation ?? p.id;
    if ( target ) {
      if ( !target.items.some(i => i.system.key === key) ) {
        await target.createEmbeddedDocuments("Item", [powerItemData(p, packId)]);
        result.embedded.push({ faction: target.id, power: p.id });
      }
      continue;
    }
    if ( game.items.some(i => (i.type === "power") && (i.system.key === key)) ) continue;
    folder ??= await ensureFolder("Item", game.i18n.format("RL.Legacy.Folder.packStickers", { pack: packLabel(packId) }), `pack-${packId}`);
    worldItems.push(powerItemData(p, packId, folder));
  }
  for ( const p of secret ) {
    if ( game.items.some(i => (i.type === "power") && (i.system.key === (p.automation ?? p.id))) ) continue;
    folder ??= await ensureFolder("Item", game.i18n.format("RL.Legacy.Folder.packStickers", { pack: packLabel(packId) }), `pack-${packId}`);
    const data = powerItemData(p, packId, folder);
    data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
    data.flags[SYSTEM_ID].secret = true;
    data.flags[SYSTEM_ID].evolution = p.evolution ?? null;
    worldItems.push(data);
  }
  if ( worldItems.length ) result.powers = (await Item.implementation.createDocuments(worldItems)).map(i => i.id);

  // Cards
  await callArea("cards", "addPackCards", { pack: packId }, missing);

  // Stickers
  for ( const s of pack.stickers ?? [] ) {
    const id = stickerId(s.id);
    result.stickers[id] = (result.stickers[id] ?? 0) + (s.qty ?? 1);
  }

  // Board reference stickers and rulebook stickers
  const references = (pack.rules ?? []).filter(r => r.kind === "reference").map(r => r.id);
  result.references = references;
  const update = {
    [`system.packs.${packId}`]: { opened: true, game: currentGame(campaign), date: today() },
    "system.referenceStickers": [...new Set([...campaign.system.referenceStickers, ...references])]
  };
  for ( const [id, n] of Object.entries(result.stickers) ) update[`system.stickers.${id}`] = (campaign.system.stickers?.[id] ?? 0) + n;
  update["system.log"] = [...campaign.system.toObject().log,
    logEntry("pack", game.i18n.format("RL.Legacy.Log.packOpened", { pack: pack.label ?? packLabel(packId) }))];
  await campaign.update(update);

  for ( const rule of (pack.rules ?? []).filter(r => (r.kind === "addition") && r.addition) ) {
    try {
      await applyRuleAddition({ letter: rule.addition, ruleId: rule.id });
      result.rules.push(`${rule.addition}:${rule.id}`);
    } catch(err) {
      console.error(`${SYSTEM_ID} | campaign: rule ${rule.id}`, err);
      missing.push(`rulebook ${rule.addition} (${err.message})`);
    }
  }

  await postWarProgresses(pack);
  Hooks.callAll("risklegacy.packOpened", packId);
  return result;
}

/* -------------------------------------------- */
/*  Guided steps (choices after opening)        */
/* -------------------------------------------- */

/** The User who plays a faction (this war), if connected. */
function playerOf(factionId) {
  const actor = game.actors.get(factionId);
  return game.users.get(actor?.system.war?.playerId ?? "") ?? null;
}

/** Ask which faction (when the trigger didn't say). */
async function chooseFaction(title, content) {
  const factions = state.getFactions({ active: true });
  const list = factions.length ? factions : state.getFactions();
  return ask(null, "option", {
    title, content,
    options: list.map(f => ({ value: f.id, label: f.name, hint: f.system.war.playerName ?? "", img: "" }))
  });
}

/** Embed an unassigned world power item on a faction (the sticker moves to the card). */
async function moveItemToFaction(item, factionId) {
  const actor = game.actors.get(factionId);
  if ( !item || !actor ) return false;
  const data = item.toObject();
  delete data._id;
  delete data.folder;
  await actor.createEmbeddedDocuments("Item", [data]);
  await item.delete();
  return true;
}

/**
 * A faction with an empty slot of this colour chooses one of the pack's unassigned power stickers for it.
 * @param {string} factionId
 * @param {object} options
 * @param {string} options.slot     power slot ("knockout", "missile")
 * @param {string} options.pack     pack whose stickers are offered
 * @param {string} options.title    localization key ({faction})
 * @param {string} options.content  localization key
 * @param {boolean} [options.force=false]  offer even if the pack isn't marked open yet (while opening it)
 * @returns {Promise<string|null>} the chosen item id
 */
async function offerSlotPower(factionId, { slot, pack, title, content, force = false }) {
  if ( !game.user.isActiveGM ) return null;
  const campaign = state.getCampaign();
  if ( !force && !campaign?.system.isPackOpen(pack) ) return null;
  const actor = game.actors.get(factionId);
  // A printed limitation ("cannot take a … power") also fills the slot.
  if ( !actor || actor.items.some(i => (i.type === "power") && (i.system.slot === slot)) ) return null;
  const available = game.items.filter(i => (i.type === "power") && (i.system.slot === slot) && !i.system.faction
    && (i.system.pack === pack));
  if ( !available.length ) return null;
  const choice = await ask(playerOf(factionId), "option", {
    title: game.i18n.format(title, { faction: actor.name }),
    content: game.i18n.localize(content),
    options: available.map(i => ({ value: i.id, label: i.name, hint: i.system.text, img: i.img }))
  });
  if ( !choice ) return null;
  const item = game.items.get(choice);
  await moveItemToFaction(item, factionId);
  await runAction("campaign.addLog", {
    kind: "power", text: game.i18n.format("RL.Legacy.Log.powerAdded", { faction: actor.name, power: item?.name ?? choice })
  });
  return choice;
}

/**
 * Rule E: a faction with an empty blue slot that is knocked out or eliminated chooses a comeback power.
 * @param {string} factionId
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 */
export function offerComebackPower(factionId, { force = false } = {}) {
  return offerSlotPower(factionId, {
    slot: "knockout", pack: "eliminated", force,
    title: "RL.Legacy.Comeback.title", content: "RL.Legacy.Comeback.content"
  });
}

/**
 * Missile powers (rules addition J): a faction with an empty brown slot gains a Missile power the next time it
 * earns a Red Star token during a game (starting tokens don't count).
 * @param {string} factionId
 */
export function offerMissilePower(factionId) {
  return offerSlotPower(factionId, {
    slot: "missile", pack: "threemissiles",
    title: "RL.Legacy.MissilePower.title", content: "RL.Legacy.MissilePower.content"
  });
}

/**
 * After a pack is opened: the choices its War Progresses cards ask for.
 * @param {string} packId
 * @param {object} result   openPackHandler result
 * @param {object} options  {faction, context}
 */
async function guidedSteps(packId, result, { faction = "", context = {} } = {}) {
  const notes = [];
  const factionScar = async (powerId, titleKey) => {
    const embedded = result.embedded.find(e => e.power === powerId);
    if ( embedded ) return embedded.faction;
    const item = game.items.find(i => (i.type === "power") && (i.system.key === powerId));
    if ( !item ) return "";
    const target = faction || await chooseFaction(game.i18n.localize(titleKey), item.system.text);
    if ( target ) await moveItemToFaction(item, target);
    return target ?? "";
  };

  switch ( packId ) {
    case "eliminated":
      if ( faction ) await offerComebackPower(faction, { force: true });
      else notes.push(game.i18n.localize("RL.Legacy.Guided.comeback"));
      break;
    case "threemissiles": {
      const bringer = await factionScar("bringer_of_nuclear_fire", "RL.Legacy.Guided.whoFiredThird");
      // The third-missile player chooses the attacking or defending territory as the Fallout Zone.
      const candidates = [context.from, context.to].filter(Boolean);
      const territory = await ask(bringer ? playerOf(bringer) : null, "territory", {
        title: game.i18n.localize("RL.Legacy.Guided.falloutTitle"),
        hint: game.i18n.localize("RL.Legacy.Guided.falloutHint"),
        allowed: candidates.length ? candidates : state.getCampaignBoard()?.ids ?? [], board: true
      });
      if ( territory ) {
        await runAction("campaign.placeMark", { territory, mark: "fallout_zone" });
        notes.push(game.i18n.format("RL.Legacy.Guided.falloutPlaced", { territory: territoryName(territory) }));
      }
      notes.push(game.i18n.localize("RL.Legacy.Guided.falloutTroops"));
      break;
    }
    case "thirtytroops": {
      const collaborator = await factionScar("alien_collaborator", "RL.Legacy.Guided.whoCollaborates");
      // The Alien Collaborator places Alien Island and its two sea lines on their own screen (GM fallback), then
      // the 30+ troops and 10 Alien troops land on it if a war is running (War Progresses 2–4).
      const { placeAlienIsland } = await import("./placements.mjs");
      let island = null;
      try {
        island = await placeAlienIsland({ faction: collaborator || faction });
      } catch(err) {
        console.error(`${SYSTEM_ID} | campaign: Alien Island`, err);
        ui.notifications.error(err.message);
      }
      const placed = !!state.getCampaign()?.system.customTerritories?.alien_island;
      notes.push(game.i18n.localize(placed ? "RL.Legacy.Guided.alienIslandPlaced" : "RL.Legacy.Guided.alienIsland"));
      if ( island?.landing && !island.landing.skipped ) {
        notes.push(game.i18n.format("RL.Legacy.Guided.alienLanding", { troops: island.landing.troops }));
      }
      notes.push(game.i18n.localize("RL.Legacy.Guided.alienEvents"));
      break;
    }
    case "worldcapital":
      notes.push(game.i18n.localize("RL.Legacy.Guided.worldCapital"));
      break;
    default:
      break;
  }
  if ( result.missing.length ) notes.push(game.i18n.format("RL.Legacy.Guided.missing", { list: result.missing.join(", ") }));
  if ( notes.length ) {
    await ChatMessage.implementation.create({
      content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
        <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(packLabel(packId))}</h3>
        <span class="rl-chat-card__sub">${esc(game.i18n.localize("RL.Legacy.Guided.title"))}</span></div>
        <div class="rl-chat-card__body"><ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>
      </div>`,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      flags: { [SYSTEM_ID]: { card: true } }
    });
  }
  return notes;
}

/**
 * [GM] Open a package, then walk through its guided choices (on the GM's client).
 * @param {string} packId
 * @param {object} [options]
 * @param {string} [options.faction]
 * @param {object} [options.context]
 */
export async function openPack(packId, { faction = "", context = {} } = {}) {
  const result = await runAction("campaign.openPack", { packId, faction });
  if ( result && !result.already && game.user.isGM ) {
    try {
      result.notes = await guidedSteps(packId, result, { faction, context });
    } catch(err) {
      console.error(`${SYSTEM_ID} | campaign: guided steps for ${packId}`, err);
    }
  }
  return result;
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerActions() {
  registerAction("campaign.openPack", openPackHandler);
  registerAction("campaign.triggerPack", async ({ packId, ...options } = {}) => {
    // Don't hold the requesting client: the GM may take a while to decide.
    promptPack(packId, options).catch(err => console.error(`${SYSTEM_ID} | campaign: triggerPack`, err));
    return { prompted: true };
  });
  registerPrompt("showPack", async data => {
    PackPromptApp.ask({ ...data, gm: false });
    return true;
  });
}
