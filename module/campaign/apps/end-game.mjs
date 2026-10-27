import { GAME_RESULTS, LEGACY_GAMES, MAX_CARD_VALUE, SYSTEM_ID, WINNER_REWARDS } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { ask } from "../ask.mjs";
import { api, esc, packLabel, stickerImg, territoryName, today, tpl } from "../common.mjs";
import * as legacy from "../legacy.mjs";
import { openPack, packInfo, packsForEvent, peekDeferred, setDeferring, takeDeferred } from "../packs.mjs";
import { TARGETS, applyReward } from "../placements.mjs";
import { rewardSummary } from "./prompts.mjs";
import CampaignWizard from "./wizard.mjs";

/**
 * End of game (rulebook pp. 14–15).
 *
 * 1. Results: won / held on / eliminated for every faction in the war (no troops on the board = eliminated),
 *    written on the backs of the faction cards and in the campaign's games.
 * 2. Victor: the winner signs the next line of the victors' section (name, date, motto).
 * 3. Reward: the winner picks one reward and makes the change.
 * 4. Held on: clockwise from the winner, each faction that held on founds a Minor City or upgrades a card.
 * 5. The world: after the 15th game, the player with the most signatures names the world.
 * 6. Packages: the envelopes whose conditions were met (triggers are held back until here).
 *
 * Steps 2–5 only happen during the first 15 games. Choices are made on the choosing player's screen (or here,
 * hot-seat). Progress is saved on the campaign actor (flag `endGame`).
 */
export default class EndGameWizard extends CampaignWizard {
  static DEFAULT_OPTIONS = {
    id: "rl-end-game",
    classes: ["rl-wizard--end"],
    window: { title: "RL.Wizard.End.title", icon: "fa-solid fa-trophy" },
    actions: {
      confirmResults: EndGameWizard.#onConfirmResults,
      sign: EndGameWizard.#onSign,
      reward: EndGameWizard.#onReward,
      heldOn: EndGameWizard.#onHeldOn,
      skipHeldOn: EndGameWizard.#onSkipHeldOn,
      rollOff: EndGameWizard.#onRollOff,
      nameWorld: EndGameWizard.#onNameWorld,
      openPack: EndGameWizard.#onOpenPack,
      finish: EndGameWizard.#onFinish
    }
  };

  static STEPS = [
    { id: "results", label: "RL.Wizard.End.stepResults", template: tpl("end/results") },
    { id: "victor", label: "RL.Wizard.End.stepVictor", template: tpl("end/victor"), when() { return this.legacy && !!this.end.winner; } },
    { id: "reward", label: "RL.Wizard.End.stepReward", template: tpl("end/reward"), when() { return this.legacy && !!this.end.winner; } },
    { id: "heldOn", label: "RL.Wizard.End.stepHeldOn", template: tpl("end/held-on"), when() { return this.legacy; } },
    { id: "world", label: "RL.Wizard.End.stepWorld", template: tpl("end/world"), when() { return this.namesWorld; } },
    { id: "packages", label: "RL.Wizard.End.stepPackages", template: tpl("end/packages") }
  ];

  static PARTS = CampaignWizard.basePARTS(EndGameWizard.STEPS.map(s => s.template));

  constructor(options = {}) {
    super(options);
    const campaign = state.getCampaign();
    const war = options.war ?? state.getWar() ?? game.combats.find(c => c.type === "war");
    const saved = campaign?.getFlag(SYSTEM_ID, "endGame");
    if ( saved && !saved.finished && (!war || (saved.warId === war.id)) ) this.end = foundry.utils.deepClone(saved);
    else this.end = this.#fresh(war);
  }

  /** Winning and holding on change the world only in the first 15 games. */
  get legacy() {
    return this.end.game <= LEGACY_GAMES;
  }

  /** After the 15th game's rewards, the world gets its name. */
  get namesWorld() {
    const campaign = state.getCampaign();
    return (this.end.game === LEGACY_GAMES) && (!campaign?.system.worldName || !!this.end.world);
  }

  #fresh(war) {
    const campaign = state.getCampaign();
    const number = war?.system.game ?? campaign?.system.nextGameNumber ?? 1;
    const results = this.#computeResults(war);
    const winner = results.find(r => r.result === "won")?.faction ?? war?.system.winner ?? "";
    return {
      warId: war?.id ?? "", game: number, date: today(), winner, results, confirmed: false,
      signature: null, reward: null, heldOn: {}, rollOff: null, world: null, packs: [], opened: [], finished: false
    };
  }

  /** Results from the turn area if it computes them, else from the board: no troops = eliminated. */
  #computeResults(war) {
    let computed = null;
    const fn = api("turn", "computeResults");
    if ( fn && war ) {
      try {
        computed = fn(war);
      } catch(err) {
        console.warn(`${SYSTEM_ID} | campaign: turn.computeResults failed`, err);
      }
    }
    const lookup = id => {
      if ( Array.isArray(computed) ) return computed.find(c => (c.faction === id) || (c.faction?.id === id))?.result;
      return computed?.[id]?.result ?? computed?.[id];
    };
    const snapshot = state.buildSnapshot();
    const winner = war?.system.winner ?? "";
    let factions = war ? war.combatants.contents.map(c => c.actor).filter(Boolean) : [];
    if ( !factions.length ) factions = state.getFactions({ active: true });
    factions.sort((a, b) => a.system.war.seat - b.system.war.seat);
    return factions.map(actor => {
      const f = snapshot?.factions?.[actor.id];
      const troops = f?.troops ?? 0;
      let result = (actor.id === winner) ? "won"
        : ((actor.system.war.status === "eliminated") || (troops === 0)) ? "eliminated" : "heldOn";
      const fromTurn = lookup(actor.id);
      if ( typeof fromTurn === "string" && GAME_RESULTS[fromTurn] ) result = fromTurn;
      return {
        faction: actor.id, factionName: actor.name, key: actor.system.key,
        player: actor.system.war.playerName, playerId: actor.system.war.playerId,
        seat: actor.system.war.seat, startingTerritory: actor.system.war.startingTerritory,
        result, troops, territories: f?.territories ?? [], hqs: f?.hqs?.length ?? 0,
        redStars: f?.redStars?.total ?? actor.system.war.redStarTokens
      };
    });
  }

  async #save() {
    const campaign = state.getCampaign();
    if ( campaign && game.user.isGM ) await campaign.setFlag(SYSTEM_ID, "endGame", this.end);
  }

  get #winnerRow() {
    return this.end.results.find(r => r.faction === this.end.winner) ?? null;
  }

  /** Held-on factions, clockwise from the winner. */
  get #heldOnRows() {
    const n = Math.max(this.end.results.length, 1);
    const start = this.#winnerRow?.seat ?? -1;
    return this.end.results.filter(r => r.result === "heldOn")
      .sort((a, b) => (((a.seat - start) + n) % n) - (((b.seat - start) + n) % n));
  }

  /* -------------------------------------------- */
  /*  Availability                                */
  /* -------------------------------------------- */

  /**
   * The winner's options. Targets come from the shared placement rules (module/campaign/placements.mjs), the same
   * ones the Sticker Sheet uses: printed territories only (Alien Island has no mark spot), no Fallout Zones.
   */
  #winnerAvailability() {
    const c = state.getCampaign().system;
    const left = id => c.stickersLeft(id);
    const unnamed = TARGETS.unnamedContinents();
    const noCity = TARGETS.city();
    const scarred = TARGETS.cancelScar();
    const cities = TARGETS.fortify();
    const unmodified = TARGETS.unmodifiedContinents();
    const cards = TARGETS.destroyCard();
    const why = key => game.i18n.localize(`RL.Wizard.End.why.${key}`);
    const opt = (ok, reason, extra) => ({ ok, why: ok ? "" : why(reason), ...extra });
    return {
      nameContinent: opt(unnamed.length > 0, "noContinent", { continents: unnamed }),
      foundMajorCity: opt((left("major_city") > 0) && (noCity.length > 0), left("major_city") ? "noTerritory" : "noSticker", { territories: noCity }),
      cancelScar: opt((left("cancel_scar") > 0) && (scarred.length > 0), left("cancel_scar") ? "noScar" : "noSticker", { territories: scarred }),
      changeContinentBonus: opt(((left("continent_plus") + left("continent_minus")) > 0) && (unmodified.length > 0),
        (left("continent_plus") + left("continent_minus")) ? "noContinent" : "noSticker",
        { continents: unmodified, plus: left("continent_plus") > 0, minus: left("continent_minus") > 0 }),
      fortifyCity: opt((left("fortification") > 0) && (cities.length > 0), left("fortification") ? "noCity" : "noSticker", { territories: cities }),
      destroyTerritoryCard: opt(cards.length > 0, "noCard", { territories: cards })
    };
  }

  /** A held-on faction's options: the shared placement rules, limited to the territories it controlled. */
  #heldOnAvailability(row) {
    const c = state.getCampaign().system;
    const controlled = new Set(row.territories ?? []);
    const noCity = TARGETS.city().filter(id => controlled.has(id));
    const upgradable = TARGETS.upgrade(MAX_CARD_VALUE).filter(id => controlled.has(id));
    const values = Object.fromEntries(upgradable.map(id => [id, legacy.territoryCardValue(id)]));
    const why = key => game.i18n.localize(`RL.Wizard.End.why.${key}`);
    return {
      foundMinorCity: { ok: (c.stickersLeft("minor_city") > 0) && (noCity.length > 0), territories: noCity,
        why: c.stickersLeft("minor_city") ? (noCity.length ? "" : why("noTerritory")) : why("noSticker") },
      upgradeCard: { ok: (c.stickersLeft("coin_heldon") > 0) && (upgradable.length > 0), territories: upgradable, values,
        why: c.stickersLeft("coin_heldon") ? (upgradable.length ? "" : why("noCard")) : why("noSticker") }
    };
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  async _prepareStep(stepId) {
    const campaign = state.getCampaign();
    const e = this.end;
    const base = { gameNumber: e.game, legacyGame: this.legacy, confirmed: e.confirmed };
    const winner = this.#winnerRow;
    switch ( stepId ) {
      case "results": return {
        ...base,
        rows: e.results.map(r => ({
          ...r, img: game.actors.get(r.faction)?.img ?? "", start: territoryName(r.startingTerritory),
          territoryCount: r.territories.length,
          choices: Object.keys(GAME_RESULTS).filter(k => k !== "absent").map(k => ({
            value: k, label: game.i18n.localize(GAME_RESULTS[k]), selected: k === r.result
          }))
        })),
        winner: winner?.factionName ?? "",
        afterFifteen: !this.legacy
      };
      case "victor": {
        const victors = campaign.system.victors.map(g => ({ number: g.number, player: g.winner.player, motto: g.winner.motto, date: g.date }));
        const signed = new Map(victors.map(v => [v.number, v]));
        if ( e.signature ) signed.set(e.game, { number: e.game, ...e.signature });
        return {
          ...base, winner,
          lines: Array.fromRange(LEGACY_GAMES, 1).map(n => ({ n, entry: signed.get(n), current: n === e.game })),
          signature: e.signature,
          signatures: winner ? campaign.system.signaturesOf(winner.playerId, winner.player) : 0
        };
      }
      case "reward": {
        const available = this.#winnerAvailability();
        return {
          ...base, winner, reward: e.reward, rewardText: rewardSummary(e.reward),
          rewards: Object.entries(WINNER_REWARDS).map(([key, r]) => ({
            key, label: game.i18n.localize(r.label), hint: game.i18n.localize(r.hint),
            img: r.sticker ? stickerImg(r.sticker) : (key === "changeContinentBonus" ? stickerImg("continent_plus") : ""),
            ok: available[key].ok, why: available[key].why, chosen: e.reward?.reward === key
          }))
        };
      }
      case "heldOn": {
        const rows = this.#heldOnRows;
        const current = rows.find(r => !e.heldOn[r.faction]);
        return {
          ...base,
          rows: rows.map((r, i) => {
            const choice = e.heldOn[r.faction];
            const available = this.#heldOnAvailability(r);
            return {
              ...r, n: i + 1, img: game.actors.get(r.faction)?.img ?? "",
              done: !!choice, skipped: choice === "skip", text: choice && (choice !== "skip") ? rewardSummary(choice) : "",
              current: current?.faction === r.faction,
              none: !available.foundMinorCity.ok && !available.upgradeCard.ok
            };
          }),
          noneHeld: !rows.length,
          stickers: { minor: campaign.system.stickersLeft("minor_city"), coins: campaign.system.stickersLeft("coin_heldon") },
          minorImg: stickerImg("minor_city"), coinImg: stickerImg("coin_heldon"),
          complete: !current
        };
      }
      case "world": {
        const totals = campaign.system.signatureTotals;
        const top = totals[0]?.count ?? 0;
        const tied = totals.filter(t => t.count === top);
        return {
          ...base, totals: totals.map(t => ({ ...t, top: t.count === top })), tied: tied.length > 1,
          rollOff: e.rollOff, namer: this.#worldNamer(), world: e.world ?? (campaign.system.worldName ? { name: campaign.system.worldName } : null)
        };
      }
      case "packages": {
        const ids = this.#pendingPacks();
        return {
          ...base,
          packs: ids.map(id => ({ ...packInfo(id), justOpened: e.opened.includes(id) })),
          none: !ids.length
        };
      }
      default: return base;
    }
  }

  /** Packages whose conditions are met (triggered during the end of game, or still true now). */
  #pendingPacks() {
    const campaign = state.getCampaign();
    const ids = new Set([...this.end.packs, ...peekDeferred().map(d => d.packId), ...this.end.opened]);
    if ( this.end.confirmed ) {
      if ( this.end.results.some(r => r.result === "eliminated") ) ids.add("eliminated");
      for ( const id of packsForEvent({ type: "cityFounded", cityType: "minor" }) ) ids.add(id);
      const winner = this.#winnerRow;
      if ( winner && (campaign.system.signaturesOf(winner.playerId, winner.player) >= 2) && this.end.signature ) ids.add("secondwin");
    }
    return [...ids].filter(id => (id !== "base") && (this.end.opened.includes(id) || !campaign.system.isPackOpen(id)));
  }

  _canAdvance(stepId) {
    const e = this.end;
    switch ( stepId ) {
      case "results": return e.confirmed;
      case "victor": return !!e.signature;
      case "reward": return !!e.reward;
      case "heldOn": return this.#heldOnRows.every(r => e.heldOn[r.faction]);
      case "world": return !!e.world || !!state.getCampaign()?.system.worldName;
      default: return true;
    }
  }

  _canGoBack(stepId) {
    return stepId !== "results";
  }

  _footerButtons(stepId) {
    const e = this.end;
    const winner = this.#winnerRow;
    switch ( stepId ) {
      case "results": return e.confirmed ? [] : [
        { action: "confirmResults", label: "RL.Wizard.End.confirmResults", icon: "fa-solid fa-pen-to-square", primary: true }
      ];
      case "victor": return e.signature ? [] : [{
        action: "sign", label: game.i18n.format("RL.Wizard.End.askSign", { name: winner?.player ?? "?" }),
        icon: "fa-solid fa-signature", primary: true
      }];
      case "reward": return e.reward ? [] : [{
        action: "reward", label: game.i18n.format("RL.Wizard.End.askReward", { name: winner?.player ?? "?" }),
        icon: "fa-solid fa-trophy", primary: true
      }];
      case "heldOn": return this._canAdvance("heldOn") ? [] : [
        { action: "heldOn", label: "RL.Wizard.End.askHeldOn", icon: "fa-solid fa-shield-halved", primary: true }
      ];
      case "world": {
        if ( e.world ) return [];
        const namer = this.#worldNamer();
        if ( !namer ) return [{ action: "rollOff", label: "RL.Wizard.End.rollOff", icon: "fa-solid fa-dice", primary: true }];
        return [{ action: "nameWorld", label: game.i18n.format("RL.Wizard.End.askWorld", { name: namer.player }),
          icon: "fa-solid fa-earth-europe", primary: true }];
      }
      case "packages": return [{ action: "finish", label: "RL.Wizard.End.finish", icon: "fa-solid fa-flag-checkered", primary: true }];
      default: return [];
    }
  }

  /* -------------------------------------------- */
  /*  Lifecycle: hold pack triggers               */
  /* -------------------------------------------- */

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    setDeferring(true);
  }

  _onClose(options) {
    const deferred = takeDeferred().map(d => d.packId);
    this.end.packs = [...new Set([...this.end.packs, ...deferred])];
    this.#save();
    setDeferring(false);
    super._onClose(options);
  }

  /* -------------------------------------------- */
  /*  Results                                     */
  /* -------------------------------------------- */

  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const select of this.element.querySelectorAll("select[data-result-for]") ) {
      select.addEventListener("change", () => {
        const row = this.end.results.find(r => r.faction === select.dataset.resultFor);
        if ( !row || this.end.confirmed ) return;
        row.result = select.value;
        if ( row.result === "won" ) {
          for ( const r of this.end.results ) if ( (r !== row) && (r.result === "won") ) r.result = "heldOn";
          this.end.winner = row.faction;
        } else if ( this.end.winner === row.faction ) this.end.winner = "";
        this.render();
      });
    }
  }

  static async #onConfirmResults() {
    if ( !game.user.isGM || this.end.confirmed ) return;
    await this.run(async () => {
      const e = this.end;
      // Backs of the faction cards
      for ( const r of e.results ) {
        const actor = game.actors.get(r.faction);
        if ( !actor ) continue;
        const history = actor.system.toObject().history;
        const row = history.find(h => h.game === e.game);
        if ( row ) row.result = r.result;
        else history.push({ game: e.game, player: r.player, startingTerritory: r.startingTerritory, result: r.result });
        history.sort((a, b) => a.game - b.game);
        await actor.update({ "system.history": history });
      }
      const winner = this.#winnerRow;
      await legacy.recordGame({
        number: e.game, date: e.date,
        winner: winner ? {
          faction: winner.faction, factionName: winner.factionName, player: winner.player, playerId: winner.playerId, motto: ""
        } : { faction: "", factionName: "", player: "", playerId: "", motto: "" },
        results: e.results.map(r => ({
          faction: r.faction, factionName: r.factionName, player: r.player, playerId: r.playerId,
          startingTerritory: r.startingTerritory, result: r.result, reward: "", rewardDetail: ""
        }))
      });
      e.confirmed = true;
      await this.#save();
      // "…or is knocked out or eliminated when the game ends."
      if ( e.results.some(r => r.result === "eliminated") ) {
        for ( const id of packsForEvent({ type: "factionEliminated" }) ) if ( !e.packs.includes(id) ) e.packs.push(id);
      }
      const content = await foundry.applications.handlebars.renderTemplate(tpl("chat/game-results"), {
        game: e.game, winner: winner?.factionName ?? "", player: winner?.player ?? "",
        rows: e.results.map(r => ({ ...r, label: game.i18n.localize(GAME_RESULTS[r.result] ?? r.result) }))
      });
      await ChatMessage.implementation.create({ content, flags: { [SYSTEM_ID]: { card: true } } });
      this.stepIndex += 1;
    });
  }

  /* -------------------------------------------- */
  /*  Victor and reward                           */
  /* -------------------------------------------- */

  static async #onSign() {
    const winner = this.#winnerRow;
    if ( !winner || this.end.signature ) return;
    await this.run(async () => {
      const campaign = state.getCampaign();
      const answer = await ask(winner.playerId, "signature", {
        title: game.i18n.format("RL.Wizard.Prompt.signFor", { name: winner.player }),
        line: this.end.game, player: winner.player, date: today(),
        victors: campaign.system.victors.map(g => ({ number: g.number, player: g.winner.player, motto: g.winner.motto, date: g.date }))
      });
      if ( !answer ) return;
      this.end.signature = { ...answer, playerId: winner.playerId };
      await legacy.recordGame({
        number: this.end.game, date: answer.date, signed: true,
        winner: { faction: winner.faction, factionName: winner.factionName, player: answer.player, playerId: winner.playerId, motto: answer.motto }
      });
      await this.#save();
      this.stepIndex += 1;
    });
  }

  static async #onReward() {
    const winner = this.#winnerRow;
    if ( !winner || this.end.reward ) return;
    await this.run(async () => {
      const campaign = state.getCampaign();
      const choice = await ask(winner.playerId, "winnerReward", {
        title: game.i18n.format("RL.Wizard.Prompt.rewardFor", { name: winner.player }),
        available: this.#winnerAvailability(), stickers: { ...campaign.system.stickers }
      });
      if ( !choice ) return;
      const by = this.end.signature?.player ?? winner.player;
      await this.#applyWinnerReward(choice, winner, by);
      this.end.reward = choice;
      await legacy.recordGame({ number: this.end.game, reward: choice.reward, rewardDetail: rewardSummary(choice) });
      await this.#save();
      this.stepIndex += 1;
    });
  }

  /** The winner's reward, through the same placement operations as the Sticker Sheet. */
  async #applyWinnerReward(choice, winner, by) {
    return applyReward(choice, { by, byId: winner.playerId });
  }

  /* -------------------------------------------- */
  /*  Held on                                     */
  /* -------------------------------------------- */

  static async #onHeldOn() {
    await this.run(async () => {
      for ( const row of this.#heldOnRows ) {
        if ( this.end.heldOn[row.faction] ) continue;
        const available = this.#heldOnAvailability(row);
        if ( !available.foundMinorCity.ok && !available.upgradeCard.ok ) {
          // "If there are no more Coins or Minor Cities to place, the losers no longer gain any additional rewards."
          this.end.heldOn[row.faction] = "skip";
          await this.#save();
          continue;
        }
        this.note(game.i18n.format("RL.Wizard.End.waitingHeldOn", { name: row.player }));
        const campaign = state.getCampaign();
        const choice = await ask(row.playerId, "heldOnReward", {
          title: game.i18n.format("RL.Wizard.Prompt.heldOnFor", { name: row.player, faction: row.factionName }),
          factionName: row.factionName, available, stickers: { ...campaign.system.stickers }
        });
        if ( !choice ) {
          ui.notifications.info(game.i18n.format("RL.Wizard.Setup.paused", { name: row.player }));
          return;
        }
        await applyReward(choice, { by: row.player, byId: row.playerId });
        this.end.heldOn[row.faction] = choice;
        await this.#recordHeldOn(row, choice);
        await this.#save();
        this.render();
      }
    });
  }

  async #recordHeldOn(row, choice) {
    const campaign = state.getCampaign();
    const entry = campaign.system.games.find(g => g.number === this.end.game);
    if ( !entry ) return;
    const results = entry.toObject?.()?.results ?? foundry.utils.deepClone(entry.results);
    const r = results.find(x => x.faction === row.faction);
    if ( r ) {
      r.reward = choice === "skip" ? "" : choice.reward;
      r.rewardDetail = choice === "skip" ? "" : rewardSummary(choice);
    }
    await legacy.recordGame({ number: this.end.game, results });
  }

  static async #onSkipHeldOn(event, target) {
    const row = this.end.results.find(r => r.faction === target.dataset.faction);
    if ( !row || this.end.heldOn[row.faction] ) return;
    this.end.heldOn[row.faction] = "skip";
    await this.#save();
    this.render();
  }

  /* -------------------------------------------- */
  /*  Naming the world                            */
  /* -------------------------------------------- */

  /** Who names the world: the most signatures, or the roll-off winner. */
  #worldNamer() {
    const totals = state.getCampaign()?.system.signatureTotals ?? [];
    if ( !totals.length ) return null;
    const top = totals.filter(t => t.count === totals[0].count);
    if ( top.length === 1 ) return top[0];
    return this.end.rollOff?.winner ?? null;
  }

  /** Ties roll off, +1 per continent the player named. */
  static async #onRollOff() {
    await this.run(async () => {
      const campaign = state.getCampaign();
      const totals = campaign.system.signatureTotals;
      let tied = totals.filter(t => t.count === totals[0].count);
      const named = t => Object.values(campaign.system.continents ?? {})
        .filter(c => c.name && ((t.playerId && (c.namedById === t.playerId)) || (!t.playerId && (c.namedBy === t.player)))).length;
      const rounds = [];
      const rolls = [];
      let winner = null;
      while ( !winner && (rounds.length < 20) ) {
        const round = [];
        for ( const t of tied ) {
          const bonus = named(t);
          const roll = await new Roll(`1d6 + ${bonus}`).evaluate();
          rolls.push(roll);
          round.push({ ...t, bonus, total: roll.total });
        }
        rounds.push(round);
        const max = Math.max(...round.map(r => r.total));
        const best = round.filter(r => r.total === max);
        if ( best.length === 1 ) winner = best[0];
        else tied = best;
      }
      this.end.rollOff = { rounds, winner: winner ? { playerId: winner.playerId, player: winner.player, count: winner.count } : null };
      await this.#save();
      await ChatMessage.implementation.create({
        content: `<div class="risklegacy rl-chat-card rl-campaign-chat">
          <div class="rl-chat-card__head"><h3 class="rl-chat-card__title">${esc(game.i18n.localize("RL.Wizard.End.rollOff"))}</h3></div>
          <div class="rl-chat-card__body">${rounds.map(round => `<p>${round.map(r => `${esc(r.player)}: <b>${r.total}</b>${r.bonus ? ` (+${r.bonus})` : ""}`).join(" · ")}</p>`).join("")}</div>
          <div class="rl-chat-card__result">${esc(game.i18n.format("RL.Wizard.End.namesTheWorld", { name: winner?.player ?? "?" }))}</div>
        </div>`,
        rolls, flags: { [SYSTEM_ID]: { card: true } }
      });
    });
  }

  static async #onNameWorld() {
    const namer = this.#worldNamer();
    if ( !namer || this.end.world ) return;
    await this.run(async () => {
      const answer = await ask(namer.playerId || null, "worldName", {
        title: game.i18n.format("RL.Wizard.Prompt.worldFor", { name: namer.player })
      });
      if ( !answer ) return;
      await legacy.nameWorld({ name: answer.name, namedBy: namer.player, namedById: namer.playerId });
      this.end.world = { name: answer.name, by: namer.player };
      await this.#save();
      this.stepIndex += 1;
    });
  }

  /* -------------------------------------------- */
  /*  Packages and finish                         */
  /* -------------------------------------------- */

  static async #onOpenPack(event, target) {
    const packId = target.dataset.pack;
    await this.run(async () => {
      const deferred = peekDeferred().find(d => d.packId === packId);
      setDeferring(false);
      try {
        await openPack(packId, { faction: deferred?.faction ?? "", context: deferred?.context ?? {} });
      } finally {
        setDeferring(true);
      }
      if ( !this.end.opened.includes(packId) ) this.end.opened.push(packId);
      await this.#save();
    });
  }

  static async #onFinish() {
    if ( !game.user.isGM ) return;
    await this.run(async () => {
      const campaign = state.getCampaign();
      this.end.finished = true;
      await this.#save();
      await campaign.update({ "system.documents.war": "" });
      for ( const actor of state.getFactions({ active: true }) ) await actor.update({ "system.war.active": false });
      const left = this.#pendingPacks().filter(id => !campaign.system.isPackOpen(id));
      if ( left.length ) {
        ui.notifications.info(game.i18n.format("RL.Wizard.End.packsLeft", { list: left.map(packLabel).join(", ") }));
      }
    });
    await this.close();
    const { openLanding } = await import("./landing.mjs");
    openLanding();
  }
}

/**
 * Open the end-of-game wizard (GM). Called by the turn area when a war ends.
 * @param {object} [options]
 * @param {Combat} [options.war]
 */
export function openEndGame({ war } = {}) {
  if ( !game.user.isGM ) return null;
  if ( !state.getCampaign() ) return ui.notifications.warn("RL.Error.noCampaign", { localize: true });
  const existing = foundry.applications.instances.get("rl-end-game");
  const app = existing ?? new EndGameWizard({ war });
  return app.render({ force: true });
}

