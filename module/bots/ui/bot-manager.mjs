/**
 * Bot Manager (BOTS.md §7.1, BOTS-LLM.md §8): the GM's window for bot players. It lists the bots (engine, difficulty,
 * the faction each plays in the current war, remove; for chat bots also the personality, the model and their notes),
 * adds Jev bots and chat bots (through the personality gallery), connects the chat models (base URL, an API key kept in
 * this browser only, Test, the default model, the spend for this war and its cap), shows whether the Jev relay
 * answers (and how to start it when it doesn't), and pauses or resumes every bot. Opened from Settings → Bot players,
 * the War Room and the game-setup wizard.
 */
import { SYSTEM_ID } from "../../config.mjs";
import * as driver from "../driver/_module.mjs";
import { PERSONALITIES, personalityById } from "../llm/personalities.mjs";
import { SETTINGS, getSetting, setSetting } from "../settings.mjs";
import {
  DIFFICULTIES, botInfo, botUsers, createBot, difficultyLabel, removeBot, seatedFaction, setBotConfig, setBotDifficulty
} from "../users.mjs";
import { choosePersonality, hasMemory, memoryCount, openNotes } from "./dialogs.mjs";
import {
  explainError, keySet, llmStatus, loadModels, modelName, modelOptions, modelState, onLLMStatus, resetLLMStatus, resetModels,
  testLLM, usd, viaRelay
} from "./llm.mjs";
import { onRelayStatus, relayCommands, relayStatus, resetRelayStatus, testRelay, validRelayUrl } from "./relay.mjs";
import { RANKS, esc, list, portraitOf, t, tpl } from "./text.mjs";

export { RANKS };

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Document hooks that can change what the manager shows. */
const HOOKS = ["createUser", "updateUser", "deleteUser", "updateActor", "createCombat", "updateCombat", "deleteCombat",
  "createSetting", "updateSetting", "risklegacy.botDecision"];

/** Settings whose change makes the last chat-model check (and model list) stale. */
const LLM_KEYS = [SETTINGS.llmBaseUrl, SETTINGS.llmApiKey];

const isChat = user => botInfo(user)?.engine === "llm";

export default class BotManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-bot-manager",
    classes: ["risklegacy", "rl-bot-app", "rl-bot-manager"],
    tag: "div",
    window: { title: "RL.Bots.Manager.title", icon: "fa-solid fa-robot", resizable: true, minimizable: true },
    position: { width: 700, height: "auto" },
    actions: {
      addBot: BotManager.#onAddBot,
      addChatBot: BotManager.#onAddChatBot,
      removeBot: BotManager.#onRemoveBot,
      pickPersonality: BotManager.#onPickPersonality,
      randomize: BotManager.#onRandomize,
      notes: BotManager.#onNotes,
      testRelay: BotManager.#onTestRelay,
      testLLM: BotManager.#onTestLLM,
      refreshModels: BotManager.#onRefreshModels,
      clearKey: BotManager.#onClearKey,
      togglePause: BotManager.#onTogglePause,
      openLog: () => game.risklegacy.bots?.openBotLog?.(),
      openSettings: BotManager.#onOpenSettings,
      copy: BotManager.#onCopy
    }
  };

  static PARTS = {
    main: { template: tpl("bots/bot-manager.hbs"), scrollable: [".rl-bot-mgr__scroll"] }
  };

  /** The open instance, if any. */
  static get instance() {
    return foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? null;
  }

  /** Open (or bring forward) the Bot Manager. GM only. */
  static async open() {
    if ( !game.user.isGM ) {
      ui.notifications.warn("RL.Bots.Error.gmOnly", { localize: true });
      return null;
    }
    const app = this.instance ?? new this();
    if ( app.rendered ) {
      if ( app.minimized ) await app.maximize();
      app.bringToFront();
      return app;
    }
    return app.render({ force: true });
  }

  #busy = false;

  #hooks = [];

  #unsubscribe = [];

  /** A render was skipped while the GM was typing in a field; do it when the field loses focus. */
  #deferred = false;

  #renderSoon = foundry.utils.debounce(() => {
    if ( !this.rendered ) return;
    if ( this.#editing() ) {
      this.#deferred = true;
      return;
    }
    this.#deferred = false;
    this.render();
  }, 100);

  /** Is the GM typing in one of our text fields (a re-render would wipe what they typed)? */
  #editing() {
    const el = document.activeElement;
    return !!el && !!this.element?.contains(el) && el.matches("input:not([type='radio']):not([type='checkbox']), textarea");
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const war = game.risklegacy?.state?.getWar?.() ?? null;
    const currentId = (war?.system?.stage === "playing") ? war.combatant?.actorId : null;
    const defaultModel = getSetting(SETTINGS.llmModel);
    context.busy = this.#busy;
    context.bots = botUsers().sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(user => this.#botRow(user, { currentId, defaultModel }));
    context.add = DIFFICULTIES.map(d => ({
      difficulty: d, rank: Array(RANKS[d]).fill(0), label: t("RL.Bots.Manager.add", { difficulty: difficultyLabel(d) }),
      level: t(`RL.Bots.Manager.level.${d}`), hint: t(`RL.Bots.Manager.hint.${d}`)
    }));
    context.chatAdd = {
      faces: PERSONALITIES.slice(0, 10).map(p => ({ portrait: p.portrait, name: `${p.name}, ${p.title}` })),
      hint: t("RL.Bots.Manager.addChatHint", { n: PERSONALITIES.length })
    };
    const chatBots = context.bots.filter(b => b.chat);
    const seatedChat = chatBots.filter(b => b.seated);
    context.randomize = chatBots.length ? {
      disabled: !!seatedChat.length,
      tip: seatedChat.length
        ? t("RL.Bots.Manager.randomizeSeated", { names: list(seatedChat.map(b => b.name)) })
        : t("RL.Bots.Manager.randomizeTip")
    } : null;
    context.llm = this.#llmContext({ war, defaultModel, chatBots: chatBots.length });
    context.relay = this.#relayContext();
    context.control = this.#controlContext();
    context.inWar = !!war && (war.system.stage !== "ended");
    return context;
  }

  /** One bot's row. */
  #botRow(user, { currentId, defaultModel }) {
    const info = botInfo(user);
    const { difficulty } = info;
    const chat = info.engine === "llm";
    const seated = seatedFaction(user);
    const faction = seated ?? game.actors.find(a => (a.type === "faction") && a.system.war?.active && (a.system.war.playerId === user.id));
    const status = faction?.system?.war?.status;
    const row = {
      id: user.id, name: user.name, difficulty, rank: Array(RANKS[difficulty]).fill(0), chat, engine: info.engine,
      options: DIFFICULTIES.map(d => ({
        value: d, label: difficultyLabel(d), checked: d === difficulty, hint: t(`RL.Bots.Manager.hint.${d}`)
      })),
      seat: faction ? {
        name: faction.name, color: faction.system?.color?.css ?? "",
        status: status && (status !== "playing") ? t(`RL.Status.${status}`) : "",
        current: faction.id === currentId,
        ended: !seated
      } : null,
      seated: !!seated,
      removable: !seated,
      removeTip: seated ? t("RL.Bots.Manager.removeSeated", { faction: seated.name }) : t("RL.Bots.Manager.remove", { name: user.name }),
      badge: t("RL.Bots.Manager.engineJev"),
      badgeTip: t("RL.Bots.Manager.engineJevTip")
    };
    if ( !chat ) return row;

    const model = info.model ?? defaultModel;
    const p = personalityById(info.personality);
    const memory = info.memory;
    const count = memoryCount(memory);
    Object.assign(row, {
      badge: modelName(model, { badge: true }) || t("RL.Bots.Manager.engineChat"),
      badgeTip: t(info.model ? "RL.Bots.Manager.engineChatTip" : "RL.Bots.Manager.engineChatDefaultTip", { model }),
      persona: {
        name: p?.name ?? t("RL.Bots.Manager.noPersonality"), title: p?.title ?? "", portrait: portraitOf(user, p),
        locked: !!seated,
        tip: seated ? t("RL.Bots.Manager.personaSeated", { faction: seated.name }) : t("RL.Bots.Manager.personaTip", { name: user.name })
      },
      models: modelOptions(info.model ?? "", {
        defaultLabel: t("RL.Bots.LLM.default", { model: modelName(defaultModel) }), prices: false
      }),
      notes: {
        count, has: hasMemory(memory),
        disabled: !memory && (difficulty === "easy"),
        tip: hasMemory(memory) ? t("RL.Bots.Manager.notesTip", { name: user.name })
          : t(difficulty === "easy" ? "RL.Bots.Manager.notesEasy" : "RL.Bots.Manager.notesNone")
      }
    });
    return row;
  }

  /** The chat-models panel. Never carries the API key itself, only whether one is saved. */
  #llmContext({ war, defaultModel, chatBots }) {
    const s = llmStatus();
    const models = modelState();
    const url = getSetting(SETTINGS.llmBaseUrl);
    const relay = viaRelay(url);
    const hasKey = keySet();
    const labels = { unknown: "RL.Bots.LLM.unknown", checking: "RL.Bots.LLM.checking", ok: "RL.Bots.LLM.ok", error: "RL.Bots.LLM.error" };
    const details = [];
    if ( s.state === "ok" ) {
      if ( Number.isFinite(s.latencyMs) ) details.push(t("RL.Bots.LLM.latency", { s: (s.latencyMs / 1000).toFixed(1) }));
      if ( s.model ) details.push(modelName(s.model));
      if ( s.cost ) details.push(t("RL.Bots.LLM.testCost", { cost: usd(s.cost, { precise: true }) }));
    }
    if ( s.state !== "checking" ) details.push(t(relay ? "RL.Bots.LLM.viaRelay" : (hasKey ? "RL.Bots.LLM.keyHere" : "RL.Bots.LLM.noKey")));
    const problem = (s.state === "error") ? explainError(s, { model: s.model }) : null;

    // Spend this war (bots.llmSpent is {war, usd, calls}, kept by the driver; another war's spend doesn't count)
    const spent = getSetting(SETTINGS.llmSpent) ?? {};
    const warId = war?.id ?? "";
    const thisWar = !!warId && (spent.war === warId);
    const amount = thisWar ? (Number(spent.usd) || 0) : 0;
    const calls = thisWar ? (Number(spent.calls) || 0) : 0;
    const limit = Number(getSetting(SETTINGS.llmSpendLimit)) || 0;
    const over = (limit > 0) && (amount >= limit);
    const talk = getSetting(SETTINGS.tableTalk);

    return {
      state: s.state, label: t(labels[s.state] ?? labels.unknown), details: details.join(" · "),
      checking: s.state === "checking",
      error: problem?.text ?? "", policy: problem?.kind === "policy",
      url, urlValid: validRelayUrl(url), relay,
      keySet: hasKey,
      keyPlaceholder: t(hasKey ? "RL.Bots.LLM.keySaved" : (relay ? "RL.Bots.LLM.keyRelay" : "RL.Bots.LLM.keyPaste")),
      models: modelOptions(defaultModel),
      modelsLoading: models.state === "loading",
      modelsError: models.state === "error" ? t("RL.Bots.LLM.modelsError", { error: models.error }) : "",
      modelsNone: (models.state === "ok") && !models.list.length,
      modelsHint: models.state === "ok"
        ? t(models.list.length === 1 ? "RL.Bots.LLM.modelsOne" : "RL.Bots.LLM.modelsMany", { n: models.list.length })
        : t("RL.Bots.LLM.modelsHint"),
      spend: {
        value: usd(amount), calls: t(calls === 1 ? "RL.Bots.LLM.callsOne" : "RL.Bots.LLM.callsMany", { n: calls }),
        limit, cap: limit > 0 ? t("RL.Bots.LLM.of", { cap: usd(limit) }) : t("RL.Bots.LLM.noCap"),
        pct: limit > 0 ? Math.min(100, Math.round((amount / limit) * 100)) : 0,
        hasCap: limit > 0, over, warn: (limit > 0) && !over && (amount >= limit * 0.8),
        war: war ? "" : t("RL.Bots.LLM.noWar")
      },
      talk: ["all", "gm", "off"].map(v => ({ value: v, label: t(`RL.Bots.Settings.tableTalk.${v}`), selected: v === talk })),
      chatBots
    };
  }

  #relayContext() {
    const s = relayStatus();
    const url = getSetting(SETTINGS.relayUrl);
    const commands = relayCommands();
    const labels = { unknown: "RL.Bots.Relay.unknown", checking: "RL.Bots.Relay.checking", ok: "RL.Bots.Relay.ok", error: "RL.Bots.Relay.error" };
    const details = [];
    if ( s.state === "ok" ) {
      if ( s.latencyMs !== null && s.latencyMs !== undefined ) details.push(t("RL.Bots.Relay.latency", { ms: s.latencyMs }));
      if ( s.model ) details.push(t("RL.Bots.Relay.model", { model: s.model }));
    }
    return {
      state: s.state, label: t(labels[s.state] ?? labels.unknown), details: details.join(" · "),
      checking: s.state === "checking", error: s.state === "error" ? s.error : "",
      showHelp: s.state === "error", url, urlValid: validRelayUrl(url), token: getSetting(SETTINGS.relayToken),
      commands, hasExtra: !!commands.extra
    };
  }

  #controlContext() {
    let status = {};
    try {
      status = driver.status?.() ?? {};
    } catch(err) { /* driver not ready */ }
    let paused = !!getSetting(SETTINGS.paused);
    try {
      paused ||= !!driver.isPaused?.();
    } catch(err) { /* placeholder */ }
    // driver status: running {faction, name, key, step}, waiting "paused"|"jev"|"llm", lastError {time, faction, message}
    const run = status.running;
    const runId = typeof run === "string" ? run : run?.faction;
    const running = run ? (run.name || game.actors.get(runId)?.name || String(runId ?? "")) : "";
    const err = status.lastError;
    let lastError = "";
    if ( err ) {
      const message = typeof err === "string" ? err : (err.message ?? err.detail ?? JSON.stringify(err));
      const who = (typeof err === "object") && err.faction ? game.actors.get(err.faction)?.name : "";
      lastError = who ? `${who}: ${message}` : message;
    }
    let hint = t("RL.Bots.Manager.activeHint");
    if ( paused ) hint = t("RL.Bots.Manager.pausedHint");
    else if ( status.waiting === "jev" ) hint = t("RL.Bots.Manager.waitingJev", { faction: running || "?" });
    else if ( status.waiting === "llm" ) hint = t("RL.Bots.Manager.waitingLLM", { faction: running || "?" });
    else if ( running ) hint = t("RL.Bots.Manager.running", { faction: running });
    return {
      paused, running, lastError, hint,
      heuristic: !!status.heuristicSession,
      state: paused ? t("RL.Bots.Manager.paused") : t("RL.Bots.Manager.active")
    };
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const settingPrefix = `${SYSTEM_ID}.bots.`;
    const relayKeys = [SETTINGS.relayUrl, SETTINGS.relayToken].map(k => `${SYSTEM_ID}.${k}`);
    const llmKeys = LLM_KEYS.map(k => `${SYSTEM_ID}.${k}`);
    const onSetting = doc => {
      const key = String(doc?.key ?? "");
      if ( !key.startsWith(settingPrefix) ) return;
      // The relay moved (here or in the core settings window): the last result no longer applies
      if ( relayKeys.includes(key) ) {
        resetRelayStatus();
        testRelay();
      }
      if ( llmKeys.includes(key) ) this.#llmChanged();
      else if ( key === `${SYSTEM_ID}.${SETTINGS.llmModel}` ) resetLLMStatus();
      this.#renderSoon();
    };
    for ( const name of HOOKS ) {
      const fn = name.endsWith("Setting") ? onSetting : () => this.#renderSoon();
      this.#hooks.push([name, Hooks.on(name, fn)]);
    }
    this.#unsubscribe.push(onRelayStatus(() => this.#renderSoon()), onLLMStatus(() => this.#renderSoon()));
    this.element.addEventListener("change", this.#onChange.bind(this));
    this.element.addEventListener("focusout", () => {
      if ( this.#deferred ) setTimeout(() => this.#renderSoon(), 0);
    });
    this.element.addEventListener("keydown", event => {
      // Enter in the key field saves it (a change event), without submitting anything else
      if ( (event.key === "Enter") && event.target.matches?.("input[name='llmApiKey']") ) {
        event.preventDefault();
        event.target.blur();
      }
    });
    // Check the relay when the window opens (a recent result is reused); load the chat models (free, cached)
    testRelay({ force: false });
    if ( keySet() || viaRelay() || botUsers().some(isChat) ) loadModels().catch(() => {});
  }

  /** @override */
  _onClose(options) {
    for ( const [name, id] of this.#hooks ) Hooks.off(name, id);
    this.#hooks = [];
    for ( const off of this.#unsubscribe ) off?.();
    this.#unsubscribe = [];
    super._onClose(options);
  }

  /** The base URL or key changed: the last check and model list no longer apply. */
  #llmChanged() {
    resetLLMStatus();
    resetModels();
    loadModels({ refresh: true }).catch(() => {});
  }

  /** Difficulty radios, the bots' model selects and the relay / chat-model fields save on change. */
  async #onChange(event) {
    const el = event.target;
    if ( el.matches("input[data-bot-difficulty]") ) {
      const user = game.users.get(el.dataset.botDifficulty);
      if ( user ) await this.#attempt(() => setBotDifficulty(user, el.value));
      return;
    }
    if ( el.matches("select[data-bot-model]") ) {
      const user = game.users.get(el.dataset.botModel);
      if ( user ) await this.#attempt(() => setBotConfig(user, { model: el.value || null }));
      return;
    }
    switch ( el.name ) {
      case "relayUrl": {
        const value = el.value.trim();
        if ( !validRelayUrl(value) ) {
          ui.notifications.warn("RL.Bots.Relay.badUrl", { localize: true });
          el.value = getSetting(SETTINGS.relayUrl);
          return;
        }
        // the setting hook re-tests the relay
        await setSetting(SETTINGS.relayUrl, value.replace(/\/+$/, ""));
        return;
      }
      case "relayToken": return setSetting(SETTINGS.relayToken, el.value.trim());
      case "llmBaseUrl": {
        const value = el.value.trim().replace(/\/+$/, "");
        if ( !validRelayUrl(value) ) {
          ui.notifications.warn("RL.Bots.LLM.badUrl", { localize: true });
          el.value = getSetting(SETTINGS.llmBaseUrl);
          return;
        }
        if ( value !== getSetting(SETTINGS.llmBaseUrl) ) await setSetting(SETTINGS.llmBaseUrl, value);
        return;
      }
      case "llmApiKey": {
        // Saved to this browser's client setting only; the field never shows it again
        const value = el.value.trim();
        el.value = "";
        if ( !value ) return;
        await this.#attempt(() => setSetting(SETTINGS.llmApiKey, value));
        ui.notifications.info("RL.Bots.LLM.keyStored", { localize: true });
        this.#llmChanged();
        this.#renderSoon();
        return;
      }
      case "llmModel": {
        // the setting hook forgets the last check (it was for the old model)
        if ( el.value && (el.value !== getSetting(SETTINGS.llmModel)) ) await this.#attempt(() => setSetting(SETTINGS.llmModel, el.value));
        return;
      }
      case "llmSpendLimit": {
        const n = Math.round(Math.max(0, Math.min(50, Number(el.value) || 0)) * 100) / 100;
        el.value = n;
        if ( n !== Number(getSetting(SETTINGS.llmSpendLimit)) ) await this.#attempt(() => setSetting(SETTINGS.llmSpendLimit, n));
        return;
      }
      case "tableTalk": {
        if ( ["all", "gm", "off"].includes(el.value) ) await this.#attempt(() => setSetting(SETTINGS.tableTalk, el.value));
      }
    }
  }

  /** Run a GM operation; show its error as a warning. */
  async #attempt(fn) {
    try {
      return await fn();
    } catch(err) {
      ui.notifications.warn(err.message);
      return null;
    }
  }

  /** Run an action that creates or changes bots, once at a time. */
  async #exclusive(fn) {
    if ( this.#busy ) return null;
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
      this.#renderSoon();
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onAddBot(event, target) {
    await this.#exclusive(async () => {
      const user = await this.#attempt(() => createBot({ difficulty: target.dataset.difficulty }));
      if ( user ) ui.notifications.info(t("RL.Bots.Manager.added", { name: user.name }));
    });
  }

  static async #onAddChatBot() {
    if ( this.#busy ) return;
    const choice = await choosePersonality({ mode: "add" });
    if ( !choice ) return;
    await this.#exclusive(async () => {
      const user = await this.#attempt(() => createBot({
        engine: "llm", difficulty: choice.difficulty, model: choice.model, personality: choice.personality
      }));
      if ( user ) ui.notifications.info(t("RL.Bots.Manager.added", { name: user.name }));
    });
  }

  static async #onPickPersonality(event, target) {
    const user = game.users.get(target.closest("[data-user-id]")?.dataset.userId);
    if ( !user || this.#busy ) return;
    const seated = seatedFaction(user);
    if ( seated ) {
      ui.notifications.warn(t("RL.Bots.Manager.personaSeated", { faction: seated.name }));
      return;
    }
    const choice = await choosePersonality({ mode: "pick", user });
    if ( !choice ) return;
    await this.#exclusive(() => this.#attempt(() => setBotConfig(user, { personality: choice.personality })));
  }

  /** Give every chat bot a different random personality (between wars only). */
  static async #onRandomize() {
    const bots = botUsers().filter(isChat);
    if ( !bots.length || this.#busy ) return;
    const seated = bots.filter(u => seatedFaction(u));
    if ( seated.length ) {
      ui.notifications.warn(t("RL.Bots.Manager.randomizeSeated", { names: list(seated.map(u => u.name)) }));
      return;
    }
    const confirm = game.risklegacy.apps?.confirmAction;
    const title = t("RL.Bots.Manager.randomizeTitle");
    const content = `<p>${esc(t("RL.Bots.Manager.randomizeBody", { n: bots.length }))}</p>`;
    const ok = confirm
      ? await confirm({ title, content, yes: "RL.Bots.Manager.randomizeYes", icon: "fa-solid fa-dice" })
      : await foundry.applications.api.DialogV2.confirm({ window: { title }, content });
    if ( !ok ) return;
    await this.#exclusive(async () => {
      // A shuffled deck, dealt so that each bot gets one nobody else gets, and a new one when there are enough
      const deck = PERSONALITIES.map(p => p.id);
      for ( let i = deck.length - 1; i > 0; i-- ) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const dealt = new Set();
      const plan = bots.map(user => {
        const current = botInfo(user).personality;
        const id = deck.find(x => !dealt.has(x) && (x !== current)) ?? deck.find(x => !dealt.has(x)) ?? deck[0];
        dealt.add(id);
        return [user, id];
      });
      for ( const [user, id] of plan ) await this.#attempt(() => setBotConfig(user, { personality: id }));
      // Swaps leave names such as "Marshal Ada Kestrel 2" while the other bot still had the name: tidy them up
      for ( const [user, id] of plan ) {
        const name = personalityById(id)?.name;
        if ( name && (user.name !== name) && user.name.startsWith(`${name} `) && /^\d+$/.test(user.name.slice(name.length + 1))
          && !game.users.getName(name) ) await this.#attempt(() => user.update({ name }));
      }
      ui.notifications.info(t("RL.Bots.Manager.randomized", { n: plan.length }));
    });
  }

  static async #onNotes(event, target) {
    const user = game.users.get(target.closest("[data-user-id]")?.dataset.userId);
    if ( user ) await openNotes(user);
  }

  static async #onRemoveBot(event, target) {
    const user = game.users.get(target.closest("[data-user-id]")?.dataset.userId);
    if ( !user ) return;
    const seated = seatedFaction(user);
    if ( seated ) {
      ui.notifications.warn(t("RL.Bots.Error.seated", { name: user.name, faction: seated.name }));
      return;
    }
    const confirm = game.risklegacy.apps?.confirmAction;
    const title = t("RL.Bots.Manager.removeTitle", { name: user.name });
    const body = isChat(user) && hasMemory(botInfo(user).memory) ? "RL.Bots.Manager.removeBodyNotes" : "RL.Bots.Manager.removeBody";
    const content = `<p>${esc(t(body, { name: user.name }))}</p>`;
    const ok = confirm
      ? await confirm({ title, content, destructive: true, yes: "RL.Bots.Manager.removeYes", icon: "fa-solid fa-user-minus" })
      : await foundry.applications.api.DialogV2.confirm({ window: { title }, content });
    if ( !ok ) return;
    await this.#attempt(() => removeBot(user));
  }

  static async #onTestRelay() {
    await testRelay();
  }

  static async #onTestLLM() {
    await testLLM({ model: getSetting(SETTINGS.llmModel) });
    // A successful check is a good moment to refresh the model list too
    if ( llmStatus().state === "ok" ) loadModels().catch(() => {});
  }

  static async #onRefreshModels() {
    await loadModels({ refresh: true });
  }

  static async #onClearKey() {
    if ( !keySet() ) return;
    await this.#attempt(() => setSetting(SETTINGS.llmApiKey, ""));
    ui.notifications.info("RL.Bots.LLM.keyCleared", { localize: true });
    this.#llmChanged();
    this.#renderSoon();
  }

  static async #onTogglePause() {
    const { paused } = this.#controlContext();
    await this.#attempt(async () => {
      if ( paused ) {
        await driver.resume?.();
        if ( getSetting(SETTINGS.paused) ) await setSetting(SETTINGS.paused, false);
      }
      else {
        await driver.pause?.();
        if ( !getSetting(SETTINGS.paused) ) await setSetting(SETTINGS.paused, true);
      }
    });
    this.#renderSoon();
  }

  static #onOpenSettings() {
    game.settings.sheet.render({ force: true, tab: { categories: "system" } });
  }

  static async #onCopy(event, target) {
    const text = target.dataset.copy ?? target.closest("[data-copy-from]")?.querySelector("code")?.textContent ?? "";
    if ( !text ) return;
    await game.clipboard.copyPlainText(text);
    ui.notifications.info("RL.Bots.Copied", { localize: true });
  }
}
