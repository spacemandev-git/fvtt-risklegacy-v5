import { HELDON_REWARDS, LEGACY_GAMES, POWER_SLOT_ORDER, WINNER_REWARDS, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { registerPrompt } from "../ask.mjs";
import { continentName, stickerImg, territoryName, today, tpl } from "../common.mjs";
import CampaignPrompt, { territoryOptions } from "./prompt-base.mjs";

/**
 * The campaign's choice prompts. Each runs on the choosing player's client (or the GM's in hot-seat) and returns
 * plain data to the GM-side wizard. Their data is JSON: ids and pre-computed availability, so a player's client
 * doesn't need permission to see the decks.
 */

export const PARTIALS = [tpl("parts/faction-card"), tpl("parts/territory-select"), tpl("parts/hot-seat"), tpl("parts/victors")];

/** Icons for rewards that don't use a sticker. */
const REWARD_ICONS = { nameContinent: "fa-solid fa-pen-nib", destroyTerritoryCard: "fa-solid fa-scissors" };

/* -------------------------------------------- */
/*  Faction cards (shared with the wizards)     */
/* -------------------------------------------- */

/**
 * Card context for a faction actor.
 * @param {Actor} actor
 * @param {object} [extra]
 */
export function factionCard(actor, extra = {}) {
  const powers = actor.items.filter(i => i.type === "power")
    .sort((a, b) => POWER_SLOT_ORDER.indexOf(a.system.slot) - POWER_SLOT_ORDER.indexOf(b.system.slot))
    .map(i => ({ name: i.name, text: i.system.text, slot: i.system.slot }));
  return {
    id: actor.id, key: actor.system.key, name: actor.name, img: actor.img,
    color: actor.system.color?.css ?? String(actor.system.color ?? "#808285"),
    powers, wins: actor.system.wins, games: actor.system.history.filter(h => h.result && (h.result !== "absent")).length,
    ...extra
  };
}

/* -------------------------------------------- */
/*  Choose a faction                            */
/* -------------------------------------------- */

class FactionPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--faction"],
    position: { width: 860 },
    window: { title: "RL.Wizard.Prompt.factionTitle", icon: "fa-solid fa-flag" }
  };

  static PARTS = {
    body: { template: tpl("prompts/faction"), templates: PARTIALS, scrollable: [".rl-camp-faction-grid"] }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const allowed = new Set(this.data.factions ?? []);
    context.factions = state.getFactions().filter(a => allowed.has(a.id)).map(a => factionCard(a));
    return context;
  }

  _getResult(data) {
    if ( !data.faction ) return this._invalid("RL.Wizard.Prompt.chooseOne");
    return data.faction;
  }
}

/* -------------------------------------------- */
/*  Choose a territory                          */
/* -------------------------------------------- */

class TerritoryPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--territory"],
    position: { width: 460 },
    window: { title: "RL.Wizard.Prompt.territoryTitle", icon: "fa-solid fa-map-location-dot" }
  };

  static PARTS = { body: { template: tpl("prompts/territory"), templates: PARTIALS } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.groups = territoryOptions(this.data.allowed ?? [], this.data.selected);
    context.canPick = !!game.risklegacy?.board?.pickTerritory;
    return context;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Starting territories: go straight to the board when the canvas can do it.
    if ( this.data.board && context.canPick ) {
      this.element.querySelector('[data-action="pickOnBoard"]')?.click();
    }
  }

  /** A board pick for a starting territory is the choice: submit straight away. */
  _onPicked(territory, select) {
    if ( this.data.board && (select.name === "territory") ) this.submit();
  }

  _getResult(data) {
    if ( !data.territory ) return this._invalid("RL.Wizard.Prompt.chooseTerritory");
    return data.territory;
  }
}

/* -------------------------------------------- */
/*  Generic option                              */
/* -------------------------------------------- */

class OptionPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--option"],
    position: { width: 520 },
    window: { icon: "fa-solid fa-list-check" }
  };

  static PARTS = { body: { template: tpl("prompts/option"), templates: PARTIALS } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.options = (this.data.options ?? []).map(o => ({ ...o, img: o.img ? systemPath(o.img) : "" }));
    return context;
  }

  _getResult(data) {
    if ( !data.choice ) return this._invalid("RL.Wizard.Prompt.chooseOne");
    return data.choice;
  }
}

/* -------------------------------------------- */
/*  Draft (Minor Cities rules B–D)              */
/* -------------------------------------------- */

class DraftPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--draft"],
    position: { width: 900 },
    window: { title: "RL.Wizard.Prompt.draftTitle", icon: "fa-solid fa-layer-group" }
  };

  static PARTS = {
    body: { template: tpl("prompts/draft"), templates: PARTIALS, scrollable: [".rl-camp-draft-scroll"] }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const held = new Set(this.data.heldTypes ?? []);
    const factionIds = new Set(this.data.factions ?? []);
    context.factions = state.getFactions().filter(a => factionIds.has(a.id))
      .map(a => factionCard(a, { disabled: this.data.hasFaction, value: `faction:${a.id}` }));
    const cards = (this.data.cards ?? []).map(id => state.findEntry("draft", id)).filter(Boolean);
    context.draftGroups = ["turnOrder", "placement", "troops", "coin"].map(type => ({
      type, label: game.i18n.localize(`RL.Wizard.Draft.type.${type}`), held: held.has(type),
      cards: cards.filter(c => c.type === type).sort((a, b) => a.value - b.value)
        .map(c => ({ ...c, img: systemPath(c.img), value: `draft:${c.id}`, disabled: held.has(type) }))
    })).filter(g => g.cards.length);
    context.hasFaction = this.data.hasFaction;
    return context;
  }

  _getResult(data) {
    if ( !data.pick ) return this._invalid("RL.Wizard.Prompt.chooseOne");
    const [type, id] = data.pick.split(":");
    return { type, id };
  }
}

/* -------------------------------------------- */
/*  Sign the victors' section                   */
/* -------------------------------------------- */

class SignaturePrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--signature"],
    position: { width: 640 },
    window: { title: "RL.Wizard.Prompt.signTitle", icon: "fa-solid fa-signature" }
  };

  static PARTS = { body: { template: tpl("prompts/signature"), templates: PARTIALS } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const signed = new Map((this.data.victors ?? []).map(v => [v.number, v]));
    context.lines = Array.fromRange(LEGACY_GAMES, 1).map(n => ({
      n, entry: signed.get(n), current: n === this.data.line
    }));
    context.date = this.data.date || today();
    context.player = this.data.player ?? "";
    return context;
  }

  _getResult(data) {
    if ( !data.player?.trim() ) return this._invalid("RL.Wizard.Prompt.signName");
    return { player: data.player.trim(), date: data.date || today(), motto: (data.motto ?? "").trim() };
  }
}

/* -------------------------------------------- */
/*  Winner's reward                             */
/* -------------------------------------------- */

/**
 * "Use the Sticker Sheet": the rewarded player places the sticker from the Sticker Sheet (claim mode) instead of the
 * lists; the sheet hands the choice back and the prompt answers with it. Same targets (the GM's `available`).
 * @this {CampaignPrompt}
 */
async function useStickerSheet(kind) {
  const { default: StickerSheet } = await import("./sticker-sheet.mjs");
  await this.minimize();
  const choice = await StickerSheet.claimReward({ kind, available: this.data.available, forUserName: this.data.forUserName ?? "" });
  if ( choice ) return this.finish(choice);
  if ( this.rendered ) await this.maximize();
}

class WinnerRewardPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--reward"],
    position: { width: 760 },
    window: { title: "RL.Wizard.Prompt.rewardTitle", icon: "fa-solid fa-trophy" },
    actions: { stickerSheet: function() { return useStickerSheet.call(this, "winner"); } }
  };

  static PARTS = { body: { template: tpl("prompts/winner-reward"), templates: PARTIALS, scrollable: [""] } };

  #reward = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const a = this.data.available ?? {};
    this.#reward ??= Object.keys(WINNER_REWARDS).find(k => a[k]?.ok) ?? null;
    context.reward = this.#reward;
    const stickers = this.data.stickers ?? {};
    context.rewards = Object.entries(WINNER_REWARDS).map(([key, r]) => {
      const continentMarks = key === "changeContinentBonus";
      return {
        key, label: game.i18n.localize(r.label), hint: game.i18n.localize(r.hint),
        img: r.sticker ? stickerImg(r.sticker) : (continentMarks ? stickerImg("continent_plus") : ""),
        icon: REWARD_ICONS[key] ?? "",
        left: r.sticker ? (stickers[r.sticker] ?? 0)
          : (continentMarks ? (stickers.continent_plus ?? 0) + (stickers.continent_minus ?? 0) : null),
        ok: !!a[key]?.ok, why: a[key]?.why ?? "", selected: key === this.#reward
      };
    }).map(r => ({ ...r, hasLeft: r.left !== null }));
    const opts = (ids, selected) => territoryOptions(ids ?? [], selected);
    context.sub = {
      nameContinent: (a.nameContinent?.continents ?? []).map(id => ({ id, name: continentName(id) })),
      foundMajorCity: opts(a.foundMajorCity?.territories),
      cancelScar: opts(a.cancelScar?.territories),
      fortifyCity: opts(a.fortifyCity?.territories),
      destroyTerritoryCard: opts(a.destroyTerritoryCard?.territories),
      changeContinentBonus: (a.changeContinentBonus?.continents ?? []).map(id => ({ id, name: continentName(id) })),
      plus: a.changeContinentBonus?.plus, minus: a.changeContinentBonus?.minus
    };
    context.canPick = !!game.risklegacy?.board?.pickTerritory;
    return context;
  }

  _onChoose(name, value) {
    if ( name !== "reward" ) return;
    this.#reward = value;
    for ( const el of this.element.querySelectorAll("[data-reward-form]") ) {
      el.hidden = el.dataset.rewardForm !== value;
    }
  }

  _getResult(data) {
    const reward = data.reward;
    if ( !reward || !this.data.available?.[reward]?.ok ) return this._invalid("RL.Wizard.Prompt.chooseOne");
    const sub = data[reward] ?? {};
    switch ( reward ) {
      case "nameContinent":
        if ( !sub.continent || !sub.name?.trim() ) return this._invalid("RL.Wizard.Prompt.continentAndName");
        return { reward, continent: sub.continent, name: sub.name.trim() };
      case "foundMajorCity":
        if ( !sub.territory || !sub.name?.trim() ) return this._invalid("RL.Wizard.Prompt.territoryAndName");
        return { reward, territory: sub.territory, name: sub.name.trim() };
      case "changeContinentBonus":
        if ( !sub.continent || !sub.delta ) return this._invalid("RL.Wizard.Prompt.continentAndDelta");
        return { reward, continent: sub.continent, delta: Number(sub.delta) };
      default:
        if ( !sub.territory ) return this._invalid("RL.Wizard.Prompt.chooseTerritory");
        return { reward, territory: sub.territory };
    }
  }
}

/* -------------------------------------------- */
/*  Held-on reward                              */
/* -------------------------------------------- */

class HeldOnRewardPrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--reward"],
    position: { width: 640 },
    window: { title: "RL.Wizard.Prompt.heldOnTitle", icon: "fa-solid fa-shield-halved" },
    actions: { stickerSheet: function() { return useStickerSheet.call(this, "heldOn"); } }
  };

  static PARTS = { body: { template: tpl("prompts/heldon-reward"), templates: PARTIALS, scrollable: [""] } };

  #reward = null;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const a = this.data.available ?? {};
    this.#reward ??= Object.keys(HELDON_REWARDS).find(k => a[k]?.ok) ?? null;
    context.reward = this.#reward;
    context.rewards = Object.entries(HELDON_REWARDS).map(([key, r]) => ({
      key, label: game.i18n.localize(r.label), hint: game.i18n.localize(r.hint), img: stickerImg(r.sticker),
      left: this.data.stickers?.[r.sticker] ?? 0, ok: !!a[key]?.ok, why: a[key]?.why ?? "",
      selected: key === this.#reward
    }));
    context.sub = {
      foundMinorCity: territoryOptions(a.foundMinorCity?.territories ?? []),
      upgradeCard: territoryOptions(a.upgradeCard?.territories ?? []).map(g => ({
        ...g, territories: g.territories.map(t => ({ ...t, value: a.upgradeCard.values?.[t.id] }))
      }))
    };
    context.faction = this.data.factionName ?? "";
    context.canPick = !!game.risklegacy?.board?.pickTerritory;
    return context;
  }

  _onChoose(name, value) {
    if ( name !== "reward" ) return;
    this.#reward = value;
    for ( const el of this.element.querySelectorAll("[data-reward-form]") ) {
      el.hidden = el.dataset.rewardForm !== value;
    }
  }

  _getResult(data) {
    const reward = data.reward;
    if ( !reward || !this.data.available?.[reward]?.ok ) return this._invalid("RL.Wizard.Prompt.chooseOne");
    const sub = data[reward] ?? {};
    if ( !sub.territory ) return this._invalid("RL.Wizard.Prompt.chooseTerritory");
    if ( (reward === "foundMinorCity") && !sub.name?.trim() ) return this._invalid("RL.Wizard.Prompt.territoryAndName");
    return { reward, territory: sub.territory, name: sub.name?.trim() ?? "" };
  }
}

/* -------------------------------------------- */
/*  Name the world                              */
/* -------------------------------------------- */

class WorldNamePrompt extends CampaignPrompt {
  static DEFAULT_OPTIONS = {
    classes: ["rl-prompt--world"],
    position: { width: 520 },
    window: { title: "RL.Wizard.Prompt.worldTitle", icon: "fa-solid fa-earth-europe" }
  };

  static PARTS = { body: { template: tpl("prompts/world-name"), templates: PARTIALS } };

  _getResult(data) {
    if ( !data.name?.trim() ) return this._invalid("RL.Wizard.Prompt.worldName");
    return { name: data.name.trim() };
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export const PROMPT_CLASSES = {
  faction: FactionPrompt,
  territory: TerritoryPrompt,
  option: OptionPrompt,
  draft: DraftPrompt,
  signature: SignaturePrompt,
  winnerReward: WinnerRewardPrompt,
  heldOnReward: HeldOnRewardPrompt,
  worldName: WorldNamePrompt
};

/** Register every prompt kind with the ask() dispatcher. */
export function registerPrompts() {
  for ( const [kind, cls] of Object.entries(PROMPT_CLASSES) ) registerPrompt(kind, data => cls.ask(data));
}

/** Labels for summaries. */
export function rewardSummary(choice) {
  if ( !choice ) return "";
  const label = game.i18n.localize(WINNER_REWARDS[choice.reward]?.label ?? HELDON_REWARDS[choice.reward]?.label ?? choice.reward);
  const parts = [label];
  if ( choice.continent ) parts.push(continentName(choice.continent, { printed: true }));
  if ( choice.territory ) parts.push(territoryName(choice.territory));
  if ( choice.name ) parts.push(`“${choice.name}”`);
  if ( choice.delta ) parts.push(choice.delta > 0 ? "+1" : "−1");
  return parts.join(" · ");
}
