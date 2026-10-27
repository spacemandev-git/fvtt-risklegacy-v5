import { STICKERS, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { confirmAction } from "../../apps/_module.mjs";
import { onPendingChange, overrideAsk, pendingPrompts } from "../ask.mjs";
import { esc, packLabel, stickerId, stickerImg, stickerLabel, tpl } from "../common.mjs";
import {
  REWARD_STICKERS, alienIslandPlaced, boardScars, chooseReward, placeScarCorrection, placeSticker, placeability,
  seaLinesTo
} from "../placements.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Catalog `group` → section of the printed sheet. */
const BASE_GROUPS = [
  { id: "beforeFirstGame", label: "RL.Legacy.Sheet.group.beforeFirstGame" },
  { id: "won", label: "RL.Legacy.Sheet.group.won" },
  { id: "heldOn", label: "RL.Legacy.Sheet.group.heldOn" }
];

/** Remote prompts the sheet can take over (placing on a player's screen). */
const PROMPT_KINDS = {
  seaLine: "RL.Legacy.Sheet.pending.seaLine",
  alienIslandPoint: "RL.Legacy.Sheet.pending.alienIsland"
};

/** Small pips (one per sticker) are drawn up to this quantity; above it the sheet shows a count. */
const MAX_PIPS = 12;

/**
 * The Sticker Sheet: the physical sheet of marks, section by section ("Before your first game", "Game won",
 * "Held on", then each opened package's stickers), with what is left of each and a **Place…** button that runs the
 * sticker's validated board-picking flow (GM).
 *
 * Claim mode: opened from an end-of-game reward prompt on the rewarded player's own screen, the sheet offers only the
 * stickers of that reward and hands the choice back to the prompt (the GM's wizard applies it).
 */
export default class StickerSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    const claim = options.claim ?? null;
    super(foundry.utils.mergeObject(options, { id: claim ? "rl-sticker-sheet-claim" : "rl-sticker-sheet" }, { inplace: false }));
    this.claim = claim;
  }

  static DEFAULT_OPTIONS = {
    classes: ["risklegacy", "rl-campaign", "rl-camp-ss-app"],
    tag: "div",
    window: { title: "RL.Legacy.Sheet.title", icon: "fa-solid fa-note-sticky", resizable: true, minimizable: true },
    position: { width: 940, height: 800, left: 120, top: 50 },
    actions: {
      place: StickerSheet.#onPlace,
      placeScar: StickerSheet.#onPlaceScar,
      takeOver: StickerSheet.#onTakeOver
    }
  };

  static PARTS = {
    sheet: { template: tpl("sticker-sheet"), scrollable: [".rl-camp-ss__scroll"] }
  };

  /** A placement is running (buttons disabled). */
  #busy = false;

  /** Claim mode: a reward was chosen. */
  #claimed = false;

  #hook = null;

  #unsubscribe = null;

  /** @override */
  get title() {
    const base = game.i18n.localize("RL.Legacy.Sheet.title");
    return this.claim?.forUserName ? `${base} · ${this.claim.forUserName}` : base;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const campaign = state.getCampaign();
    const isGM = game.user.isGM && !this.claim;
    Object.assign(context, {
      isGM, busy: this.#busy, claim: !!this.claim, campaign: !!campaign,
      claimLead: this.claim ? game.i18n.localize(this.claim.kind === "heldOn" ? "RL.Legacy.Sheet.claimHeldOn" : "RL.Legacy.Sheet.claimWinner") : "",
      worldName: campaign?.system.worldName ?? ""
    });
    if ( !campaign ) return context;
    context.groups = this.#groups(campaign);
    context.pending = isGM ? pendingPrompts().filter(p => PROMPT_KINDS[p.kind]).map(p => ({
      ...p, text: game.i18n.format(PROMPT_KINDS[p.kind], { name: p.userName })
    })) : [];
    if ( isGM ) {
      const scars = boardScars();
      context.tools = {
        scars: scars.map(s => ({ name: s.name, img: s.stickerImg ? systemPath(s.stickerImg) : "" })),
        canScar: scars.length > 0
      };
    }
    return context;
  }

  /** Sections of the sheet, with a tile per sticker. */
  #groups(campaign) {
    const remaining = campaign.system.stickers ?? {};
    const groups = BASE_GROUPS.map(g => ({ id: g.id, label: game.i18n.localize(g.label), stickers: [] }));
    const seen = new Set();
    for ( const pack of state.allPacks() ) {
      const base = pack.id === "base";
      if ( !base && !campaign.system.isPackOpen(pack.id) ) continue;
      const tiles = [];
      for ( const entry of pack.stickers ?? [] ) {
        const id = stickerId(entry.id);
        if ( seen.has(id) ) continue;
        seen.add(id);
        tiles.push({ entry, id, group: base ? (entry.group ?? "won") : "pack" });
      }
      if ( base ) {
        for ( const t of tiles ) (groups.find(g => g.id === t.group) ?? groups[1]).stickers.push(this.#tile(t.id, t.entry, remaining));
      }
      else if ( tiles.length ) {
        groups.push({ id: `pack-${pack.id}`, pack: true, label: packLabel(pack.id), stickers: tiles.map(t => this.#tile(t.id, t.entry, remaining)) });
      }
    }
    // Base stickers the catalog didn't list (config STICKERS), and inventory entries nobody describes
    for ( const id of Object.keys(STICKERS) ) {
      if ( seen.has(id) ) continue;
      seen.add(id);
      groups[1].stickers.push(this.#tile(id, null, remaining));
    }
    return groups.filter(g => g.stickers.length);
  }

  /** One sticker tile. */
  #tile(id, entry, remaining) {
    const left = remaining[id] ?? 0;
    const qty = entry?.qty ?? STICKERS[id]?.qty ?? 0;
    const img = entry?.img ? systemPath(entry.img) : stickerImg(id);
    const paragraphs = String(entry?.text ?? "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const info = placeability(id);
    const tile = {
      id, name: STICKERS[id] ? stickerLabel(id) : (entry?.name ?? stickerLabel(id)), img,
      isCard: /\.jpe?g$/i.test(img), left, qty, empty: left <= 0,
      summary: paragraphs[0] ?? "", more: paragraphs.slice(1).join(" "),
      pips: (qty > 0) && (qty <= MAX_PIPS) ? Array.from({ length: qty }, (_, i) => ({ used: i >= left })) : null,
      stamp: ""
    };
    if ( (id === "alien_island") && alienIslandPlaced() ) {
      tile.stamp = game.i18n.localize("RL.Legacy.Sheet.placed");
      tile.status = game.i18n.format("RL.Legacy.Sheet.islandLines", { n: seaLinesTo("alien_island").length });
    }
    if ( this.claim ) return this.#claimTile(tile);
    if ( !game.user.isGM || !info.known ) return tile;
    tile.showButton = true;
    tile.disabled = this.#busy || !info.targets;
    tile.override = info.targets && !info.stock;
    tile.primary = info.targets && info.stock;
    tile.reason = info.reason;
    tile.placeLabel = game.i18n.localize(tile.override ? "RL.Legacy.Sheet.placeAnyway" : "RL.Legacy.Sheet.place");
    return tile;
  }

  /** Claim mode: only the stickers of the reward being chosen get a button. */
  #claimTile(tile) {
    const kind = this.claim.kind === "heldOn" ? "heldOn" : "winner";
    const reward = REWARD_STICKERS[kind][tile.id];
    if ( !reward ) return tile;
    const a = this.claim.available?.[reward];
    let ok = !!a?.ok;
    if ( ok && (tile.id === "continent_plus") ) ok = !!a.plus;
    if ( ok && (tile.id === "continent_minus") ) ok = !!a.minus;
    Object.assign(tile, {
      showButton: true, claimable: ok, disabled: this.#busy || !ok, primary: ok,
      reason: ok ? "" : (a?.why || game.i18n.localize("RL.Legacy.Sheet.why.noTarget")),
      placeLabel: game.i18n.localize("RL.Legacy.Sheet.claim")
    });
    return tile;
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const rerender = foundry.utils.debounce(() => {
      if ( this.rendered ) this.render();
    }, 100);
    this.#hook = Hooks.on("updateActor", actor => {
      if ( actor.type === "campaign" ) rerender();
    });
    this.#unsubscribe = onPendingChange(rerender);
  }

  /** @override */
  _onClose(options) {
    if ( this.#hook !== null ) Hooks.off("updateActor", this.#hook);
    this.#hook = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if ( this.claim && !this.#claimed ) this.claim.resolve?.(null);
    super._onClose(options);
  }

  /** Run a placement with the buttons disabled; errors become notifications. */
  async #run(fn) {
    if ( this.#busy ) return null;
    this.#busy = true;
    this.element?.classList.add("is-busy");
    try {
      return await fn();
    } catch(err) {
      console.error("risklegacy | sticker sheet", err);
      if ( err?.message ) ui.notifications.error(err.message);
      return null;
    } finally {
      this.#busy = false;
      this.element?.classList.remove("is-busy");
      if ( this.rendered ) this.render();
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onPlace(event, target) {
    const id = target.closest("[data-sticker]")?.dataset.sticker;
    if ( !id || this.#busy ) return;
    if ( this.claim ) {
      const choice = await this.#run(() => chooseReward(id, this.claim.available, { app: this }));
      if ( choice ) {
        this.#claimed = true;
        this.claim.resolve?.(choice);
        await this.close();
      }
      return;
    }
    if ( !game.user.isGM ) return;
    const info = placeability(id);
    let force = false;
    if ( !info.stock ) {
      const ok = await confirmAction({
        title: game.i18n.localize("RL.Legacy.Sheet.overrideTitle"), icon: "fa-solid fa-triangle-exclamation",
        content: esc(game.i18n.format("RL.Legacy.Sheet.overrideText", { sticker: stickerLabel(id), n: info.uses, left: info.left })),
        yes: "RL.Legacy.Sheet.placeAnyway"
      });
      if ( !ok ) return;
      force = true;
    }
    const result = await this.#run(() => placeSticker(id, { app: this, force }));
    if ( result ) ui.notifications.info(game.i18n.format("RL.Legacy.Sheet.done", { sticker: stickerLabel(id) }));
  }

  static async #onPlaceScar() {
    if ( !game.user.isGM || this.claim ) return;
    const result = await this.#run(() => placeScarCorrection({ app: this }));
    if ( result ) ui.notifications.info(game.i18n.localize("RL.Legacy.Sheet.scarDone"));
  }

  static #onTakeOver(event, target) {
    overrideAsk(target.dataset.promptId).catch(err => console.error(err));
  }

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /**
   * Open (or bring forward) the Sticker Sheet.
   * @returns {Promise<StickerSheet>}
   */
  static async open() {
    if ( !state.getCampaign() ) {
      ui.notifications.warn("RL.Error.noCampaign", { localize: true });
      return null;
    }
    const app = foundry.applications.instances.get("rl-sticker-sheet") ?? new this();
    if ( app.rendered ) {
      if ( app.minimized ) await app.maximize();
      app.bringToFront();
      return app;
    }
    return app.render({ force: true });
  }

  /**
   * Claim mode (end-of-game reward, on the rewarded player's screen): resolves with a reward choice, or null.
   * @param {object} options
   * @param {"winner"|"heldOn"} options.kind
   * @param {object} options.available     the wizard's availability data
   * @param {string} [options.forUserName]
   * @returns {Promise<object|null>}
   */
  static claimReward({ kind, available, forUserName = "" } = {}) {
    foundry.applications.instances.get("rl-sticker-sheet-claim")?.close();
    return new Promise(resolve => {
      const app = new this({ claim: { kind, available, forUserName, resolve } });
      app.render({ force: true });
    });
  }
}

/** Open the Sticker Sheet. */
export function openStickerSheet() {
  return StickerSheet.open();
}
