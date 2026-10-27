import { SYSTEM_ID } from "../config.mjs";
import * as rules from "../rules/_module.mjs";
import * as state from "../state/_module.mjs";
import { currentMission, revealMission } from "./missions.mjs";
import { drawResourceCard, getRow } from "./sideboard.mjs";
import { factionActor, territoryName } from "./util.mjs";

/**
 * Event card automation (rulebook p. 13). `runEffect(catalogId, ctx)` carries out the catalog event on the active
 * GM and returns what happened; module/cards/events.mjs posts/updates the chat card and disposes of the card.
 *
 * Who decides: an event that needs a choice asks the controlling player **on their own client** with the User query
 * `fvtt-risklegacy-v5.events.choose` (one query per step: an option dialog, a number, or a territory pick on the
 * board). The step closes itself after ASK_TIMEOUT; if the player is offline, doesn't answer in time or the query
 * fails, the GM is asked instead for the rest of that event. Every board change is made here, on the GM, through the
 * canvas/campaign GM actions (never the turn's serialized actions: events run inside `turn.end`).
 *
 * Rulebook: "If there is ever a tie, or if a noted faction/player is knocked out, eliminated or not in the current
 * game; the Event does not occur." An event that does not occur is DISCARDED (back in the box), whatever the card
 * says to do after resolving it.
 *
 * Effect result: {occurred, reason, lead, leadValue, rows[], summary, note, token, outcome, rolls[], pending, faction}
 *   outcome  box | destroy | keep | null (the card's afterResolve) — overrides the catalog for conditional cards
 *   pending  true when the event could not be finished (the card waits for the GM's buttons)
 */

export const QUERY = `${SYSTEM_ID}.events.choose`;
export const SETTING = "eventAutomation";

/** How long a player has for each step of an event choice before the GM decides (ms). */
export const ASK_TIMEOUT = 60_000;

/** How many times a chooser may back out of a sub-step (Esc on the board) and pick another option. */
const MAX_TRIES = 4;

/** Factions that are not human (Agent of Chaos: "If no human faction has a continent bonus"). */
const NON_HUMAN = new Set(["mutants", "aliens"]);

const fmt = (key, data) => game.i18n.format(key, data);
const loc = key => game.i18n.localize(key);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const snap = () => state.buildSnapshot();
const board = () => game.risklegacy.board;
const campaignApi = () => game.risklegacy.campaign;

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** Register the world setting and the User query. Called from the cards area's init(). */
export function init() {
  game.settings.register(SYSTEM_ID, SETTING, {
    name: "RL.Events.Settings.automation.name",
    hint: "RL.Events.Settings.automation.hint",
    scope: "world", config: true,
    type: new foundry.data.fields.BooleanField({ initial: true })
  });
  CONFIG.queries[QUERY] = async (request, { user } = {}) => {
    if ( !user?.isGM ) throw new Error("Only a GM may ask for event choices");
    return answerRequest(request ?? {});
  };
}

/** @returns {boolean} whether events are carried out automatically (world setting, default on) */
export function automationEnabled() {
  try {
    return game.settings.get(SYSTEM_ID, SETTING) !== false;
  } catch(err) {
    return true;
  }
}

/** @returns {boolean} whether this catalog event has an automated effect */
export function isAutomated(catalogId) {
  return Object.hasOwn(EFFECTS, catalogId ?? "");
}

/**
 * [GM] Carry out an event's effect.
 * @param {string} catalogId
 * @param {object} ctx
 * @param {object} ctx.entry                 the catalog event entry
 * @param {string} ctx.name                  display name
 * @param {(text: string) => Promise} [ctx.onStatus]  updates the chat card's status strip (waiting, fallback)
 * @returns {Promise<object>} the effect result (see the module comment)
 */
export async function runEffect(catalogId, ctx) {
  const fn = EFFECTS[catalogId];
  if ( !fn ) throw new Error(`No automation for event "${catalogId}"`);
  const s = snap();
  if ( !s ) return notOccurring(loc("RL.Events.reason.noBoard"));
  const result = await fn({ ...ctx, catalogId });
  result.rows ??= [];
  result.rolls ??= [];
  return result;
}

/* -------------------------------------------- */
/*  Who: the noted faction                      */
/* -------------------------------------------- */

/** In the current war and not eliminated (knocked-out factions are still in the game). */
const inGame = f => !!f?.active && (f.status !== "eliminated");

/** The faction with the largest population, or {reason} when the event does not occur. */
function largestPopulation(s) {
  const players = Object.values(s.factions).filter(inGame);
  if ( !players.length ) return { reason: loc("RL.Events.reason.noWar") };
  const max = Math.max(0, ...players.map(f => f.population));
  if ( max <= 0 ) return { reason: loc("RL.Events.reason.noPopulation") };
  const top = players.filter(f => f.population === max);
  if ( top.length > 1 ) {
    return { reason: fmt("RL.Events.reason.tie", { names: top.map(f => f.name).join(", "), n: max }), tie: true };
  }
  const f = top[0];
  if ( f.status !== "playing" ) return { reason: fmt("RL.Events.reason.knockedOut", { faction: f.name }) };
  return { faction: f, lead: loc("RL.Events.who.largestPopulation"), leadValue: `${f.name} (${max})` };
}

/** The faction with this catalog key (aliens, mutants), or {reason}. */
function byKey(s, key, leadKey) {
  const f = Object.values(s.factions).find(x => x.key === key);
  const name = f?.name ?? state.findEntry("factions", key)?.name ?? key;
  if ( !f || !f.active ) return { reason: fmt("RL.Events.reason.notInGame", { faction: name }) };
  if ( f.status === "eliminated" ) return { reason: fmt("RL.Events.reason.eliminated", { faction: name }) };
  if ( f.status !== "playing" ) return { reason: fmt("RL.Events.reason.knockedOut", { faction: name }) };
  return { faction: f, lead: loc(leadKey), leadValue: f.name };
}

/** The faction controlling a territory, or {reason}. */
function controllerOf(s, territory) {
  const t = s.territories[territory];
  if ( !t ) return { reason: fmt("RL.Events.reason.noTerritory", { territory: territoryName(territory) }) };
  if ( !t.owner ) return { reason: fmt("RL.Events.reason.nobody", { territory: t.name }) };
  const f = s.factions[t.owner];
  if ( !inGame(f) ) return { reason: fmt("RL.Events.reason.notInGame", { faction: f?.name ?? "?" }) };
  if ( f.status !== "playing" ) return { reason: fmt("RL.Events.reason.knockedOut", { faction: f.name }) };
  return { faction: f, lead: fmt("RL.Events.who.controller", { territory: t.name }), leadValue: f.name };
}

/** Is the faction immune to Mutant Event Cards (Mutants: "You don't lose troops ... from Mutant Event Cards")? */
function mutantImmune(s, fid) {
  return rules.hasPower(s, fid, "mutants_starter") || (s.factions[fid]?.key === "mutants");
}

/* -------------------------------------------- */
/*  Results                                     */
/* -------------------------------------------- */

function notOccurring(reason) {
  return { occurred: false, reason, rows: [], rolls: [] };
}

function whoFails(who) {
  return notOccurring(who.reason);
}

/** The event happened; spread `who` for the lead line. */
function occurred(who, extra = {}) {
  return { occurred: true, lead: who?.lead ?? "", leadValue: who?.leadValue ?? "", faction: who?.faction?.id ?? null,
    rows: [], rolls: [], ...extra };
}

/** The chooser chose not to act (Cancel). */
function declined(who, chooser, extra = {}) {
  return occurred(who, { summary: fmt("RL.Events.declined", { faction: esc(who.faction.name) }), chosenBy: chooser.by, ...extra });
}

/* -------------------------------------------- */
/*  Asking the controlling player               */
/* -------------------------------------------- */

/**
 * The user who plays a faction: the war's player, else an active non-GM owner.
 * @param {Actor} actor
 * @returns {User|null}
 */
export function playerOf(actor) {
  if ( !actor ) return null;
  const assigned = game.users.get(actor.system?.war?.playerId ?? "");
  if ( assigned ) return assigned;
  return game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER")) ?? null;
}

/**
 * Asks one faction's player for the steps of an event choice, falling back to this (GM) client.
 */
class Chooser {
  /**
   * @param {object} faction       FactionState
   * @param {object} ctx           effect context ({name, onStatus})
   */
  constructor(faction, ctx) {
    this.faction = faction;
    this.actor = factionActor(faction.id);
    this.user = playerOf(this.actor);
    this.ctx = ctx;
    this.fallback = false;
    this.started = false;
    this.answeredBy = null;
  }

  /** @returns {boolean} the next step goes to the player's own client */
  get remote() {
    return !!this.user && !this.user.isSelf && this.user.active && !this.fallback;
  }

  /** Name of whoever made the choices (for the card). */
  get by() {
    return (this.answeredBy ?? game.user)?.name ?? "";
  }

  /** Player name for legacy logs ("by"). */
  get playerName() {
    return this.faction.playerName || this.user?.name || this.actor?.name || "";
  }

  async #status() {
    if ( this.started ) return;
    this.started = true;
    const text = this.remote
      ? fmt("RL.Events.status.waiting", { user: esc(this.user.name), faction: esc(this.faction.name), s: Math.round(ASK_TIMEOUT / 1000) })
      : fmt("RL.Events.status.waitingGM", { faction: esc(this.faction.name) });
    await this.ctx.onStatus?.(text);
  }

  /**
   * Ask one step.
   * @param {object} request  {type: option|number|territory, ...}
   * @returns {Promise<*>} the answer, or null (cancelled)
   */
  async ask(request) {
    const data = { ...request, event: this.ctx.name, faction: this.faction.id, factionName: this.faction.name };
    // Bot players answer here (module/bots)
    const bot = await game.risklegacy.bots?.answer?.(`event.${request.type}`, { user: this.user, data });
    if ( bot !== undefined ) {
      this.answeredBy = this.user;
      return bot;
    }
    await this.#status();
    if ( this.remote ) {
      let answer = null;
      try {
        answer = await this.user.query(QUERY, { ...data, timeout: ASK_TIMEOUT }, { timeout: ASK_TIMEOUT + 5_000 });
      } catch(err) {
        console.warn(`${SYSTEM_ID} | events: ${this.user.name} could not answer`, err);
      }
      if ( answer && !answer.timedOut && !answer.error ) {
        this.answeredBy = this.user;
        return answer.value ?? null;
      }
      this.fallback = true;
      ui.notifications.warn(fmt("RL.Events.notify.fallback", { user: this.user.name, faction: this.faction.name }));
      await this.ctx.onStatus?.(fmt("RL.Events.status.fallback", { user: esc(this.user.name), faction: esc(this.faction.name) }));
    }
    const hotSeat = !this.user?.isSelf;
    const local = await answerRequest({ ...data, hotSeat });
    if ( !this.answeredBy && hotSeat ) this.answeredBy = game.user;
    return local.value ?? null;
  }
}

/** Build the explanatory callout of a dialog step (trusted markup; texts are escaped). */
function askContent(request, marker) {
  const lines = [`<p><strong>${esc(request.event)}</strong>${request.prompt ? `: ${esc(request.prompt)}` : ""}</p>`];
  if ( request.detail ) lines.push(`<p>${esc(request.detail)}</p>`);
  if ( request.hotSeat ) lines.push(`<p><strong>${esc(fmt("RL.Events.ask.hotSeat", { faction: request.factionName ?? "" }))}</strong></p>`);
  if ( request.cancelHint ) lines.push(`<p><em>${esc(request.cancelHint)}</em></p>`);
  if ( request.timeout ) {
    lines.push(`<p><em>${esc(fmt("RL.Events.ask.timer", { s: Math.round(Number(request.timeout) / 1000) }))}</em></p>`);
  }
  lines.push(`<span data-rl-event-ask="${marker}" hidden></span>`);
  return lines.join("");
}

/** Close an open step (time is up). */
function cancelStep(type, marker) {
  if ( type === "territory" ) {
    game.risklegacy.board?.stopPlacement?.();
    return;
  }
  const el = document.querySelector(`[data-rl-event-ask="${marker}"]`)?.closest(".application");
  const app = el ? foundry.applications.instances.get(el.id) : null;
  app?.close().catch(() => null);
}

/**
 * Answer one step of an event choice on this client (the query handler, or the GM's fallback). Opens the shared
 * dialogs (`apps.chooseOption` / `apps.chooseNumber`) or a board pick (`board.pickTerritory`), and closes them by
 * itself after `request.timeout` ms.
 * @param {object} request
 * @param {"option"|"number"|"territory"} request.type
 * @param {string} request.event          event name
 * @param {string} [request.prompt]        what to choose
 * @param {object[]} [request.options]     option: [{value, label, hint, img, disabled}]
 * @param {string[]} [request.allowed]     territory: clickable ids
 * @param {number} [request.min]           number
 * @param {number} [request.max]
 * @param {number} [request.value]
 * @param {number} [request.timeout]       ms; 0 = no limit
 * @returns {Promise<{value: *, timedOut: boolean, error?: string}>}
 */
export async function answerRequest(request = {}) {
  const marker = foundry.utils.randomID();
  const timeout = Math.max(0, Number(request.timeout) || 0);
  const apps = game.risklegacy.apps;
  let timedOut = false;
  let timer = null;
  const title = request.title || request.event || loc("RL.Events.title");
  const step = (async () => {
    switch ( request.type ) {
      case "option":
        return apps.chooseOption({
          title, content: askContent(request, marker), options: request.options ?? [], confirm: request.confirm,
          columns: request.columns, width: request.width, icon: "fa-solid fa-bolt"
        });
      case "number":
        return apps.chooseNumber({
          title, content: askContent(request, marker), label: request.label, min: request.min ?? 1,
          max: request.max ?? 1, value: request.value, confirm: request.confirm, icon: "fa-solid fa-person-military-rifle"
        });
      case "territory": {
        const prompt = `${request.event}: ${request.prompt ?? ""}${request.cancelHint ? ` (${request.cancelHint})` : ""}`;
        return game.risklegacy.board.pickTerritory({ prompt, allowed: request.allowed ?? null, faction: request.faction });
      }
      default:
        throw new Error(`Unknown event choice "${request.type}"`);
    }
  })();
  if ( timeout ) {
    timer = setTimeout(() => {
      timedOut = true;
      cancelStep(request.type, marker);
    }, timeout);
  }
  try {
    const value = await step;
    return { value: timedOut ? null : (value ?? null), timedOut };
  } catch(err) {
    console.error(`${SYSTEM_ID} | events: choice failed`, err);
    return { value: null, timedOut, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------- */
/*  Board helpers                               */
/* -------------------------------------------- */

/** City territories the faction controls and may place troops in. */
function placeableCities(s, fid) {
  return Object.values(s.territories)
    .filter(t => (t.owner === fid) && t.city && !rules.territoryHas(s, t.id, "noPlaceTroops", fid))
    .map(t => t.id);
}

/** Territories the faction may maneuver into from `from`, outside its turn. */
function maneuverTargetsFrom(s, fid, from) {
  return Object.keys(s.territories).filter(id => (id !== from)
    && rules.checkManeuver(s, fid, from, id, 1, { ignoreTurn: true }).ok);
}

/** Territories the faction could start an immediate maneuver from. */
function maneuverSources(s, fid) {
  return Object.values(s.territories)
    .filter(t => (t.owner === fid) && (t.troops >= 2) && maneuverTargetsFrom(s, fid, t.id).length)
    .map(t => t.id);
}

/** Land neighbours of a territory: board neighbours minus those joined only by a sea line. */
function landNeighbors(s, id) {
  const sea = new Set((s.board?.seaLines ?? []).flatMap(l => ((l.a === id) ? [l.b] : (l.b === id) ? [l.a] : [])));
  return (s.territories[id]?.neighbors ?? []).filter(n => !sea.has(n));
}

/** Put new troops on the board. */
async function place(fid, territory, troops) {
  await board().spawnPieces({ faction: fid, territory, troops });
}

/** Remove troops (makes change); returns the number removed. */
async function remove(fid, territory, count) {
  if ( count <= 0 ) return 0;
  const res = await board().removeTroops({ faction: fid, territory, count });
  return res?.removed ?? count;
}

/**
 * DEMOLISH the HQs standing in a territory: "put it back in the box. It is out of this game". There is no canvas
 * helper for this, so the HQ tokens are deleted here (on the GM) with the canvas area's internal-operation flag.
 * @returns {Promise<string[]>} faction ids whose HQ was demolished
 */
async function demolishHQs(territory) {
  const scene = state.getBoardScene();
  const t = snap()?.territories[territory];
  if ( !scene || !t ) return [];
  const ids = [];
  const owners = [];
  for ( const [fid, p] of Object.entries(t.pieces) ) {
    if ( !p.hq ) continue;
    for ( const id of p.tokens ) {
      const doc = scene.tokens.get(id);
      if ( doc && (state.pieceKind(doc) === "hq") ) {
        ids.push(id);
        owners.push(fid);
      }
    }
  }
  if ( ids.length ) await scene.deleteEmbeddedDocuments("Token", ids, { [SYSTEM_ID]: { internal: true } });
  return [...new Set(owners)];
}

/**
 * Factions that lost their last territory are knocked out (their next turn: Join the War or be eliminated).
 * The cards stay in hand (no one knocked them out). Adds a row per knock-out.
 */
async function knockOuts(factionIds, rows) {
  const war = state.getWar();
  if ( war?.system.stage !== "playing" ) return;
  const s = snap();
  for ( const fid of new Set(factionIds) ) {
    const f = s.factions[fid];
    const actor = game.actors.get(fid);
    if ( !f || !actor || !f.active || (actor.system.war.status !== "playing") || f.territories.length ) continue;
    await actor.update({ "system.war.status": "knockedOut", "system.war.reserve": 0 });
    Hooks.callAll("risklegacy.factionKnockedOut", actor, null);
    rows.push({ label: actor.name, value: loc("RL.Events.row.knockedOut"), strong: true });
  }
}

/** Evaluate a 1d6 roll (shown with the chat card; Dice So Nice animates it). */
async function d6() {
  const roll = await new Roll("1d6", {}, { risklegacy: "event" }).evaluate();
  return roll;
}

/** Request builders. */
const option = (prompt, options, extra = {}) => ({ type: "option", prompt, options, ...extra });
const pick = (prompt, allowed, extra = {}) => ({ type: "territory", prompt, allowed, ...extra });
const number = (prompt, { min = 1, max = 1, value, label } = {}) => ({ type: "number", prompt, min, max, value: value ?? max, label });

/* -------------------------------------------- */
/*  Minor Cities                                */
/* -------------------------------------------- */

/** Control the People: +5 troops in one controlled city, or an immediate maneuver. */
async function controlThePeople(ctx) {
  const who = largestPopulation(snap());
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const chooser = new Chooser(f, ctx);
  for ( let i = 0; i < MAX_TRIES; i++ ) {
    const s = snap();
    const cities = placeableCities(s, f.id);
    const sources = maneuverSources(s, f.id);
    const choice = await chooser.ask(option(loc("RL.Events.control_the_people.prompt"), [
      { value: "troops", label: fmt("RL.Events.control_the_people.troops", { n: 5 }),
        hint: cities.length ? "" : loc("RL.Events.hint.noCity"), disabled: !cities.length },
      { value: "maneuver", label: loc("RL.Events.control_the_people.maneuver"),
        hint: sources.length ? loc("RL.Events.control_the_people.maneuverHint") : loc("RL.Events.hint.noManeuver"),
        disabled: !sources.length }
    ], { cancelHint: loc("RL.Events.ask.cancelNothing") }));
    if ( !choice ) return declined(who, chooser);

    if ( choice === "troops" ) {
      const t = await chooser.ask(pick(fmt("RL.Events.prompt.city", { n: 5 }), cities));
      if ( !t || !placeableCities(snap(), f.id).includes(t) ) continue;
      await place(f.id, t, 5);
      return occurred(who, {
        chosenBy: chooser.by,
        rows: [{ label: territoryName(t), value: fmt("RL.Events.row.placed", { n: 5, faction: f.name }) }],
        summary: fmt("RL.Events.control_the_people.doneTroops", { faction: esc(f.name), n: 5, territory: esc(territoryName(t)) })
      });
    }

    const move = await askManeuver(chooser, f);
    if ( !move ) continue;
    return occurred(who, {
      chosenBy: chooser.by,
      rows: [{ label: `${territoryName(move.from)} → ${territoryName(move.to)}`, value: fmt("RL.Events.row.moved", { n: move.count }) }],
      summary: fmt("RL.Events.control_the_people.doneManeuver", {
        faction: esc(f.name), n: move.count, from: esc(territoryName(move.from)), to: esc(territoryName(move.to))
      })
    });
  }
  return declined(who, chooser);
}

/**
 * An immediate maneuver outside the faction's turn: from → to → how many. Validated with
 * `rules.checkManeuver(..., {ignoreTurn: true})` under the world's enforcement level, moved with `board.moveTroops`.
 * @returns {Promise<{from, to, count}|null>}
 */
async function askManeuver(chooser, f) {
  const from = await chooser.ask(pick(loc("RL.Events.prompt.maneuverFrom"), maneuverSources(snap(), f.id)));
  if ( !from ) return null;
  const targets = maneuverTargetsFrom(snap(), f.id, from);
  if ( !targets.length ) return null;
  const to = await chooser.ask(pick(fmt("RL.Events.prompt.maneuverTo", { from: territoryName(from) }), targets));
  if ( !to ) return null;
  const max = Math.max(1, (snap().territories[from]?.troops ?? 1) - 1);
  const count = (max === 1) ? 1 : Number(await chooser.ask(number(
    fmt("RL.Events.prompt.maneuverCount", { from: territoryName(from), to: territoryName(to) }),
    { min: 1, max, value: max, label: loc("RL.Events.label.troops") }
  )));
  if ( !Number.isInteger(count) || (count < 1) ) return null;
  const result = rules.checkManeuver(snap(), f.id, from, to, count, { ignoreTurn: true });
  if ( !state.enforce(result) ) return null;
  const res = await board().moveTroops({ faction: f.id, from, to, count });
  return { from, to, count: res?.moved ?? count };
}

/** Fortify: fortify one city (DESTROY the card) or +2 troops in up to two cities (DISCARD). */
async function fortify(ctx) {
  const who = largestPopulation(snap());
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const chooser = new Chooser(f, ctx);
  for ( let i = 0; i < MAX_TRIES; i++ ) {
    const s = snap();
    const left = state.getCampaign()?.system.stickers?.fortification ?? 0;
    // A fresh fortification can't be improved; a worn one may be replaced (its remaining uses are lost).
    const fortifiable = Object.values(s.territories)
      .filter(t => (t.owner === f.id) && t.city && !(t.fortified && !t.fortificationUsed) && !t.marks.includes("fallout_zone"))
      .map(t => t.id);
    const cities = placeableCities(s, f.id);
    const choice = await chooser.ask(option(loc("RL.Events.fortify.prompt"), [
      { value: "fortify", label: loc("RL.Events.fortify.fortify"),
        hint: !left ? loc("RL.Events.hint.noFortification") : (fortifiable.length ? fmt("RL.Events.fortify.fortifyHint", { n: left }) : loc("RL.Events.hint.noCity")),
        disabled: !left || !fortifiable.length },
      { value: "troops", label: fmt("RL.Events.fortify.troops", { n: 2 }), hint: cities.length ? "" : loc("RL.Events.hint.noCity"),
        disabled: !cities.length }
    ], { cancelHint: loc("RL.Events.ask.cancelNothing") }));
    if ( !choice ) return declined(who, chooser, { outcome: "box" });

    if ( choice === "fortify" ) {
      const t = await chooser.ask(pick(loc("RL.Events.prompt.fortify"), fortifiable));
      if ( !t ) continue;
      try {
        await campaignApi().fortifyCity({ territory: t, by: chooser.playerName });
      } catch(err) {
        return occurred(who, { chosenBy: chooser.by, outcome: "box", rows: [{ label: territoryName(t), value: err.message }],
          summary: fmt("RL.Events.fortify.failed", { territory: esc(territoryName(t)) }) });
      }
      return occurred(who, {
        chosenBy: chooser.by, outcome: "destroy",
        rows: [{ label: territoryName(t), value: loc("RL.Events.row.fortified") }],
        summary: fmt("RL.Events.fortify.doneFortify", { faction: esc(f.name), territory: esc(territoryName(t)) })
      });
    }

    const first = await chooser.ask(pick(fmt("RL.Events.prompt.city", { n: 2 }), cities));
    if ( !first ) continue;
    const others = cities.filter(id => id !== first);
    const second = others.length
      ? await chooser.ask(pick(fmt("RL.Events.prompt.secondCity", { n: 2 }), others, { cancelHint: loc("RL.Events.ask.escOnlyOne") }))
      : null;
    const targets = [first, second].filter(t => t && placeableCities(snap(), f.id).includes(t));
    for ( const t of targets ) await place(f.id, t, 2);
    return occurred(who, {
      chosenBy: chooser.by, outcome: "box",
      rows: targets.map(t => ({ label: territoryName(t), value: fmt("RL.Events.row.placed", { n: 2, faction: f.name }) })),
      summary: fmt("RL.Events.fortify.doneTroops", { faction: esc(f.name), n: 2, count: targets.length })
    });
  }
  return declined(who, chooser, { outcome: "box" });
}

/** Resistance: every Minor City holding 1 or 2 troops loses 1 troop. */
async function resistance() {
  const s = snap();
  const targets = Object.values(s.territories)
    .filter(t => (t.city?.type === "minor") && t.owner && (t.troops >= 1) && (t.troops <= 2));
  const rows = [];
  for ( const t of targets ) {
    const removed = await remove(t.owner, t.id, 1);
    rows.push({ label: t.name, value: fmt("RL.Events.row.removed", { n: removed, faction: s.factions[t.owner]?.name ?? "" }) });
  }
  await knockOuts(targets.map(t => t.owner), rows);
  return {
    occurred: true, rows, rolls: [],
    summary: targets.length ? fmt("RL.Events.resistance.done", { n: targets.length }) : loc("RL.Events.resistance.none")
  };
}

/**
 * Riots (no structured effect in the catalog): for every Major City a player controls, roll a die and add 1 per
 * troop and HQ in that territory. Below 6: remove troops equal to the natural roll and DEMOLISH any HQs there.
 */
async function riots() {
  const s = snap();
  const targets = Object.values(s.territories).filter(t => (t.city?.type === "major") && t.owner);
  const rows = [];
  const rolls = [];
  const hit = [];
  let riotsCount = 0;
  for ( const t of targets ) {
    const owner = s.factions[t.owner];
    const roll = await d6();
    rolls.push(roll);
    const natural = roll.total;
    const hqs = t.hq ? 1 : 0;
    const modified = natural + t.troops + hqs;
    if ( modified >= 6 ) {
      rows.push({ label: t.name, die: natural, mod: modified, value: fmt("RL.Events.riots.calm", { faction: owner?.name ?? "", mod: modified }) });
      continue;
    }
    riotsCount += 1;
    const removed = await remove(t.owner, t.id, natural);
    const demolished = hqs ? await demolishHQs(t.id) : [];
    hit.push(t.owner, ...demolished);
    const parts = [fmt("RL.Events.row.removed", { n: removed, faction: owner?.name ?? "" })];
    if ( demolished.length ) parts.push(loc("RL.Events.row.hqDemolished"));
    rows.push({ label: t.name, die: natural, mod: modified, lost: true, value: `${loc("RL.Events.riots.riot")} ${parts.join(", ")}`, strong: true });
  }
  await knockOuts(hit, rows);
  return {
    occurred: true, rows, rolls, hazard: riotsCount > 0,
    summary: !targets.length ? loc("RL.Events.riots.none") : fmt("RL.Events.riots.done", { n: targets.length, riots: riotsCount })
  };
}

/* -------------------------------------------- */
/*  Second Win                                  */
/* -------------------------------------------- */

/** Join the Cause: 3 troops split among controlled cities, or choose a new mission. */
async function joinTheCause(ctx) {
  const who = largestPopulation(snap());
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const chooser = new Chooser(f, ctx);
  const total = 3;
  for ( let i = 0; i < MAX_TRIES; i++ ) {
    const cities = placeableCities(snap(), f.id);
    const missions = state.getCardStack("missionDeck")?.availableCards ?? [];
    const choice = await chooser.ask(option(loc("RL.Events.join_the_cause.prompt"), [
      { value: "troops", label: fmt("RL.Events.join_the_cause.troops", { n: total }),
        hint: cities.length ? "" : loc("RL.Events.hint.noCity"), disabled: !cities.length },
      { value: "mission", label: loc("RL.Events.join_the_cause.mission"),
        hint: missions.length ? loc("RL.Events.join_the_cause.missionHint") : loc("RL.Events.hint.noMission"), disabled: !missions.length }
    ], { cancelHint: loc("RL.Events.ask.cancelNothing") }));
    if ( !choice ) return declined(who, chooser);

    if ( choice === "troops" ) {
      const plan = await askSplit(chooser, f, total);
      if ( !plan ) continue;
      const rows = [];
      for ( const [t, n] of plan ) {
        await place(f.id, t, n);
        rows.push({ label: territoryName(t), value: fmt("RL.Events.row.placed", { n, faction: f.name }) });
      }
      return occurred(who, { chosenBy: chooser.by, rows,
        summary: fmt("RL.Events.join_the_cause.doneTroops", { faction: esc(f.name), n: total }) });
    }

    const old = currentMission();
    const cardId = await chooser.ask(option(loc("RL.Events.join_the_cause.pickMission"), missions.map(c => ({
      value: c.id, label: c.name, img: c.currentFace?.img ?? c.img,
      hint: fmt("RL.Events.join_the_cause.reward", { n: c.system.reward ?? 1 })
    })), {
      detail: old ? fmt("RL.Events.join_the_cause.replaces", { name: old.name }) : "",
      cancelHint: loc("RL.Events.ask.cancelBack"), columns: Math.min(3, missions.length), width: 640
    }));
    if ( !cardId || !state.getCardStack("missionDeck")?.availableCards.some(c => c.id === cardId) ) continue;
    const res = await revealMission({ replace: true, cardId }, { user: game.user });
    const chosen = state.getCardStack("missionSlot")?.cards.get(res?.cardId ?? "");
    const rows = [];
    if ( old ) rows.push({ label: loc("RL.Events.join_the_cause.discarded"), value: old.name });
    rows.push({ label: loc("RL.Events.join_the_cause.newMission"), value: chosen?.name ?? "?" });
    return occurred(who, { chosenBy: chooser.by, rows,
      summary: fmt("RL.Events.join_the_cause.doneMission", { faction: esc(f.name), name: esc(chosen?.name ?? "") }) });
  }
  return declined(who, chooser);
}

/**
 * Split troops among controlled cities: pick a city, then how many go there, until all are placed. The plan is
 * applied only when complete; Esc returns to the option menu.
 * @returns {Promise<Map<string, number>|null>}
 */
async function askSplit(chooser, f, total) {
  const plan = new Map();
  let left = total;
  while ( left > 0 ) {
    const cities = placeableCities(snap(), f.id);
    const t = await chooser.ask(pick(fmt("RL.Events.prompt.split", { n: left }), cities));
    if ( !t || !cities.includes(t) ) return null;
    let n = left;
    if ( (left > 1) && (cities.length > 1) ) {
      n = Number(await chooser.ask(number(fmt("RL.Events.prompt.splitCount", { territory: territoryName(t), n: left }),
        { min: 1, max: left, value: left, label: loc("RL.Events.label.troops") })));
      if ( !Number.isInteger(n) || (n < 1) ) return null;
    }
    plan.set(t, (plan.get(t) ?? 0) + n);
    left -= n;
  }
  return plan;
}

/* -------------------------------------------- */
/*  Thirty Troops (Aliens)                      */
/* -------------------------------------------- */

/** Beam Down: the Alien player may place 5 troops into one unoccupied city territory. */
async function beamDown(ctx) {
  const who = byKey(snap(), "aliens", "RL.Events.who.alien");
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const targets = s => Object.values(s.territories)
    .filter(t => t.city && !rules.isOccupied(t) && !rules.territoryHas(s, t.id, "noPlaceTroops", f.id))
    .map(t => t.id);
  if ( !targets(snap()).length ) return occurred(who, { summary: loc("RL.Events.beam_down.none") });
  const chooser = new Chooser(f, ctx);
  for ( let i = 0; i < MAX_TRIES; i++ ) {
    const allowed = targets(snap());
    const choice = await chooser.ask(option(loc("RL.Events.beam_down.prompt"), [
      { value: "beam", label: fmt("RL.Events.beam_down.beam", { n: 5 }), hint: fmt("RL.Events.beam_down.beamHint", { n: allowed.length }) },
      { value: "no", label: loc("RL.Events.beam_down.no") }
    ]));
    if ( !choice || (choice === "no") ) return declined(who, chooser);
    const t = await chooser.ask(pick(fmt("RL.Events.prompt.unoccupiedCity", { n: 5 }), allowed));
    if ( !t || !targets(snap()).includes(t) ) continue;
    await place(f.id, t, 5);
    return occurred(who, { chosenBy: chooser.by,
      rows: [{ label: territoryName(t), value: fmt("RL.Events.row.placed", { n: 5, faction: f.name }) }],
      summary: fmt("RL.Events.beam_down.done", { faction: esc(f.name), n: 5, territory: esc(territoryName(t)) }) });
  }
  return declined(who, chooser);
}

/**
 * Die Humans: the Alien player may ruin a Minor City (ruin mark over the city mark, remove all troops, DEMOLISH any
 * HQ). DESTROY the card if a city is ruined, otherwise DISCARD it. Uses `campaign.ruinCity` when the campaign area
 * provides it (feature-detected), else places the `ruins` mark; leftover pieces are cleared here either way.
 */
async function dieHumans(ctx) {
  const who = byKey(snap(), "aliens", "RL.Events.who.alien");
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const targets = s => Object.values(s.territories)
    .filter(t => (t.city?.type === "minor") && !t.marks.includes("fallout_zone"))
    .map(t => t.id);
  if ( !targets(snap()).length ) return occurred(who, { outcome: "box", summary: loc("RL.Events.die_humans.none") });
  const stickers = state.getCampaign()?.system.stickers ?? {};
  const noRuins = (stickers.ruins !== undefined) && (stickers.ruins <= 0) && (state.enforcementLevel() === "strict");
  const chooser = new Chooser(f, ctx);
  for ( let i = 0; i < MAX_TRIES; i++ ) {
    const allowed = targets(snap());
    const choice = await chooser.ask(option(loc("RL.Events.die_humans.prompt"), [
      { value: "ruin", label: loc("RL.Events.die_humans.ruin"),
        hint: noRuins ? loc("RL.Events.hint.noRuins") : fmt("RL.Events.die_humans.ruinHint", { n: allowed.length }), disabled: noRuins },
      { value: "spare", label: loc("RL.Events.die_humans.spare") }
    ]));
    if ( !choice || (choice === "spare") ) return declined(who, chooser, { outcome: "box" });
    const t = await chooser.ask(pick(loc("RL.Events.prompt.minorCity"), allowed));
    if ( !t || !targets(snap()).includes(t) ) continue;

    const before = snap().territories[t];
    const cityName = before?.city?.name || territoryName(t);
    const owners = Object.keys(before?.pieces ?? {});
    let byCampaign = null;
    try {
      const api = campaignApi();
      if ( typeof api.ruinCity === "function" ) byCampaign = await api.ruinCity({ territory: t, by: chooser.playerName });
      else await api.placeMark({ territory: t, mark: "ruins", by: chooser.playerName });
    } catch(err) {
      return occurred(who, { chosenBy: chooser.by, outcome: "box", rows: [{ label: territoryName(t), value: err.message }],
        summary: fmt("RL.Events.die_humans.failed", { territory: esc(territoryName(t)) }) });
    }
    const ruined = !state.getCampaign()?.system.territories?.[t]?.city?.type;
    // "Remove all troops and DEMOLISH any HQ in that territory" (a no-op if ruinCity already cleared it)
    const cleared = await clearTerritory(t);
    cleared.troops += Number(byCampaign?.troops) || 0;
    cleared.hqs += Number(byCampaign?.hqs) || 0;
    const rows = [{ label: territoryName(t), value: ruined ? fmt("RL.Events.row.ruined", { name: cityName }) : loc("RL.Events.row.notRuined"), strong: true }];
    if ( cleared.troops ) rows.push({ label: territoryName(t), value: fmt("RL.Events.row.cleared", { n: cleared.troops }) });
    if ( cleared.hqs ) rows.push({ label: territoryName(t), value: loc("RL.Events.row.hqDemolished") });
    await knockOuts(owners, rows);
    return occurred(who, { chosenBy: chooser.by, outcome: ruined ? "destroy" : "box", rows, hazard: ruined,
      summary: ruined
        ? fmt("RL.Events.die_humans.done", { faction: esc(f.name), name: esc(cityName), territory: esc(territoryName(t)) })
        : fmt("RL.Events.die_humans.failed", { territory: esc(territoryName(t)) }) });
  }
  return declined(who, chooser, { outcome: "box" });
}

/** Remove every troop and demolish every HQ in a territory. */
async function clearTerritory(territory) {
  const t = snap()?.territories[territory];
  if ( !t ) return { troops: 0, hqs: 0 };
  let troops = 0;
  for ( const [fid, p] of Object.entries(t.pieces) ) {
    if ( p.troops > 0 ) troops += await remove(fid, territory, p.troops);
  }
  const hqs = (await demolishHQs(territory)).length;
  return { troops, hqs };
}

/** Mysterious Island: whoever controls Alien Island may take any one face-up territory card (may trigger an event). */
async function mysteriousIsland(ctx) {
  const who = controllerOf(snap(), "alien_island");
  if ( !who.faction ) return whoFails(who);
  const f = who.faction;
  const row = getRow();
  if ( !row.length ) return occurred(who, { summary: loc("RL.Events.mysterious_island.none") });
  const chooser = new Chooser(f, ctx);
  const cardId = await chooser.ask(option(loc("RL.Events.mysterious_island.prompt"), row.map(c => ({
    value: c.id, label: `${c.name} (${c.system.value})`, img: c.currentFace?.img ?? c.img,
    hint: fmt("RL.Events.mysterious_island.slot", { n: c.system.slot })
  })), { cancelHint: loc("RL.Events.ask.cancelNothing"), columns: Math.min(4, row.length), width: 600 }));
  if ( !cardId || !getRow().some(c => c.id === cardId) ) return declined(who, chooser);
  const card = getRow().find(c => c.id === cardId);
  const name = card.name;
  const value = card.system.value;
  // The cards area's draw mechanics (slide right, refill slot 1, an even card → another event), forced past the
  // end-of-turn eligibility rules. Called directly: this runs inside the cards area's serialized queue already.
  const drawn = await drawResourceCard({ faction: f.id, cardId, force: true }, { user: game.user });
  const rows = [{ label: f.name, value: fmt("RL.Events.mysterious_island.took", { name, n: value }) }];
  if ( drawn?.eventCardId ) rows.push({ label: loc("RL.Events.mysterious_island.second"), value: loc("RL.Events.mysterious_island.secondValue"), strong: true });
  return occurred(who, { chosenBy: chooser.by, rows,
    summary: fmt("RL.Events.mysterious_island.done", { faction: esc(f.name), name: esc(name) }) });
}

/* -------------------------------------------- */
/*  Three Missiles (Mutants)                    */
/* -------------------------------------------- */

/** Agent of Chaos: if no human faction has a continent bonus, the Mutants collect one Red Star token. */
async function agentOfChaos() {
  const s = snap();
  const who = byKey(s, "mutants", "RL.Events.who.mutant");
  if ( !who.faction ) return whoFails(who);
  const bonusOf = (f, cid) => {
    const c = s.continents[cid];
    return (c?.value ?? 0) + ((f.playerId && (c?.namedById === f.playerId)) ? 1 : 0);
  };
  const holders = Object.values(s.factions)
    .filter(f => inGame(f) && !NON_HUMAN.has(f.key))
    .map(f => ({ f, continents: f.continents.filter(cid => bonusOf(f, cid) > 0) }))
    .filter(h => h.continents.length);
  if ( holders.length ) {
    return occurred(who, {
      rows: holders.map(h => ({ label: h.f.name, value: h.continents.map(cid => s.continents[cid]?.name || s.continents[cid]?.label || cid).join(", ") })),
      summary: loc("RL.Events.agent_of_chaos.blocked")
    });
  }
  const actor = game.actors.get(who.faction.id);
  const tokens = actor.system.war.redStarTokens + 1;
  await actor.update({ "system.war.redStarTokens": tokens });
  Hooks.callAll("risklegacy.redStarTokenGained", actor, 1, "event");
  // The turn area's victory watcher reacts to the token update; call its check too when it is exposed (not awaited:
  // it may be serialized behind the turn that triggered this event).
  const check = game.risklegacy.turn?.checkVictory;
  if ( typeof check === "function" ) Promise.resolve().then(() => check()).catch(err => console.error(err));
  const total = rules.redStarTotal(snap(), actor.id);
  return occurred(who, { token: true,
    summary: fmt("RL.Events.agent_of_chaos.done", { faction: esc(actor.name), total }) });
}

/** Fallout: roll 1 die for each territory connected to the fallout territory by land; remove that many troops. */
async function fallout() {
  const s = snap();
  const zones = Object.values(s.territories).filter(t => t.marks.includes("fallout_zone")).map(t => t.id);
  if ( !zones.length ) return notOccurring(loc("RL.Events.reason.noFallout"));
  const zoneSet = new Set(zones);
  const connected = [...new Set(zones.flatMap(z => landNeighbors(s, z)))].filter(id => !zoneSet.has(id));
  const rows = [];
  const rolls = [];
  const hit = [];
  let lost = 0;
  for ( const id of connected ) {
    const t = s.territories[id];
    if ( !t?.owner || (t.troops <= 0) ) continue;
    const owner = s.factions[t.owner];
    if ( mutantImmune(s, t.owner) ) {
      rows.push({ label: t.name, value: fmt("RL.Events.fallout.immune", { faction: owner?.name ?? "" }) });
      continue;
    }
    const roll = await d6();
    rolls.push(roll);
    const removed = await remove(t.owner, id, roll.total);
    lost += removed;
    hit.push(t.owner);
    rows.push({ label: t.name, die: roll.total, lost: true, value: fmt("RL.Events.row.removed", { n: removed, faction: owner?.name ?? "" }) });
  }
  await knockOuts(hit, rows);
  return {
    occurred: true, rows, rolls, hazard: lost > 0,
    lead: loc("RL.Events.fallout.zone"), leadValue: zones.map(z => territoryName(z)).join(", "),
    summary: rolls.length ? fmt("RL.Events.fallout.done", { n: rolls.length, lost }) : loc("RL.Events.fallout.none")
  };
}

/**
 * The Mutants Evolve (1: OFFENSIVE/DEFENSIVE, 2: BODIES/BRAINS): the mutant player chooses; the choice is recorded
 * on the Mutants faction actor (`flags[SYSTEM_ID].evolution.{approach,target}`). Once both are chosen, the card says
 * which box to scratch off on the faction card (the secret power whose `evolution` matches). The card is kept.
 */
async function mutantsEvolve(ctx) {
  const who = byKey(snap(), "mutants", "RL.Events.who.mutant");
  if ( !who.faction ) return whoFails(who);
  const effect = ctx.entry?.effect ?? {};
  const axis = effect.axis ?? (ctx.catalogId === "mutants_evolve_2" ? "target" : "approach");
  const choices = effect.options ?? (axis === "target" ? ["bodies", "brains"] : ["offensive", "defensive"]);
  const actor = game.actors.get(who.faction.id);
  const current = actor.getFlag(SYSTEM_ID, "evolution") ?? {};
  const chooser = new Chooser(who.faction, ctx);
  let picked = null;
  for ( let i = 0; (i < MAX_TRIES) && !picked; i++ ) {
    picked = await chooser.ask(option(loc(`RL.Events.mutants_evolve.prompt.${axis}`), choices.map(c => ({
      value: c, label: loc(`RL.Events.mutants_evolve.choice.${c}`), selected: current[axis] === c
    })), { cancelHint: loc("RL.Events.mutants_evolve.mustChoose") }));
  }
  if ( !choices.includes(picked) ) {
    return occurred(who, { pending: true, outcome: null, summary: loc("RL.Events.mutants_evolve.noChoice") });
  }
  await actor.update({ [`flags.${SYSTEM_ID}.evolution.${axis}`]: picked });
  const evolution = { ...current, [axis]: picked };
  const rows = [{ label: loc(`RL.Events.mutants_evolve.axis.${axis}`), value: loc(`RL.Events.mutants_evolve.choice.${picked}`), strong: true }];
  const other = axis === "approach" ? "target" : "approach";
  if ( evolution[other] ) rows.push({ label: loc(`RL.Events.mutants_evolve.axis.${other}`), value: loc(`RL.Events.mutants_evolve.choice.${evolution[other]}`) });
  let summary = fmt("RL.Events.mutants_evolve.done", { faction: esc(actor.name), choice: esc(loc(`RL.Events.mutants_evolve.choice.${picked}`)) });
  let note = "";
  if ( evolution.approach && evolution.target ) {
    const code = `${evolution.approach}-${evolution.target}`.toUpperCase();
    const power = (state.getPack("threemissiles")?.secretPowers ?? [])
      .find(p => (p.evolution?.approach === evolution.approach) && (p.evolution?.target === evolution.target));
    await actor.update({ [`flags.${SYSTEM_ID}.evolution.code`]: code, [`flags.${SYSTEM_ID}.evolution.power`]: power?.id ?? "" });
    summary += ` ${fmt("RL.Events.mutants_evolve.scratch", { code: esc(code), faction: esc(actor.name) })}`;
    if ( power ) {
      rows.push({ label: loc("RL.Events.mutants_evolve.revealed"), value: power.name, strong: true });
      summary += `<br><em>${esc(power.name)}: ${esc(power.text)}</em>`;
      // The scratched-off box is now part of the Mutants' card: add it as a power sticker so the rules/battle
      // automation keyed on the power (unstable_cloning, unnatural_strength, …) applies from now on.
      if ( !actor.items.some(i => (i.type === "power") && (i.system.key === power.id)) ) {
        await actor.createEmbeddedDocuments("Item", [{
          name: power.name, type: "power", img: actor.img,
          system: { slot: power.slot || "other", text: power.text, faction: actor.system.key, pack: "threemissiles",
            key: power.id, timing: power.timing ?? "" }
        }]);
      }
    }
    note = code;
  }
  return occurred(who, { chosenBy: chooser.by, outcome: "keep", rows, summary, note });
}

/* -------------------------------------------- */

/** catalogId → effect. */
const EFFECTS = {
  control_the_people: controlThePeople,
  fortify,
  resistance,
  riots,
  join_the_cause: joinTheCause,
  beam_down: beamDown,
  die_humans: dieHumans,
  mysterious_island: mysteriousIsland,
  agent_of_chaos: agentOfChaos,
  fallout,
  mutants_evolve_1: mutantsEvolve,
  mutants_evolve_2: mutantsEvolve
};
