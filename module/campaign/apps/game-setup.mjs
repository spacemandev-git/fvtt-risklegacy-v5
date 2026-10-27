import { STARTING_TROOPS, SYSTEM_ID, TERRITORY_IDS, systemPath } from "../../config.mjs";
import * as state from "../../state/_module.mjs";
import { ask } from "../ask.mjs";
import { api, callArea, esc, territoryName, tpl } from "../common.mjs";
import { factionCard } from "./prompts.mjs";
import CampaignWizard from "./wizard.mjs";

/**
 * "Setup before every game".
 *
 * 1. Players: who takes part this game, in seating order (clockwise).
 * 2. Pick order: everyone rolls a die (ties re-roll); selection goes clockwise from the high roller. Each player's
 *    Red Star token or Missiles (one per signature) is shown.
 * 3. Factions: in pick order, each player chooses a faction on their own screen. If the Minor Cities rules
 *    (rulebook additions B–D) are in the book, this is the snake draft of factions and draft cards instead.
 * 4. Deploy: clear last game's pieces, set up the sideboard, create the war, give each player their faction
 *    (token ownership), deal scars (and the draft's coin cards), then each player picks a legal starting territory
 *    on the board, in placement order.
 * 5. Done: the backs of the faction cards are written (player + starting territory, "X" for factions not chosen).
 *
 * Players choose factions before anyone places, then place in order (the turn API creates the war with every
 * faction known). Progress is saved on the campaign actor (flag `setup`) so the wizard can be reopened.
 */
export default class GameSetupWizard extends CampaignWizard {
  static DEFAULT_OPTIONS = {
    id: "rl-game-setup",
    classes: ["rl-wizard--setup"],
    window: { title: "RL.Wizard.Setup.title", icon: "fa-solid fa-chess-board" },
    actions: {
      togglePlayer: GameSetupWizard.#onTogglePlayer,
      movePlayer: GameSetupWizard.#onMovePlayer,
      roll: GameSetupWizard.#onRoll,
      choose: GameSetupWizard.#onChoose,
      resetChoices: GameSetupWizard.#onResetChoices,
      deploy: GameSetupWizard.#onDeploy,
      place: GameSetupWizard.#onPlace,
      finish: GameSetupWizard.#onFinish,
      restart: GameSetupWizard.#onRestart,
      // Bot players (module/bots): the Bot Manager adds them; the wizard re-renders when the new User appears
      addBot: () => api("bots", "openBotManager")?.()
    }
  };

  static STEPS = [
    { id: "players", label: "RL.Wizard.Setup.stepPlayers", template: tpl("setup/players") },
    { id: "order", label: "RL.Wizard.Setup.stepOrder", template: tpl("setup/order") },
    { id: "factions", label: "RL.Wizard.Setup.stepFactions", template: tpl("setup/factions"), when() { return !this.draft; } },
    { id: "draft", label: "RL.Wizard.Setup.stepDraft", template: tpl("setup/draft"), when() { return this.draft; } },
    { id: "deploy", label: "RL.Wizard.Setup.stepDeploy", template: tpl("setup/deploy") },
    { id: "done", label: "RL.Wizard.Setup.stepDone", template: tpl("setup/done") }
  ];

  static PARTS = CampaignWizard.basePARTS(GameSetupWizard.STEPS.map(s => s.template));

  constructor(options) {
    super(options);
    const campaign = state.getCampaign();
    this.draft = !!campaign?.system.rulesAdditions?.B;
    const saved = campaign?.getFlag(SYSTEM_ID, "setup");
    const game = campaign?.system.nextGameNumber ?? 1;
    this.setup = (saved?.game === game) && !saved.finished ? foundry.utils.deepClone(saved) : this.#fresh(game);
    if ( this.setup.recorded ) this.stepIndex = this.steps.length - 1;
    else if ( this.setup.deployed ) this.stepIndex = this.steps.findIndex(s => s.id === "deploy");
  }

  #fresh(gameNumber) {
    const users = game.users.filter(u => !u.isGM && u.active);
    const players = (users.length ? users : game.users.filter(u => !u.isGM)).map(u => ({ userId: u.id, name: u.name }));
    return {
      game: gameNumber, players, rounds: [], first: "", order: [], picks: {}, draft: {}, draftLog: [],
      deployed: false, placed: {}, recorded: false, finished: false
    };
  }

  async #save() {
    const campaign = state.getCampaign();
    if ( campaign && game.user.isGM ) await campaign.setFlag(SYSTEM_ID, "setup", this.setup);
  }

  /* -------------------------------------------- */
  /*  Derived data                                */
  /* -------------------------------------------- */

  /** Signatures → starting tokens. */
  #tokens(userId, name) {
    const campaign = state.getCampaign();
    const signatures = campaign?.system.signaturesOf(userId, name) ?? 0;
    return { signatures, redStar: signatures === 0, missiles: signatures };
  }

  /** Draft cards in play for this many players. */
  #draftCards() {
    const n = this.setup.players.length;
    return (state.getPack("minorcities")?.draft ?? []).filter(c => (c.players ?? 0) <= n);
  }

  /** The faction each player plays. */
  #factionOf(userId) {
    return this.draft ? (this.setup.draft[userId]?.faction ?? "") : (this.setup.picks[userId] ?? "");
  }

  /** Draft card value held by a player, by type. */
  #draftValue(userId, type) {
    const id = this.setup.draft[userId]?.[type];
    return id ? (state.findEntry("draft", id)?.value ?? null) : null;
  }

  /** Participants with seats (turn order). */
  #participants() {
    const list = this.setup.order.map((userId, i) => ({
      userId, name: this.setup.players.find(p => p.userId === userId)?.name ?? "", faction: this.#factionOf(userId), pick: i
    }));
    if ( this.draft ) list.sort((a, b) => (this.#draftValue(a.userId, "turnOrder") ?? 99) - (this.#draftValue(b.userId, "turnOrder") ?? 99));
    return list.map((p, seat) => ({ ...p, seat }));
  }

  /** Faction ids in starting-placement order. */
  #placementOrder() {
    const list = [...this.#participants()];
    if ( this.draft ) list.sort((a, b) => (this.#draftValue(a.userId, "placement") ?? 99) - (this.#draftValue(b.userId, "placement") ?? 99));
    else list.sort((a, b) => a.pick - b.pick);
    return list.map(p => p.faction).filter(Boolean);
  }

  #troopsFor(factionId) {
    if ( !this.draft ) return STARTING_TROOPS;
    const p = this.#participants().find(x => x.faction === factionId);
    return this.#draftValue(p?.userId, "troops") ?? STARTING_TROOPS;
  }

  #availableFactions() {
    const taken = new Set(this.setup.players.map(p => this.#factionOf(p.userId)).filter(Boolean));
    return state.getFactions().filter(f => !taken.has(f.id)).map(f => f.id);
  }

  /** Snake draft order: clockwise from the high roller, then back, until everyone has 5 picks. */
  #draftSequence() {
    const order = this.setup.order;
    const seq = [];
    for ( let round = 0; round < 5; round++ ) seq.push(...(round % 2 ? [...order].reverse() : order));
    return seq;
  }

  /** Legal starting territories for a faction (rules area, or our own reading of p. 7). */
  #legalStarts(factionId, userId) {
    const snapshot = state.buildSnapshot();
    const fn = api("rules", "legalStartingTerritories");
    if ( fn && snapshot ) {
      try {
        const result = fn(snapshot, factionId, { joining: false });
        if ( Array.isArray(result) ) return result;
      } catch(err) {
        console.warn(`${SYSTEM_ID} | campaign: rules.legalStartingTerritories failed`, err);
      }
    }
    if ( !snapshot ) return [...TERRITORY_IDS];
    return Object.values(snapshot.territories).filter(t => {
      const occupied = Object.values(t.pieces).some(p => (p.troops > 0) || p.hq);
      if ( occupied ) return false;
      const ownMajor = (t.city?.type === "major") && (t.city.founderId === userId);
      // A cancelled scar (white sticker) leaves the territory without a scar (p. 14).
      const unmarked = !t.city && !t.scar && !t.marks.filter(m => m !== "cancel_scar").length;
      if ( !unmarked && !ownMajor ) return false;
      return !t.neighbors.some(n => snapshot.territories[n]?.hq);
    }).map(t => t.id);
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  async _prepareStep(stepId) {
    const s = this.setup;
    const base = { draft: this.draft, gameNumber: s.game, deployed: s.deployed };
    const playerRow = p => {
      const tokens = this.#tokens(p.userId, p.name);
      const user = game.users.get(p.userId);
      const faction = game.actors.get(this.#factionOf(p.userId));
      const bot = api("bots", "botDifficulty")?.(p.userId);   // bot players (module/bots): "BOT · Warlord"
      return {
        ...p, ...tokens, color: user?.color?.css ?? "#888", active: !!user?.active,
        bot: bot ? game.i18n.format("RL.Bots.Tag", { difficulty: game.risklegacy.bots.difficultyLabel(bot) }) : "",
        faction: faction ? { id: faction.id, name: faction.name, img: faction.img, key: faction.system.key } : null
      };
    };
    switch ( stepId ) {
      case "players": {
        const included = new Set(s.players.map(p => p.userId));
        const others = game.users.filter(u => !included.has(u.id)).map(u => ({ userId: u.id, name: u.name }));
        return {
          ...base,
          players: s.players.map((p, i) => ({ ...playerRow(p), n: i + 1, included: true, first: i === 0, last: i === s.players.length - 1 })),
          others: others.map(p => ({ ...playerRow(p), included: false, gm: game.users.get(p.userId)?.isGM })),
          count: s.players.length, countOk: (s.players.length >= 3) && (s.players.length <= 5)
        };
      }
      case "order": return {
        ...base,
        rounds: s.rounds.map((round, i) => ({
          n: i + 1, rolls: round.map(r => ({ ...r, name: game.users.get(r.userId)?.name ?? "?", top: r.top }))
        })),
        first: game.users.get(s.first)?.name ?? "",
        orderList: s.order.map((userId, i) => playerRow({ userId, name: game.users.get(userId)?.name ?? "", n: i + 1 }))
      };
      case "factions": {
        const pending = s.order.find(userId => !s.picks[userId]);
        return {
          ...base,
          orderList: s.order.map((userId, i) => ({
            ...playerRow({ userId, name: game.users.get(userId)?.name ?? "" }), n: i + 1, current: userId === pending
          })),
          available: this.#availableFactions().map(id => factionCard(game.actors.get(id))),
          complete: !pending
        };
      }
      case "draft": {
        const seq = this.#draftSequence();
        const nextIndex = s.draftLog.length;
        const cards = this.#draftCards();
        const taken = new Set(Object.values(s.draft).flatMap(d => Object.entries(d).filter(([k]) => k !== "faction").map(([, v]) => v)));
        return {
          ...base,
          rows: s.order.map((userId, i) => {
            const d = s.draft[userId] ?? {};
            const card = id => (id ? state.findEntry("draft", id) : null);
            return {
              ...playerRow({ userId, name: game.users.get(userId)?.name ?? "" }), n: i + 1,
              current: seq[nextIndex] === userId,
              turnOrder: card(d.turnOrder)?.name ?? "", placement: card(d.placement)?.name ?? "",
              troops: card(d.troops)?.name ?? "", coin: card(d.coin)?.name ?? ""
            };
          }),
          sequence: seq.map((userId, i) => ({ name: game.users.get(userId)?.name ?? "?", done: i < nextIndex, current: i === nextIndex })),
          cards: cards.filter(c => !taken.has(c.id)).map(c => ({ ...c, img: systemPath(c.img) })),
          available: this.#availableFactions().map(id => factionCard(game.actors.get(id))),
          complete: nextIndex >= seq.length,
          hasDraftCards: cards.length > 0
        };
      }
      case "deploy": {
        const participants = this.#participants();
        const order = this.#placementOrder();
        return {
          ...base,
          seats: participants.map(p => ({
            ...playerRow(p), seat: p.seat + 1, troops: this.#troopsFor(p.faction),
            coins: this.draft ? (this.#draftValue(p.userId, "coin") ?? 0) : null
          })),
          placement: order.map((factionId, i) => {
            const actor = game.actors.get(factionId);
            const p = participants.find(x => x.faction === factionId);
            const placed = s.placed[factionId];
            return {
              n: i + 1, faction: actor?.name ?? "?", key: actor?.system.key, img: actor?.img, player: p?.name ?? "",
              territory: placed ? territoryName(placed) : "", current: !placed && (order.find(f => !s.placed[f]) === factionId)
            };
          }),
          allPlaced: order.every(f => s.placed[f])
        };
      }
      case "done": return {
        ...base,
        seats: this.#participants().map(p => ({
          ...playerRow(p), seat: p.seat + 1,
          territory: territoryName(s.placed[p.faction] ?? "")
        })),
        absent: state.getFactions().filter(f => !this.#participants().some(p => p.faction === f.id)).map(f => f.name),
        warRoom: !!api("apps", "openWarRoom")
      };
      default: return base;
    }
  }

  _canAdvance(stepId) {
    const s = this.setup;
    switch ( stepId ) {
      case "players": return s.players.length >= 2;
      case "order": return !!s.first;
      case "factions": return s.order.every(u => s.picks[u]);
      case "draft": return s.draftLog.length >= this.#draftSequence().length;
      case "deploy": return s.deployed && this.#placementOrder().every(f => s.placed[f]) && s.recorded;
      default: return true;
    }
  }

  _canGoBack(stepId) {
    return !this.setup.deployed;
  }

  _footerButtons(stepId) {
    const s = this.setup;
    switch ( stepId ) {
      case "players": return s.rounds.length ? [{ action: "restart", label: "RL.Wizard.Setup.restart", icon: "fa-solid fa-rotate-left", disabled: s.deployed }] : [];
      case "order": return [{ action: "roll", label: s.first ? "RL.Wizard.Setup.reroll" : "RL.Wizard.Setup.roll",
        icon: "fa-solid fa-dice-six", primary: !s.first, disabled: s.deployed || Object.keys(s.picks).length > 0 }];
      case "factions":
      case "draft": {
        const complete = this._canAdvance(stepId);
        return [
          { action: "resetChoices", label: "RL.Wizard.Setup.resetChoices", icon: "fa-solid fa-rotate-left", disabled: s.deployed },
          { action: "choose", label: stepId === "draft" ? "RL.Wizard.Setup.startDraft" : "RL.Wizard.Setup.startChoosing",
            icon: "fa-solid fa-hand-pointer", primary: !complete, disabled: complete }
        ];
      }
      case "deploy":
        if ( !s.deployed ) return [{ action: "deploy", label: "RL.Wizard.Setup.deploy", icon: "fa-solid fa-truck-ramp-box", primary: true }];
        return [{ action: "place", label: "RL.Wizard.Setup.place", icon: "fa-solid fa-location-dot",
          primary: !this._canAdvance("deploy"), disabled: this._canAdvance("deploy") }];
      case "done": return [{ action: "finish", label: "RL.Wizard.Setup.finish", icon: "fa-solid fa-flag", primary: true }];
      default: return [];
    }
  }

  /* -------------------------------------------- */
  /*  Players and pick order                      */
  /* -------------------------------------------- */

  static async #onTogglePlayer(event, target) {
    if ( this.setup.deployed ) return;
    const userId = target.dataset.user;
    const index = this.setup.players.findIndex(p => p.userId === userId);
    if ( index >= 0 ) this.setup.players.splice(index, 1);
    else this.setup.players.push({ userId, name: game.users.get(userId)?.name ?? "" });
    this.#resetFrom("players");
    await this.#save();
    this.render();
  }

  static async #onMovePlayer(event, target) {
    if ( this.setup.deployed ) return;
    const players = this.setup.players;
    const i = players.findIndex(p => p.userId === target.dataset.user);
    const j = i + (target.dataset.dir === "up" ? -1 : 1);
    if ( (i < 0) || (j < 0) || (j >= players.length) ) return;
    [players[i], players[j]] = [players[j], players[i]];
    this.#resetFrom("players");
    await this.#save();
    this.render();
  }

  /** Changing an earlier step clears the later choices. */
  #resetFrom(stepId) {
    if ( this.setup.deployed ) return;
    if ( stepId === "players" ) {
      this.setup.rounds = [];
      this.setup.first = "";
      this.setup.order = [];
    }
    this.setup.picks = {};
    this.setup.draft = {};
    this.setup.draftLog = [];
  }

  /** Roll a d6 each; ties for the highest roll again. */
  static async #onRoll() {
    if ( this.setup.deployed ) return;
    await this.run(async () => {
      const players = this.setup.players;
      let contenders = players.map(p => p.userId);
      const rounds = [];
      const rolls = [];
      let first = "";
      while ( !first ) {
        const round = [];
        for ( const userId of contenders ) {
          const roll = await new Roll("1d6").evaluate();
          rolls.push(roll);
          round.push({ userId, value: roll.total });
        }
        const max = Math.max(...round.map(r => r.value));
        const top = round.filter(r => r.value === max);
        for ( const r of round ) r.top = r.value === max;
        rounds.push(round);
        if ( (top.length === 1) || (rounds.length >= 20) ) first = top[0].userId;
        else contenders = top.map(r => r.userId);
      }
      const start = players.findIndex(p => p.userId === first);
      this.setup.rounds = rounds;
      this.setup.first = first;
      this.setup.order = [...players.slice(start), ...players.slice(0, start)].map(p => p.userId);
      this.#resetFrom("order");
      await this.#save();

      const content = await foundry.applications.handlebars.renderTemplate(tpl("chat/pick-order"), {
        game: this.setup.game,
        rounds: rounds.map((round, i) => ({
          n: i + 1, tie: i > 0,
          rolls: round.map(r => ({ name: game.users.get(r.userId)?.name ?? "?", value: r.value, top: r.top }))
        })),
        first: game.users.get(first)?.name ?? "",
        order: this.setup.order.map(id => game.users.get(id)?.name ?? "?"),
        draft: this.draft
      });
      await ChatMessage.implementation.create({
        content, rolls, sound: CONFIG.sounds.dice,
        flags: { [SYSTEM_ID]: { card: true } }
      });
    });
  }

  /* -------------------------------------------- */
  /*  Faction choice / draft                      */
  /* -------------------------------------------- */

  static async #onChoose() {
    if ( this.setup.deployed ) return;
    await this.run(() => (this.draft ? this.#runDraft() : this.#chooseFactions()));
  }

  static async #onResetChoices() {
    if ( this.setup.deployed ) return;
    this.#resetFrom("order");
    await this.#save();
    this.render();
  }

  async #announce(text) {
    await ChatMessage.implementation.create({
      content: `<div class="risklegacy rl-chat-card rl-campaign-chat"><div class="rl-chat-card__body"><p>${esc(text)}</p></div></div>`,
      flags: { [SYSTEM_ID]: { card: true } }
    });
  }

  async #chooseFactions() {
    for ( const userId of this.setup.order ) {
      if ( this.setup.picks[userId] ) continue;
      const user = game.users.get(userId);
      const available = this.#availableFactions();
      this.note(game.i18n.format("RL.Wizard.Setup.waitingFaction", { name: user?.name ?? "?" }));
      const faction = await ask(user, "faction", {
        factions: available,
        title: game.i18n.format("RL.Wizard.Prompt.factionFor", { name: user?.name ?? "" })
      });
      if ( !faction ) {
        ui.notifications.info(game.i18n.format("RL.Wizard.Setup.paused", { name: user?.name ?? "?" }));
        return;
      }
      if ( !this.#availableFactions().includes(faction) ) continue;
      this.setup.picks[userId] = faction;
      await this.#save();
      await this.#announce(game.i18n.format("RL.Wizard.Setup.choseFaction", {
        name: user?.name ?? "?", faction: game.actors.get(faction)?.name ?? "?"
      }));
      this.render();
    }
  }

  async #runDraft() {
    const seq = this.#draftSequence();
    const cards = this.#draftCards();
    for ( let i = this.setup.draftLog.length; i < seq.length; i++ ) {
      const userId = seq[i];
      const user = game.users.get(userId);
      const mine = this.setup.draft[userId] ??= {};
      const heldTypes = Object.keys(mine).filter(k => k !== "faction");
      const taken = new Set(Object.values(this.setup.draft).flatMap(d => Object.entries(d).filter(([k]) => k !== "faction").map(([, v]) => v)));
      const availableCards = cards.filter(c => !taken.has(c.id) && !heldTypes.includes(c.type)).map(c => c.id);
      const availableFactions = mine.faction ? [] : this.#availableFactions();
      if ( !availableCards.length && !availableFactions.length ) {
        this.setup.draftLog.push({ userId, type: "skip", id: "" });
        continue;
      }
      this.note(game.i18n.format("RL.Wizard.Setup.waitingDraft", { name: user?.name ?? "?" }));
      const pick = await ask(user, "draft", {
        title: game.i18n.format("RL.Wizard.Prompt.draftFor", { name: user?.name ?? "" }),
        factions: availableFactions, cards: availableCards, heldTypes, hasFaction: !!mine.faction
      });
      if ( !pick ) {
        ui.notifications.info(game.i18n.format("RL.Wizard.Setup.paused", { name: user?.name ?? "?" }));
        return;
      }
      let label;
      if ( pick.type === "faction" ) {
        if ( mine.faction || !this.#availableFactions().includes(pick.id) ) { i--; continue; }
        mine.faction = pick.id;
        label = game.actors.get(pick.id)?.name ?? "?";
      } else {
        const card = state.findEntry("draft", pick.id);
        if ( !card || mine[card.type] || taken.has(card.id) ) { i--; continue; }
        mine[card.type] = card.id;
        label = `${game.i18n.localize(`RL.Wizard.Draft.type.${card.type}`)}: ${card.name}`;
      }
      this.setup.draftLog.push({ userId, type: pick.type, id: pick.id });
      await this.#save();
      await this.#announce(game.i18n.format("RL.Wizard.Setup.drafted", { name: user?.name ?? "?", pick: label }));
      this.render();
    }
  }

  /* -------------------------------------------- */
  /*  Deploy and starting placement               */
  /* -------------------------------------------- */

  static async #onDeploy() {
    if ( !game.user.isGM || this.setup.deployed ) return;
    await this.run(async () => {
      const missing = [];
      const participants = this.#participants();
      const factionIds = participants.map(p => p.faction);
      if ( factionIds.some(f => !f) ) throw new Error(game.i18n.localize("RL.Wizard.Setup.noFaction"));

      this.note(game.i18n.localize("RL.Wizard.Setup.noteClear"));
      await callArea("board", "clearPieces", {}, missing);
      this.note(game.i18n.localize("RL.Wizard.Setup.noteSideboard"));
      await callArea("cards", "setupSideboard", {}, missing);

      this.note(game.i18n.localize("RL.Wizard.Setup.noteWar"));
      const payload = participants.map(p => ({ faction: p.faction, userId: p.userId, seat: p.seat }));
      if ( api("turn", "createWar") ) await callArea("turn", "createWar", { participants: payload }, missing);
      else {
        missing.push("turn.createWar");
        await this.#fallbackWarState(participants);
      }

      // Each player owns their faction (so they can move their own pieces).
      const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
      for ( const actor of state.getFactions() ) {
        const p = participants.find(x => x.faction === actor.id);
        const ownership = { default: L.OBSERVER };
        // Keep GM/assistant entries; last game's players lose ownership of this faction.
        for ( const [id, level] of Object.entries(actor.ownership) ) {
          if ( (id !== "default") && game.users.get(id)?.isGM ) ownership[id] = level;
        }
        if ( p ) ownership[p.userId] = L.OWNER;
        await actor.update({ ownership }, { recursive: false, diff: false });
      }

      // Bringer of Nuclear Fire: +2 Missiles when the Mutants play too (rules addition A). turn.createWar already
      // added them to system.war.missiles; only announce it here.
      const mutantsIn = participants.some(p => game.actors.get(p.faction)?.system.key === "mutants");
      if ( mutantsIn ) {
        for ( const p of participants ) {
          const actor = game.actors.get(p.faction);
          if ( !actor?.items.some(i => i.system.key === "bringer_of_nuclear_fire") ) continue;
          await this.#announce(game.i18n.format("RL.Wizard.Setup.bringer", { faction: actor.name }));
        }
      }

      this.note(game.i18n.localize("RL.Wizard.Setup.noteScars"));
      await callArea("cards", "dealScars", { factions: factionIds }, missing);

      if ( this.draft ) {
        for ( const p of participants ) {
          const coins = this.#draftValue(p.userId, "coin") ?? 0;
          if ( coins > 0 ) await this.#giveCoins(p.faction, coins, missing);
        }
      }

      const order = this.#placementOrder();
      await callArea("turn", "beginPlacement", { order }, missing);
      this.setup.deployed = true;
      await this.#save();
      if ( missing.length ) ui.notifications.warn(game.i18n.format("RL.Wizard.Setup.missing", { list: [...new Set(missing)].join(", ") }));
    });
  }

  /** Without the turn area: write each faction's per-war state ourselves. */
  async #fallbackWarState(participants) {
    for ( const actor of state.getFactions() ) {
      const p = participants.find(x => x.faction === actor.id);
      if ( !p ) {
        await actor.update({ "system.war.active": false });
        continue;
      }
      const tokens = this.#tokens(p.userId, p.name);
      await actor.update({
        "system.war": {
          active: true, playerId: p.userId, playerName: p.name, seat: p.seat,
          redStarTokens: tokens.redStar ? 1 : 0, missiles: tokens.missiles, reserve: 0,
          startingTerritory: "", status: "playing", knockedOut: []
        }
      });
      for ( const item of actor.items.filter(i => (i.type === "power") && i.system.used) ) await item.update({ "system.used": false });
    }
  }

  /** Draft: starting coin cards from the coin pile to the faction's hand. */
  async #giveCoins(factionId, count, missing) {
    if ( api("cards", "giveCoinCards") ) return callArea("cards", "giveCoinCards", { faction: factionId, count }, missing);
    await callArea("cards", "ensureHand", { faction: factionId }, missing);
    const hand = state.getHand(factionId);
    const pile = state.getCardStack("coinDeck");
    if ( !hand || !pile ) {
      missing.push("cards.giveCoinCards");
      return null;
    }
    const ids = pile.cards.filter(c => c.type === "coin").slice(0, count).map(c => c.id);
    if ( ids.length ) await pile.pass(hand, ids, { chatNotification: false });
    return ids;
  }

  static async #onPlace() {
    if ( !game.user.isGM || !this.setup.deployed ) return;
    await this.run(() => this.#placeAll());
  }

  async #placeAll() {
    const missing = [];
    const participants = this.#participants();
    for ( const factionId of this.#placementOrder() ) {
      if ( this.setup.placed[factionId] ) continue;
      const p = participants.find(x => x.faction === factionId);
      const user = game.users.get(p?.userId);
      const actor = game.actors.get(factionId);
      const allowed = this.#legalStarts(factionId, p?.userId);
      if ( !allowed.length ) {
        ui.notifications.error(game.i18n.format("RL.Wizard.Setup.noStart", { faction: actor?.name ?? "?" }));
        return;
      }
      this.note(game.i18n.format("RL.Wizard.Setup.waitingStart", { name: user?.name ?? "?", faction: actor?.name ?? "?" }));
      const troops = this.#troopsFor(factionId);
      const territory = await ask(user, "territory", {
        title: game.i18n.format("RL.Wizard.Prompt.startFor", { faction: actor?.name ?? "" }),
        hint: game.i18n.format("RL.Wizard.Prompt.startHint", { troops }),
        allowed, board: true, faction: factionId
      });
      if ( !territory ) {
        ui.notifications.info(game.i18n.format("RL.Wizard.Setup.paused", { name: user?.name ?? "?" }));
        return;
      }
      if ( !this.#legalStarts(factionId, p?.userId).includes(territory) ) {
        ui.notifications.warn(game.i18n.format("RL.Wizard.Ask.notAllowed", { territory: territoryName(territory) }));
        return this.#placeAll();
      }
      if ( api("turn", "placeStartingForces") ) {
        await callArea("turn", "placeStartingForces", { faction: factionId, territory, troops }, missing);
      } else {
        missing.push("turn.placeStartingForces");
        await callArea("board", "spawnPieces", { faction: factionId, territory, troops, hq: true }, missing);
        await actor?.update({ "system.war.startingTerritory": territory });
      }
      if ( (troops !== STARTING_TROOPS) && api("board", "setTroops") ) {
        const snapshot = state.buildSnapshot();
        if ( snapshot?.territories[territory]?.troops !== troops ) {
          await callArea("board", "setTroops", { faction: factionId, territory, count: troops }, missing);
        }
      }
      this.setup.placed[factionId] = territory;
      await this.#save();
      await this.#announce(game.i18n.format("RL.Wizard.Setup.placed", {
        faction: actor?.name ?? "?", territory: territoryName(territory), troops
      }));
      this.render();
    }
    if ( !this.setup.recorded ) await this.#afterPlacement(missing);
    if ( missing.length ) ui.notifications.warn(game.i18n.format("RL.Wizard.Setup.missing", { list: [...new Set(missing)].join(", ") }));
  }

  /** Lead faction in the World Capital, then the backs of the faction cards. */
  async #afterPlacement(missing) {
    const campaign = state.getCampaign();
    const participants = this.#participants();
    if ( campaign?.system.isPackOpen("worldcapital") ) {
      const capital = Object.entries(campaign.system.territories ?? {}).find(([, t]) => t.city?.type === "capital")?.[0];
      const ranked = participants.map(p => ({ ...p, wins: game.actors.get(p.faction)?.system.wins ?? 0 }))
        .sort((a, b) => b.wins - a.wins);
      const lead = (ranked.length && ranked[0].wins > 0 && (ranked[1]?.wins !== ranked[0].wins)) ? ranked[0] : null;
      if ( lead && capital ) {
        await callArea("board", "spawnPieces", { faction: lead.faction, territory: capital, troops: 3, hq: false }, missing);
        await this.#announce(game.i18n.format("RL.Wizard.Setup.leadFaction", {
          faction: game.actors.get(lead.faction)?.name ?? "?", territory: territoryName(capital)
        }));
      }
    }
    // The back of every faction card: player and starting territory, or an "X".
    const n = this.setup.game;
    for ( const actor of state.getFactions() ) {
      const p = participants.find(x => x.faction === actor.id);
      const history = actor.system.toObject().history.filter(h => h.game !== n);
      history.push(p
        ? { game: n, player: p.name, startingTerritory: this.setup.placed[actor.id] ?? "", result: "" }
        : { game: n, player: "X", startingTerritory: "", result: "absent" });
      history.sort((a, b) => a.game - b.game);
      await actor.update({ "system.history": history });
    }
    this.setup.recorded = true;
    await this.#save();
    this.stepIndex = this.steps.findIndex(s => s.id === "done");
  }

  static async #onFinish() {
    this.setup.finished = true;
    await this.#save();
    const openWarRoom = api("apps", "openWarRoom");
    await this.close();
    openWarRoom?.();
  }

  static async #onRestart() {
    if ( this.setup.deployed ) return;
    this.setup = this.#fresh(this.setup.game);
    await this.#save();
    this.stepIndex = 0;
    this.render();
  }
}

/** Open "Setup before every game" (GM). */
export function openGameSetup() {
  if ( !game.user.isGM ) return ui.notifications.warn("RL.Legacy.Error.gmOnly", { localize: true });
  const campaign = state.getCampaign();
  if ( !campaign ) return ui.notifications.warn("RL.Error.noCampaign", { localize: true });
  const app = foundry.applications.instances.get("rl-game-setup") ?? new GameSetupWizard();
  return app.render({ force: true });
}
