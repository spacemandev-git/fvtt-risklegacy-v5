import { SYSTEM_ID } from "../config.mjs";
import { canActFor, enforcementLevel, getCardStack, reasonText } from "../state/_module.mjs";
import { runAction } from "../gm/actions.mjs";
import * as rules from "../rules/_module.mjs";
import { powerName, territoryName } from "./chat.mjs";
import { getTurnInfo } from "./info.mjs";
import { api, esc, snapshot, t } from "./util.mjs";

/**
 * Client-side API of the turn area (`game.risklegacy.turn.*`). [GM] functions are thin wrappers around GM actions:
 * they resolve to the handler's result, or `null` when the action was refused or failed (the reason is shown as a
 * notification). Factions and territories are ids; `faction` defaults to the faction whose turn it is.
 */

/** Run a GM action; null on failure (notified). */
export async function call(name, payload = {}) {
  try {
    return await runAction(name, payload);
  } catch(err) {
    // runAction already notifies when the request went to another client; locally we do it here.
    if ( game.user.isActiveGM ) ui.notifications.error(err.message);
    console.warn(`${SYSTEM_ID} | ${name} refused: ${err.message}`);
    return null;
  }
}

/* -------------------------------------------- */
/*  [GM] wrappers                               */
/* -------------------------------------------- */

export const createWar = payload => call("turn.createWar", payload);
export const beginPlacement = (payload = {}) => call("turn.beginPlacement", payload);
export const placeStartingForces = payload => call("turn.placeStartingForces", payload);
export const beginPlay = (payload = {}) => call("turn.beginPlay", payload);
export const setPhase = payload => call("turn.setPhase", payload);
export const advancePhase = (payload = {}) => call("turn.advancePhase", payload);
export const buyRedStars = payload => call("turn.buyRedStars", payload);
export const tradeForTroops = payload => call("turn.tradeForTroops", payload);
export const recruit = (payload = {}) => call("turn.recruit", payload);
export const joinWar = payload => call("turn.joinWar", payload);
export const placeReserve = payload => call("turn.placeReserve", payload);
export const expand = payload => call("turn.expand", payload);
export const maneuver = payload => call("turn.maneuver", payload);
/** More troops following the last expansion/conquest from the same territory (not a maneuver). */
export const advance = payload => call("turn.advance", payload);
/** An HQ dragged to an adjacent own territory (Mobile power). */
export const moveHQ = payload => call("turn.moveHQ", payload);
/** Attack: validated and recorded by the turn area, then `battle.startBattle`. Resolves `{messageId}` or null. */
export const attack = payload => call("turn.attack", payload);
export const recordConquest = payload => call("turn.recordConquest", payload);
export const protect = payload => call("turn.protect", payload);
export const usePower = payload => call("turn.usePower", payload);
export const endWar = (payload = {}) => call("turn.endWar", payload);
export const eliminate = payload => call("turn.eliminate", payload);

/* -------------------------------------------- */
/*  Dialog helpers (apps area's dialogs, with a core fallback) */
/* -------------------------------------------- */

/** Pick one option; null when dismissed. */
export async function choose({ title, content, options }) {
  const shared = api("apps", "chooseOption", { optional: true });
  if ( shared ) return shared({ title, content, options });
  const enabled = options.filter(o => !o.disabled);
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title }, classes: ["risklegacy"], rejectClose: false,
    content: `<div class="rl-callout">${content ?? ""}</div>`,
    buttons: enabled.map((o, i) => ({ action: String(i), label: o.label, default: i === 0 }))
  });
  return (result === null) || (result === undefined) ? null : (enabled[Number(result)]?.value ?? null);
}

/** Yes / no; null when dismissed. */
export async function confirm({ title, content }) {
  const shared = api("apps", "confirmAction", { optional: true });
  if ( shared ) return shared({ title, content });
  return foundry.applications.api.DialogV2.confirm({
    window: { title }, classes: ["risklegacy"], content: `<p>${content}</p>`, rejectClose: false
  });
}

/** Ask for a number; null when dismissed. */
export async function chooseCount({ title, label, min = 1, max = 1, value }) {
  if ( max <= min ) return min;
  const shared = api("apps", "chooseNumber", { optional: true });
  if ( shared ) return shared({ title, label, min, max, value: value ?? max });
  const result = await foundry.applications.api.DialogV2.input({
    window: { title }, classes: ["risklegacy"], rejectClose: false,
    content: `<label>${esc(label)} <input type="number" name="count" min="${min}" max="${max}" value="${value ?? max}" autofocus></label>`
  });
  const n = Number(result?.count);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : null;
}

/* -------------------------------------------- */
/*  End of turn                                 */
/* -------------------------------------------- */

/** The face-up mission card, if any. */
function missionCard() {
  return getCardStack("missionSlot")?.cards.contents[0] ?? null;
}

/**
 * The face-up mission and whether the faction completed it: true / false / null (can't be checked: the player
 * claims it). Uses the cards area's `missionStatus` when available (it also knows islands and the row).
 */
function missionState(snap, fid) {
  if ( snap.turn?.log?.missionCompleted || snap.turn?.log?.cardDrawn ) return { mission: null, verdict: false };
  const status = api("cards", "missionStatus", { optional: true });
  if ( status ) {
    try {
      const s = status(fid);
      if ( !s?.mission ) return { mission: null, verdict: false };
      if ( !s.canComplete ) return { mission: s.mission, verdict: false };
      return { mission: s.mission, verdict: s.status === "complete" ? true : (s.status === "incomplete" ? false : null) };
    } catch(err) {
      console.warn(`${SYSTEM_ID} | cards.missionStatus failed`, err);
    }
  }
  const mission = missionCard();
  const verdict = mission?.system?.check ? rules.missionCheck(snap, fid, mission.system.check) : null;
  return { mission, verdict };
}

/**
 * End the turn (client side): gather the choices on this client, then run the GM action `turn.end`.
 *   1. "Complete the mission *or* draw a card" when both are possible (a mission whose structured check fails is not
 *      offered; one that can't be checked automatically is offered for the player to claim).
 *   2. `cards.promptResourceDraw(faction)` for which card.
 *   3. Khan Industries (`khan_2`): place a troop in the drawn territory?
 * Cancelling a dialog keeps the turn going.
 * @param {{faction?: string}} [options]
 * @returns {Promise<object|null>} the GM action's result, or null if cancelled/refused
 */
export async function endTurn({ faction } = {}) {
  const info = getTurnInfo();
  if ( !info.war || (info.stage !== "playing") ) {
    ui.notifications.warn(t("RL.Turn.Error.noWar"));
    return null;
  }
  const fid = faction || info.factionId;
  const actor = game.actors.get(fid);
  if ( !actor || (fid !== info.factionId) || !canActFor(game.user, actor) ) {
    ui.notifications.warn(t("RL.Error.notYourTurn"));
    return null;
  }
  let snap;
  try {
    snap = snapshot();
  } catch(err) {
    ui.notifications.error(err.message);
    return null;
  }
  const gate = rules.checkTurnAction(snap, fid, "endTurn");
  if ( !gate.ok && (enforcementLevel() === "strict") ) {
    ui.notifications.warn(t("RL.Enforce.blocked", { reason: reasonText(gate) }));
    return null;
  }

  // 1. Mission or card
  const eligible = rules.resourceDrawEligibility(snap, fid);
  const { mission, verdict } = missionState(snap, fid);
  let completeMission = false;
  let wantDraw = eligible.ok;
  if ( mission && (verdict !== false) ) {
    const options = [{
      value: "mission", label: t("RL.Turn.End.completeMission", { mission: mission.name }),
      hint: verdict ? t("RL.Turn.End.missionMet") : t("RL.Turn.End.missionManual"), img: mission.img
    }];
    if ( eligible.ok ) options.push({ value: "draw", label: t("RL.Turn.End.drawCard"), hint: t("RL.Turn.End.drawHint") });
    options.push({ value: "none", label: eligible.ok ? t("RL.Turn.End.neither") : t("RL.Turn.End.noMission") });
    const choice = await choose({ title: t("RL.Turn.End.title"), content: t("RL.Turn.End.choiceContent"), options });
    if ( choice === null ) return null;
    completeMission = choice === "mission";
    wantDraw = choice === "draw";
  }

  // 2. Which card
  let draw = null;
  if ( !completeMission && wantDraw ) {
    const prompt = api("cards", "promptResourceDraw", { optional: true });
    if ( prompt ) draw = await prompt(fid);
    else ui.notifications.warn(t("RL.Turn.Error.missingApi", { api: "game.risklegacy.cards.promptResourceDraw" }));
  }

  // 3. Khan Industries: one troop into the drawn territory
  const powers = {};
  if ( draw?.cardId && rules.hasPower(snap, fid, rules.POWERS.khan2) ) {
    const card = getCardStack("row")?.cards.get(draw.cardId);
    const territory = card?.system?.territory;
    if ( territory && (snap.territories[territory]?.owner === fid) ) {
      powers.khan_2 = !!(await confirm({
        title: powerName("khan_2"), content: t("RL.Turn.End.khan2", { territory: esc(territoryName(territory)) })
      }));
    }
  }
  return call("turn.end", { faction: fid, draw, completeMission, powers });
}
