/**
 * Battle highlight on the world board, on every client: while a battle is open (declared, awaiting the defender's
 * dice, rolled), the canvas area's battle marker shows the attacking and defending territories and an arrow between
 * them (`game.risklegacy.board.showBattleMarker`). It is derived from the battle ChatMessages (document hooks fire on
 * every client), so no socket is needed: it appears when the card is posted, lingers briefly once the battle is
 * resolved (so the result can be seen on the board) and disappears at once when the battle is cancelled or deleted.
 *
 * Players who aren't the attacker can have their view panned to the battle (client setting `battlePanToBattle`).
 */
import { SYSTEM_ID } from "../config.mjs";
import { api } from "./services.mjs";

const OPEN = new Set(["declared", "awaitingDefender", "rolled"]);
/** How long the marker stays on the board after the battle is resolved (ms), before fading out. */
const LINGER = 2500;

let lingerTimer = null;

const board = () => api("board");

/** Register the client setting and the document/canvas hooks (battle init). */
export function registerBattleHighlight() {
  game.settings.register(SYSTEM_ID, "battlePanToBattle", {
    name: "RL.Battle.Settings.panToBattle.name",
    hint: "RL.Battle.Settings.panToBattle.hint",
    scope: "client", config: true, type: Boolean, default: true
  });

  Hooks.on("createChatMessage", message => {
    if ( message.type !== "battle" ) return;
    onBattleShown(message, { created: true });
  });
  Hooks.on("updateChatMessage", (message, changed) => {
    if ( message.type !== "battle" ) return;
    if ( !foundry.utils.hasProperty(changed, "system.status") ) return;
    onBattleShown(message);
  });
  Hooks.on("deleteChatMessage", message => {
    if ( message.type === "battle" ) board()?.clearBattleMarker?.(message.id, { fade: false });
  });
  Hooks.on("canvasReady", () => syncBattleHighlight());
}

/** After `ready`: show the battle that is still open (reload, late join). */
export function readyBattleHighlight() {
  syncBattleHighlight();
}

/** The newest battle message that is still open, if any. */
function openBattleMessage() {
  const recent = game.messages.contents.slice(-60).reverse();
  const latest = recent.find(m => m.type === "battle");
  return latest && OPEN.has(latest.system.status) ? latest : null;
}

/** Marker spec of a battle message. */
function specOf(message) {
  const sys = message.system;
  return {
    id: message.id, from: sys.from, to: sys.to, attacker: sys.attacker, defender: sys.defender
  };
}

/** Show the open battle (or nothing) — used after a (re)draw of the canvas and on ready. */
export function syncBattleHighlight() {
  const b = board();
  if ( typeof b?.showBattleMarker !== "function" ) return;
  const open = openBattleMessage();
  if ( open ) b.showBattleMarker(specOf(open));
  else if ( !lingerTimer ) b.clearBattleMarker?.(null, { fade: false });
  else b.redrawBattleMarker?.();
}

/**
 * A battle message was created or changed status.
 * @param {ChatMessage} message
 * @param {{created?: boolean}} [options]
 */
function onBattleShown(message, { created = false } = {}) {
  const b = board();
  if ( typeof b?.showBattleMarker !== "function" ) return;
  const status = message.system.status;
  clearTimeout(lingerTimer);
  lingerTimer = null;
  if ( status === "cancelled" ) {
    b.clearBattleMarker(message.id, { fade: false });
    return;
  }
  // Open, or resolved (a blitz card is created already resolved): show; a resolved battle lingers, then fades.
  b.showBattleMarker(specOf(message));
  if ( status === "resolved" ) {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      // A newer battle may have started meanwhile
      if ( openBattleMessage() ) return;
      b.clearBattleMarker(message.id, { fade: true });
    }, LINGER);
  }
  if ( created ) panToBattle(message);
}

/* -------------------------------------------- */
/*  Panning                                     */
/* -------------------------------------------- */

/** Is the current user the one playing the attacking faction (who is looking at the battle already)? */
function isAttackerUser(actor) {
  if ( !actor ) return game.user.isGM;
  const playerId = actor.system?.war?.playerId;
  if ( playerId ) return (playerId === game.user.id) || (game.user.isGM && !game.users.get(playerId)?.active);
  return game.user.isGM || actor.testUserPermission(game.user, "OWNER");
}

/** Pan the view to a newly posted battle (client setting), unless it is already in view or this user attacks. */
function panToBattle(message) {
  try {
    if ( !game.settings.get(SYSTEM_ID, "battlePanToBattle") ) return;
    if ( isAttackerUser(game.actors.get(message.system.attacker)) ) return;
    const focus = board()?.battleFocus?.(message.system);
    if ( !focus || !canvas?.ready ) return;
    // Already on screen (both territories' centres, with a margin)?
    const scale = canvas.stage.scale.x || 1;
    const [w, h] = canvas.screenDimensions;
    const cx = canvas.stage.pivot.x;
    const cy = canvas.stage.pivot.y;
    const halfW = (w / 2 / scale) * 0.85;
    const halfH = (h / 2 / scale) * 0.85;
    const inView = p => !p || ((Math.abs(p.x - cx) <= halfW) && (Math.abs(p.y - cy) <= halfH));
    if ( inView(focus.a) && inView(focus.b) ) return;
    canvas.animatePan({ x: focus.x, y: focus.y, duration: 700 });
  } catch(err) {
    console.warn("risklegacy | could not pan to the battle", err);
  }
}
