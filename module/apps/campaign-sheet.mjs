import { BOARD_VARIANTS, CITY_TYPES, FORTIFICATION_USES, LEGACY_GAMES, PACKS, STICKERS, systemPath } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { confirmAction, promptText } from "./dialogs.mjs";
import {
  api, attempt, board, CITY_ART, cityPopulation, continentLabel, esc, fortificationBoxes, humanize, markInfo,
  scarInfo, snapshot, STICKER_ART, t, territoryIds, territoryName, tpl
} from "./helpers.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

/** Which part of the sticker sheet each base sticker comes from. */
const STICKER_GROUPS = {
  coin_pregame: "beforeFirstGame",
  major_city: "gameWon", fortification: "gameWon", cancel_scar: "gameWon", continent_plus: "gameWon",
  continent_minus: "gameWon",
  coin_heldon: "heldOn", minor_city: "heldOn"
};
const GROUP_ORDER = ["beforeFirstGame", "gameWon", "heldOn", "packs"];

/** Icons for chronicle entry kinds. */
const LOG_ICONS = {
  city: "fa-solid fa-city", scar: "fa-solid fa-burst", continent: "fa-solid fa-flag", card: "fa-solid fa-scissors",
  pack: "fa-solid fa-envelope-open-text", victory: "fa-solid fa-trophy", power: "fa-solid fa-note-sticky",
  fortification: "fa-solid fa-shield-halved", world: "fa-solid fa-globe", note: "fa-solid fa-pen"
};

/**
 * "The World of ___": the campaign actor. The persistent board and everything written on it: territory marks,
 * continents, the victors' section, the sticker sheet, the sealed packages and the chronicle.
 * Everyone can read it; GMs can correct marks by hand (the campaign area's wizards do the normal writing).
 */
export default class CampaignSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-ui-sheet", "rl-campaign-sheet"],
    position: { width: 940, height: 760 },
    window: { resizable: true, icon: "fa-solid fa-earth-europe" },
    form: { submitOnChange: true },
    actions: {
      nameWorld: CampaignSheet.#onNameWorld,
      editFounding: CampaignSheet.#onEditFounding,
      addSignature: CampaignSheet.#onAddSignature,
      editTerritory: CampaignSheet.#onEditTerritory,
      editContinent: CampaignSheet.#onEditContinent,
      adjustSticker: CampaignSheet.#onAdjustSticker,
      openPack: CampaignSheet.#onOpenPack,
      addLog: CampaignSheet.#onAddLog,
      filterTerritories: CampaignSheet.#onFilterTerritories,
      sortTerritories: CampaignSheet.#onSortTerritories,
      openWarRoom: () => game.risklegacy.apps?.openWarRoom?.(),
      openStickerSheet: () => game.risklegacy.campaign?.openStickerSheet?.(),
      openReference: () => game.risklegacy.apps?.openReference?.()
    }
  };

  static PARTS = {
    header: { template: tpl("apps/campaign/header.hbs") },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    world: { template: tpl("apps/campaign/world.hbs"), scrollable: [""] },
    territories: { template: tpl("apps/campaign/territories.hbs"), scrollable: [".rl-cs-terr__scroll"] },
    continents: { template: tpl("apps/campaign/continents.hbs"), scrollable: [""] },
    stickers: { template: tpl("apps/campaign/stickers.hbs"), scrollable: [""] },
    packages: { template: tpl("apps/campaign/packages.hbs"), scrollable: [""] },
    chronicle: { template: tpl("apps/campaign/chronicle.hbs"), scrollable: [""] },
    notes: { template: tpl("apps/campaign/notes.hbs") }
  };

  static TABS = {
    primary: {
      tabs: [{ id: "world" }, { id: "territories" }, { id: "continents" }, { id: "stickers" }, { id: "packages" },
        { id: "chronicle" }, { id: "notes" }],
      initial: "world",
      labelPrefix: "RL.Sheet.Campaign.Tab"
    }
  };

  /** Territory list UI state (per window, not saved). */
  #terr = { filter: "all", sort: "continent", search: "" };

  /** @override */
  get title() {
    const name = this.document.system.worldName;
    return name ? t("RL.Sheet.Campaign.TitleNamed", { name }) : t("RL.Sheet.Campaign.Title");
  }

  get canManage() {
    return game.user.isGM && this.isEditable;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = this.document.system;
    Object.assign(context, {
      actor: this.document, system,
      systemFields: system.schema.fields,
      canManage: this.canManage,
      isGM: game.user.isGM,
      board: board(),
      boardLabel: t(BOARD_VARIANTS[system.boardVariant]?.label ?? system.boardVariant),
      gamesPlayed: system.gamesPlayed,
      nextGame: system.nextGameNumber,
      legacyGames: LEGACY_GAMES,
      legacyLeft: Math.max(0, LEGACY_GAMES - system.gamesPlayed),
      worldComplete: system.gamesPlayed >= LEGACY_GAMES
    });
    return context;
  }

  /** @inheritDoc */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( partId in (context.tabs ?? {}) ) context.tab = context.tabs[partId];
    switch ( partId ) {
      case "world": this.#prepareWorld(context); break;
      case "territories": this.#prepareTerritories(context); break;
      case "continents": this.#prepareContinents(context); break;
      case "stickers": this.#prepareStickers(context); break;
      case "packages": this.#preparePackages(context); break;
      case "chronicle": this.#prepareChronicle(context); break;
      case "notes":
        context.notesHTML = await TextEditor.enrichHTML(this.document.system.notes, {
          secrets: this.document.isOwner, relativeTo: this.document
        });
        break;
    }
    return context;
  }

  #prepareWorld(context) {
    const system = this.document.system;
    const victors = system.victors;
    const lines = Math.max(LEGACY_GAMES, victors.length);
    context.victorLines = Array.from({ length: lines }, (_, i) => {
      const g = victors[i];
      return {
        n: i + 1,
        signed: !!g,
        player: g?.winner.player ?? "",
        motto: g?.winner.motto ?? "",
        faction: g?.winner.factionName ?? "",
        game: g?.number ?? null,
        date: g?.date ?? "",
        reward: g?.reward ? t(game.risklegacy.config.winnerRewards[g.reward]?.label ?? g.reward) : ""
      };
    });
    context.signatures = system.founding.signatures;
    context.foundingDate = system.founding.date;

    // Most signatures (who names the world after game 15)
    const counts = {};
    for ( const g of victors ) counts[g.winner.player] = (counts[g.winner.player] ?? 0) + 1;
    context.leaders = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([player, count]) => ({ player, count }));

    // Quick facts
    const marks = Object.values(system.territories ?? {});
    context.facts = [
      { label: "RL.Sheet.Campaign.Fact.cities", value: marks.filter(m => m.city?.type).length },
      { label: "RL.Sheet.Campaign.Fact.scars", value: marks.filter(m => m.scar).length },
      { label: "RL.Sheet.Campaign.Fact.fortified", value: marks.filter(m => m.city?.type && m.fortification?.active
          && (m.fortification.used < FORTIFICATION_USES)).length },
      { label: "RL.Sheet.Campaign.Fact.named", value: Object.values(system.continents ?? {}).filter(c => c.name).length },
      { label: "RL.Sheet.Campaign.Fact.packs", value: Object.entries(system.packs ?? {})
          .filter(([id, p]) => p.opened && (id !== "base")).length }
    ];
  }

  #prepareTerritories(context) {
    const b = context.board;
    const marks = this.document.system.territories ?? {};
    const rows = territoryIds(b).map(id => {
      const m = marks[id] ?? {};
      const cityType = m.city?.type || "";
      const fort = m.fortification ?? {};
      const fortActive = !!(cityType && fort.active);
      const scar = m.scar ? scarInfo(m.scar) : null;
      const row = {
        id, name: territoryName(id, b),
        continent: b?.territories?.[id]?.continent ?? "",
        city: cityType ? {
          type: cityType, label: t(CITY_TYPES[cityType]?.label ?? cityType), name: m.city.name, founder: m.city.founder,
          population: cityPopulation(cityType), art: CITY_ART[cityType], game: m.city.game, capital: cityType === "capital"
        } : null,
        fort: fortActive ? {
          used: fort.used ?? 0, left: Math.max(0, FORTIFICATION_USES - (fort.used ?? 0)),
          worn: (fort.used ?? 0) >= FORTIFICATION_USES, boxes: fortificationBoxes(fort.used ?? 0)
        } : null,
        scar,
        marks: (m.marks ?? []).map(markInfo),
        cardDestroyed: !!m.cardDestroyed
      };
      row.marked = !!(row.city || row.scar || row.marks.some(m => m !== "cancel_scar"));
      row.population = row.city?.population ?? 0;
      row.tags = [row.marked ? "marked" : "", row.city ? "cities" : "", row.scar ? "scars" : "",
        row.fort && !row.fort.worn ? "fortified" : "", row.cardDestroyed ? "destroyed" : ""].filter(Boolean).join(" ");
      row.search = [row.name, row.city?.name, row.city?.founder, row.scar?.label, ...row.marks.map(x => x.label)]
        .filter(Boolean).join(" ").toLowerCase();
      return row;
    });

    // Group by continent (board order) or sort flat
    const sort = this.#terr.sort;
    let groups;
    if ( (sort === "continent") && b ) {
      groups = Object.keys(b.continents).map(cid => ({
        id: cid, label: continentLabel(cid, b),
        name: this.document.system.continents?.[cid]?.name ?? "",
        color: b.continents[cid].color ?? "",
        rows: rows.filter(r => r.continent === cid)
      })).filter(g => g.rows.length);
      const orphans = rows.filter(r => !b.continents[r.continent]);
      if ( orphans.length ) groups.push({ id: "", label: t("RL.Sheet.Campaign.OtherTerritories"), rows: orphans });
    }
    else {
      const sorted = [...rows];
      if ( sort === "population" ) sorted.sort((a, b2) => (b2.population - a.population) || a.name.localeCompare(b2.name));
      else sorted.sort((a, b2) => a.name.localeCompare(b2.name));
      groups = [{ id: "", label: "", rows: sorted }];
    }
    context.terr = {
      groups, state: this.#terr,
      counts: {
        all: rows.length,
        marked: rows.filter(r => r.marked).length,
        cities: rows.filter(r => r.city).length,
        scars: rows.filter(r => r.scar).length,
        fortified: rows.filter(r => r.fort && !r.fort.worn).length,
        destroyed: rows.filter(r => r.cardDestroyed).length
      },
      filters: ["all", "marked", "cities", "scars", "fortified", "destroyed"],
      sorts: ["continent", "name", "population"]
    };
  }

  #prepareContinents(context) {
    const b = context.board;
    const data = this.document.system.continents ?? {};
    const ids = b ? Object.keys(b.continents) : Object.keys(data);
    const snap = snapshot();
    context.continents = ids.map(id => {
      const def = b?.continents?.[id] ?? {};
      const c = data[id] ?? {};
      const bonus = def.bonus ?? 0;
      const modifier = c.modifier ?? 0;
      const owner = snap?.turn ? Object.values(snap.factions).find(f => f.continents.includes(id)) : null;
      return {
        id, label: continentLabel(id, b), color: def.color ?? "", bonus, modifier, value: bonus + modifier,
        territories: def.territories?.length ?? 0,
        name: c.name ?? "", namedBy: c.namedBy ?? "", game: c.game ?? 0,
        modArt: modifier > 0 ? STICKER_ART.continent_plus : (modifier < 0 ? STICKER_ART.continent_minus : null),
        owner: owner ? { name: owner.name, color: owner.color } : null
      };
    });
    context.noBoard = !b;
  }

  #prepareStickers(context) {
    const remaining = this.document.system.stickers ?? {};
    const tiles = [];
    for ( const [id, def] of Object.entries(STICKERS) ) {
      tiles.push({
        id, label: t(def.label), qty: def.qty, left: remaining[id] ?? 0, img: STICKER_ART[id],
        group: STICKER_GROUPS[id] ?? "packs"
      });
    }
    // Pack stickers (only once their package is open)
    const opened = id => this.document.system.isPackOpen?.(id) ?? false;
    for ( const pack of state.allPacks?.() ?? [] ) {
      if ( (pack.id === "base") || !opened(pack.id) ) continue;
      for ( const s of pack.stickers ?? [] ) {
        if ( tiles.some(x => x.id === s.id) ) continue;
        tiles.push({
          id: s.id, label: s.name ?? humanize(s.id), qty: s.qty ?? 0, left: remaining[s.id] ?? 0,
          img: s.img ? systemPath(s.img) : null, group: "packs", text: s.text ?? "",
          pack: PACKS[pack.id] ? t(PACKS[pack.id].label) : pack.label
        });
      }
    }
    // Inventory entries we don't know about (added by other areas)
    for ( const [id, left] of Object.entries(remaining) ) {
      if ( !tiles.some(x => x.id === id) ) tiles.push({ id, label: humanize(id), qty: null, left, img: null, group: "packs" });
    }
    for ( const tile of tiles ) {
      tile.empty = tile.left <= 0;
      tile.pips = (tile.qty && (tile.qty <= 12)) ? Array.from({ length: tile.qty }, (_, i) => ({ used: i >= tile.left })) : null;
    }
    context.stickerGroups = GROUP_ORDER.map(g => ({
      id: g, label: t(`RL.Sheet.Campaign.StickerGroup.${g}`), tiles: tiles.filter(x => x.group === g)
    })).filter(g => g.tiles.length);
  }

  #preparePackages(context) {
    const packs = this.document.system.packs ?? {};
    const canTrigger = !!api("campaign", "triggerPack");
    context.packs = Object.entries(PACKS).filter(([id]) => id !== "base")
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, def]) => {
        const p = packs[id] ?? {};
        const catalog = state.getPack?.(id);
        const pocket = ["threemissiles", "thirtytroops"].includes(id);
        return {
          id, label: t(def.label), order: def.order, pocket,
          number: pocket ? def.order - 4 : def.order,
          opened: !!p.opened, game: p.game, date: p.date,
          trigger: catalog?.trigger?.text || t(`RL.Sheet.Campaign.PackTrigger.${id}`),
          when: t(`RL.Sheet.Campaign.PackWhen.${id}`),
          canTrigger: canTrigger && game.user.isGM && !p.opened
        };
      });
    context.canTriggerPacks = canTrigger;
  }

  #prepareChronicle(context) {
    const log = this.document.system.log ?? [];
    const byGame = new Map();
    log.forEach((entry, index) => {
      const g = entry.game ?? 0;
      if ( !byGame.has(g) ) byGame.set(g, []);
      byGame.get(g).push({ ...entry, index, icon: LOG_ICONS[entry.kind] ?? "fa-solid fa-circle-dot" });
    });
    context.chronicle = [...byGame.entries()].sort((a, b) => a[0] - b[0]).map(([g, entries]) => ({
      game: g, label: g ? t("RL.Sheet.Campaign.GameN", { game: g }) : t("RL.Sheet.Campaign.BeforeTheWars"), entries
    }));
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._createContextMenu(this.#logContextOptions, ".rl-cs-chronicle__entry[data-index]", { fixed: true });
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const search = this.element.querySelector(".rl-cs-terr__search");
    if ( search ) {
      search.value = this.#terr.search;
      search.addEventListener("input", () => {
        this.#terr.search = search.value.trim().toLowerCase();
        this.#applyTerritoryFilter();
      });
      search.addEventListener("change", event => event.stopPropagation());
    }
    this.#applyTerritoryFilter();
  }

  /** Show/hide territory rows for the current filter and search (no re-render). */
  #applyTerritoryFilter() {
    const { filter, search } = this.#terr;
    const list = this.element?.querySelector(".rl-cs-terr");
    if ( !list ) return;
    let shown = 0;
    for ( const row of list.querySelectorAll(".rl-cs-terr__row") ) {
      const tags = row.dataset.tags.split(" ");
      const visible = ((filter === "all") || tags.includes(filter)) && (!search || row.dataset.search.includes(search));
      row.hidden = !visible;
      if ( visible ) shown++;
    }
    for ( const group of list.querySelectorAll(".rl-cs-terr__group") ) {
      group.hidden = !group.querySelector(".rl-cs-terr__row:not([hidden])");
    }
    list.querySelector(".rl-cs-terr__none")?.toggleAttribute("hidden", shown > 0);
    for ( const chip of this.element.querySelectorAll("[data-action=filterTerritories]") ) {
      chip.classList.toggle("active", chip.dataset.filter === filter);
      chip.setAttribute("aria-pressed", String(chip.dataset.filter === filter));
    }
  }

  static #onFilterTerritories(event, target) {
    this.#terr.filter = target.dataset.filter;
    this.#applyTerritoryFilter();
  }

  static #onSortTerritories(event, target) {
    this.#terr.sort = target.dataset.sort;
    this.render({ parts: ["territories"] });
  }

  /* -------------------------------------------- */
  /*  World & victors                             */
  /* -------------------------------------------- */

  static async #onNameWorld() {
    if ( !this.canManage ) return;
    const name = await promptText({
      title: "RL.Sheet.Campaign.NameWorldTitle", label: "RL.Sheet.Campaign.TheWorldOf", hand: true,
      value: this.document.system.worldName, hint: "RL.Sheet.Campaign.NameWorldHint"
    });
    if ( name === null ) return;
    const nameWorld = api("campaign", "nameWorld");
    if ( nameWorld && name ) await attempt(() => nameWorld({ name }));
    else await this.document.update({ "system.worldName": name });
  }

  static async #onEditFounding() {
    if ( !this.canManage ) return;
    const date = await promptText({
      title: "RL.Sheet.Campaign.FoundingTitle", label: "RL.Sheet.Campaign.WarsStarted", hand: true,
      value: this.document.system.founding.date
    });
    if ( date !== null ) await this.document.update({ "system.founding.date": date });
  }

  static async #onAddSignature() {
    if ( !this.canManage ) return;
    const name = await promptText({ title: "RL.Sheet.Campaign.SignTitle", label: "RL.Sheet.Campaign.Signature", hand: true, required: true });
    if ( !name ) return;
    const signatures = [...this.document.system.founding.signatures, name];
    await this.document.update({ "system.founding.signatures": signatures });
  }

  /* -------------------------------------------- */
  /*  Territories                                 */
  /* -------------------------------------------- */

  static async #onEditTerritory(event, target) {
    if ( !this.canManage ) return;
    const id = target.closest("[data-territory]")?.dataset.territory;
    if ( !id ) return;
    const m = this.document.system.toObject().territories?.[id] ?? {};
    const scars = new Set(Object.keys(game.risklegacy.config.scars));
    for ( const pack of state.allPacks?.() ?? [] ) for ( const s of pack.scars ?? [] ) if ( s.target !== "faction" ) scars.add(s.id);
    if ( m.scar ) scars.add(m.scar);
    const content = await foundry.applications.handlebars.renderTemplate(tpl("apps/campaign/territory-edit.hbs"), {
      id, name: territoryName(id), m: {
        city: { type: "", name: "", founder: "", game: 0, ...m.city },
        fortification: { active: false, used: 0, ...m.fortification },
        scar: m.scar ?? "", scarGame: m.scarGame ?? 0, cardDestroyed: !!m.cardDestroyed, marks: (m.marks ?? []).join(", ")
      },
      cityChoices: { "": "RL.Sheet.Campaign.NoCity", ...Object.fromEntries(Object.entries(CITY_TYPES).map(([k, v]) => [k, v.label])) },
      scarChoices: { "": "RL.Sheet.Campaign.NoScar", ...Object.fromEntries([...scars].map(s => [s, scarInfo(s)?.label ?? s])) },
      fortMax: FORTIFICATION_USES
    });
    const div = document.createElement("div");
    div.innerHTML = content;
    const data = await DialogV2.wait({
      window: { title: t("RL.Sheet.Campaign.EditTerritoryTitle", { name: territoryName(id) }), icon: "fa-solid fa-map-location-dot" },
      classes: ["risklegacy", "rl-ui-dialog", "rl-ui-dialog--territory"],
      position: { width: 460 },
      content: div,
      buttons: [
        { action: "cancel", label: "RL.UI.Cancel", type: "button", class: "rl-ui-dialog__cancel" },
        { action: "ok", label: "RL.UI.Save", default: true, callback: (ev, button) => new FormDataExtended(button.form).object }
      ]
    });
    if ( !data || (typeof data !== "object") ) return;
    const update = {
      city: { type: data.cityType ?? "", name: data.cityName ?? "", founder: data.cityFounder ?? "",
        founderId: m.city?.founderId ?? "", game: Number(data.cityGame) || 0 },
      fortification: { active: !!data.fortActive, used: Math.clamp(Number(data.fortUsed) || 0, 0, FORTIFICATION_USES) },
      scar: data.scar ?? "", scarGame: Number(data.scarGame) || 0,
      cardDestroyed: !!data.cardDestroyed,
      marks: String(data.marks ?? "").split(",").map(s => s.trim()).filter(Boolean)
    };
    if ( !update.city.type ) Object.assign(update.city, { name: "", founder: "", founderId: "", game: 0 });
    await this.document.update({ [`system.territories.${id}`]: update });
  }

  /* -------------------------------------------- */
  /*  Continents                                  */
  /* -------------------------------------------- */

  static async #onEditContinent(event, target) {
    if ( !this.canManage ) return;
    const id = target.closest("[data-continent]")?.dataset.continent;
    if ( !id ) return;
    const c = this.document.system.continents?.[id] ?? {};
    const content = await foundry.applications.handlebars.renderTemplate(tpl("apps/campaign/continent-edit.hbs"), {
      label: continentLabel(id), c: { name: "", namedBy: "", modifier: 0, game: 0, ...c },
      modifierChoices: { "-1": "−1", 0: "RL.Sheet.Campaign.NoModifier", 1: "+1" }
    });
    const div = document.createElement("div");
    div.innerHTML = content;
    const data = await DialogV2.wait({
      window: { title: t("RL.Sheet.Campaign.EditContinentTitle", { name: continentLabel(id) }), icon: "fa-solid fa-flag" },
      classes: ["risklegacy", "rl-ui-dialog", "rl-ui-dialog--continent"],
      position: { width: 420 },
      content: div,
      buttons: [
        { action: "cancel", label: "RL.UI.Cancel", type: "button", class: "rl-ui-dialog__cancel" },
        { action: "ok", label: "RL.UI.Save", default: true, callback: (ev, button) => new FormDataExtended(button.form).object }
      ]
    });
    if ( !data || (typeof data !== "object") ) return;
    await this.document.update({ [`system.continents.${id}`]: {
      name: data.name ?? "", namedBy: data.namedBy ?? "", namedById: c.namedById ?? "",
      modifier: Math.clamp(Number(data.modifier) || 0, -1, 1), game: Number(data.game) || 0
    } });
  }

  /* -------------------------------------------- */
  /*  Stickers & packages                         */
  /* -------------------------------------------- */

  static async #onAdjustSticker(event, target) {
    if ( !this.canManage ) return;
    const id = target.closest("[data-sticker]")?.dataset.sticker;
    const delta = Number(target.dataset.delta) || 0;
    const left = Math.max(0, (this.document.system.stickers?.[id] ?? 0) + delta);
    await this.document.update({ [`system.stickers.${id}`]: left });
  }

  static async #onOpenPack(event, target) {
    const id = target.closest("[data-pack]")?.dataset.pack;
    const trigger = api("campaign", "triggerPack");
    if ( !id || !trigger || !game.user.isGM ) return;
    await attempt(() => trigger(id, { reason: "manual" }));
  }

  /* -------------------------------------------- */
  /*  Chronicle                                   */
  /* -------------------------------------------- */

  static async #onAddLog() {
    if ( !this.canManage ) return;
    const text = await promptText({ title: "RL.Sheet.Campaign.AddLogTitle", label: "RL.Sheet.Campaign.AddLogLabel",
      required: true, maxLength: 400 });
    if ( !text ) return;
    const system = this.document.system;
    const war = state.getWar();
    const entry = { game: war?.system.game ?? system.gamesPlayed, date: new Date().toISOString().slice(0, 10), kind: "note", text };
    const addLog = api("campaign", "addLog");
    if ( addLog ) await attempt(() => addLog(entry));
    else await this.document.update({ "system.log": [...system.toObject().log, entry] });
  }

  #logContextOptions() {
    return [{
      label: "RL.Sheet.Campaign.DeleteLog", icon: "fa-solid fa-trash", visible: () => this.canManage,
      onClick: async (event, target) => {
        const index = Number(target.dataset.index);
        const log = this.document.system.toObject().log;
        const entry = log[index];
        if ( !entry ) return;
        const ok = await confirmAction({
          title: "RL.Sheet.Campaign.DeleteLogTitle", content: `<p>${esc(entry.text)}</p>`, destructive: true,
          yes: "RL.UI.Delete"
        });
        if ( !ok ) return;
        log.splice(index, 1);
        await this.document.update({ "system.log": log });
      }
    }];
  }
}
