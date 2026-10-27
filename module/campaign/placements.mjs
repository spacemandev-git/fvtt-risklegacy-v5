import { MAX_CARD_VALUE, MAX_CARD_VALUE_BEFORE_FIRST_GAME, SYSTEM_ID, TERRITORY_IDS, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { chooseOption, confirmAction, promptText } from "../apps/_module.mjs";
import { scarTargets as cardScarTargets } from "../cards/_module.mjs";
import { ask, onPromptCancel, registerPrompt } from "./ask.mjs";
import {
  CITY_STICKERS, api, callArea, cityLabel, continentName, esc, requireCampaign, stickerLabel, territoryName
} from "./common.mjs";
import * as legacy from "./legacy.mjs";
import { pickTerritory } from "./apps/prompt-base.mjs";

/**
 * Placing stickers on the world: the shared validation (which territories/continents a sticker may go on), the
 * client-side "choose" steps (pick on the board, name it, confirm) and the "apply" step (the GM legacy operation
 * that writes the campaign and takes the sticker off the sheet).
 *
 * The Sticker Sheet, the end-of-game reward prompts, the Explore the World mission and Pocket 2 (Alien Island) all go
 * through these helpers, so a sticker is validated the same way whichever window it is placed from.
 *
 *  - TARGETS.*()                 eligible ids (sync)
 *  - choosePlacement(id, ctx)    client: board pick + name/confirm → a placement object, or null
 *  - applyPlacement(p, opts)     any client: the GM action for a placement object
 *  - placeSticker(id, opts)      choose + apply (GM, Sticker Sheet)
 *  - placeSeaLine / placeAlienIsland / offerSeaLine / ruinCity / placeScarCorrection
 *  - applyReward(choice, by)     an end-of-game reward choice → the same operations
 */

const fmt = (key, data) => game.i18n.format(key, data ?? {});
const loc = key => game.i18n.localize(key);

/* -------------------------------------------- */
/*  Board facts                                 */
/* -------------------------------------------- */

const board = () => state.getCampaignBoard();
const sys = () => state.getCampaign()?.system ?? null;
const marksOf = id => sys()?.territories?.[id] ?? {};

/** Does a Fallout Zone cover this territory (no more marks of any kind)? */
export const isFallout = id => !!marksOf(id).marks?.includes("fallout_zone");

/** Territories added during the campaign (Alien Island) have no bow-tie spot for marks. */
export const isCustom = (id, b = board()) => !!b?.territories?.[id]?.custom;

/** Every territory of the campaign board (printed + custom). */
const allTerritories = (b = board()) => b?.ids ?? TERRITORY_IDS;

/** Printed territories: the ones with a city/scar spot. */
export const printedTerritories = (b = board()) => allTerritories(b).filter(id => !isCustom(id, b));

/** Is it still "before your first game" (territory cards max 3 resources)? */
export function beforeFirstGame() {
  const c = sys();
  return !!c && !c.firstGameReady && (c.gamesPlayed === 0);
}

/** The highest value a territory card may have right now (3 before the first game, then 6). */
export function maxCardValue() {
  const fn = api("cards", "maxCardValue");
  try {
    const v = fn?.();
    if ( Number.isFinite(v) ) return v;
  } catch(err) { /* fall through */ }
  return beforeFirstGame() ? MAX_CARD_VALUE_BEFORE_FIRST_GAME : MAX_CARD_VALUE;
}

/** Territories a territory scar may go on (cards.scarTargets: unscarred, not a Fallout Zone, printed). */
export function scarTargets() {
  return cardScarTargets();
}

/**
 * Eligible targets for each kind of sticker. Territory lists are ids of the campaign board.
 * Fallout Zones are "unmodifiable" and never eligible; custom territories (Alien Island) have no mark spot.
 */
export const TARGETS = {
  /** A territory without a city (a ruin may be built over). */
  city: () => printedTerritories().filter(id => !marksOf(id).city?.type && !isFallout(id)),
  /** The World Capital may replace any mark in the city slot. */
  capital: () => printedTerritories().filter(id => (marksOf(id).city?.type !== "capital") && !isFallout(id)),
  /** A territory with a city (even a fortified one: the new ring covers the old). */
  fortify: () => printedTerritories().filter(id => !!marksOf(id).city?.type && !isFallout(id)),
  /** A scarred territory. */
  cancelScar: () => printedTerritories().filter(id => !!marksOf(id).scar && !isFallout(id)),
  /** A territory a scar may go on. */
  scar: () => scarTargets(),
  /** A Minor City (Ruins). */
  ruins: () => printedTerritories().filter(id => (marksOf(id).city?.type === "minor") && !isFallout(id)),
  /** Any territory not yet a Fallout Zone. */
  fallout: () => printedTerritories().filter(id => !isFallout(id)),
  /** Territories whose borders touch an ocean (sea-line starts). */
  coastal: () => allTerritories().filter(id => !!board()?.territories?.[id]?.coastal && !isFallout(id)),
  /** Territory cards that still exist and are below `max`. */
  upgrade: (max = maxCardValue()) => allTerritories().filter(id => legacy.territoryCardExists(id)
    && (legacy.territoryCardValue(id) < max)),
  /** Territory cards that still exist. */
  destroyCard: () => allTerritories().filter(id => legacy.territoryCardExists(id)),
  /** Continents nobody has named. */
  unnamedContinents: () => Object.keys(board()?.continents ?? {}).filter(id => !sys()?.continents?.[id]?.name),
  /** Continents whose bonus hasn't been changed. */
  unmodifiedContinents: () => Object.keys(board()?.continents ?? {}).filter(id => !sys()?.continents?.[id]?.modifier)
};

/** Coastal territories a sea line from `a` may go to. */
function seaLinePartners(a, { exclude = [] } = {}) {
  const b = board();
  return TARGETS.coastal().filter(id => (id !== a) && !exclude.includes(id) && !b?.areAdjacent(a, id));
}

/** Sea lines already drawn to a territory (e.g. Alien Island). */
export function seaLinesTo(territory) {
  return (sys()?.seaLines ?? []).filter(l => (l.a === territory) || (l.b === territory));
}

/** Is the Alien Island sticker on the board? */
export const alienIslandPlaced = () => !!sys()?.customTerritories?.alien_island;

/* -------------------------------------------- */
/*  What each sticker does                      */
/* -------------------------------------------- */

/**
 * The sticker kinds the Sticker Sheet can place. `uses` = stickers taken per placement; `targets()` = eligible ids
 * (a non-empty list, or `true`/`false` for flows without a simple target list).
 */
export const STICKER_KINDS = {
  coin_pregame: { uses: 1, targets: () => TARGETS.upgrade() },
  coin_heldon: { uses: 1, targets: () => TARGETS.upgrade() },
  minor_city: { uses: 1, targets: () => TARGETS.city() },
  major_city: { uses: 1, targets: () => TARGETS.city() },
  world_capital: { uses: 1, targets: () => TARGETS.capital() },
  fortification: { uses: 1, targets: () => TARGETS.fortify() },
  cancel_scar: { uses: 1, targets: () => TARGETS.cancelScar() },
  continent_plus: { uses: 1, targets: () => TARGETS.unmodifiedContinents() },
  continent_minus: { uses: 1, targets: () => TARGETS.unmodifiedContinents() },
  // Uses per line: see legacy.SEA_LINE_STICKERS (literal here: no module-level reads across the import cycle)
  sea_line_start: { uses: 2, targets: () => TARGETS.coastal().length > 1 },
  alien_island: { uses: 1, targets: () => !alienIslandPlaced(), reason: "RL.Legacy.Sheet.why.islandPlaced" },
  alien_island_sea_line_start: {
    uses: 1,
    // Alien Island has exactly two sea lines
    targets: () => alienIslandPlaced() && (seaLinesTo("alien_island").length < 2) && (seaLinePartners("alien_island").length > 0),
    reason: () => (alienIslandPlaced() ? "RL.Legacy.Sheet.why.linesDrawn" : "RL.Legacy.Sheet.why.islandFirst")
  },
  ruins: { uses: 1, targets: () => TARGETS.ruins() },
  fallout_zone: { uses: 1, targets: () => TARGETS.fallout() }
};

/**
 * Can this sticker be placed now?
 * @param {string} id  inventory sticker id
 * @returns {{known: boolean, left: number, uses: number, stock: boolean, targets: boolean, count: number, reason: string}}
 */
export function placeability(id) {
  const kind = STICKER_KINDS[id];
  const left = sys()?.stickers?.[id] ?? 0;
  if ( !kind ) return { known: false, left, uses: 1, stock: left > 0, targets: false, count: 0, reason: "" };
  const t = kind.targets();
  const count = Array.isArray(t) ? t.length : (t ? 1 : 0);
  const stock = left >= kind.uses;
  let reason = "";
  if ( !count ) reason = loc((typeof kind.reason === "function" ? kind.reason() : kind.reason) ?? "RL.Legacy.Sheet.why.noTarget");
  else if ( !stock ) reason = loc("RL.Legacy.Sheet.why.noSticker");
  return { known: true, left, uses: kind.uses, stock, targets: count > 0, count, reason };
}

/* -------------------------------------------- */
/*  Picking                                     */
/* -------------------------------------------- */

const byName = (a, b) => a.label.localeCompare(b.label);

/**
 * Pick a territory on the board (falls back to a list when the canvas can't be used).
 * @param {object} options
 * @param {string} options.prompt      banner text
 * @param {string[]} options.allowed   clickable ids
 * @param {string} [options.faction]   colour of the highlight
 * @param {ApplicationV2} [options.app]  minimized while picking
 * @returns {Promise<string|null>}
 */
export async function pickOnBoard({ prompt, allowed, faction, app } = {}) {
  if ( !allowed?.length ) {
    ui.notifications.warn("RL.Legacy.Place.noTargets", { localize: true });
    return null;
  }
  const noCanvas = game.settings.get("core", "noCanvas");
  if ( api("board", "pickTerritory") && !noCanvas && state.getBoardScene() ) {
    return pickTerritory({ allowed, prompt, faction, app });
  }
  return chooseOption({
    title: prompt, icon: "fa-solid fa-map-location-dot",
    options: allowed.map(id => ({ value: id, label: territoryName(id) })).sort(byName)
  });
}

/** Who founded it (the GM placing a city sticker by hand): a player, or nobody. */
async function chooseFounder({ title }) {
  const war = state.getFactions({ active: true });
  const factionOf = user => war.find(f => f.system.war.playerId === user.id)?.name ?? "";
  const users = game.users.filter(u => !u.isGM).sort((a, b) => a.name.localeCompare(b.name));
  if ( !users.length ) return { founder: "", founderId: "" };
  const options = [
    ...users.map(u => ({ value: u.id, label: u.name, hint: factionOf(u) })),
    { value: "-", label: loc("RL.Legacy.Place.nobody"), hint: loc("RL.Legacy.Place.nobodyHint") }
  ];
  const id = await chooseOption({ title, icon: "fa-solid fa-user-pen", content: esc(loc("RL.Legacy.Place.founderLead")), options });
  if ( !id ) return null;
  if ( id === "-" ) return { founder: "", founderId: "" };
  const user = game.users.get(id);
  return { founder: user?.name ?? "", founderId: user?.id ?? "" };
}

/** A name written on a sticker in marker. */
function chooseName({ title, label, placeholder }) {
  return promptText({
    title, label, hand: true, required: true, maxLength: 30, placeholder, icon: "fa-solid fa-pen-nib",
    confirm: "RL.Legacy.Place.write"
  });
}

/** Choose a continent from a list (names, printed bonus). */
function chooseContinent({ title, allowed, content }) {
  const b = board();
  return chooseOption({
    title, icon: "fa-solid fa-flag", content,
    options: allowed.map(id => {
      const c = b?.continents?.[id];
      const printed = continentName(id, { printed: true });
      const name = continentName(id);
      return {
        value: id, label: name,
        hint: [name !== printed ? printed : "", fmt("RL.Legacy.Place.bonus", { n: c?.bonus ?? "?" })].filter(Boolean).join(" · ")
      };
    }).sort(byName)
  });
}

/* -------------------------------------------- */
/*  Choose (client)                             */
/* -------------------------------------------- */

/**
 * @typedef {object} PlaceContext
 * @property {ApplicationV2} [app]       window to tuck away while picking on the board
 * @property {string} [faction]          faction colour for the board highlight
 * @property {string[]} [allowed]        restrict the targets (e.g. the end-of-game reward's list)
 * @property {string|null} [founder]     founder name for cities; `undefined` = ask (GM), null/"" = nobody
 * @property {string} [founderId]
 * @property {number} [max]              card value cap for coins
 */

/** A city sticker (minor, major, World Capital). */
async function chooseCity(type, ctx = {}) {
  const sticker = CITY_STICKERS[type];
  const city = cityLabel(type);
  const allowed = ctx.allowed ?? (type === "capital" ? TARGETS.capital() : TARGETS.city());
  const territory = await pickOnBoard({ prompt: fmt("RL.Legacy.Place.pickCity", { city }), allowed, faction: ctx.faction, app: ctx.app });
  if ( !territory ) return null;
  const existing = marksOf(territory).city;
  if ( (type === "capital") && existing?.type ) {
    const ok = await confirmAction({
      title: fmt("RL.Legacy.Place.capitalReplaceTitle", { territory: territoryName(territory) }),
      content: esc(fmt("RL.Legacy.Place.capitalReplace", { city: existing.name || cityLabel(existing.type), territory: territoryName(territory) })),
      icon: "fa-solid fa-city"
    });
    if ( !ok ) return null;
  }
  const name = await chooseName({
    title: fmt("RL.Legacy.Place.nameTitle", { city, territory: territoryName(territory) }),
    label: "RL.Legacy.Place.cityName", placeholder: type === "minor" ? "BenTown" : "Jasonville"
  });
  if ( !name ) return null;
  let founder = ctx.founder;
  let founderId = ctx.founderId ?? "";
  if ( founder === undefined ) {
    const who = await chooseFounder({ title: fmt("RL.Legacy.Place.founderTitle", { name }) });
    if ( !who ) return null;
    ({ founder, founderId } = who);
  }
  return { sticker, type, territory, name, founder: founder ?? "", founderId };
}

/** A territory pick for a sticker that only needs the territory. */
async function chooseTerritory(sticker, allowed, promptKey, ctx = {}, data = {}) {
  const territory = await pickOnBoard({ prompt: fmt(promptKey, data), allowed: ctx.allowed ?? allowed, faction: ctx.faction, app: ctx.app });
  return territory ? { sticker, territory } : null;
}

/** The choose step of every sticker the Sticker Sheet places by picking a target. */
const CHOOSERS = {
  minor_city: ctx => chooseCity("minor", ctx),
  major_city: ctx => chooseCity("major", ctx),
  world_capital: ctx => chooseCity("capital", ctx),
  fortification: async ctx => {
    const choice = await chooseTerritory("fortification", TARGETS.fortify(), "RL.Legacy.Place.pickFortify", ctx);
    if ( !choice ) return null;
    const fort = marksOf(choice.territory).fortification;
    if ( fort?.active && ((fort.used ?? 0) < 10) ) {
      const ok = await confirmAction({
        title: loc("RL.Legacy.Place.refortifyTitle"),
        content: esc(fmt("RL.Legacy.Place.refortify", { territory: territoryName(choice.territory), left: 10 - (fort.used ?? 0) })),
        icon: "fa-solid fa-shield-halved"
      });
      if ( !ok ) return null;
    }
    return choice;
  },
  cancel_scar: ctx => chooseTerritory("cancel_scar", TARGETS.cancelScar(), "RL.Legacy.Place.pickCancelScar", ctx),
  continent_plus: ctx => chooseContinentMark(1, ctx),
  continent_minus: ctx => chooseContinentMark(-1, ctx),
  coin_pregame: ctx => chooseCoin("coin_pregame", ctx),
  coin_heldon: ctx => chooseCoin("coin_heldon", ctx),
  ruins: async ctx => {
    const choice = await chooseTerritory("ruins", TARGETS.ruins(), "RL.Legacy.Place.pickRuins", ctx);
    if ( !choice ) return null;
    const city = marksOf(choice.territory).city;
    const ok = await confirmAction({
      title: loc("RL.Legacy.Place.ruinsTitle"), destructive: true, yes: "RL.Legacy.Place.ruinsYes", icon: "fa-solid fa-house-crack",
      content: esc(fmt("RL.Legacy.Place.ruinsConfirm", { city: city?.name || cityLabel("minor"), territory: territoryName(choice.territory) })),
      note: loc("RL.Wizard.toughToDo")
    });
    return ok ? choice : null;
  },
  fallout_zone: async ctx => {
    const choice = await chooseTerritory("fallout_zone", TARGETS.fallout(), "RL.Legacy.Place.pickFallout", ctx);
    if ( !choice ) return null;
    const ok = await confirmAction({
      title: loc("RL.Legacy.Place.falloutTitle"), destructive: true, yes: "RL.Legacy.Place.falloutYes", icon: "fa-solid fa-radiation",
      content: esc(fmt("RL.Legacy.Place.falloutConfirm", { territory: territoryName(choice.territory) }))
    });
    return ok ? choice : null;
  }
};

async function chooseContinentMark(delta, ctx = {}) {
  const sticker = delta > 0 ? "continent_plus" : "continent_minus";
  const continent = await chooseContinent({
    title: fmt("RL.Legacy.Place.continentMarkTitle", { mark: delta > 0 ? "+1" : "−1" }),
    allowed: ctx.allowed ?? TARGETS.unmodifiedContinents(),
    content: esc(loc("RL.Legacy.Place.continentMarkLead"))
  });
  return continent ? { sticker, continent, delta } : null;
}

async function chooseCoin(sticker, ctx = {}) {
  const max = ctx.max ?? maxCardValue();
  const choice = await chooseTerritory(sticker, TARGETS.upgrade(max), "RL.Legacy.Place.pickCoin", ctx, { max });
  return choice ? { ...choice, max } : null;
}

/**
 * Choose where a sticker goes (client side: board picks and dialogs, no database writes).
 * @param {string} sticker   inventory sticker id
 * @param {PlaceContext} [ctx]
 * @returns {Promise<object|null>} a placement object for applyPlacement()
 */
export function choosePlacement(sticker, ctx = {}) {
  const fn = CHOOSERS[sticker];
  if ( !fn ) throw new Error(fmt("RL.Legacy.Error.cantPlace", { sticker: stickerLabel(sticker) }));
  return fn(ctx);
}

/* -------------------------------------------- */
/*  Apply (GM actions)                          */
/* -------------------------------------------- */

/**
 * Make the change for a placement object (runs the matching GM legacy operation, which validates again and takes
 * the sticker off the sheet).
 * @param {object} p                 from choosePlacement()
 * @param {object} [options]
 * @param {string} [options.by]      name for the chronicle
 * @param {boolean} [options.force]  GM override when the sheet has run out
 */
export function applyPlacement(p, { by = "", force = false } = {}) {
  by ||= game.user.name;
  switch ( p.sticker ) {
    case "minor_city":
    case "major_city":
    case "world_capital": {
      const type = p.type ?? { minor_city: "minor", major_city: "major", world_capital: "capital" }[p.sticker];
      return legacy.foundCity({ territory: p.territory, type, name: p.name, founder: p.founder ?? "", founderId: p.founderId ?? "", force });
    }
    case "fortification": return legacy.fortifyCity({ territory: p.territory, by, force });
    case "cancel_scar": return legacy.cancelScar({ territory: p.territory, by, force });
    case "continent_plus":
    case "continent_minus":
      return legacy.modifyContinent({ continent: p.continent, delta: p.sticker === "continent_plus" ? 1 : -1, by, force });
    case "coin_pregame":
    case "coin_heldon":
      return legacy.upgradeCard({ territory: p.territory, amount: 1, sticker: p.sticker, max: p.max ?? maxCardValue(), by, force });
    case "ruins": return legacy.ruinCity({ territory: p.territory, by, force });
    case "fallout_zone": return legacy.placeMark({ territory: p.territory, mark: "fallout_zone", by, force });
    default: throw new Error(fmt("RL.Legacy.Error.cantPlace", { sticker: stickerLabel(p.sticker) }));
  }
}

/**
 * Choose and place a sticker from the Sticker Sheet (GM).
 * @param {string} sticker
 * @param {object} [options]
 * @param {ApplicationV2} [options.app]
 * @param {boolean} [options.force]
 * @returns {Promise<object|null>}
 */
export async function placeSticker(sticker, { app = null, force = false } = {}) {
  switch ( sticker ) {
    case "sea_line_start": return placeSeaLine({ sticker, force, app });
    case "alien_island_sea_line_start": return placeSeaLine({ sticker, b: "alien_island", force, app });
    case "alien_island": return placeAlienIsland({ force, app });
    default: {
      const choice = await choosePlacement(sticker, { app });
      if ( !choice ) return null;
      return applyPlacement(choice, { force });
    }
  }
}

/* -------------------------------------------- */
/*  End-of-game rewards                         */
/* -------------------------------------------- */

/** Reward keys (WINNER_REWARDS / HELDON_REWARDS) of the stickers that place them. */
export const REWARD_STICKERS = {
  winner: {
    major_city: "foundMajorCity", cancel_scar: "cancelScar", fortification: "fortifyCity",
    continent_plus: "changeContinentBonus", continent_minus: "changeContinentBonus"
  },
  heldOn: { minor_city: "foundMinorCity", coin_heldon: "upgradeCard" }
};

/** A placement object → the reward choice the end-of-game wizard records. */
export function placementToReward(p) {
  switch ( p.sticker ) {
    case "major_city": return { reward: "foundMajorCity", territory: p.territory, name: p.name };
    case "minor_city": return { reward: "foundMinorCity", territory: p.territory, name: p.name };
    case "cancel_scar": return { reward: "cancelScar", territory: p.territory };
    case "fortification": return { reward: "fortifyCity", territory: p.territory };
    case "continent_plus":
    case "continent_minus": return { reward: "changeContinentBonus", continent: p.continent, delta: p.sticker === "continent_plus" ? 1 : -1 };
    case "coin_heldon": return { reward: "upgradeCard", territory: p.territory };
    default: return null;
  }
}

/**
 * Choose a reward with the Sticker Sheet (the player owed it, on their own client): the same choosers, limited to
 * the targets the GM's wizard offered.
 * @param {string} sticker
 * @param {object} available   the wizard's availability data (`available[reward].territories|continents`)
 * @param {PlaceContext} [ctx]
 * @returns {Promise<object|null>} a reward choice
 */
export async function chooseReward(sticker, available, ctx = {}) {
  const reward = REWARD_STICKERS.winner[sticker] ?? REWARD_STICKERS.heldOn[sticker];
  const a = available?.[reward];
  if ( !reward || !a?.ok ) return null;
  if ( (sticker === "continent_plus") && !a.plus ) return null;
  if ( (sticker === "continent_minus") && !a.minus ) return null;
  const allowed = a.territories ?? a.continents ?? [];
  const p = await choosePlacement(sticker, { ...ctx, allowed, founder: null, max: MAX_CARD_VALUE });
  return p ? placementToReward(p) : null;
}

/**
 * Apply an end-of-game reward choice (winner or held on) with the shared legacy operations.
 * @param {object} choice                {reward, territory?, continent?, name?, delta?}
 * @param {object} who
 * @param {string} who.by                the player's name as written
 * @param {string} [who.byId]            their User id (city founder, continent namer)
 */
export function applyReward(choice, { by = "", byId = "" } = {}) {
  switch ( choice.reward ) {
    case "nameContinent":
      return legacy.nameContinent({ continent: choice.continent, name: choice.name, namedBy: by, namedById: byId });
    case "foundMajorCity":
      return applyPlacement({ sticker: "major_city", territory: choice.territory, name: choice.name, founder: by, founderId: byId }, { by });
    case "foundMinorCity":
      return applyPlacement({ sticker: "minor_city", territory: choice.territory, name: choice.name, founder: by, founderId: byId }, { by });
    case "cancelScar":
      return applyPlacement({ sticker: "cancel_scar", territory: choice.territory }, { by });
    case "changeContinentBonus":
      return applyPlacement({ sticker: Number(choice.delta) > 0 ? "continent_plus" : "continent_minus", continent: choice.continent }, { by });
    case "fortifyCity":
      return applyPlacement({ sticker: "fortification", territory: choice.territory }, { by });
    case "upgradeCard":
      return applyPlacement({ sticker: "coin_heldon", territory: choice.territory, max: MAX_CARD_VALUE }, { by });
    case "destroyTerritoryCard":
      return legacy.destroyTerritoryCard({ territory: choice.territory, by });
    default:
      throw new Error(`Unknown reward ${choice.reward}`);
  }
}

/* -------------------------------------------- */
/*  Sea lines                                   */
/* -------------------------------------------- */

/** Printed panels a pen line must not cross: board furniture boxes and the continent plates. */
function obstacleBoxes(brd) {
  const isBox = b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite);
  const out = [];
  for ( const value of Object.values(brd?.furniture ?? {}) ) {
    for ( const box of (Array.isArray(value) ? value : [value]) ) if ( isBox(box) ) out.push(box);
  }
  for ( const c of Object.values(brd?.continents ?? {}) ) if ( isBox(c.plate) ) out.push(c.plate);
  return out;
}

/** Does the pen line p→q stay on water (or inside a/b) and off the printed panels? Sampled every 20 px. */
function segmentClear(brd, a, b, p, q, boxes) {
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const END = 40;
  for ( let d = END; d <= length - END; d += 20 ) {
    const x = p[0] + (((q[0] - p[0]) * d) / length);
    const y = p[1] + (((q[1] - p[1]) * d) / length);
    const t = brd.territoryAt(x, y);
    if ( t && (t !== a) && (t !== b) ) return false;
    if ( boxes.some(box => (x >= box.x) && (x <= box.x + box.width) && (y >= box.y) && (y <= box.y + box.height)) ) return false;
  }
  return true;
}

/**
 * Where to draw a pen sea line between two territories: the nearest pair of coast points whose segment crosses no
 * other land and no printed panel (victors' section, charts, continent plates…). When no pair is clean, the nearest
 * pair is used and `clean` is false (the placer is warned).
 * @param {string} a
 * @param {string} b
 * @param {object} [brd]  the campaign board
 * @returns {{points: number[][], clean: boolean}}
 */
export function seaLinePoints(a, b, brd = board()) {
  const def = id => brd?.territories?.[id];
  const coast = id => {
    const d = def(id);
    if ( d?.coastPoints?.length ) return d.coastPoints;
    const out = [];
    for ( const poly of d?.polygons ?? [] ) for ( let i = 0; i < poly.length; i += 2 ) out.push([poly[i], poly[i + 1]]);
    return out.length ? out : (d?.center ? [d.center] : []);
  };
  if ( !def(a) || !def(b) ) return { points: [], clean: false };
  const pairs = [];
  for ( const p of coast(a) ) for ( const q of coast(b) ) pairs.push([p, q, ((p[0] - q[0]) ** 2) + ((p[1] - q[1]) ** 2)]);
  pairs.sort((x, y) => x[2] - y[2]);
  const boxes = obstacleBoxes(brd);
  const round = pt => [Math.round(pt[0]), Math.round(pt[1])];
  for ( const [p, q] of pairs.slice(0, 600) ) {
    if ( segmentClear(brd, a, b, p, q, boxes) ) return { points: [round(p), round(q)], clean: true };
  }
  return { points: pairs.length ? [round(pairs[0][0]), round(pairs[0][1])] : state.seaLineEndpoints(brd, a, b), clean: false };
}

/**
 * Choose the two ends of a pen-drawn sea line (client side; also the remote prompt "seaLine").
 * @param {object} [options]
 * @param {string} [options.faction]   highlight colour
 * @param {string} [options.sticker="sea_line_start"]
 * @param {string} [options.a]         fixed first end
 * @param {string} [options.b]         fixed second end (e.g. "alien_island")
 * @param {string[]} [options.exclude] ends that may not be used (the other Alien Island line)
 * @param {ApplicationV2} [options.app]
 * @param {string} [options.forUserName]  set by ask() in hot-seat
 * @returns {Promise<{a: string, b: string}|null>}
 */
export async function chooseSeaLine({ faction = "", sticker = "sea_line_start", a = null, b = null, exclude = [], app = null, hotSeat, forUserName, signal } = {}) {
  const brd = board();
  if ( !brd ) return null;
  const who = hotSeat && forUserName ? fmt("RL.Legacy.SeaLine.for", { name: forUserName }) : "";
  const label = stickerLabel(sticker);
  if ( b && !brd.territories[b] ) {
    ui.notifications.warn(fmt("RL.Legacy.Error.unknownTerritory", { territory: b }));
    return null;
  }
  if ( !a ) {
    const allowed = TARGETS.coastal().filter(id => (id !== b) && !exclude.includes(id)
      && (b ? !brd.areAdjacent(id, b) : seaLinePartners(id, { exclude }).length > 0));
    a = await pickOnBoard({
      prompt: `${fmt(b ? "RL.Legacy.SeaLine.pickTo" : "RL.Legacy.SeaLine.pickA", { sticker: label, b: territoryName(b) })}${who}`,
      allowed, faction, app
    });
    if ( !a || signal?.aborted ) return null;
  }
  if ( !b ) {
    b = await pickOnBoard({
      prompt: `${fmt("RL.Legacy.SeaLine.pickB", { a: territoryName(a) })}${who}`,
      allowed: seaLinePartners(a, { exclude }), faction, app
    });
    if ( !b || signal?.aborted ) return null;
  }
  const line = seaLinePoints(a, b, board());
  const warning = line.clean ? "" : `<p class="rl-hand rl-hand--red">${esc(loc("RL.Legacy.SeaLine.crosses"))}</p>`;
  const ok = await confirmAction({
    title: loc("RL.Legacy.SeaLine.confirmTitle"), icon: "fa-solid fa-pen",
    content: `<p>${fmt("RL.Legacy.SeaLine.confirm", { a: `<b>${esc(territoryName(a))}</b>`, b: `<b>${esc(territoryName(b))}</b>` })}</p>${warning}`,
    note: loc("RL.Legacy.SeaLine.forever"), yes: "RL.Legacy.SeaLine.draw"
  });
  return (ok && !signal?.aborted) ? { a, b, points: line.points, clean: line.clean } : null;
}

/**
 * Write a chosen sea line (GM action) with the pen-line ends the placer saw (or the cleanest ones), stored
 * explicitly on the campaign.
 */
function applySeaLine({ a, b, points, sticker = "sea_line_start", by = "", force = false }) {
  const valid = Array.isArray(points) && (points.length === 2) && points.every(p => Array.isArray(p) && (p.length === 2));
  const ends = valid ? points : seaLinePoints(a, b).points;
  return legacy.addSeaLine({ a, b, sticker, by: by || game.user.name, points: ends, force });
}

/**
 * Draw a custom sea line (Explore the World; Alien Island; GM from the Sticker Sheet): pick a coastal territory A,
 * then a coastal B that isn't A and isn't already adjacent, confirm, and write it with `campaign.addSeaLine`.
 * The write is a GM action: players reach this through `offerSeaLine` (asked on their own client).
 * @param {object} [options]
 * @param {string} [options.faction]
 * @param {string} [options.by]
 * @param {string} [options.sticker="sea_line_start"]   sea_line_start | alien_island_sea_line_start
 * @param {string} [options.a]
 * @param {string} [options.b]
 * @param {string[]} [options.exclude]
 * @param {boolean} [options.force]   GM override when the stickers have run out
 * @param {ApplicationV2} [options.app]
 * @returns {Promise<{a: string, b: string, sticker: string, points: number[][]}|null>}
 */
export async function placeSeaLine({ faction = "", by = "", sticker = "sea_line_start", a = null, b = null, exclude = [], force = false, app = null } = {}) {
  const choice = await chooseSeaLine({ faction, sticker, a, b, exclude, app });
  if ( !choice ) return null;
  return applySeaLine({ ...choice, sticker, by, force });
}

/**
 * Ask a player on their own screen (remote prompt), or run the flow right here when it is this client's choice
 * (nobody plays that faction, the player is this user, or they aren't connected): then the open window can be tucked
 * away while picking.
 */
function askOrHere(user, kind, data, local) {
  // Bot players answer here (module/bots)
  const bot = game.risklegacy.bots?.answer?.(kind, { user, data });
  if ( bot !== undefined ) return bot;
  if ( !user || user.isSelf || !user.active ) {
    return local({ ...data, hotSeat: !!user && !user.isSelf, forUserName: user?.name ?? "", forUserId: user?.id ?? "" });
  }
  return ask(user, kind, data);
}

/** The User who plays a faction this war (or null: the GM chooses). */
export function playerOf(factionId) {
  const actor = factionId ? game.actors.get(factionId) : null;
  return game.users.get(actor?.system.war?.playerId ?? "") ?? null;
}

/** A note to the GMs in chat. */
async function gmNote(title, lines) {
  await ChatMessage.implementation.create({
    content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
      <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(title)}</h3></div>
      <div class="rl-chat-card__body"><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></div>
    </div>`,
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    flags: { [SYSTEM_ID]: { card: true } }
  });
}

/**
 * [GM orchestration] A faction earned a sea line (Explore the World): its player draws it on their own screen
 * (remote prompt; the GM chooses if they aren't connected), then the GM writes it.
 * @param {object} options
 * @param {string} options.faction
 * @param {string} [options.sticker="sea_line_start"]
 * @param {string} [options.reason]   e.g. the mission's name
 * @returns {Promise<object|null>}
 */
export async function offerSeaLine({ faction = "", sticker = "sea_line_start", reason = "" } = {}) {
  if ( !game.user.isGM ) return null;
  const campaign = requireCampaign();
  const actor = faction ? game.actors.get(faction) : null;
  const user = playerOf(faction);
  const by = actor?.system.war?.playerName || user?.name || actor?.name || "";
  const title = fmt("RL.Legacy.SeaLine.earned", { name: by || game.user.name, reason });
  const uses = legacy.SEA_LINE_STICKERS[sticker] ?? 2;
  if ( campaign.system.stickersLeft(sticker) < uses ) {
    await gmNote(title, [fmt("RL.Legacy.SeaLine.noStickers", { sticker: stickerLabel(sticker) })]);
    return null;
  }
  const choice = await ask(user, "seaLine", { faction, sticker, title });
  if ( !choice?.a || !choice?.b ) {
    await gmNote(title, [loc("RL.Legacy.SeaLine.later")]);
    return null;
  }
  return applySeaLine({ ...choice, sticker, by });
}

/* -------------------------------------------- */
/*  Alien Island                                */
/* -------------------------------------------- */

/**
 * Click a spot on an ocean for the Alien Island sticker (client side; also the remote prompt "alienIslandPoint").
 * Uses the canvas area's `board.pickPoint` validated with `board.isOpenWater`; without them, a numeric x/y dialog.
 * @returns {Promise<{x: number, y: number}|null>}
 */
export async function chooseAlienIslandPoint({ radius = legacy.ALIEN_ISLAND_RADIUS, faction = "", hotSeat, forUserName, app = null, signal } = {}) {
  const pick = api("board", "pickPoint");
  const water = api("board", "isOpenWater");
  const validate = point => {
    try {
      return water ? (water(point, radius) ?? { ok: true }) : { ok: true };
    } catch(err) {
      return { ok: true };
    }
  };
  const entry = state.findEntry("marks", "alien_island");
  const img = entry?.img ?? "assets/unlocks/thirtytroops/rules/images/alien_island.png";
  const who = hotSeat && forUserName ? fmt("RL.Legacy.SeaLine.for", { name: forUserName }) : "";
  const prompt = `${loc("RL.Legacy.AlienIsland.pick")}${who}`;
  const noCanvas = game.settings.get("core", "noCanvas");
  for ( let attempt = 0; attempt < 5; attempt++ ) {
    let point = null;
    if ( pick && !noCanvas && state.getBoardScene() ) {
      const scene = state.getBoardScene();
      if ( canvas.scene?.id !== scene.id ) await scene.view();
      if ( app?.rendered ) await app.minimize();
      try {
        point = await pick({ prompt, hint: loc("RL.Legacy.AlienIsland.pickHint"), radius, img, validate, faction: faction || undefined });
      } finally {
        if ( app?.rendered ) await app.maximize();
      }
    }
    else point = await numericPoint({ radius, prompt });
    if ( !point || signal?.aborted ) return null;
    const check = validate(point);
    if ( check?.ok === false ) {
      ui.notifications.warn(fmt("RL.Legacy.Error.notOpenWater", { reason: check.reason ?? "" }));
      continue;
    }
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }
  return null;
}

/** Fallback when the canvas can't pick a point: type the scene coordinates. */
async function numericPoint({ radius, prompt }) {
  const brd = board();
  const w = brd?.scene?.width ?? 6000;
  const h = brd?.scene?.height ?? 4000;
  const { DialogV2 } = foundry.applications.api;
  const content = `<div class="rl-dlg">
    <div class="rl-callout">${esc(prompt)}<br>${esc(fmt("RL.Legacy.AlienIsland.numericHint", { w, h, r: radius }))}</div>
    <div class="rl-field"><label>X</label><input type="number" name="x" min="0" max="${w}" step="1" value="${Math.round(w / 2)}"></div>
    <div class="rl-field"><label>Y</label><input type="number" name="y" min="0" max="${h}" step="1" value="${Math.round(h / 2)}"></div>
  </div>`;
  const result = await DialogV2.input({
    window: { title: loc("RL.Legacy.AlienIsland.title"), icon: "fa-solid fa-location-crosshairs" },
    classes: ["risklegacy", "rl-ui-dialog"], content, ok: { label: "RL.UI.Confirm" }
  });
  if ( !result ) return null;
  const x = Number(result.x);
  const y = Number(result.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Make sure the Alien Island territory card is in play (cards.addPackCards puts it in the deck when Pocket 2 opens). */
async function ensureAlienIslandCard() {
  if ( sys()?.territories?.alien_island?.cardDestroyed ) return false;
  const exists = game.cards.some(s => s.cards.some(c => (c.type === "territory") && (c.system.territory === "alien_island")));
  if ( exists ) return true;
  const missing = [];
  await callArea("cards", "addPackCards", { pack: "thirtytroops" }, missing);
  return !missing.length;
}

/**
 * [GM orchestration] Pocket 2: the Alien Collaborator places the Alien Island sticker on any ocean and connects it
 * with its two sea-line start stickers to two different coastal territories; then (The War Progresses 4), if a war is
 * running, the 30+ recruited troops plus 10 Alien troops go onto the island. Choices are made on the collaborator's
 * own screen (the GM chooses if nobody plays that faction or the player isn't connected). Each step is saved as it is
 * made, so an interrupted placement can be finished from the Sticker Sheet.
 * @param {object} [options]
 * @param {string} [options.faction]   the collaborating faction
 * @param {string} [options.by]        the name written in the chronicle
 * @param {boolean} [options.force]    GM override when the stickers have run out
 * @param {ApplicationV2} [options.app]
 * @returns {Promise<{placed: boolean, lines: object[], landing: object|null}|null>}
 */
export async function placeAlienIsland({ faction = "", by = "", force = false, app = null } = {}) {
  if ( !game.user.isGM ) {
    ui.notifications.warn("RL.Legacy.Error.gmOnly", { localize: true });
    return null;
  }
  const campaign = requireCampaign();
  const actor = faction ? game.actors.get(faction) : null;
  const user = playerOf(faction);
  const who = by || actor?.system.war?.playerName || user?.name || game.user.name;
  const result = { placed: false, lines: [], landing: null };

  // 1. The Alien Island sticker on an ocean
  if ( !campaign.system.customTerritories?.alien_island ) {
    const point = await askOrHere(user, "alienIslandPoint", {
      faction, radius: legacy.ALIEN_ISLAND_RADIUS,
      title: fmt("RL.Legacy.AlienIsland.titleFor", { name: actor?.name ?? who })
    }, data => chooseAlienIslandPoint({ ...data, app }));
    if ( !point ) return null;
    await legacy.addAlienIsland({ x: point.x, y: point.y, radius: legacy.ALIEN_ISLAND_RADIUS, by: who, force });
    result.placed = true;
  }

  // 2. Its two sea lines to two different coastal territories
  for ( let n = seaLinesTo("alien_island").length; n < 2; n++ ) {
    const used = seaLinesTo("alien_island").map(l => (l.a === "alien_island" ? l.b : l.a));
    const choice = await askOrHere(user, "seaLine", {
      faction, sticker: "alien_island_sea_line_start", b: "alien_island", exclude: used,
      title: fmt("RL.Legacy.AlienIsland.lineTitle", { n: n + 1 })
    }, data => chooseSeaLine({ ...data, app }));
    if ( !choice?.a ) {
      await gmNote(loc("RL.Legacy.AlienIsland.title"), [loc("RL.Legacy.AlienIsland.linesLater")]);
      break;
    }
    result.lines.push(await applySeaLine({ a: choice.a, b: "alien_island", points: choice.points, sticker: "alien_island_sea_line_start", by: who, force }));
  }

  // 3. The Alien Island territory card goes into the territory deck
  await ensureAlienIslandCard();

  // 4. The War Progresses (4): the collaborator's 30+ troops and 10 Alien troops land on the island
  if ( actor && legacy.warOnBoard() && actor.system.war?.active && (seaLinesTo("alien_island").length > 0) ) {
    try {
      result.landing = await legacy.alienLanding({ faction: actor.id });
    } catch(err) {
      console.error(`${SYSTEM_ID} | campaign: Alien landing`, err);
      ui.notifications.error(err.message);
    }
  }
  return result;
}

/* -------------------------------------------- */
/*  Ruins, scars                                */
/* -------------------------------------------- */

/**
 * [GM] Ruins: remove a Minor City and place the ruin mark; during a war remove all troops and demolish the HQ there.
 * (Also used by the "Die Humans" event.)
 * @param {{territory: string, by?: string, force?: boolean}} payload
 * @returns {Promise<{territory: string}>}
 */
export function ruinCity(payload) {
  return legacy.ruinCity(payload);
}

/** Board scars of the opened packs (catalog scars with target "territory"). */
export function boardScars({ opened = true } = {}) {
  const campaign = state.getCampaign();
  const seen = new Set();
  const out = [];
  for ( const pack of state.allPacks() ) {
    if ( opened && campaign && !campaign.system.isPackOpen(pack.id) ) continue;
    for ( const s of pack.scars ?? [] ) {
      if ( (s.target !== "territory") || seen.has(s.id) ) continue;
      seen.add(s.id);
      out.push({ ...s, pack: pack.id });
    }
  }
  return out;
}

/**
 * [GM] Correction: put a scar sticker on any eligible territory (no card is played).
 * @param {object} [options]
 * @param {ApplicationV2} [options.app]
 */
export async function placeScarCorrection({ app = null } = {}) {
  if ( !game.user.isGM ) return null;
  const scars = boardScars();
  if ( !scars.length ) return null;
  const scar = await chooseOption({
    title: loc("RL.Legacy.Place.scarTitle"), icon: "fa-solid fa-burst",
    content: esc(loc("RL.Legacy.Place.scarLead")),
    options: scars.map(s => ({
      value: s.id, label: s.name, img: s.stickerImg ? systemPath(s.stickerImg) : "",
      hint: String(s.text ?? "").split(/\n\s*\n/).filter(Boolean).at(-1) ?? ""
    })), columns: Math.min(4, scars.length), width: 640
  });
  if ( !scar ) return null;
  const name = scars.find(s => s.id === scar)?.name ?? scar;
  const territory = await pickOnBoard({ prompt: fmt("RL.Legacy.Place.pickScar", { scar: name }), allowed: TARGETS.scar(), app });
  if ( !territory ) return null;
  return legacy.placeScar({ territory, scar, by: game.user.name });
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** Remote prompts used by these flows (choices made on a player's own screen). Called from init(). */
export function registerPlacementPrompts() {
  registerPrompt("seaLine", data => chooseSeaLine({ ...data, signal: cancellable(data.promptId) }));
  registerPrompt("alienIslandPoint", data => chooseAlienIslandPoint({ ...data, signal: cancellable(data.promptId) }));
}

/**
 * A flag set when the GM takes over a remote placement prompt: the board pick in progress is ended (Esc) and the
 * flow stops at its next step.
 */
function cancellable(promptId) {
  const signal = { aborted: false };
  onPromptCancel(promptId, () => {
    signal.aborted = true;
    for ( const type of ["keydown", "keyup"] ) {
      window.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true }));
    }
  });
  return signal;
}
