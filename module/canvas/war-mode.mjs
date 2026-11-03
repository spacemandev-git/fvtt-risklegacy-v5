import { SYSTEM_ID } from "../config.mjs";
import { buildSnapshot, canActFor, currentFaction, enforcementLevel, getWar, reasonText } from "../state/_module.mjs";
import { boardForScene } from "./geometry.mjs";
import * as interaction from "./interaction.mjs";

/**
 * The sticky attack / expand mode ("war mode") of step 3.
 *
 * Armed from the War Room (Attack / Expand) or `game.risklegacy.board.armWarMode()`, it stays on until the player
 * stops it (Esc, right-click with nothing selected, the banner's Stop, the War Room's button again) or the step/turn
 * ends. While it is on, the board (rlBoard layer) works like this:
 *   - your territories that can act are tinted in your colour; click one (or start a drag on it) to select it;
 *   - targets of the selected territory are red (attack) or yellow (expand): click one, or drag onto it;
 *       attack  = the most dice (Shift: choose), through `turn.attack` → a battle card in chat;
 *       expand  = choose how many troops (Shift: all but one), through `turn.expand`;
 *   - after a conquest/expansion the territory just entered is blue while more troops may follow: click it to move
 *     them in (`battle.moveIn` while the battle card offers it, `turn.advance` otherwise);
 *   - after each battle/expansion the mode stays armed and selects a sensible source by itself: the conquered
 *     territory when it can go on (the original one while the survivors can still be joined, or after a failed attack);
 *   - the banner has an Attack | Expand switch; the War Room shows which mode is armed.
 * Bots don't use this (they call the GM actions directly); nothing here changes what the actions do.
 */

const ACTIONS = ["attack", "expand"];
const COLORS = { attack: 0xc4151c, expand: 0xfcdc07, advance: 0x2f9fd0, none: 0x6d6f71 };
const ICONS = { attack: "fa-solid fa-crosshairs", expand: "fa-solid fa-person-walking-arrow-right" };

/** @returns {object} game.risklegacy.<area> or {} */
const area = name => game.risklegacy?.[name] ?? {};
const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** The running war mode, if any. */
function active() {
  const m = interaction.currentMode();
  return m?.kind === "war" ? m : null;
}

/**
 * The armed war mode, for UIs (the War Room).
 * @returns {{action: "attack"|"expand", faction: string, from: string|null, busy: boolean}|null}
 */
export function warMode() {
  const m = active();
  return m ? { action: m.action, faction: m.faction, from: m.selected ?? null, busy: !!m.busy } : null;
}

function changed() {
  Hooks.callAll("risklegacy.warModeChanged", warMode());
}

/* -------------------------------------------- */
/*  Arming                                      */
/* -------------------------------------------- */

/**
 * Arm the attack/expand mode for a faction (switches the action if it is already armed).
 * @param {object} [options]
 * @param {string} [options.faction]                 default: the faction whose turn it is
 * @param {"attack"|"expand"} [options.action="attack"]
 * @param {string} [options.from]                    territory to select first
 * @returns {Promise<boolean>} whether the mode is armed
 */
export async function armWarMode({ faction, action = "attack", from = null } = {}) {
  if ( !ACTIONS.includes(action) ) throw new Error(`Unknown war mode action "${action}"`);
  const fid = faction || currentFaction()?.id;
  const current = active();
  if ( current && (current.faction === fid) ) {
    setAction(current, action);
    if ( from ) select(current, from);
    return true;
  }
  const v = validity(fid, action);
  if ( !v.ok ) {
    ui.notifications.warn(v.reason);
    return false;
  }
  if ( !(await interaction.ensureBoardView()) ) return false;
  interaction.cancelMode();
  const m = createMode(fid, action);
  if ( from ) m.selected = from;
  else {
    // Carry on from the last expansion/conquest of this turn
    const last = area("rules").turnFlags?.(buildSnapshot())?.lastAdvance;
    if ( last ) m.prefer = [last.to, last.from];
  }
  m.refresh();
  interaction.startMode(m);
  changed();
  return true;
}

/**
 * Arm, switch or disarm: the War Room's buttons. Pressing the armed action again stops the mode.
 * @param {{faction?: string, action: "attack"|"expand"}} options
 * @returns {Promise<boolean>} whether the mode is armed afterwards
 */
export async function toggleWarMode({ faction, action = "attack" } = {}) {
  const current = active();
  if ( current && (current.action === action) && (!faction || (faction === current.faction)) ) {
    disarmWarMode();
    return false;
  }
  return armWarMode({ faction, action });
}

/**
 * Stop the attack/expand mode.
 * @returns {boolean} whether it was armed
 */
export function disarmWarMode() {
  if ( !active() ) return false;
  return interaction.cancelMode();
}

/** Switch between attack and expand, keeping the selected territory when it can do the new action. */
function setAction(m, action) {
  if ( m.action === action ) return;
  m.action = action;
  m.prefer = m.selected ? [m.selected] : null;
  m.auto = true;
  update(m);
  changed();
}

/**
 * May the faction be in the war mode now?
 * @returns {{ok: boolean, reason?: string}}
 */
function validity(fid, action) {
  const war = getWar();
  if ( !war || (war.system.stage !== "playing") ) return { ok: false, reason: t("RL.Canvas.War.noWar") };
  const actor = game.actors.get(fid);
  if ( !actor || (currentFaction()?.id !== fid) || !canActFor(game.user, actor) ) {
    return { ok: false, reason: t("RL.Error.notYourTurn") };
  }
  const rules = area("rules");
  let snap;
  try {
    snap = buildSnapshot();
  } catch(err) {
    return { ok: false, reason: err.message };
  }
  if ( ["maneuver", "end"].includes(snap?.turn?.phase) ) return { ok: false, reason: t("RL.Canvas.War.stepOver") };
  const gate = rules.checkTurnAction?.(snap, fid, action);
  if ( gate && !gate.ok && (enforcementLevel() === "strict") ) return { ok: false, reason: reasonText(gate) };
  return { ok: true };
}

/* -------------------------------------------- */
/*  The mode                                    */
/* -------------------------------------------- */

function createMode(fid, action) {
  const actor = game.actors.get(fid);
  const m = {
    kind: "war", action, faction: fid,
    color: Number(actor?.system?.color ?? 0x808285),
    selected: null,
    prefer: null,      // territories to select once they can act (after a battle/expansion)
    auto: true,        // select the only possible source by itself (off after a manual deselect)
    busy: false,
    drag: null,
    battleKey: null,
    view: null,        // last computed board view (sources, targets, advance…)
    allowed: null,     // the mode validates clicks itself (better messages than "not allowed")
    clickable: [],
    paint: [],
    cancelLabel: t("RL.Canvas.War.stop"),
    refresh: () => compute(m),
    onClick: (territory, event) => onClick(m, territory, event),
    onRightClick: () => {
      if ( !m.selected || m.busy ) return false;
      m.selected = null;
      m.auto = false;
      m.prefer = null;
      update(m);
      return true;
    },
    onDrag: (phase, territory, event, point) => onDrag(m, phase, territory, event, point),
    onBannerAction: action => {
      if ( ACTIONS.includes(action) ) setAction(m, action);
    },
    onCancel: () => changed()
  };
  return m;
}

/** Recompute and redraw (banner, highlights). */
function update(m) {
  if ( active() === m ) interaction.refreshMode();
}

/** Troops of the faction in a territory. */
function troops(snap, fid, id) {
  const x = snap?.territories?.[id];
  return x?.pieces?.[fid]?.troops ?? (x?.owner === fid ? (x.troops ?? 0) : 0);
}

/** The battle that blocks a new attack, or offers a move-in. */
function battleState(snap, fid) {
  const msg = area("battle").currentBattle?.() ?? null;
  if ( !msg || (msg.system.attacker !== fid) ) return { open: null, moveIn: null };
  const s = msg.system;
  if ( !["resolved", "cancelled"].includes(s.status) ) return { open: msg, moveIn: null };
  const r = s.result ?? {};
  const pending = (s.status === "resolved") && r.conquered && !s.closed && !r.moveInDone
    && (snap.territories[s.to]?.owner === fid) && (troops(snap, fid, s.from) > 1);
  return { open: null, moveIn: pending ? msg : null };
}

/** Compute the board view of the mode: what can be selected/clicked, colours, banner text. */
function compute(m) {
  const v = validity(m.faction, m.action);
  if ( !v.ok ) {
    // The step or turn is over: stop (after this refresh returns)
    setTimeout(() => {
      if ( active() !== m ) return;
      interaction.cancelMode();
      ui.notifications.info(t("RL.Canvas.War.disarmed", { reason: v.reason }));
    }, 0);
    m.paint = [];
    m.clickable = [];
    return;
  }
  const rules = area("rules");
  const snap = buildSnapshot();
  const fid = m.faction;
  const targetsOf = id => {
    try {
      return (m.action === "attack" ? rules.attackTargets?.(snap, fid, id) : rules.expandTargets?.(snap, fid, id)) ?? [];
    } catch(err) {
      console.error(`${SYSTEM_ID} | war mode targets failed`, err);
      return [];
    }
  };
  const battle = battleState(snap, fid);
  // More troops may follow the last expansion/conquest: lastAdvance + checkAdvance (move-in pending is one case)
  const last = rules.turnFlags?.(snap)?.lastAdvance ?? null;
  const advanceOf = id => {
    if ( battle.moveIn && (battle.moveIn.system.from === id) ) return battle.moveIn.system.to;
    if ( last && (last.from === id) && rules.checkAdvance?.(snap, fid, last.from, last.to, 1)?.ok ) return last.to;
    return null;
  };
  const own = snap.factions?.[fid]?.territories ?? [];
  const sources = own.filter(id => targetsOf(id).length);
  const selectable = id => sources.includes(id) || !!advanceOf(id);

  // Selection: keep it while it can act; else the preferred territory; else the only source
  if ( m.selected && !selectable(m.selected) ) m.selected = null;
  if ( m.prefer?.length ) {
    const pick = m.prefer.find(selectable);
    if ( pick ) m.selected = pick;
  }
  if ( !m.selected && m.auto && (sources.length === 1) ) m.selected = sources[0];
  const sel = m.selected;
  const targets = sel ? targetsOf(sel) : [];
  const advance = sel ? advanceOf(sel) : null;
  m.view = { snap, sources, targets, advance, battle: battle.open, moveIn: battle.moveIn };

  // Colours: sources in the faction colour, the selection outlined, targets red/yellow, move-in blue
  const paint = sources.filter(id => id !== sel)
    .map(id => ({ id, color: m.color, line: 0xfbfcfc, width: 6, fill: sel ? 0.2 : 0.35 }));
  if ( sel ) paint.push({ id: sel, color: m.color, line: 0xfbfcfc, width: 18, fill: 0.45, selected: true });
  for ( const id of targets ) paint.push({ id, color: COLORS[m.action], width: 14, fill: 0.35, outline: true });
  if ( advance ) paint.push({ id: advance, color: COLORS.advance, width: 14, fill: 0.4, outline: true });
  m.paint = paint;
  m.clickable = (battle.open || m.busy) ? [] : [...new Set([...sources, ...targets, ...(advance ? [advance] : [])])];

  // Banner
  const name = id => snap.territories?.[id]?.name ?? boardForScene()?.territories?.[id]?.name ?? id;
  m.switches = ACTIONS.map(a => ({ action: a, label: t(`RL.Canvas.War.${a}`), icon: ICONS[a], active: a === m.action }));
  if ( m.busy ) {
    m.prompt = t("RL.Canvas.War.busy");
    m.hint = "";
  }
  else if ( battle.open ) {
    m.prompt = t("RL.Canvas.War.battleOpen", { to: name(battle.open.system.to) });
    m.hint = t("RL.Canvas.War.battleOpenHint");
  }
  else if ( sel ) {
    m.prompt = t(`RL.Canvas.War.${m.action}From`, { from: name(sel) });
    const hints = [];
    if ( targets.length ) hints.push(t(`RL.Canvas.War.${m.action}Hint`));
    else hints.push(t(`RL.Canvas.War.${m.action}NoTargets`, { from: name(sel) }));
    if ( advance ) hints.push(t("RL.Canvas.War.moveInHint", { to: name(advance) }));
    hints.push(t("RL.Canvas.War.stopHint"));
    m.hint = hints.join(" ");
  }
  else if ( sources.length ) {
    m.prompt = t(`RL.Canvas.War.${m.action}Pick`);
    m.hint = `${t("RL.Canvas.War.pickHint")} ${t("RL.Canvas.War.stopHint")}`;
  }
  else {
    m.prompt = t(`RL.Canvas.War.${m.action}None`);
    m.hint = t("RL.Canvas.War.noneHint");
  }
}

/** Select a territory as the source (manual choice: overrides the automatic one). */
function select(m, id) {
  m.selected = id;
  m.prefer = null;
  m.auto = true;
  update(m);
}

/* -------------------------------------------- */
/*  Input                                       */
/* -------------------------------------------- */

function onClick(m, territory, event) {
  if ( m.busy || !territory ) return;
  const view = m.view;
  if ( !view ) return;
  const name = id => view.snap.territories?.[id]?.name ?? id;
  const ask = !!event?.shiftKey;
  if ( view.battle ) {
    ui.notifications.warn(t("RL.Canvas.War.battleOpen", { to: name(view.battle.system.to) }));
    return;
  }
  const sel = m.selected;
  if ( sel && view.advance && (territory === view.advance) ) return run(m, () => advanceInto(m, sel, territory, ask));
  if ( sel && view.targets.includes(territory) ) {
    return run(m, () => (m.action === "attack" ? attackFrom(m, sel, territory, ask) : expandFrom(m, sel, territory, ask)));
  }
  if ( territory === sel ) return;   // already selected (right-click deselects)
  if ( view.sources.includes(territory) ) return select(m, territory);
  // Not clickable: say why
  const owner = view.snap.territories?.[territory]?.owner;
  if ( owner === m.faction ) ui.notifications.warn(t(`RL.Canvas.War.${m.action}NoTargets`, { from: name(territory) }));
  else if ( sel ) ui.notifications.warn(t(`RL.Canvas.War.${m.action}NotTarget`, { from: name(sel), to: name(territory) }));
  else ui.notifications.warn(t("RL.Canvas.War.pickFirst"));
}

function onDrag(m, phase, territory, event, point) {
  const center = id => {
    const c = boardForScene()?.territories?.[id]?.center;
    return c ? { x: c[0], y: c[1] } : null;
  };
  switch ( phase ) {
    case "start": {
      m.drag = null;
      const view = m.view;
      if ( m.busy || !view || view.battle || !territory ) return;
      if ( !view.sources.includes(territory) && (territory !== m.selected) ) return;
      if ( territory !== m.selected ) select(m, territory);
      m.drag = { source: territory, from: center(territory) ?? point, to: point, color: COLORS.none };
      break;
    }
    case "move": {
      if ( !m.drag ) return;
      const view = m.view;
      m.drag.to = point;
      m.drag.color = view?.targets.includes(territory) ? COLORS[m.action]
        : ((territory && (territory === view?.advance)) ? COLORS.advance : COLORS.none);
      break;
    }
    case "drop": {
      const drag = m.drag;
      m.drag = null;
      canvas.rlBoard?.drawHighlights();
      if ( drag && territory && (territory !== drag.source) ) onClick(m, territory, event);
      return;
    }
    default:
      m.drag = null;
  }
  canvas.rlBoard?.drawHighlights();
}

/** Run one action with the mode busy (no clicks meanwhile), then refresh. */
async function run(m, fn) {
  m.busy = true;
  m.auto = true;
  update(m);
  try {
    await fn();
  } catch(err) {
    console.error(`${SYSTEM_ID} | war mode action failed`, err);
    ui.notifications.error(err.message);
  } finally {
    m.busy = false;
    update(m);
  }
}

async function attackFrom(m, from, to, ask) {
  const turn = area("turn");
  const snap = m.view.snap;
  const max = Math.max(1, area("rules").maxAttackDice?.(snap, from) ?? Math.min(3, troops(snap, m.faction, from) - 1));
  let dice = max;
  if ( ask && (max > 1) ) {
    dice = await turn.chooseCount?.({
      title: t("RL.Canvas.War.attackTitle", { from: snap.territories[from]?.name ?? from, to: snap.territories[to]?.name ?? to }),
      label: t("RL.Canvas.War.dice"), min: 1, max, value: max
    });
    if ( !dice ) return;
  }
  const out = await turn.attack?.({ faction: m.faction, from, to, dice });
  // The battle's outcome picks the next source (onBattle); until then stay on this one
  if ( out ) m.selected = from;
}

async function expandFrom(m, from, to, ask) {
  const turn = area("turn");
  const snap = m.view.snap;
  const max = troops(snap, m.faction, from) - 1;
  const cost = area("rules").expandCost?.(snap, m.faction, to, max)?.cost ?? 0;
  const min = Math.max(1, Math.min(max, cost + 1));
  let count = max;
  if ( !ask && (max > min) ) {
    count = await turn.chooseCount?.({
      title: t("RL.Canvas.War.expandTitle", { from: snap.territories[from]?.name ?? from, to: snap.territories[to]?.name ?? to }),
      label: cost ? t("RL.Canvas.War.troopsCost", { cost }) : t("RL.Canvas.War.troops"), min, max, value: max
    });
    if ( !count ) return;
  }
  const out = await turn.expand?.({ faction: m.faction, from, to, count });
  if ( out ) m.prefer = [to, from];
}

async function advanceInto(m, from, to, ask) {
  const snap = m.view.snap;
  const max = troops(snap, m.faction, from) - 1;
  if ( max < 1 ) return;
  let count = max;
  if ( !ask && (max > 1) ) {
    count = await area("turn").chooseCount?.({
      title: t("RL.Canvas.War.moveInTitle", { to: snap.territories[to]?.name ?? to }),
      label: t("RL.Canvas.War.troops"), min: 1, max, value: max
    });
    if ( !count ) return;
  }
  const moveIn = m.view.moveIn;
  let out;
  if ( moveIn && (moveIn.system.from === from) && (moveIn.system.to === to) ) {
    out = await area("battle").moveIn?.({ message: moveIn.id, count });
  }
  else out = await area("turn").advance?.({ faction: m.faction, from, to, count });
  if ( out ) m.prefer = [to, from];
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

const refreshSoon = foundry.utils.debounce(() => {
  if ( active() ) interaction.refreshMode();
}, 80);

/** A battle card of the armed faction changed: pick the next source once it is decided. */
function onBattle(message) {
  const m = active();
  if ( !m || (message?.type !== "battle") || (message.system.attacker !== m.faction) ) return;
  const s = message.system;
  const key = `${message.id}|${s.status}|${!!s.result?.moveInDone}|${!!s.closed}`;
  if ( key === m.battleKey ) return;
  m.battleKey = key;
  if ( s.status === "resolved" ) {
    const r = s.result ?? {};
    if ( r.conquered ) m.prefer = (!s.closed && !r.moveInDone) ? [s.from, s.to] : [s.to, s.from];
    else m.prefer = [s.from];
    m.auto = true;
  }
  else if ( s.status !== "cancelled" ) {
    // A battle under way (possibly started elsewhere: chat card, macro): its source stays selected
    m.selected = s.from;
    m.prefer = null;
  }
  refreshSoon();
}

function onTokens(token) {
  if ( active() && (token?.parent === canvas.scene) ) refreshSoon();
}

/** Register the hooks (canvas init). */
export function initWarMode() {
  Hooks.on("createChatMessage", onBattle);
  Hooks.on("updateChatMessage", onBattle);
  Hooks.on("createToken", onTokens);
  Hooks.on("updateToken", onTokens);
  Hooks.on("deleteToken", onTokens);
  Hooks.on("deleteCombat", refreshSoon);
}
