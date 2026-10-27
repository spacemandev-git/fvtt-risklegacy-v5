import { CARDS_PER_RED_STAR, PHASES, PHASE_ORDER, RED_STARS_TO_WIN, STARTING_TROOPS, SYSTEM_ID } from "../config.mjs";
import * as state from "../state/_module.mjs";
import { chooseNumber, chooseOption } from "./dialogs.mjs";
import {
  affectsWar, api, applyFactionVars, attempt, esc, factionArt, factionColor, factionHQ, playerName, redStarSlots, snapshot, t,
  territoryName, tpl, WAR_HOOKS, watchHooks
} from "./helpers.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const WIDTH = 340;

/**
 * What each control needs from the other areas (feature-detected; they ship independently). Each entry lists
 * alternatives: the turn area's rules-aware `prompt*` helper, or the raw calls the War Room can chain itself.
 */
const NEEDS = {
  buyStars: [[["turn", "promptBuyRedStars"]], [["turn", "buyRedStars"], ["cards", "chooseResourceCards"]]],
  tradeTroops: [[["turn", "promptTrade"]], [["turn", "tradeForTroops"], ["cards", "chooseResourceCards"]]],
  recruit: [[["turn", "recruit"]]],
  placeTroops: [[["board", "startPlacement"]]],
  joinWar: [[["turn", "promptJoinWar"]], [["turn", "joinWar"], ["board", "pickTerritory"]]],
  attack: [[["turn", "promptAttack"]], [["turn", "attack"], ["board", "pickTerritory"]]],
  expand: [[["turn", "promptExpand"]], [["turn", "expand"], ["board", "pickTerritory"]]],
  maneuver: [[["turn", "promptManeuver"]], [["turn", "maneuver"], ["board", "pickTerritory"]]],
  nextStep: [[["turn", "advancePhase"]]],
  endTurn: [[["turn", "endTurn"]]],
  setupGame: [[["campaign", "openGameSetup"]]],
  endGame: [[["campaign", "openEndGame"]]],
  sideboard: [[["cards", "openSideboard"]]],
  placeStart: [[["turn", "promptStartingTerritory"]], [["board", "startPlacement"]]]
};
const available = control => NEEDS[control].some(set => set.every(([area, name]) => !!api(area, name)));

/** "BOT · Warlord" for a faction played by a bot player (module/bots), "BOT · Warlord · The Iron Wall" for a chat bot. */
const botTag = actor => {
  const bot = api("bots", "botOfFaction")?.(actor);
  if ( !bot ) return "";
  const difficulty = game.risklegacy.bots.difficultyLabel(bot.difficulty);
  const title = (bot.engine === "llm") ? api("bots", "botPersonality")?.(bot.user)?.title : "";
  return title ? t("RL.Bots.TagTitle", { difficulty, title }) : t("RL.Bots.Tag", { difficulty });
};

/** War Room controls → `rules.checkTurnAction` action names. */
const RULE_ACTIONS = {
  buyStars: "buyRedStars", tradeTroops: "trade", recruit: "recruit", joinWar: "join", placeTroops: "place",
  expand: "expand", attack: "attack", maneuver: "maneuver", endTurn: "endTurn"
};

/**
 * The War Room: a compact, docked turn HUD. It shows whose turn it is, the five numbered turn steps with the current
 * one lit, the controls for the current step (only for the player whose turn it is, or a GM), and everyone's
 * scoreboard. It opens automatically during a war and refreshes on combat, actor, token and card changes.
 */
export default class WarRoom extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-war-room",
    classes: ["risklegacy", "rl-war-room"],
    tag: "aside",
    window: {
      title: "RL.UI.WarRoom.Title", icon: "fa-solid fa-chess-board", minimizable: true, resizable: false,
      controls: [{ icon: "fa-solid fa-down-left-and-up-right-to-center", label: "RL.UI.WarRoom.Compact", action: "toggleCompact" },
        { icon: "fa-solid fa-thumbtack", label: "RL.UI.WarRoom.Redock", action: "redock" }]
    },
    position: { width: WIDTH, height: "auto" },
    actions: {
      buyStars: WarRoom.#onBuyStars,
      tradeTroops: WarRoom.#onTradeTroops,
      recruit: WarRoom.#onRecruit,
      placeTroops: WarRoom.#onPlaceTroops,
      placeStart: WarRoom.#onPlaceStart,
      joinWar: WarRoom.#onJoinWar,
      attack: WarRoom.#onAttack,
      expand: WarRoom.#onExpand,
      maneuver: WarRoom.#onManeuver,
      nextStep: WarRoom.#onNextStep,
      endTurn: WarRoom.#onEndTurn,
      setupGame: () => api("campaign", "openGameSetup")?.(),
      endGame: () => api("campaign", "openEndGame")?.(),
      stickerSheet: () => api("campaign", "openStickerSheet")?.(),
      playScar: WarRoom.#onPlayScar,
      sideboard: () => api("cards", "openSideboard")?.(),
      reference: () => game.risklegacy.apps?.openReference?.(),
      bots: () => api("bots", "openBotManager")?.(),
      openSheet: WarRoom.#onOpenSheet,
      toggleScore: WarRoom.#onToggleScore,
      toggleCompact: WarRoom.#onToggleCompact,
      redock: WarRoom.#onRedock
    }
  };

  static PARTS = {
    main: { template: tpl("apps/war-room.hbs"), root: true, scrollable: [".rl-wr__score"] }
  };

  /** The single instance. */
  static get instance() {
    return foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? null;
  }

  /**
   * Open (or bring forward) the War Room.
   * @returns {Promise<WarRoom>}
   */
  static async open() {
    const app = this.instance ?? new this();
    if ( app.rendered ) {
      if ( app.minimized ) await app.maximize();
      app.bringToFront();
      return app;
    }
    return app.render({ force: true, position: app.#dockPosition() });
  }

  /** Busy flag while an action runs (buttons are disabled meanwhile). */
  #busy = false;

  /** Scoreboard collapsed (per client). */
  #scoreCollapsed = false;

  /** A click-to-place session (board.startPlacement) is running. */
  #placing = false;

  #unwatch = null;

  /**
   * The docked spot: top left, beside the scene controls and under the scene list, well clear of the board's
   * centre. With a long scene list it sits beside the list instead.
   * @returns {{left: number, top: number}}
   */
  static dockedSpot() {
    const controls = document.getElementById("scene-controls")?.getBoundingClientRect();
    const left = Math.round((controls?.width ? controls.right : 88) + 16);
    let top = 16;
    let navRight = left;
    for ( const li of document.querySelectorAll("#scene-navigation li.scene, #scene-navigation li.ui-control") ) {
      const b = li.getBoundingClientRect();
      if ( !b.height || (b.left > left + WIDTH) ) continue;
      top = Math.max(top, Math.round(b.bottom + 10));
      navRight = Math.max(navRight, Math.round(b.right + 12));
    }
    if ( top > window.innerHeight * 0.35 ) return { left: navRight, top: 16 };
    return { left, top };
  }

  /** Is a saved position clear of the board's centre (window centre outside the middle 40% of the screen)? */
  static #isEdgePosition({ left, top } = {}) {
    if ( !Number.isFinite(left) || !Number.isFinite(top) ) return false;
    const vw = window.innerWidth;
    const centre = left + (WIDTH / 2);
    return (top >= 0) && (top < window.innerHeight - 60) && (left > -WIDTH + 60) && (left < vw - 60)
      && ((centre < vw * 0.3) || (centre > vw * 0.7));
  }

  /** Where to open: where the user last left it if that's at an edge, else the docked spot. */
  #dockPosition() {
    const saved = game.settings.get(SYSTEM_ID, "warRoomPosition");
    return WarRoom.#isEdgePosition(saved) ? { left: saved.left, top: saved.top } : WarRoom.dockedSpot();
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const war = state.getWar();
    const campaign = state.getCampaign();
    context.isGM = game.user.isGM;
    context.busy = this.#busy;
    context.scoreCollapsed = this.#scoreCollapsed;
    context.placing = this.#placing;
    context.controls = Object.fromEntries(Object.keys(NEEDS).map(k => [k, available(k)]));
    context.legal = Object.fromEntries(Object.keys(NEEDS).map(k => [k, true]));
    context.tips = Object.fromEntries(Object.keys(NEEDS).map(k => [k, context.controls[k] ? "" : t("RL.UI.NotAvailable")]));
    context.campaign = campaign ? { nextGame: campaign.system.nextGameNumber, worldName: campaign.system.worldName } : null;
    context.canStickerSheet = context.isGM && !!campaign && !!api("campaign", "openStickerSheet");
    context.canBots = context.isGM && !!api("bots", "openBotManager");
    if ( !war ) {
      context.noWar = true;
      return context;
    }
    const snap = snapshot();
    const sys = war.system;
    context.war = { id: war.id, game: sys.game, stage: sys.stage, round: war.round, stageLabel: t(`RL.Stage.${sys.stage}`) };
    context.scoreboard = this.#scoreboard(war, snap);
    context.scarHands = this.#scarHands(war);

    switch ( sys.stage ) {
      case "setup":
        context.setup = true;
        break;
      case "placement":
        context.placement = this.#placement(war);
        break;
      case "ended":
        context.ended = this.#ended(war);
        break;
      default:
        this.#preparePlaying(context, war, snap);
    }
    return context;
  }

  /** Per-faction rows in seat order. */
  #scoreboard(war, snap) {
    const current = war.combatant?.actorId;
    return state.getFactions({ active: true }).map(actor => {
      const f = snap?.factions?.[actor.id];
      const tokens = actor.system.war.redStarTokens;
      const hqs = f?.redStars?.hqs ?? 0;
      const status = actor.system.war.status;
      return {
        id: actor.id, name: actor.name, key: actor.system.key, color: factionColor(actor), hq: factionHQ(actor),
        player: playerName(actor), bot: botTag(actor),
        stars: tokens + hqs, starSlots: redStarSlots(tokens, hqs).slice(0, Math.max(RED_STARS_TO_WIN, tokens + hqs)),
        troops: f?.troops ?? "—",
        territories: f?.territories.length ?? "—",
        cards: f?.hand?.count ?? (state.getHand(actor)?.cards.size ?? 0),
        missiles: actor.system.war.missiles,
        status, statusLabel: t(`RL.Status.${status}`),
        out: status !== "playing",
        current: (war.system.stage === "playing") && (actor.id === current),
        mine: actor.system.war.playerId === game.user.id
      };
    });
  }

  /**
   * Scar cards held by the factions this user plays (a GM sees every faction's: hot-seat and corrections). Several
   * scars are played "at the start of any player's turn", so this shows whenever such a card is in hand, not only on
   * the holder's turn. Bunker / Ammo Shortage are played from the battle card, before the attack roll.
   */
  #scarHands(war) {
    const getScars = api("cards", "getScarCards");
    if ( !getScars || (war.system.stage === "ended") ) return [];
    let strict = true;
    try {
      strict = game.settings.get(SYSTEM_ID, "enforcement") === "strict";
    } catch(err) { /* default strict */ }
    const mine = actor => game.user.isGM || (actor.system.war.playerId === game.user.id);
    return state.getFactions({ active: true }).filter(mine).map(actor => {
      const cards = (getScars(actor) ?? []).map(card => {
        const play = card.getFlag(SYSTEM_ID, "play") ?? state.findEntry("scars", card.system.catalogId)?.play ?? {};
        const timing = play.timing ?? "any";
        const battle = timing === "beforeAttackRoll";
        const key = `RL.UI.WarRoom.ScarTiming.${timing}`;
        return {
          id: card.id, name: card.name, img: card.system.stickerImg || card.img, target: card.system.target,
          timing: game.i18n.has(key) ? t(key) : "", text: card.system.text,
          disabled: battle && strict && !game.user.isGM,
          tip: battle ? t("RL.UI.WarRoom.ScarFromBattle") : ""
        };
      });
      return cards.length ? { id: actor.id, name: actor.name, color: factionColor(actor), cards } : null;
    }).filter(Boolean);
  }

  #placement(war) {
    const order = war.system.placement.order ?? [];
    const index = war.system.placement.index ?? 0;
    const rows = order.map((id, i) => {
      const actor = game.actors.get(id);
      return {
        id, name: actor?.name ?? "?", color: factionColor(actor), player: playerName(actor),
        placed: i < index, current: i === index,
        territory: actor?.system.war.startingTerritory ? territoryName(actor.system.war.startingTerritory) : ""
      };
    });
    const current = game.actors.get(order[index]);
    return {
      rows,
      current: current ? { id: current.id, name: current.name } : null,
      mine: current ? state.canActFor(game.user, current) : false
    };
  }

  #ended(war) {
    const winner = game.actors.get(war.system.winner);
    return { winner: winner ? { name: winner.name, color: factionColor(winner), player: playerName(winner), hq: factionHQ(winner) } : null };
  }

  #preparePlaying(context, war, snap) {
    const actor = war.combatant?.actor ?? null;
    const sys = war.system;
    const phase = PHASES[sys.phase] ? sys.phase : "start";
    const stepIndex = PHASE_ORDER.indexOf(phase);
    context.steps = PHASE_ORDER.map((id, i) => ({
      id, n: i + 1, label: t(PHASES[id].label), short: t(`RL.UI.WarRoom.Step.${id}`),
      state: i < stepIndex ? "past" : (i === stepIndex ? "current" : "future")
    }));
    context.phase = phase;
    context.phaseLabel = t(PHASES[phase].label);
    context.isLastStep = stepIndex === PHASE_ORDER.length - 1;
    context.nextLabel = context.isLastStep ? "" : t(`RL.UI.WarRoom.Step.${PHASE_ORDER[stepIndex + 1]}`);
    if ( !actor ) return;

    const f = snap?.factions?.[actor.id];
    const w = actor.system.war;
    const tokens = w.redStarTokens;
    const hqs = f?.redStars?.hqs ?? 0;
    const log = sys.turn;
    const mine = state.canActFor(game.user, actor);
    context.current = {
      id: actor.id, name: actor.name, key: actor.system.key, color: factionColor(actor), hq: factionHQ(actor),
      player: playerName(actor), bot: botTag(actor), stars: tokens + hqs, starSlots: redStarSlots(tokens, hqs),
      reserve: w.reserve, missiles: w.missiles, status: w.status,
      handCount: f?.hand?.count ?? (state.getHand(actor)?.cards.size ?? 0),
      territories: f?.territories.length ?? 0, troops: f?.troops ?? 0
    };
    context.canAct = mine && !this.#busy;
    this.#prepareLegality(context, snap, actor.id);
    context.isMine = mine;
    context.isOwnTurn = w.playerId === game.user.id;
    context.waitingFor = t("RL.UI.WarRoom.WaitingFor", { faction: actor.name, player: context.current.player || "?" });

    // Step panels
    const handCount = context.current.handCount;
    context.panel = {
      start: phase === "start" ? {
        affordable: Math.floor(handCount / CARDS_PER_RED_STAR),
        bought: log.starsBought
      } : null,
      recruit: phase === "recruit" ? this.#recruitPanel(actor, f, snap, log) : null,
      attack: phase === "attack" ? {
        conquered: log.conquered, expanded: log.expanded, attacks: log.attacks, reserve: w.reserve
      } : null,
      maneuver: phase === "maneuver" ? {
        done: log.maneuver.done,
        from: territoryName(log.maneuver.from), to: territoryName(log.maneuver.to)
      } : null,
      end: phase === "end" ? {
        canDraw: (log.conquered ?? 0) > 0, cardDrawn: log.cardDrawn
      } : null
    };
  }

  /**
   * Which controls the rules allow right now (rules.checkTurnAction), with the reason as tooltip. In advisory or
   * free-play enforcement nothing is disabled; the reason still shows.
   */
  #prepareLegality(context, snap, factionId) {
    const check = api("rules", "checkTurnAction");
    let strict = true;
    try {
      strict = game.settings.get(SYSTEM_ID, "enforcement") === "strict";
    } catch(err) { /* setting not registered: treat as strict */ }
    context.legal = {};
    context.tips = {};
    for ( const control of Object.keys(NEEDS) ) {
      let ok = true;
      let reason = "";
      if ( check && snap && RULE_ACTIONS[control] ) {
        try {
          const result = check(snap, factionId, RULE_ACTIONS[control]);
          if ( !result.ok ) {
            reason = state.reasonText(result);
            ok = !strict;
          }
        } catch(err) { /* rules not ready: leave enabled */ }
      }
      context.legal[control] = ok;
      context.tips[control] = !context.controls[control] ? t("RL.UI.NotAvailable") : reason;
    }
  }

  #recruitPanel(actor, f, snap, log) {
    const joining = !f || !f.territories.length;
    let breakdown = null;
    const fn = api("rules", "recruitBreakdown");
    if ( fn && snap && !joining ) {
      try {
        breakdown = fn(snap, actor.id);
      } catch(err) {
        console.warn(`${SYSTEM_ID} | recruitBreakdown failed`, err);
      }
    }
    if ( breakdown ) breakdown = {
      ...breakdown,
      continents: (breakdown.continents ?? []).map(c => ({ ...c, label: snap.continents?.[c.id]?.name || c.id }))
    };
    return {
      joining, joinTroops: Math.floor(STARTING_TROOPS / 2),
      breakdown, recruited: log.recruited, recruitTotal: log.recruitTotal, traded: log.tradedForTroops,
      joined: log.joinedWar, reserve: actor.system.war.reserve,
      handCount: f?.hand?.count ?? 0, coins: f?.hand?.coins ?? 0
    };
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#unwatch = watchHooks(WAR_HOOKS, () => {
      if ( this.rendered ) this.render();
    }, { wait: 150, filter: affectsWar });
  }

  /** @inheritDoc */
  _onClose(options) {
    this.#unwatch?.();
    this.#unwatch = null;
    const { left, top } = this.position;
    const saved = WarRoom.#isEdgePosition({ left, top }) ? { left, top } : {};
    game.settings.set(SYSTEM_ID, "warRoomPosition", saved).catch(() => {});
    super._onClose(options);
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    applyFactionVars(this.element, context.current?.color ?? context.ended?.winner?.color ?? null);
    this.element.classList.toggle("is-my-turn", !!context.isOwnTurn);
    this.element.classList.toggle("is-compact", !!game.settings.get(SYSTEM_ID, "warRoomCompact"));
    // Keep the title informative while minimized
    const title = context.war ? t("RL.UI.WarRoom.TitleGame", { game: context.war.game }) : t("RL.UI.WarRoom.Title");
    const titleEl = this.element.querySelector(".window-title");
    if ( titleEl ) titleEl.textContent = title;
  }

  /* -------------------------------------------- */
  /*  Action helpers                              */
  /* -------------------------------------------- */

  /** The faction whose turn it is, if the user may act for it. */
  #actingFaction() {
    const actor = state.currentFaction();
    if ( !actor || !state.canActFor(game.user, actor) ) {
      ui.notifications.warn("RL.Error.notYourTurn", { localize: true });
      return null;
    }
    return actor;
  }

  /** Run an action with the buttons disabled. */
  async #run(fn) {
    if ( this.#busy ) return null;
    this.#busy = true;
    this.element?.classList.add("is-busy");
    try {
      return await attempt(fn);
    } finally {
      this.#busy = false;
      this.element?.classList.remove("is-busy");
      if ( this.rendered ) this.render();
    }
  }

  /** Pick a territory on the board. */
  async #pick(promptKey, allowed, faction, data = {}) {
    const pick = api("board", "pickTerritory");
    if ( !pick ) return null;
    if ( !allowed?.length ) {
      ui.notifications.warn("RL.UI.WarRoom.NoTargets", { localize: true });
      return null;
    }
    return pick({ prompt: t(promptKey, data), allowed, faction: faction.id });
  }

  /** Own territories with at least `min` troops. */
  static #own(snap, factionId, min = 1) {
    return Object.values(snap?.territories ?? {}).filter(x => (x.owner === factionId) && (x.troops >= min));
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onBuyStars() {
    const faction = this.#actingFaction();
    if ( !faction || !available("buyStars") ) return;
    const prompt = api("turn", "promptBuyRedStars");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const cardIds = await game.risklegacy.cards.chooseResourceCards({
        faction: faction.id, purpose: "redStar", title: t("RL.UI.WarRoom.BuyStarsTitle")
      });
      if ( cardIds?.length ) await game.risklegacy.turn.buyRedStars({ faction: faction.id, cardIds });
    });
  }

  static async #onTradeTroops() {
    const faction = this.#actingFaction();
    if ( !faction || !available("tradeTroops") ) return;
    const prompt = api("turn", "promptTrade");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const cardIds = await game.risklegacy.cards.chooseResourceCards({
        faction: faction.id, purpose: "troops", title: t("RL.UI.WarRoom.TradeTitle")
      });
      if ( cardIds?.length ) await game.risklegacy.turn.tradeForTroops({ faction: faction.id, cardIds });
    });
  }

  static async #onRecruit() {
    const faction = this.#actingFaction();
    if ( !faction || !available("recruit") ) return;
    await this.#run(() => game.risklegacy.turn.recruit({ faction: faction.id }));
  }

  static async #onPlaceTroops() {
    if ( this.#placing ) {
      await attempt(() => api("board", "stopPlacement")?.());
      return;
    }
    const faction = this.#actingFaction();
    if ( !faction || !available("placeTroops") ) return;
    // startPlacement resolves when the placement session ends (all placed, Esc, or stopped)
    this.#placing = true;
    this.render();
    try {
      await attempt(() => game.risklegacy.board.startPlacement({ faction: faction.id, mode: "reserve" }));
    } finally {
      this.#placing = false;
      if ( this.rendered ) this.render();
    }
  }

  static async #onPlaceStart() {
    const war = state.getWar();
    const id = war?.system.placement.order?.[war.system.placement.index];
    const actor = game.actors.get(id);
    if ( !actor || !state.canActFor(game.user, actor) || !available("placeStart") ) return;
    const prompt = api("turn", "promptStartingTerritory");
    if ( prompt ) return this.#run(() => prompt(actor.id));
    await attempt(() => game.risklegacy.board.startPlacement({ faction: actor.id, mode: "starting" }));
  }

  static async #onJoinWar() {
    const faction = this.#actingFaction();
    if ( !faction || !available("joinWar") ) return;
    const prompt = api("turn", "promptJoinWar");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const snap = snapshot();
      let allowed = null;
      const legal = api("rules", "legalStartingTerritories");
      if ( legal && snap ) allowed = legal(snap, faction.id, { joining: true });
      allowed ??= Object.values(snap?.territories ?? {})
        .filter(x => !x.owner && !x.city && !x.scar && !x.marks.some(m => m !== "cancel_scar")).map(x => x.id);
      const territory = await this.#pick("RL.UI.WarRoom.PickJoin", allowed, faction);
      if ( territory ) await game.risklegacy.turn.joinWar({ faction: faction.id, territory });
    });
  }

  static async #onAttack() {
    const faction = this.#actingFaction();
    if ( !faction || !available("attack") ) return;
    const prompt = api("turn", "promptAttack");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const snap = snapshot();
      if ( !snap ) return;
      const protectedIds = new Set(state.getWar()?.system.turn.protected ?? []);
      const enemyNeighbors = id => snap.territories[id].neighbors.filter(n => {
        const owner = snap.territories[n]?.owner;
        return owner && (owner !== faction.id) && !protectedIds.has(n);
      });
      const froms = WarRoom.#own(snap, faction.id, 2).filter(x => enemyNeighbors(x.id).length).map(x => x.id);
      const from = await this.#pick("RL.UI.WarRoom.PickAttackFrom", froms, faction);
      if ( !from ) return;
      const to = await this.#pick("RL.UI.WarRoom.PickAttackTo", enemyNeighbors(from), faction, { from: territoryName(from) });
      if ( !to ) return;
      const maxDice = api("rules", "maxAttackDice")?.(snap, from) ?? Math.min(3, snap.territories[from].troops - 1);
      let dice = maxDice;
      if ( maxDice > 1 ) {
        dice = await chooseNumber({
          title: t("RL.UI.WarRoom.AttackTitle", { from: territoryName(from), to: territoryName(to) }),
          label: "RL.UI.WarRoom.AttackDice", min: 1, max: maxDice, value: maxDice, confirm: "RL.UI.WarRoom.Attack",
          icon: "fa-solid fa-dice"
        });
      }
      if ( dice ) await game.risklegacy.turn.attack({ faction: faction.id, from, to, dice });
    });
  }

  static async #onExpand() {
    const faction = this.#actingFaction();
    if ( !faction || !available("expand") ) return;
    const prompt = api("turn", "promptExpand");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const snap = snapshot();
      if ( !snap ) return;
      const empty = id => snap.territories[id].neighbors.filter(n => !snap.territories[n]?.owner);
      const froms = WarRoom.#own(snap, faction.id, 2).filter(x => empty(x.id).length).map(x => x.id);
      const from = await this.#pick("RL.UI.WarRoom.PickExpandFrom", froms, faction);
      if ( !from ) return;
      const to = await this.#pick("RL.UI.WarRoom.PickExpandTo", empty(from), faction, { from: territoryName(from) });
      if ( !to ) return;
      const max = snap.territories[from].troops - 1;
      const count = max > 1 ? await chooseNumber({
        title: t("RL.UI.WarRoom.ExpandTitle", { from: territoryName(from), to: territoryName(to) }),
        label: "RL.UI.WarRoom.HowMany", min: 1, max, value: max, confirm: "RL.UI.WarRoom.Expand",
        hint: this.#expandHint(snap, to), icon: "fa-solid fa-person-walking-arrow-right"
      }) : 1;
      if ( count ) await game.risklegacy.turn.expand({ faction: faction.id, from, to, count });
    });
  }

  /** Expansion cost note (city population + fortification). */
  #expandHint(snap, to) {
    const x = snap.territories[to];
    const cost = (x?.population ?? 0) + (x?.fortified ? 2 : 0);
    return cost ? t("RL.UI.WarRoom.ExpandCost", { cost }) : "";
  }

  static async #onManeuver() {
    const faction = this.#actingFaction();
    if ( !faction || !available("maneuver") ) return;
    const prompt = api("turn", "promptManeuver");
    if ( prompt ) return this.#run(() => prompt(faction.id));
    await this.#run(async () => {
      const snap = snapshot();
      if ( !snap ) return;
      const own = WarRoom.#own(snap, faction.id, 1).map(x => x.id);
      const froms = WarRoom.#own(snap, faction.id, 2).map(x => x.id);
      const from = await this.#pick("RL.UI.WarRoom.PickManeuverFrom", froms, faction);
      if ( !from ) return;
      const connected = api("rules", "connectedThroughOwned");
      const tos = own.filter(id => (id !== from) && (!connected || connected(snap, faction.id, from, id)));
      const to = await this.#pick("RL.UI.WarRoom.PickManeuverTo", tos, faction, { from: territoryName(from) });
      if ( !to ) return;
      const max = snap.territories[from].troops - 1;
      const count = max > 1 ? await chooseNumber({
        title: t("RL.UI.WarRoom.ManeuverTitle", { from: territoryName(from), to: territoryName(to) }),
        label: "RL.UI.WarRoom.HowMany", min: 1, max, value: max, confirm: "RL.UI.WarRoom.Maneuver",
        icon: "fa-solid fa-route"
      }) : 1;
      if ( count ) await game.risklegacy.turn.maneuver({ faction: faction.id, from, to, count });
    });
  }

  static async #onNextStep() {
    const faction = this.#actingFaction();
    if ( !faction || !available("nextStep") ) return;
    await this.#run(() => game.risklegacy.turn.advancePhase());
  }

  static async #onEndTurn() {
    const faction = this.#actingFaction();
    if ( !faction || !available("endTurn") ) return;
    await this.#run(() => game.risklegacy.turn.endTurn({ faction: faction.id }));
  }

  /**
   * Play a scar card from the hand: a territory scar goes on any territory that can take one (`scarTargets`), picked
   * on the board; a weakness scar goes on a faction with an empty yellow slot.
   */
  static async #onPlayScar(event, target) {
    const actor = game.actors.get(target.closest("[data-faction-id]")?.dataset.factionId);
    const cardId = target.dataset.cardId;
    if ( !actor || !state.canActFor(game.user, actor) ) return;
    const card = state.getHand(actor)?.cards.get(cardId);
    const play = api("cards", "playScar");
    if ( !card || !play ) return;
    await this.#run(async () => {
      if ( card.system.target === "faction" ) {
        const free = state.getFactions().filter(a => !a.items.some(i => (i.type === "power") && (i.system.slot === "weakness")));
        if ( !free.length ) {
          ui.notifications.warn("RL.UI.WarRoom.NoWeaknessSlot", { localize: true });
          return;
        }
        const targetId = await chooseOption({
          title: t("RL.UI.WarRoom.ScarFactionTitle", { scar: card.name }), icon: "fa-solid fa-burst",
          content: esc(String(card.system.text ?? "").split(/\n\s*\n/).at(-1) ?? ""),
          options: free.map(a => ({
            value: a.id, label: a.name, img: factionArt(a),
            hint: a.system.war.active ? (playerName(a) || t("RL.UI.WarRoom.Playing")) : t("RL.UI.WarRoom.NotPlaying")
          }))
        });
        if ( targetId ) await play({ faction: actor.id, cardId, target: targetId });
        return;
      }
      const targets = (api("cards", "scarTargets") ?? api("campaign", "scarTargets"))?.() ?? [];
      const territory = await this.#pick("RL.UI.WarRoom.PickScar", targets, actor, { scar: card.name });
      if ( territory ) await play({ faction: actor.id, cardId, territory });
    });
  }

  static #onOpenSheet(event, target) {
    const actor = game.actors.get(target.closest("[data-faction-id]")?.dataset.factionId);
    actor?.sheet.render({ force: true });
  }

  static async #onToggleCompact() {
    await game.settings.set(SYSTEM_ID, "warRoomCompact", !game.settings.get(SYSTEM_ID, "warRoomCompact"));
    this.render();
  }

  static #onRedock() {
    this.setPosition(WarRoom.dockedSpot());
  }

  static #onToggleScore() {
    this.#scoreCollapsed = !this.#scoreCollapsed;
    this.render();
  }
}
