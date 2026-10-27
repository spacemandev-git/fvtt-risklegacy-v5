/**
 * The battle chat card (client side): renders a ChatMessage of type "battle" from its `system` data, per user (each
 * client only sees the controls it may use), and wires its buttons to the battle GM actions.
 *
 * RLChatMessage#renderHTML (module/documents/chat-message.mjs) calls `renderBattleMessage` for battle messages. Core
 * re-renders a message whenever it is updated, so every client sees the card change live.
 */
import { SYSTEM_PATH } from "../config.mjs";
import { canActFor, getCampaign, getCampaignBoard, getFactions, getHand, getWar } from "../state/_module.mjs";
import { runAction } from "../gm/actions.mjs";
import { normalizeKey, resolveDice } from "./modifiers.mjs";
import { lookup } from "./services.mjs";

export const CARD_TEMPLATE = `${SYSTEM_PATH}/templates/battle/battle-card.hbs`;
export const DIE_TEMPLATE = `${SYSTEM_PATH}/templates/battle/die.hbs`;

/** A battle still "declared" (not in its pre-roll window) after this long is considered stuck. */
const STUCK_MS = 20_000;

const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const label = text => (text && game.i18n.has(text) ? game.i18n.localize(text) : (text ?? ""));
const signed = n => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/** Client-local UI state per battle message: {armed: boolean, faction: string, moveIn: number, stopAt: number}. */
const uiState = new Map();
const uiFor = id => {
  if ( !uiState.has(id) ) uiState.set(id, { armed: false, faction: "", moveIn: null, stopAt: 1 });
  return uiState.get(id);
};

/* -------------------------------------------- */
/*  Context                                     */
/* -------------------------------------------- */

/** Territory display name. */
function territoryName(id) {
  const board = getCampaignBoard();
  return board?.territories?.[id]?.name ?? (id ?? "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/** Faction display data. */
function factionInfo(id) {
  const actor = game.actors.get(id);
  return {
    id, actor,
    name: actor?.name ?? loc("RL.Battle.Card.unknown"),
    color: actor?.system?.color?.css ?? "#808285",
    key: actor?.system?.key ?? ""
  };
}

/** Factions of the war (all factions outside a war). */
function warFactions() {
  const active = getFactions({ active: true });
  return active.length ? active : getFactions();
}

/** Factions this user may fire a missile for. */
function missileFactions(user = game.user) {
  return warFactions().filter(f => ((f.system.war?.missiles ?? 0) > 0) && canActFor(user, f));
}

/** Pre-roll reactions available to this user: EMP and scar cards in their own hands. */
function preRollOptions(sys, user = game.user) {
  const options = [];
  const war = getWar();
  const flags = war?.system.turn?.flags ?? {};
  const empDone = (flags.emp ?? []).includes(sys.to);
  const usedPowers = flags.missilePowers ?? {};   // {factionId: power}, kept by the turn area
  const scarred = !!getCampaign()?.system.territories?.[sys.to]?.scar;
  for ( const faction of warFactions() ) {
    if ( !canActFor(user, faction) ) continue;
    if ( war && !empDone && !usedPowers[faction.id] && ((faction.system.war?.missiles ?? 0) > 0)
      && faction.items.some(i => (i.type === "power") && (normalizeKey(i.system.key) === "emp")) ) {
      options.push({ action: "emp", faction: faction.id, label: loc("RL.Battle.Button.emp", { faction: faction.name }) });
    }
    if ( scarred || (typeof game.risklegacy?.cards?.playScar !== "function") ) continue;
    // Players only see scar cards in hands they can open.
    for ( const card of getHand(faction)?.cards ?? [] ) {
      if ( card.type !== "scar" ) continue;
      const entry = lookup("scars", card.system?.scar);
      if ( (entry?.play?.timing ?? "beforeAttackRoll") !== "beforeAttackRoll" ) continue;
      if ( entry?.play?.where && (entry.play.where !== "defendingTerritory") ) continue;
      options.push({
        action: "scar", faction: faction.id, card: card.id,
        label: loc("RL.Battle.Button.playScar", { scar: entry?.name ?? card.name })
      });
    }
  }
  return options;
}

/** "4 troops", or "4 → 2 troops" once the battle is resolved. */
function troopsLabel(before, after) {
  if ( (after === null) || (after === undefined) || (after === before) ) return before === 1 ? loc("RL.Battle.Card.troopsOne") : loc("RL.Battle.Card.troops", { count: before });
  return loc("RL.Battle.Card.troopsChange", { before, after });
}

/** Text of the modifiers applied to one die ("5 +1 Bunker +1 Fortified = 6"). */
function dieTooltip(die, side) {
  const parts = [loc(side === "attack" ? "RL.Battle.Card.attackDie" : "RL.Battle.Card.defendDie", { value: die.natural })];
  for ( const m of die.mods ) parts.push(`${signed(m.delta)} ${label(m.label)}`);
  if ( die.missile ) {
    parts.push(loc("RL.Battle.Card.missileBy", { faction: game.actors.get(die.missileBy)?.name ?? "?" }));
  }
  if ( die.missile || die.mods.length ) parts.push(`= ${die.value}`);
  return parts.join(" ");
}

/**
 * Build the template context for one battle message, for the current user.
 * @param {ChatMessage} message
 * @returns {object}
 */
export function prepareBattleContext(message) {
  const sys = message.system;
  const data = sys.toObject();
  const user = game.user;
  const state = uiFor(message.id);
  const attacker = factionInfo(sys.attacker);
  const defender = factionInfo(sys.defender);
  const isAttacker = attacker.actor ? canActFor(user, attacker.actor) : user.isGM;
  const isDefender = defender.actor ? canActFor(user, defender.actor) : user.isGM;
  const status = sys.status;
  const rolled = data.attack.length > 0;                       // dice on the table (also on a cancelled battle)
  const compared = ["rolled", "resolved"].includes(status) && rolled;
  const resolved = status === "resolved";

  // Outcome: final once resolved, projected while the missile window is open.
  const outcome = resolved ? { pairs: data.result.pairs } : (compared ? resolveDice(data) : null);
  const pairs = outcome?.pairs ?? [];
  const winnerOf = (side, slot) => {
    const pair = pairs.find(p => p[side] === slot);
    return pair ? pair.winner : null;
  };

  // Missiles: who can fire, and is this client in "pick a die" mode?
  const firing = (status === "rolled") ? missileFactions(user) : [];
  const unmodifiable = new Set(data.rules.unmodifiable ?? []);
  const missileWindow = (status === "rolled") && firing.length && (unmodifiable.size < 2);
  if ( !missileWindow ) state.armed = false;
  if ( missileWindow && !firing.some(f => f.id === state.faction) ) state.faction = firing[0].id;
  const armedFaction = firing.find(f => f.id === state.faction);

  const dieContext = (die, side) => {
    if ( !die ) return null;
    const winner = winnerOf(side, die.slot);
    const modified = die.missile || (die.value !== die.natural);
    const target = missileWindow && state.armed && !die.missile && !unmodifiable.has(side);
    return {
      ...die, side,
      mark: modified ? String(die.value) : "",
      css: [
        side === "defend" ? "rl-die--defend" : "",
        winner && (winner !== side) ? "is-lost" : "",
        compared && !winner ? "is-ignored" : "",
        die.missile ? "is-missile" : "",
        target ? "is-target" : ""
      ].filterJoin(" "),
      target,
      tooltip: dieTooltip(die, side)
    };
  };
  let columns;
  if ( rolled ) {
    const width = Math.max(data.attack.length, data.defend.length, 1);
    columns = Array.fromRange(width).map(i => {
      const a = data.attack[i] ?? null;
      const d = data.defend[i] ?? null;
      const pair = (a && d) ? pairs.find(p => (p.attack === a.slot) && (p.defend === d.slot)) : null;
      return { attack: dieContext(a, "attack"), defend: dieContext(d, "defend"), winner: pair?.winner ?? null };
    });
  }
  else {
    // Not rolled yet: blank dice ("?") for the dice declared so far.
    const pendingDie = side => ({
      pending: true, side, natural: "?", mark: "", target: false, tooltip: "",
      css: `${side === "defend" ? "rl-die--defend " : ""}is-pending`
    });
    const a = data.attackDice;
    const d = data.defendDice || Math.max(1, Math.min(2, data.troops.defender || 2));
    columns = Array.fromRange(Math.max(a, d)).map(i => ({
      attack: i < a ? pendingDie("attack") : null, defend: i < d ? pendingDie("defend") : null, winner: null
    }));
  }

  // The marker note: the modifiers in effect, one line per side ("+1 Fortified · +1 Bunker").
  const modLines = ["attack", "defend"].map(side => {
    const parts = [...new Set(data.sources.filter(src => src.side === side)
      .map(src => `${signed(src.delta)} ${label(src.label)}`))];
    return parts.length ? { side, text: parts.join(" \u00b7 ") } : null;
  }).filter(Boolean);

  // Result line
  const losses = (faction, n) => loc(
    n === 0 ? "RL.Battle.Card.losesNone" : (n === 1 ? "RL.Battle.Card.losesOne" : "RL.Battle.Card.losesMany"),
    { faction: faction.name, count: n }
  );
  let resultText = "";
  const resultSub = [];
  const resultLabel = (status === "rolled") ? loc("RL.Battle.Card.projected") : "";
  if ( status === "declared" ) resultText = loc(data.preRoll ? "RL.Battle.Card.preRoll" : "RL.Battle.Card.rolling");
  else if ( status === "awaitingDefender" ) resultText = loc("RL.Battle.Card.awaiting", { faction: defender.name });
  else if ( status === "cancelled" ) resultText = loc("RL.Battle.Card.cancelled");
  else if ( status === "rolled" ) {
    const p = resolveDice(data);
    resultText = [losses(attacker, p.attackerLosses), losses(defender, p.defenderLosses)].join("\n");
    if ( p.conquerAll ) resultSub.push(loc("RL.Battle.Card.enclaveArmed"));
    if ( data.hold ) resultSub.push(loc("RL.Battle.Card.hold"));
  }
  else if ( resolved ) {
    const r = data.result;
    resultText = [losses(attacker, r.attackerLosses), losses(defender, r.defenderLosses)].join("\n");
    if ( r.conqueredAll ) resultSub.push(loc("RL.Battle.Card.conqueredAll"));
    if ( r.conquered ) resultSub.push(loc("RL.Battle.Card.movedIn", { count: r.movedIn, territory: territoryName(sys.to) }));
    if ( r.fortificationWorn ) {
      resultSub.push(loc(r.fortificationWorn === 1 ? "RL.Battle.Card.fortificationWorn" : "RL.Battle.Card.fortificationWornMany",
        { count: r.fortificationWorn }));
    }
    if ( r.protected ) resultSub.push(loc("RL.Battle.Card.protected", { territory: territoryName(sys.to) }));
    if ( r.cloned ) resultSub.push(loc("RL.Battle.Card.cloned", { faction: defender.name }));
  }

  // Controls
  const open = resolved && !data.closed;
  const r = data.result;
  const moveInMax = Math.max(0, (r.fromLeft ?? 0) - 1);
  const canMoveIn = open && isAttacker && r.conquered && !r.moveInDone && (moveInMax > 0);
  if ( canMoveIn ) state.moveIn = Math.min(moveInMax, Math.max(1, state.moveIn ?? moveInMax));
  const canAttackAgain = open && isAttacker && !r.conquered && (r.fromLeft >= 2) && (r.toLeft >= 1) && !r.protected;
  const noMissiles = !warFactions().some(f => (f.system.war?.missiles ?? 0) > 0);
  const controls = {
    // The attacker rolls after the pre-roll window; the GM can also restart a roll that got stuck (e.g. the GM
    // reloaded mid-roll: the card is then older than a normal roll takes).
    roll: (status === "declared") && (data.preRoll ? isAttacker : (user.isGM && ((Date.now() - message.timestamp) > STUCK_MS))),
    preRoll: (status === "declared") && data.preRoll ? preRollOptions(data, user) : [],
    defend: (status === "awaitingDefender") && (isDefender || user.isGM)
      ? Array.fromRange(Math.max(1, Math.min(2, data.troops.defender || 2)), 1).reverse()
        .map(n => ({ n, label: loc(n === 1 ? "RL.Battle.Defense.one" : "RL.Battle.Defense.many", { n }) }))
      : [],
    resolve: (status === "rolled") && isAttacker,
    resolveDisabled: !!data.hold,
    missile: missileWindow ? {
      armed: state.armed,
      factions: firing.map(f => ({ id: f.id, name: f.name, missiles: f.system.war.missiles, selected: f.id === state.faction })),
      choose: firing.length > 1,
      label: loc("RL.Battle.Button.fire", { count: armedFaction?.system.war.missiles ?? 0 })
    } : null,
    moveIn: canMoveIn ? { max: moveInMax, value: state.moveIn } : null,
    attackAgain: canAttackAgain,
    blitz: canAttackAgain && noMissiles ? { value: Math.min(Math.max(1, state.stopAt), Math.max(1, r.fromLeft - 1)) } : null,
    stop: open && isAttacker && (canMoveIn || canAttackAgain),
    cancel: user.isGM && !["resolved", "cancelled"].includes(status)
  };
  controls.any = controls.roll || controls.preRoll.length || controls.defend.length || controls.resolve
    || controls.moveIn || controls.attackAgain || controls.stop || controls.cancel;

  // Header
  const subParts = [];
  if ( data.blitz.active ) subParts.push(loc("RL.Battle.Card.blitz", { count: data.blitz.rounds.length }));
  else {
    if ( rolled || data.defendDice ) subParts.push(loc("RL.Battle.Card.vs", { attack: data.attackDice, defend: data.defendDice || "?" }));
    else subParts.push(loc("RL.Battle.Card.dice", { count: data.attackDice }));
    if ( data.round > 1 ) subParts.push(loc("RL.Battle.Card.round", { round: data.round }));
  }

  const missilesFired = data.missiles.length;
  return {
    messageId: message.id,
    status,
    statusClass: `rl-battle--${status}`,
    title: loc("RL.Battle.Card.title", { territory: territoryName(sys.to) }),
    sub: subParts.join(" · "),
    attacker: { ...attacker, territory: territoryName(sys.from), troops: troopsLabel(data.troops.attacker, resolved ? r.fromLeft : null) },
    defender: {
      ...defender, territory: territoryName(sys.to),
      troops: troopsLabel(data.troops.defender, resolved ? (r.conquered ? 0 : r.toLeft) : null)
    },
    rolled: compared, resolved,
    columns, armed: state.armed && missileWindow,
    modLines,
    missilesFired: missilesFired ? loc("RL.Battle.Card.missilesFired", { count: missilesFired }) : "",
    notes: data.notes.map(n => (game.i18n.has(n.key) ? game.i18n.format(n.key, n.data ?? {}) : n.key)),
    blitzRounds: data.blitz.active && (data.blitz.rounds.length > 1)
      ? data.blitz.rounds.slice(0, -1).map((round, i) => ({
        n: i + 1, attack: round.attack.join(" "), defend: round.defend.join(" "),
        attackLoss: round.attackerLosses ? `\u2212${round.attackerLosses}` : "0",
        defendLoss: round.defenderLosses ? `\u2212${round.defenderLosses}` : "0"
      }))
      : [],
    resultText, resultSub, resultLabel,
    conquered: resolved && r.conquered,
    controls
  };
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

/**
 * Render the full chat log entry (`<li class="chat-message">`) for a battle message, mirroring core's
 * ChatMessage#renderHTML but with the card generated from `system`.
 * @param {ChatMessage} message
 * @param {object} [options]  {canDelete, canClose, ...}
 * @returns {Promise<HTMLElement>}
 */
export async function renderBattleMessage(message, { canDelete, canClose = false, ...rest } = {}) {
  canDelete ??= game.user.isGM;
  const { renderTemplate } = foundry.applications.handlebars;
  let content;
  try {
    content = await renderTemplate(CARD_TEMPLATE, prepareBattleContext(message));
  } catch(err) {
    console.error("risklegacy | could not render the battle card", err);
    content = `<div class="risklegacy rl-chat-card"><div class="rl-chat-card__body">${foundry.utils.escapeHTML(err.message)}</div></div>`;
  }
  const isWhisper = message.whisper.length;
  const messageData = {
    ...rest,
    canDelete, canClose,
    message: { ...message.toObject(false), content },
    user: game.user,
    author: message.author,
    speakerActor: message.speakerActor,
    alias: message.alias,
    cssClass: ["risklegacy", "rl-battle-message", isWhisper ? "whisper" : null, message.blind ? "blind" : null].filterJoin(" "),
    isWhisper,
    whisperTo: message.whisper.map(u => game.users.get(u)?.name).filterJoin(", ")
  };
  const html = foundry.utils.parseHTML(await renderTemplate(CONFIG.ChatMessage.template, messageData));
  activateListeners(message, html);
  Hooks.callAll("renderChatMessageHTML", message, html, messageData);
  return html;
}

/** Re-render one message in this client's chat log (for client-only UI state). */
function rerender(message) {
  ui.chat?.updateMessage?.(message);
}

/* -------------------------------------------- */
/*  Listeners                                   */
/* -------------------------------------------- */

/**
 * Run a battle GM action from a card control. Errors are shown as notifications (runAction already notifies on
 * player clients; the GM runs handlers locally, so notify here).
 */
async function act(name, payload) {
  try {
    return await runAction(name, payload);
  } catch(err) {
    if ( game.user.isActiveGM ) ui.notifications.error(err.message);
    console.warn(`risklegacy | ${name} failed`, err);
    return null;
  }
}

/**
 * Wire the card controls.
 * @param {ChatMessage} message
 * @param {HTMLElement} html  the <li> element
 */
function activateListeners(message, html) {
  const card = html.querySelector(".rl-battle");
  if ( !card ) return;
  const id = message.id;
  const state = uiFor(id);

  card.addEventListener("change", event => {
    const input = event.target;
    if ( input.name === "missileFaction" ) state.faction = input.value;
    else if ( input.name === "moveIn" ) state.moveIn = Number(input.value) || 1;
    else if ( input.name === "stopAt" ) state.stopAt = Number(input.value) || 1;
  });

  card.addEventListener("keydown", event => {
    if ( !["Enter", " "].includes(event.key) ) return;
    const target = event.target.closest("[data-battle-action][role=button]");
    if ( !target ) return;
    event.preventDefault();
    target.click();
  });

  card.addEventListener("click", async event => {
    const target = event.target.closest("[data-battle-action]");
    if ( !target || target.disabled ) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.battleAction;
    const value = name => card.querySelector(`[name="${name}"]`)?.value;
    if ( action === "arm" ) {
      state.armed = !state.armed;
      return rerender(message);
    }
    target.disabled = true;
    try {
      switch ( action ) {
        case "roll": return await act("battle.roll", { message: id });
        case "emp": return await act("battle.emp", { message: id, faction: target.dataset.faction });
        case "scar": return await act("battle.scar", { message: id, faction: target.dataset.faction, cardId: target.dataset.card });
        case "defend": return await act("battle.defend", { message: id, dice: Number(target.dataset.dice) });
        case "fireAt": {
          state.armed = false;
          const faction = value("missileFaction") || state.faction;
          return await act("battle.fireMissile", {
            message: id, faction, side: target.dataset.side, index: Number(target.dataset.slot)
          });
        }
        case "resolve": return await act("battle.resolve", { message: id });
        case "moveIn": return await act("battle.moveIn", { message: id, count: Number(value("moveIn")) || state.moveIn });
        case "attackAgain": return await act("battle.attackAgain", { message: id });
        case "blitz": return await act("battle.blitz", { message: id, stopAt: Number(value("stopAt")) || 1 });
        case "stop": return await act("battle.stop", { message: id });
        case "cancel": return await act("battle.cancel", { message: id });
        default: return null;
      }
    } finally {
      if ( target.isConnected ) target.disabled = false;
    }
  });
}

/** Forget client UI state of deleted messages. */
export function forgetBattleUI(message) {
  uiState.delete(message.id);
}
