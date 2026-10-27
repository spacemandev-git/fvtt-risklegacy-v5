/**
 * Bot Log (BOTS.md §7.2, BOTS-LLM.md §8): every bot decision, newest first, filterable by faction and kind. The
 * headline is the narration line; expanding a record shows the decision, its `why`, its table talk, and each exchange:
 * - Jev (the request's state and questions, the answers with their probabilities, model, tokens and time);
 * - chat model (model, purpose, time, tokens, cost, the parsed answer with its `thinking` and `say`; the messages, with
 *   the system message folded, and the model's reasoning collapsed);
 * with Copy JSON for replaying it. The log lives in memory on the active GM's client (module/bots/log.mjs); the window
 * re-renders on `risklegacy.botDecision`.
 */
import { clearLog, getLog, logStats } from "../log.mjs";
import { botOfFaction } from "../users.mjs";
import { modelName, usd } from "./llm.mjs";
import {
  categoryLabel, categoryOf, factionName, humanize, jevOf, llmOf, narrationLine, percent, recordBot, sayOf, t, tpl, whyRows
} from "./text.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PAGE = 100;
const MAX = 500;
const JSON_LIMIT = 60_000;

/** Pretty JSON for display, cut short when huge (Copy JSON always copies everything). */
function pretty(value) {
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch(err) {
    s = String(value);
  }
  return (s?.length > JSON_LIMIT) ? `${s.slice(0, JSON_LIMIT)}\n… (${t("RL.Bots.Log.truncated", { n: s.length })})` : (s ?? "");
}

/** Text of a chat message's content (a string, or OpenAI-style parts). */
function messageText(content) {
  if ( typeof content === "string" ) return content;
  if ( Array.isArray(content) ) return content.map(p => (typeof p === "string" ? p : (p?.text ?? JSON.stringify(p)))).join("\n");
  return pretty(content ?? "");
}

/** "1,234" in the world's language. */
const num = n => (Number(n) || 0).toLocaleString(game.i18n.lang);

/** Prompt and completion tokens of a chat exchange. */
const llmTokens = x => ({
  input: Number(x?.response?.usage?.prompt_tokens) || 0,
  output: Number(x?.response?.usage?.completion_tokens) || 0
});

/** A chat exchange's cost in USD (the response's, else its usage's). */
const llmCost = x => Number(x?.response?.cost ?? x?.response?.usage?.cost ?? x?.cost) || 0;

/** A probability bar row. */
const bar = (p, extra = {}) => ({ p, pct: percent(p), width: Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 100))), ...extra });

export default class BotLog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-bot-log",
    classes: ["risklegacy", "rl-bot-app", "rl-bot-log-app"],
    tag: "div",
    window: { title: "RL.Bots.Log.title", icon: "fa-solid fa-list-check", resizable: true, minimizable: true },
    position: { width: 680, height: 720 },
    actions: {
      copyRecord: BotLog.#onCopyRecord,
      copyRequest: BotLog.#onCopyRequest,
      copyExchange: BotLog.#onCopyExchange,
      more: BotLog.#onMore,
      clear: BotLog.#onClear,
      manager: () => game.risklegacy.bots?.openBotManager?.()
    }
  };

  static PARTS = {
    main: { template: tpl("bots/bot-log.hbs"), scrollable: [".rl-bot-log__list"] }
  };

  static get instance() {
    return foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? null;
  }

  /** Open (or bring forward) the Bot Log. GM only. */
  static async open() {
    if ( !game.user.isGM ) {
      ui.notifications.warn("RL.Bots.Error.gmOnly", { localize: true });
      return null;
    }
    const app = this.instance ?? new this();
    if ( app.rendered ) {
      if ( app.minimized ) await app.maximize();
      app.bringToFront();
      return app.render();
    }
    return app.render({ force: true });
  }

  /** Filters and paging (per window). */
  #filter = { faction: "", kind: "" };

  #limit = PAGE;

  /** Records the user has expanded. */
  #open = new Set();

  /** Folded sections inside records (messages, reasoning, state) the user has opened, by their data-sync key. */
  #openInner = new Set();

  #hook = null;

  #renderSoon = foundry.utils.debounce(() => {
    if ( this.rendered ) this.render();
  }, 200);

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const all = getLog({ limit: MAX });
    const stats = logStats();
    // `requests` counts Jev and chat-model requests together; `llmRequests` and `cost` are the chat models' share
    const llmRequests = Number(stats.llmRequests) || 0;
    const jevRequests = Number.isFinite(stats.jevRequests) ? stats.jevRequests : Math.max(0, (Number(stats.requests) || 0) - llmRequests);
    context.stats = [
      { label: t("RL.Bots.Log.stat.decisions"), value: num(stats.decisions) },
      { label: t("RL.Bots.Log.stat.requests"), value: num(jevRequests) },
      { label: t("RL.Bots.Log.stat.llmRequests"), value: num(llmRequests) },
      { label: t("RL.Bots.Log.stat.tokens"), value: num(stats.inputTokens) },
      { label: t("RL.Bots.Log.stat.cost"), value: usd(stats.cost), tip: t("RL.Bots.Log.stat.costTip") },
      { label: t("RL.Bots.Log.stat.latency"), value: (stats.avgMs >= 1000)
        ? t("RL.Bots.Log.seconds", { s: (stats.avgMs / 1000).toLocaleString(game.i18n.lang, { maximumFractionDigits: 1 }) })
        : t("RL.Bots.Log.ms", { ms: num(stats.avgMs) }) },
      { label: t("RL.Bots.Log.stat.errors"), value: num(stats.errors), warn: stats.errors > 0 },
      { label: t("RL.Bots.Log.stat.heuristic"), value: num(stats.heuristic), warn: stats.heuristic > 0 }
    ];

    // Filter options from what is in the log (plus the current war's bot factions)
    const factions = new Map();
    for ( const r of all ) if ( r.faction && !factions.has(r.faction) ) factions.set(r.faction, factionName(r.faction, r));
    for ( const a of game.actors.filter(x => (x.type === "faction") && x.system.war?.active && botOfFaction(x)) ) {
      if ( !factions.has(a.id) ) factions.set(a.id, a.name);
    }
    const kinds = [...new Set(all.map(r => r.kind).filter(Boolean))].sort();
    if ( this.#filter.faction && !factions.has(this.#filter.faction) ) factions.set(this.#filter.faction, factionName(this.#filter.faction));
    if ( this.#filter.kind && !kinds.includes(this.#filter.kind) ) kinds.push(this.#filter.kind);
    context.filters = {
      factions: [...factions].map(([value, label]) => ({ value, label, selected: value === this.#filter.faction })),
      kinds: kinds.map(value => ({ value, label: this.#kindLabel(value), selected: value === this.#filter.kind })),
      active: !!(this.#filter.faction || this.#filter.kind)
    };

    const filtered = all.filter(r => (!this.#filter.faction || (r.faction === this.#filter.faction))
      && (!this.#filter.kind || (r.kind === this.#filter.kind)));
    context.records = filtered.slice(0, this.#limit).map(r => this.#row(r));
    context.shown = context.records.length;
    context.total = filtered.length;
    context.more = filtered.length > this.#limit;
    context.empty = !all.length;
    context.noMatch = !!all.length && !filtered.length;
    context.activeGM = game.users.activeGM;
    context.isActiveGM = game.user.isActiveGM;
    return context;
  }

  #kindLabel(kind) {
    const key = `RL.Bots.Kind.${kind}`;
    return game.i18n.has(key) ? t(key) : humanize(kind);
  }

  /** One record's summary (and its detail when expanded). */
  #row(r) {
    const category = categoryOf(r);
    const actor = game.actors.get(r.faction);
    const jev = jevOf(r);
    const chats = llmOf(r);
    const tokens = jev.reduce((s, x) => s + (x.response?.usage?.input_tokens ?? 0), 0);
    const ms = jev.reduce((s, x) => s + (x.ms ?? 0), 0);
    const errors = jev.filter(x => x.error).length + chats.filter(x => x.error).length + (r.error ? 1 : 0);
    const bot = recordBot(r);
    const cost = Number.isFinite(Number(r.cost)) && (r.cost !== null) && (r.cost !== undefined)
      ? Number(r.cost) : chats.reduce((s, x) => s + llmCost(x), 0);
    const chatTokens = chats.reduce((s, x) => s + llmTokens(x).input + llmTokens(x).output, 0);
    const chatMs = chats.reduce((s, x) => s + (x.ms ?? 0), 0);
    let line;
    try {
      line = narrationLine(r);
    } catch(err) {
      line = `${r.kind ?? "?"}: ${r.decision?.why?.reason ?? "?"}`;
    }
    const date = new Date(r.time);
    const open = this.#open.has(r.id);
    return {
      id: r.id, open, line, category, categoryLabel: categoryLabel(category),
      kind: r.kind, kindLabel: r.kind ? this.#kindLabel(r.kind) : "",
      time: date.toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      timeFull: date.toLocaleString(game.i18n.lang),
      faction: factionName(r.faction, r) || r.factionName || "",
      color: actor?.system?.color?.css ?? "",
      difficulty: bot.difficultyLabel,
      heuristic: !!r.heuristic, errors,
      heuristicTip: t(bot.engine === "llm" ? "RL.Bots.Log.heuristicTipLLM" : "RL.Bots.Log.heuristicTip"),
      requests: jev.length,
      jev: jev.length ? t(jev.length === 1 ? "RL.Bots.Log.jevOne" : "RL.Bots.Log.jevMany", {
        n: jev.length, tokens: num(tokens), ms: num(Math.round(ms))
      }) : "",
      chats: chats.length,
      cost: (chats.length || cost) ? usd(cost) : "",
      chat: chats.length ? t(chats.length === 1 ? "RL.Bots.Log.chatOne" : "RL.Bots.Log.chatMany", {
        n: chats.length, tokens: num(chatTokens), ms: num(Math.round(chatMs)), cost: usd(cost, { precise: true })
      }) : "",
      engine: bot.engine,
      model: (bot.engine === "llm") ? (r.model ?? chats.find(x => x.request?.model)?.request?.model ?? "") : "",
      personality: bot.title,
      say: sayOf(r),
      detail: open ? this.#detail(r) : null
    };
  }

  #detail(r) {
    const d = r.decision ?? null;
    const decision = d ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "why")) : null;
    return {
      reason: d?.why?.reason ?? "",
      reasonKnown: !!d?.why?.reason && game.i18n.has(`RL.Bots.Why.${d.why.reason}`),
      why: whyRows(r),
      decision: decision === null ? "null" : pretty(decision),
      error: r.error ?? "",
      exchanges: jevOf(r).map((x, i) => this.#exchange(x, i, r)),
      chats: llmOf(r).map((x, i) => this.#chat(r, x, i))
    };
  }

  /** One chat-model exchange (BOTS-LLM.md §4.2 logging shape). */
  #chat(r, x, i) {
    const req = x.request ?? {};
    const res = x.response ?? {};
    const { input, output } = llmTokens(x);
    const reasoningTokens = Number(res.usage?.completion_tokens_details?.reasoning_tokens) || 0;
    const parsed = (res.parsed && (typeof res.parsed === "object")) ? res.parsed : null;
    const answer = parsed ? Object.fromEntries(Object.entries(parsed).filter(([k]) => !["thinking", "say"].includes(k))) : null;
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const sync = `${r.id}-llm-${i}`;
    const effort = req.reasoning?.effort ?? (req.reasoning ? JSON.stringify(req.reasoning) : "");
    const model = res.model ?? req.model ?? "";
    return {
      n: i + 1, index: i, purpose: x.purpose ?? "",
      model: modelName(model), modelId: model,
      ms: num(Math.round(x.ms ?? 0)),
      tokens: (input || output) ? t(reasoningTokens ? "RL.Bots.Log.tokensReasoning" : "RL.Bots.Log.tokens", {
        input: num(input), output: num(output), reasoning: num(reasoningTokens)
      }) : "",
      cost: (llmCost(x) || res.usage) ? usd(llmCost(x), { precise: true }) : "",
      finish: res.finish && (res.finish !== "stop") ? res.finish : "",
      attempt: Number(x.attempt) > 1 ? t("RL.Bots.Log.attempt", { n: x.attempt }) : "",
      settings: [
        effort ? t("RL.Bots.Log.effort", { effort }) : "",
        Number.isFinite(Number(req.temperature)) ? t("RL.Bots.Log.temperature", { temperature: req.temperature }) : "",
        req.max_tokens ? t("RL.Bots.Log.maxTokens", { n: num(req.max_tokens) }) : ""
      ].filter(Boolean).join(" · "),
      error: x.error ? String(x.error) : "",
      thinking: typeof parsed?.thinking === "string" ? parsed.thinking.trim() : "",
      say: typeof parsed?.say === "string" ? parsed.say.trim() : "",
      answer: answer && Object.keys(answer).length ? pretty(answer) : (!parsed && res.content ? pretty(res.content) : ""),
      raw: !parsed && !!res.content,
      messages: messages.map((m, j) => {
        const content = messageText(m?.content);
        const role = String(m?.role ?? "?");
        return {
          role, system: role === "system", chars: num(content.length), content: pretty(content),
          roleLabel: game.i18n.has(`RL.Bots.Log.role.${role}`) ? t(`RL.Bots.Log.role.${role}`) : role,
          sync: `${sync}-m${j}`, open: role === "system" ? this.#openInner.has(`${sync}-m${j}`) : true
        };
      }),
      messagesSync: `${sync}-msgs`, messagesOpen: this.#openInner.has(`${sync}-msgs`),
      reasoning: res.reasoning ? pretty(res.reasoning) : "",
      reasoningChars: num(String(res.reasoning ?? "").length),
      reasoningSync: `${sync}-reasoning`, reasoningOpen: this.#openInner.has(`${sync}-reasoning`),
      schema: req.schema?.name ?? ""
    };
  }

  /** One Jev request/response, with each question next to its answer. */
  #exchange(x, i, r) {
    const questions = x.request?.questions ?? {};
    const answers = x.response?.answers ?? {};
    const names = [...new Set([...Object.keys(questions), ...Object.keys(answers)])];
    return {
      n: i + 1, index: i, purpose: x.purpose ?? "",
      ms: Math.round(x.ms ?? 0),
      model: x.response?.model ?? x.request?.model ?? "",
      inputTokens: x.response?.usage?.input_tokens?.toLocaleString(game.i18n.lang) ?? "",
      outputTokens: x.response?.usage?.output_tokens?.toLocaleString(game.i18n.lang) ?? "",
      error: x.error ?? "",
      questions: names.map(name => this.#question(name, questions[name], answers[name])),
      state: pretty(x.request?.state ?? null),
      stateOpen: this.#openInner.has(`state-${r?.id}-${i}`),
      stateChars: (typeof x.request?.state === "string" ? x.request.state : JSON.stringify(x.request?.state ?? null) ?? "").length
    };
  }

  #question(name, q = {}, a = null) {
    const type = a?.type ?? q?.type ?? "?";
    const out = {
      name, type, typeLabel: game.i18n.has(`RL.Bots.Log.type.${type}`) ? t(`RL.Bots.Log.type.${type}`) : type,
      instructions: q?.instructions ?? "", missing: !a
    };
    if ( !a ) return out;
    if ( type === "noul" ) {
      out.noul = bar(a.noul, { chosen: Number(a.noul) >= 0.5 });
      out.criteria = q?.criteria ? Object.entries(q.criteria).map(([k, v]) => ({ key: k, text: typeof v === "string" ? v : JSON.stringify(v) })) : [];
    }
    else if ( type === "choice" ) {
      const criteria = q?.criteria ?? {};
      const keys = [...new Set([...Object.keys(criteria), ...Object.keys(a.probabilities ?? {})])];
      out.options = keys.map(k => bar(a.probabilities?.[k] ?? 0, {
        key: k, text: typeof criteria[k] === "string" ? criteria[k] : "", chosen: k === a.choice
      }));
      out.confidence = Number.isFinite(a.confidence) ? percent(a.confidence) : "";
    }
    else if ( type === "score" ) {
      const legend = a.legend ?? {};
      const keys = Object.keys({ ...legend, ...(a.probabilities ?? {}) }).sort((x, y) => Number(x) - Number(y));
      const top = keys.reduce((best, k) => ((a.probabilities?.[k] ?? 0) > (a.probabilities?.[best] ?? -1) ? k : best), keys[0]);
      out.levels = keys.map(k => bar(a.probabilities?.[k] ?? 0, {
        key: k, text: typeof legend[k] === "string" ? legend[k] : JSON.stringify(legend[k] ?? ""), chosen: k === top
      }));
      out.score = Number.isFinite(a.score) ? a.score.toFixed(2) : "";
      out.confidence = Number.isFinite(a.confidence) ? percent(a.confidence) : "";
    }
    else out.raw = pretty(a);
    return out;
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hook = Hooks.on("risklegacy.botDecision", () => this.#renderSoon());
    this.element.addEventListener("change", this.#onChange.bind(this));
    // <details> toggles don't bubble: listen in the capture phase
    this.element.addEventListener("toggle", this.#onToggle.bind(this), true);
  }

  /** @override */
  _onClose(options) {
    if ( this.#hook !== null ) Hooks.off("risklegacy.botDecision", this.#hook);
    this.#hook = null;
    super._onClose(options);
  }

  #onChange(event) {
    const el = event.target;
    if ( el.name === "faction" ) this.#filter.faction = el.value;
    else if ( el.name === "kind" ) this.#filter.kind = el.value;
    else return;
    this.#limit = PAGE;
    this.render();
  }

  #onToggle(event) {
    const details = event.target;
    // Folded sections inside a record keep their state across re-renders
    if ( details?.matches?.("details[data-sync]") ) {
      if ( details.open ) this.#openInner.add(details.dataset.sync);
      else this.#openInner.delete(details.dataset.sync);
      return;
    }
    if ( !details?.matches?.("details.rl-bot-rec") ) return;
    const id = details.dataset.recordId;
    const was = this.#open.has(id);
    if ( details.open === was ) return;
    if ( details.open ) this.#open.add(id);
    else this.#open.delete(id);
    // Expanding builds the detail (it isn't rendered for closed records)
    if ( details.open ) this.render();
  }

  /** The full record by id. */
  static #record(id) {
    return getLog({ limit: MAX }).find(r => r.id === id) ?? null;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onCopyRecord(event, target) {
    const record = BotLog.#record(target.closest("[data-record-id]")?.dataset.recordId);
    if ( !record ) return;
    await game.clipboard.copyPlainText(JSON.stringify(record, null, 2));
    ui.notifications.info("RL.Bots.Copied", { localize: true });
  }

  static async #onCopyRequest(event, target) {
    const record = BotLog.#record(target.closest("[data-record-id]")?.dataset.recordId);
    const exchange = record?.jev?.[Number(target.dataset.index)];
    if ( !exchange ) return;
    await game.clipboard.copyPlainText(JSON.stringify(exchange.request, null, 2));
    ui.notifications.info("RL.Bots.Copied", { localize: true });
  }

  /** A whole chat-model exchange (request and response; the API key is never part of it). */
  static async #onCopyExchange(event, target) {
    const record = BotLog.#record(target.closest("[data-record-id]")?.dataset.recordId);
    const exchange = llmOf(record)[Number(target.dataset.index)];
    if ( !exchange ) return;
    await game.clipboard.copyPlainText(JSON.stringify(exchange, null, 2));
    ui.notifications.info("RL.Bots.Copied", { localize: true });
  }

  static #onMore() {
    this.#limit = Math.min(MAX, this.#limit + PAGE);
    this.render();
  }

  static async #onClear() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "RL.Bots.Log.clearTitle", icon: "fa-solid fa-eraser" },
      content: `<p>${game.i18n.localize("RL.Bots.Log.clearBody")}</p>`,
      classes: ["risklegacy"]
    });
    if ( !ok ) return;
    clearLog();
    this.#open.clear();
    this.#openInner.clear();
    this.render();
  }
}
