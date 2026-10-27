import { FACTION_STATUS, FACTIONS, GAME_RESULTS, LEGACY_GAMES, RED_STARS_TO_WIN, SYSTEM_ID } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { confirmAction } from "./dialogs.mjs";
import {
  affectsWar, api, applyFactionVars, attempt, continentLabel, esc, factionArt, factionColor, factionHQ, playerName, powerIcon,
  redStarSlots, slotLabel, SLOT_ORDER, snapshot, t, territoryIdFromText, territoryIds, territoryName, tpl, WAR_HOOKS,
  watchHooks
} from "./helpers.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

/** Result columns on the back of the card, in printed order. */
const RESULT_COLUMNS = ["won", "heldOn", "eliminated"];

/**
 * The Faction card (Actor type "faction"): the card front with its six sticker slots, this war's numbers, the back
 * of the card (game history) and notes.
 *
 * Permissions: the GM edits everything. The faction's owner edits notes, and during first-game setup
 * (`campaign.system.firstGameReady === false`) may place power stickers. Everyone else sees a read-only sheet.
 */
export default class FactionSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-ui-sheet", "rl-faction-sheet"],
    position: { width: 720, height: 720 },
    window: { resizable: true, icon: "fa-solid fa-flag" },
    form: { submitOnChange: true },
    actions: {
      openPower: FactionSheet.#onOpenPower,
      removePower: FactionSheet.#onRemovePower,
      togglePowerUsed: FactionSheet.#onTogglePowerUsed,
      toggleResult: FactionSheet.#onToggleResult,
      openWarRoom: () => game.risklegacy.apps?.openWarRoom?.()
    }
  };

  static PARTS = {
    header: { template: tpl("apps/faction/header.hbs") },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    card: { template: tpl("apps/faction/card.hbs"), scrollable: [""] },
    war: { template: tpl("apps/faction/war.hbs"), scrollable: [""] },
    history: { template: tpl("apps/faction/history.hbs"), scrollable: [""] },
    notes: { template: tpl("apps/faction/notes.hbs") }
  };

  static TABS = {
    primary: {
      tabs: [{ id: "card" }, { id: "war" }, { id: "history" }, { id: "notes" }],
      initial: "card",
      labelPrefix: "RL.Sheet.Faction.Tab"
    }
  };

  /** Disposer for the board/hand/war hooks that refresh the live parts. */
  #unwatch = null;

  /* -------------------------------------------- */

  /** @inheritDoc */
  _initializeApplicationOptions(options) {
    options = super._initializeApplicationOptions(options);
    const key = options.document?.system?.key;
    if ( key ) options.classes.push(`rl-faction--${key}`);
    return options;
  }

  /** @override */
  get title() {
    return this.document.name;
  }

  /* -------------------------------------------- */
  /*  Permissions                                 */
  /* -------------------------------------------- */

  /** GM-only fields (war numbers, history). */
  get canManage() {
    return game.user.isGM && this.isEditable;
  }

  /** May the current user place or remove power stickers? */
  get canPlaceStickers() {
    if ( !this.isEditable ) return false;
    if ( game.user.isGM ) return true;
    const campaign = state.getCampaign();
    return this.document.isOwner && !!campaign && !campaign.system.firstGameReady;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.document;
    const system = actor.system;
    const snap = snapshot();
    const live = snap?.factions?.[actor.id] ?? null;
    const war = state.getWar();
    const tokens = system.war.redStarTokens;
    const hqs = live?.redStars?.hqs ?? 0;
    Object.assign(context, {
      actor, system,
      systemFields: system.schema.fields,
      canManage: this.canManage,
      canPlaceStickers: this.canPlaceStickers,
      isGM: game.user.isGM,
      color: factionColor(actor),
      art: factionArt(actor),
      hq: factionHQ(actor),
      player: playerName(actor),
      inWar: !!war && system.war.active,
      live, snap,
      redStars: {
        tokens, hqs, total: tokens + hqs, goal: RED_STARS_TO_WIN,
        slots: redStarSlots(tokens, hqs)
      },
      record: system.record
    });
    return context;
  }

  /** @inheritDoc */
  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    if ( partId in (context.tabs ?? {}) ) context.tab = context.tabs[partId];
    switch ( partId ) {
      case "header": this.#prepareHeader(context); break;
      case "card": context.slots = this.#prepareSlots(); break;
      case "war": await this.#prepareWar(context); break;
      case "history": this.#prepareHistory(context); break;
      case "notes":
        context.notesHTML = await TextEditor.enrichHTML(this.document.system.notes, {
          secrets: this.document.isOwner, relativeTo: this.document
        });
        break;
    }
    return context;
  }

  #prepareHeader(context) {
    const w = this.document.system.war;
    const war = state.getWar();
    context.status = context.inWar ? w.status : "";
    context.statusLabel = context.status && (context.status !== "playing") ? t(`RL.Status.${context.status}`) : "";
    context.gameNumber = war?.system?.game ?? (state.getCampaign()?.system.nextGameNumber ?? 1);
    context.subtitle = [
      context.inWar && context.player ? t("RL.Sheet.Faction.PlayedBy", { player: context.player }) : null,
      context.inWar ? t("RL.Sheet.Faction.InGame", { game: context.gameNumber }) : t("RL.Sheet.Faction.NotInWar"),
      t("RL.Sheet.Faction.Record", context.record)
    ].filter(Boolean);
  }

  /** The six slots in rulebook order with the sticker placed in each. */
  #prepareSlots() {
    const items = this.document.items.filter(i => i.type === "power");
    const extra = items.filter(i => !SLOT_ORDER.includes(i.system.slot));
    return SLOT_ORDER.map(slot => {
      const item = items.find(i => i.system.slot === slot);
      return {
        slot,
        label: slotLabel(slot),
        empty: t(`RL.Sheet.Faction.EmptySlot.${slot}`),
        item: item ? this.#powerView(item) : null
      };
    }).concat(extra.length ? [{ slot: "other", label: slotLabel("other"), extra: extra.map(i => this.#powerView(i)) }] : []);
  }

  #powerView(item) {
    return {
      id: item.id, name: item.name, text: item.system.text || item.name, used: item.system.used,
      icon: powerIcon(item), slot: item.system.slot, key: item.system.key,
      isScar: item.system.slot === "scar"
    };
  }

  async #prepareWar(context) {
    const actor = this.document;
    const w = actor.system.war;
    const live = context.live;
    const snap = context.snap;
    context.war = w;
    context.statusChoices = FACTION_STATUS;
    context.missiles = Array.from({ length: w.missiles }, (_, i) => i);
    context.startingTerritory = territoryName(w.startingTerritory);
    context.stats = live ? [
      { key: "troops", label: "RL.Sheet.Stat.troops", value: live.troops },
      { key: "territories", label: "RL.Sheet.Stat.territories", value: live.territories.length },
      { key: "population", label: "RL.Sheet.Stat.population", value: live.population },
      { key: "reserve", label: "RL.Sheet.Stat.reserve", value: w.reserve }
    ] : null;
    context.continents = (live?.continents ?? []).map(id => {
      const c = snap?.continents?.[id];
      return { id, label: c?.name || continentLabel(id), value: c?.value ?? 0, named: !!c?.name };
    });
    context.hqTerritories = (live?.hqs ?? []).map(id => ({
      id, name: territoryName(id), own: snap?.territories?.[id]?.hq === actor.id
    }));

    // Recruit preview (rules area, when available)
    context.recruit = null;
    const breakdown = api("rules", "recruitBreakdown");
    if ( breakdown && snap && live?.territories.length ) {
      try {
        const r = breakdown(snap, actor.id);
        if ( r ) context.recruit = {
          ...r,
          continents: (r.continents ?? []).map(c => ({
            ...c, label: snap.continents?.[c.id]?.name || continentLabel(c.id)
          }))
        };
      } catch(err) {
        console.warn(`${SYSTEM_ID} | recruitBreakdown failed`, err);
      }
    }

    // Hand of cards
    context.hand = await this.#prepareHand(live);
  }

  async #prepareHand(live) {
    const actor = this.document;
    const hand = state.getHand(actor);
    const count = live?.hand?.count ?? hand?.cards.size ?? 0;
    const visible = !!hand && (game.user.isGM || hand.testUserPermission(game.user, "OBSERVER") || actor.isOwner);
    // Preferred: the cards area's live <rl-hand> element (handles face-down backs and refreshes itself)
    if ( customElements.get("rl-hand") ) {
      return { live: true, interactive: state.canActFor(game.user, actor), exists: !!hand, visible, count, cards: [] };
    }
    let html = null;
    const render = api("cards", "renderHand");
    if ( render && visible ) {
      try {
        const out = await render(actor);
        html = out instanceof HTMLElement ? out.outerHTML : (typeof out === "string" ? out : null);
      } catch(err) {
        console.warn(`${SYSTEM_ID} | cards.renderHand failed`, err);
      }
    }
    const cards = (!html && visible && hand) ? hand.cards.contents.map(c => ({
      id: c.id, name: c.name, img: c.img, type: c.type,
      coins: c.system?.coins ?? c.system?.value ?? (c.type === "coin" ? 1 : null)
    })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    // Coin totals are hidden information: only for those who may see the hand
    return { exists: !!hand, visible, count, coins: visible ? (live?.hand?.coins ?? null) : null, html, cards };
  }

  #prepareHistory(context) {
    const history = this.document.system.history;
    const rows = Math.max(LEGACY_GAMES, ...history.map(h => h.game), (state.getCampaign()?.system.gamesPlayed ?? 0));
    context.territoryNames = territoryIds().map(id => territoryName(id));
    context.historyRows = Array.from({ length: rows }, (_, i) => {
      const game = i + 1;
      const entry = history.find(h => h.game === game);
      return {
        game,
        exists: !!entry,
        player: entry?.player ?? "",
        absent: entry?.result === "absent",
        startingTerritory: entry?.startingTerritory ? territoryName(entry.startingTerritory) : "",
        results: RESULT_COLUMNS.map(r => ({ key: r, checked: entry?.result === r, label: t(`RL.Sheet.Faction.ResultShort.${r}`) }))
      };
    });
    context.resultColumns = RESULT_COLUMNS.map(r => ({ key: r, short: t(`RL.Sheet.Faction.ResultShort.${r}`), label: t(GAME_RESULTS[r]) }));
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Keep the live <rl-hand> element across re-renders of the This War part (token moves re-render it often), so
   * the hand doesn't blink empty while it re-renders itself.
   * @inheritDoc
   */
  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    if ( partId !== "war" ) return;
    const prior = priorElement.querySelector("rl-hand");
    const fresh = newElement.querySelector("rl-hand");
    if ( prior && fresh && (prior.getAttribute("faction") === fresh.getAttribute("faction"))
      && (prior.hasAttribute("readonly") === fresh.hasAttribute("readonly")) ) fresh.replaceWith(prior);
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const actorId = this.document.id;
    this.#unwatch = watchHooks(WAR_HOOKS, () => {
      if ( this.rendered ) this.render({ parts: ["header", "war"] });
    }, {
      wait: 150,
      // Our own actor re-renders through DocumentSheetV2; other factions don't change our numbers.
      filter: doc => affectsWar(doc) && !((doc?.documentName === "Actor") && ((doc.id === actorId) || (doc.type !== "campaign")))
    });
    this._createContextMenu(this.#historyContextOptions, ".rl-fs-history__row", { fixed: true });
    this._createContextMenu(this.#stickerContextOptions, ".rl-fs-slot .rl-sticker[data-item-id]", { fixed: true });
  }

  /** @inheritDoc */
  _onClose(options) {
    this.#unwatch?.();
    this.#unwatch = null;
    super._onClose(options);
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    applyFactionVars(this.element, context.color);

    // Sticker "buttons" work from the keyboard too
    for ( const el of this.element.querySelectorAll("[role=button][data-action]") ) {
      el.addEventListener("keydown", event => {
        if ( (event.key !== "Enter") && (event.key !== " ") ) return;
        event.preventDefault();
        el.click();
      });
    }

    // Highlight the slot under a dragged sticker
    for ( const slot of this.element.querySelectorAll(".rl-fs-slot[data-slot]") ) {
      slot.addEventListener("dragenter", () => slot.classList.add("is-drop-target"));
      slot.addEventListener("dragleave", ev => {
        if ( !slot.contains(ev.relatedTarget) ) slot.classList.remove("is-drop-target");
      });
      slot.addEventListener("drop", () => slot.classList.remove("is-drop-target"));
    }

    // History inputs edit the history array (no name="": they'd submit as actor data)
    for ( const input of this.element.querySelectorAll("[data-history-field]") ) {
      input.addEventListener("change", event => {
        event.stopPropagation();
        const row = Number(input.closest("[data-game]").dataset.game);
        let value = input.value.trim();
        if ( input.dataset.historyField === "startingTerritory" ) value = territoryIdFromText(value);
        this.#updateHistory(row, { [input.dataset.historyField]: value });
      });
    }
  }

  /* -------------------------------------------- */
  /*  History                                     */
  /* -------------------------------------------- */

  /**
   * Update (or create) the history entry for a game.
   * @param {number} game
   * @param {object|null} changes  null deletes the row
   */
  async #updateHistory(game, changes) {
    if ( !this.canManage ) return;
    const history = this.document.system.toObject().history;
    const index = history.findIndex(h => h.game === game);
    if ( changes === null ) {
      if ( index >= 0 ) history.splice(index, 1);
    }
    else if ( index >= 0 ) Object.assign(history[index], changes);
    else history.push({ game, player: "", startingTerritory: "", result: "", ...changes });
    history.sort((a, b) => a.game - b.game);
    await this.document.update({ "system.history": history });
  }

  #historyContextOptions() {
    const row = target => Number(target.closest("[data-game]")?.dataset.game);
    const set = result => (event, target) => this.#updateHistory(row(target), { result });
    const entries = RESULT_COLUMNS.map(r => ({
      label: GAME_RESULTS[r], icon: "fa-solid fa-xmark", visible: () => this.canManage, onClick: set(r)
    }));
    entries.push({
      label: "RL.Sheet.Faction.MarkAbsent", icon: "fa-solid fa-ban", visible: () => this.canManage,
      onClick: (event, target) => this.#updateHistory(row(target), { result: "absent", player: "", startingTerritory: "" })
    }, {
      label: "RL.Sheet.Faction.ClearRow", icon: "fa-solid fa-eraser", visible: () => this.canManage,
      onClick: (event, target) => this.#updateHistory(row(target), null)
    });
    return entries;
  }

  static async #onToggleResult(event, target) {
    event.preventDefault();
    if ( !this.canManage ) return;
    const game = Number(target.closest("[data-game]").dataset.game);
    const result = target.dataset.result;
    const current = this.document.system.history.find(h => h.game === game)?.result;
    await this.#updateHistory(game, { result: current === result ? "" : result });
  }

  /* -------------------------------------------- */
  /*  Powers                                      */
  /* -------------------------------------------- */

  #stickerContextOptions() {
    const item = target => this.document.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    return [{
      label: "RL.Sheet.Power.Open", icon: "fa-solid fa-eye",
      onClick: (event, target) => item(target)?.sheet.render({ force: true })
    }, {
      label: "RL.Sheet.Power.ToggleUsed", icon: "fa-solid fa-check", visible: () => this.canManage,
      onClick: (event, target) => item(target)?.update({ "system.used": !item(target).system.used })
    }, {
      label: "RL.Sheet.Power.Remove", icon: "fa-solid fa-trash", visible: () => this.canPlaceStickers,
      onClick: (event, target) => this.#removePower(item(target))
    }];
  }

  static #onOpenPower(event, target) {
    const item = this.document.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    item?.sheet.render({ force: true });
  }

  static async #onRemovePower(event, target) {
    event.stopPropagation();
    const item = this.document.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    await this.#removePower(item);
  }

  static async #onTogglePowerUsed(event, target) {
    event.stopPropagation();
    if ( !this.canManage ) return;
    const item = this.document.items.get(target.closest("[data-item-id]")?.dataset.itemId);
    await item?.update({ "system.used": !item.system.used });
  }

  async #removePower(item) {
    if ( !item || !this.canPlaceStickers ) return;
    const ok = await confirmAction({
      title: "RL.Sheet.Power.RemoveTitle",
      content: t("RL.Sheet.Power.RemoveContent", { name: esc(item.name), faction: esc(this.document.name) }),
      note: "RL.Sheet.Power.RemoveNote",
      destructive: true,
      yes: "RL.Sheet.Power.RemoveConfirm"
    });
    if ( ok ) await item.delete();
  }

  /* -------------------------------------------- */
  /*  Drag & drop                                 */
  /* -------------------------------------------- */

  /** @override */
  _canDragDrop(selector) {
    return this.canPlaceStickers;
  }

  /** @inheritDoc */
  async _onDropItem(event, item) {
    if ( item.type !== "power" ) {
      ui.notifications.warn("RL.Sheet.Power.OnlyPowers", { localize: true });
      return null;
    }
    if ( !this.canPlaceStickers ) {
      ui.notifications.warn("RL.Sheet.Power.CannotPlace", { localize: true });
      return null;
    }
    if ( item.parent === this.document ) return null;

    // The sticker goes in its own coloured slot; generic ("other") stickers take the slot they're dropped on.
    const target = event.target?.closest?.(".rl-fs-slot[data-slot]")?.dataset.slot;
    let slot = item.system.slot;
    if ( !SLOT_ORDER.includes(slot) ) slot = target && SLOT_ORDER.includes(target) ? target : null;
    if ( !slot ) {
      ui.notifications.warn("RL.Sheet.Power.NoSlot", { localize: true });
      return null;
    }
    if ( target && (target !== slot) ) {
      ui.notifications.info(t("RL.Sheet.Power.WrongSlot", { slot: slotLabel(slot) }));
    }

    // Stickers printed for another faction need a second look
    const printedFor = item.system.faction;
    if ( printedFor && (printedFor !== this.document.system.key) ) {
      const other = state.getFactionByKey(printedFor)?.name
        ?? (FACTIONS[printedFor] ? t(FACTIONS[printedFor].label) : printedFor);
      const ok = await confirmAction({
        title: "RL.Sheet.Power.OtherFactionTitle",
        content: t("RL.Sheet.Power.OtherFactionContent", { name: esc(item.name), other: esc(other), faction: esc(this.document.name) })
      });
      if ( !ok ) return null;
    }

    // One sticker per slot: replacing destroys the old one (GM only)
    const occupant = this.document.items.find(i => (i.type === "power") && (i.system.slot === slot));
    if ( occupant ) {
      if ( !game.user.isGM ) {
        ui.notifications.warn(t("RL.Sheet.Power.SlotTaken", { slot: slotLabel(slot) }));
        return null;
      }
      const ok = await confirmAction({
        title: "RL.Sheet.Power.ReplaceTitle",
        content: t("RL.Sheet.Power.ReplaceContent", { old: esc(occupant.name), name: esc(item.name), slot: slotLabel(slot) }),
        destructive: true, yes: "RL.Sheet.Power.ReplaceConfirm"
      });
      if ( !ok ) return null;
      await occupant.delete();
    }

    const data = item.inCompendium ? game.items.fromCompendium(item, { clearFolder: true }) : item.toObject();
    delete data._id;
    foundry.utils.setProperty(data, "system.slot", slot);
    foundry.utils.setProperty(data, "system.used", false);
    const created = await attempt(() => Item.implementation.create(data, { parent: this.document }));
    if ( !created ) return null;

    // A sticker moves: peel it off its old card, or take it out of the unplaced pile
    if ( !item.inCompendium && item.isOwner ) {
      if ( item.parent || (item.collection === game.items) ) await attempt(() => item.delete());
    }
    return created;
  }
}
