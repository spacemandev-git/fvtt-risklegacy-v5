import { MAX_CARD_VALUE_BEFORE_FIRST_GAME, SYSTEM_ID } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { esc, logEntry, shuffle, stickerImg, territoryGroups, territoryName, tpl } from "../common.mjs";
import { territoryCardValue, upgradeCard } from "../legacy.mjs";
import CampaignWizard from "./wizard.mjs";

/**
 * "Before your first game": pick one of the two starting powers for each faction (the other is destroyed), and
 * put the 12 pre-game coin stickers on territory cards (max 3 resources per card before the first game).
 */
export default class FirstGameWizard extends CampaignWizard {
  static DEFAULT_OPTIONS = {
    id: "rl-first-game",
    classes: ["rl-wizard--first"],
    window: { title: "RL.Wizard.First.title", icon: "fa-solid fa-flag-checkered" },
    actions: {
      choosePower: FirstGameWizard.#onChoosePower,
      flipCoin: FirstGameWizard.#onFlipCoin,
      flipAll: FirstGameWizard.#onFlipAll,
      coinPlus: FirstGameWizard.#onCoinPlus,
      coinMinus: FirstGameWizard.#onCoinMinus,
      randomCoins: FirstGameWizard.#onRandomCoins,
      resetCoins: FirstGameWizard.#onResetCoins,
      apply: FirstGameWizard.#onApply,
      setupGame: FirstGameWizard.#onSetupGame
    }
  };

  static STEPS = [
    { id: "powers", label: "RL.Wizard.First.stepPowers", template: tpl("first/powers") },
    { id: "coins", label: "RL.Wizard.First.stepCoins", template: tpl("first/coins") },
    { id: "confirm", label: "RL.Wizard.First.stepConfirm", template: tpl("first/confirm") }
  ];

  static PARTS = CampaignWizard.basePARTS(FirstGameWizard.STEPS.map(s => s.template));

  /** faction key → chosen power item id */
  choices = {};

  /** territory id → coins added */
  coins = {};

  /** Flip results to animate ("heads"/"tails") by faction key. */
  flips = {};

  done = false;

  /* -------------------------------------------- */

  /** Base factions with their two First Game Power stickers. */
  #factionPowers() {
    return state.getFactions().filter(f => f.system.pack === "base").map(actor => {
      const key = actor.system.key;
      const placed = actor.items.find(i => (i.type === "power") && (i.system.slot === "starter"));
      const options = game.items.filter(i => (i.type === "power") && (i.system.faction === key) && (i.system.slot === "starter"))
        .sort((a, b) => a.system.key.localeCompare(b.system.key));
      return { actor, key, placed, options };
    });
  }

  /** Starting value of each territory card (before this wizard's coins). */
  #values() {
    const board = state.getCampaignBoard();
    const ids = board?.ids ?? state.getPack("base")?.territoryCards?.map(t => t.id) ?? [];
    return Object.fromEntries(ids.map(id => [id, territoryCardValue(id)]));
  }

  get totalCoins() {
    return state.getCampaign()?.system.stickersLeft("coin_pregame") ?? 12;
  }

  get placedCoins() {
    return Object.values(this.coins).reduce((n, c) => n + c, 0);
  }

  /* -------------------------------------------- */

  async _prepareStep(stepId) {
    const campaign = state.getCampaign();
    const base = { ready: !!campaign?.system.firstGameReady, done: this.done };
    switch ( stepId ) {
      case "powers": return {
        ...base,
        factions: this.#factionPowers().map(({ actor, key, placed, options }) => ({
          id: actor.id, key, name: actor.name, img: actor.img,
          color: actor.system.color?.css ?? "#808285", placed: placed ? { text: placed.system.text } : null,
          flip: this.flips[key] ?? "",
          options: options.map((item, i) => ({
            id: item.id, text: item.system.text, n: i + 1,
            chosen: this.choices[key] === item.id,
            destroyed: !!this.choices[key] && (this.choices[key] !== item.id)
          }))
        }))
      };
      case "coins": {
        const values = this.#values();
        return {
          ...base,
          remaining: this.totalCoins - this.placedCoins, total: this.totalCoins,
          coinImg: stickerImg("coin_pregame"),
          groups: territoryGroups().map(g => ({
            ...g,
            territories: g.territories.map(t => {
              const start = values[t.id] ?? 1;
              const added = this.coins[t.id] ?? 0;
              const value = start + added;
              return {
                ...t, value, added,
                coins: Array.fromRange(6, 1).map(n => ({ filled: n <= value, added: (n > start) && (n <= value) })),
                canAdd: (value < MAX_CARD_VALUE_BEFORE_FIRST_GAME) && (this.placedCoins < this.totalCoins),
                canRemove: added > 0
              };
            })
          }))
        };
      }
      case "confirm": {
        const factions = this.#factionPowers();
        return {
          ...base,
          powerSummary: factions.map(({ actor, key, placed, options }) => ({
            name: actor.name,
            chosen: placed?.system.text ?? options.find(o => o.id === this.choices[key])?.system.text ?? "",
            destroyed: placed ? [] : options.filter(o => o.id !== this.choices[key]).map(o => o.system.text),
            missing: !placed && !this.choices[key]
          })),
          coinSummary: Object.entries(this.coins).filter(([, n]) => n > 0)
            .map(([id, n]) => ({ name: territoryName(id), n }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          remaining: this.totalCoins - this.placedCoins
        };
      }
      default: return base;
    }
  }

  _canAdvance(stepId) {
    if ( stepId === "powers" ) return this.#factionPowers().every(f => f.placed || this.choices[f.key] || !f.options.length);
    return true;
  }

  _canGoBack() {
    return !this.done;
  }

  _footerButtons(stepId) {
    switch ( stepId ) {
      case "powers": return [{ action: "flipAll", label: "RL.Wizard.First.flipAll", icon: "fa-solid fa-coins" }];
      case "coins": return [
        { action: "resetCoins", label: "RL.Wizard.First.resetCoins", icon: "fa-solid fa-rotate-left" },
        { action: "randomCoins", label: "RL.Wizard.First.randomCoins", icon: "fa-solid fa-shuffle" }
      ];
      case "confirm":
        if ( this.done || state.getCampaign()?.system.firstGameReady ) {
          return [{ action: "setupGame", label: "RL.Wizard.Setup.title", icon: "fa-solid fa-chess-board", primary: true }];
        }
        return [{ action: "apply", label: "RL.Wizard.First.apply", icon: "fa-solid fa-scissors", destroy: true }];
      default: return [];
    }
  }

  /* -------------------------------------------- */

  static #onChoosePower(event, target) {
    const { faction, item } = target.dataset;
    this.choices[faction] = item;
    delete this.flips[faction];
    this.render();
  }

  #flip(key) {
    const entry = this.#factionPowers().find(f => f.key === key);
    if ( !entry || entry.placed || entry.options.length < 2 ) return;
    const heads = Math.random() < 0.5;
    this.choices[key] = entry.options[heads ? 0 : 1].id;
    this.flips[key] = heads ? "heads" : "tails";
  }

  static #onFlipCoin(event, target) {
    this.#flip(target.dataset.faction);
    this.render();
  }

  static #onFlipAll() {
    for ( const { key } of this.#factionPowers() ) this.#flip(key);
    this.render();
  }

  static #onCoinPlus(event, target) {
    const id = target.dataset.territory;
    const value = (this.#values()[id] ?? 1) + (this.coins[id] ?? 0);
    if ( (value >= MAX_CARD_VALUE_BEFORE_FIRST_GAME) || (this.placedCoins >= this.totalCoins) ) return;
    this.coins[id] = (this.coins[id] ?? 0) + 1;
    this.render();
  }

  static #onCoinMinus(event, target) {
    const id = target.dataset.territory;
    if ( !this.coins[id] ) return;
    this.coins[id] -= 1;
    this.render();
  }

  /** "Shuffle the Territory deck, and put one coin on the first 12 cards drawn." */
  static #onRandomCoins() {
    const values = this.#values();
    const ids = shuffle(Object.keys(values).filter(id => values[id] < MAX_CARD_VALUE_BEFORE_FIRST_GAME));
    this.coins = {};
    for ( const id of ids.slice(0, this.totalCoins) ) this.coins[id] = 1;
    this.render();
  }

  static #onResetCoins() {
    this.coins = {};
    this.render();
  }

  static async #onApply() {
    if ( !game.user.isGM ) return;
    await this.run(async () => {
      const campaign = state.getCampaign();
      if ( !campaign ) throw new Error(game.i18n.localize("RL.Error.noCampaign"));
      const entries = [];

      // Starting powers: the chosen sticker goes on the faction card; the other is destroyed.
      for ( const { actor, key, placed, options } of this.#factionPowers() ) {
        if ( placed ) continue;
        const chosen = options.find(o => o.id === this.choices[key]);
        if ( !chosen ) continue;
        const data = chosen.toObject();
        delete data._id;
        delete data.folder;
        await actor.createEmbeddedDocuments("Item", [data]);
        await Item.implementation.deleteDocuments(options.map(o => o.id));
        entries.push(logEntry("power", game.i18n.format("RL.Legacy.Log.startingPower", {
          faction: actor.name, power: chosen.system.text
        }), 0));
        this.note(game.i18n.format("RL.Wizard.First.notePower", { faction: actor.name }));
      }
      const folder = game.folders.find(f => (f.type === "Item") && (f.getFlag(SYSTEM_ID, "role") === "firstGamePowers"));
      if ( folder && !folder.contents.length ) await folder.delete();

      // Coin stickers on territory cards
      const coins = Object.entries(this.coins).filter(([, n]) => n > 0);
      for ( const [territory, amount] of coins ) {
        await upgradeCard({
          territory, amount, sticker: "coin_pregame", max: MAX_CARD_VALUE_BEFORE_FIRST_GAME, log: false
        });
      }
      if ( coins.length ) {
        const list = coins.map(([id, n]) => (n > 1 ? `${territoryName(id)} ×${n}` : territoryName(id))).join(", ");
        entries.push(logEntry("card", game.i18n.format("RL.Legacy.Log.pregameCoins", { list }), 0));
      }

      await campaign.update({
        "system.firstGameReady": true,
        "system.log": [...campaign.system.toObject().log, ...entries]
      });
      this.coins = {};
      this.done = true;
      await ChatMessage.implementation.create({
        content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
          <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(game.i18n.localize("RL.Wizard.First.title"))}</h3></div>
          <div class="rl-chat-card__body"><ul>${entries.map(e => `<li>${esc(e.text)}</li>`).join("")}</ul></div>
          <div class="rl-chat-card__result">${esc(game.i18n.localize("RL.Wizard.First.readyChat"))}</div>
        </div>`,
        flags: { [SYSTEM_ID]: { card: true } }
      });
    });
  }

  static async #onSetupGame() {
    const { openGameSetup } = await import("./game-setup.mjs");
    await this.close();
    openGameSetup();
  }
}

/** Open "Before your first game" (GM). */
export function openFirstGame() {
  if ( !game.user.isGM ) return ui.notifications.warn("RL.Legacy.Error.gmOnly", { localize: true });
  if ( !state.getCampaign() ) return ui.notifications.warn("RL.Error.noCampaign", { localize: true });
  const app = foundry.applications.instances.get("rl-first-game") ?? new FirstGameWizard();
  return app.render({ force: true });
}

