import { reasonText } from "../state/_module.mjs";
import * as rules from "../rules/_module.mjs";
import { territoryName } from "./chat.mjs";
import {
  attack, buyRedStars, chooseCount, expand, joinWar, maneuver, placeStartingForces, tradeForTroops, usePower, choose
} from "./client.mjs";
import { getTurnInfo } from "./info.mjs";
import { api, snapshot, t } from "./util.mjs";

/**
 * Interactive flows for the War Room HUD and macros: pick territories on the board (`board.pickTerritory`), choose
 * cards (`cards.chooseResourceCards`) or numbers (apps' `chooseNumber`), then run the turn action. Each resolves to
 * the action's result, or null when cancelled/refused.
 */

/** Pick a territory among `allowed` on the board. */
async function pick(prompt, allowed, faction) {
  if ( !allowed.length ) {
    ui.notifications.warn(t("RL.Turn.Prompt.none"));
    return null;
  }
  const picker = api("board", "pickTerritory", { optional: true });
  if ( picker ) return picker({ prompt, allowed, faction });
  // Fallback without the canvas area: a list.
  return choose({ title: prompt, options: allowed.map(id => ({ value: id, label: territoryName(id) })) });
}

/** Faction id to act for: given, or the current one. */
const who = faction => faction || getTurnInfo().factionId;

/** Show a refused RuleResult and return true. */
function refused(result) {
  if ( result.ok ) return false;
  ui.notifications.warn(t("RL.Enforce.blocked", { reason: reasonText(result) }));
  return true;
}

/** Choose and place starting forces (placement stage). */
export async function promptStartingTerritory(faction) {
  const fid = faction || getTurnInfo().factionId;
  const allowed = rules.legalStartingTerritories(snapshot(), fid);
  const territory = await pick(t("RL.Turn.Prompt.start"), allowed, fid);
  return territory ? placeStartingForces({ faction: fid, territory }) : null;
}

/** Join the War in a chosen legal starting territory. */
export async function promptJoinWar(faction) {
  const fid = who(faction);
  const snap = snapshot();
  if ( refused(rules.checkTurnAction(snap, fid, "join")) ) return null;
  const territory = await pick(t("RL.Turn.Prompt.join"), rules.legalStartingTerritories(snap, fid, { joining: true }), fid);
  return territory ? joinWar({ faction: fid, territory }) : null;
}

/** Choose 4/8/… resource cards and buy Red Stars. */
export async function promptBuyRedStars(faction) {
  const fid = who(faction);
  if ( refused(rules.checkTurnAction(snapshot(), fid, "buyRedStars")) ) return null;
  const chooser = api("cards", "chooseResourceCards");
  const cardIds = await chooser({ faction: fid, purpose: "redStar", title: t("RL.Turn.Prompt.redStars") });
  return cardIds?.length ? buyRedStars({ faction: fid, cardIds }) : null;
}

/** Choose resource cards and turn them in for troops. */
export async function promptTrade(faction) {
  const fid = who(faction);
  if ( refused(rules.checkTurnAction(snapshot(), fid, "trade")) ) return null;
  const chooser = api("cards", "chooseResourceCards");
  const cardIds = await chooser({ faction: fid, purpose: "troops", title: t("RL.Turn.Prompt.trade") });
  return cardIds?.length ? tradeForTroops({ faction: fid, cardIds }) : null;
}

/** Pick an attacking territory, a target and the number of dice, then attack. */
export async function promptAttack(faction) {
  const fid = who(faction);
  const snap = snapshot();
  if ( refused(rules.checkTurnAction(snap, fid, "attack")) ) return null;
  const sources = (snap.factions[fid]?.territories ?? []).filter(id => rules.attackTargets(snap, fid, id).length);
  const from = await pick(t("RL.Turn.Prompt.attackFrom"), sources, fid);
  if ( !from ) return null;
  const to = await pick(t("RL.Turn.Prompt.attackTo"), rules.attackTargets(snap, fid, from), fid);
  if ( !to ) return null;
  const max = rules.maxAttackDice(snap, from);
  const dice = await chooseCount({ title: t("RL.Turn.Prompt.dice"), label: t("RL.Turn.Prompt.diceLabel"), min: 1, max, value: max });
  return dice ? attack({ faction: fid, from, to, dice }) : null;
}

/** Pick an origin, an unoccupied target and how many troops, then expand. */
export async function promptExpand(faction) {
  const fid = who(faction);
  const snap = snapshot();
  if ( refused(rules.checkTurnAction(snap, fid, "expand")) ) return null;
  const sources = (snap.factions[fid]?.territories ?? []).filter(id => rules.expandTargets(snap, fid, id).length);
  const from = await pick(t("RL.Turn.Prompt.expandFrom"), sources, fid);
  if ( !from ) return null;
  const to = await pick(t("RL.Turn.Prompt.expandTo"), rules.expandTargets(snap, fid, from), fid);
  if ( !to ) return null;
  const max = snap.territories[from].troops - 1;
  const min = Math.min(max, rules.expandCost(snap, fid, to, max).cost + 1);
  const count = await chooseCount({ title: t("RL.Turn.Prompt.troops"), label: t("RL.Turn.Prompt.troopsLabel"), min, max, value: max });
  return count ? expand({ faction: fid, from, to, count }) : null;
}

/** Pick an origin, a connected own territory and how many troops, then maneuver. */
export async function promptManeuver(faction) {
  const fid = who(faction);
  const snap = snapshot();
  if ( refused(rules.checkTurnAction(snap, fid, "maneuver")) ) return null;
  const sources = (snap.factions[fid]?.territories ?? []).filter(id => (snap.territories[id].troops > 1) && rules.maneuverTargets(snap, fid, id).length);
  const from = await pick(t("RL.Turn.Prompt.maneuverFrom"), sources, fid);
  if ( !from ) return null;
  const to = await pick(t("RL.Turn.Prompt.maneuverTo"), rules.maneuverTargets(snap, fid, from), fid);
  if ( !to ) return null;
  const max = snap.territories[from].troops - 1;
  const count = await chooseCount({ title: t("RL.Turn.Prompt.troops"), label: t("RL.Turn.Prompt.troopsLabel"), min: 1, max, value: max });
  return count ? maneuver({ faction: fid, from, to, count }) : null;
}

/** Use an activatable power, asking for its targets. */
export async function promptPower(power, faction) {
  const info = getTurnInfo();
  const fid = faction || (power === "bad_intel" ? info.myFaction?.id : info.factionId);
  const snap = snapshot();
  if ( power === "mobile" ) {
    const from = await pick(t("RL.Turn.Prompt.mobileFrom"), snap.factions[fid]?.hqs ?? [], fid);
    if ( !from ) return null;
    const to = await pick(t("RL.Turn.Prompt.mobileTo"), (snap.territories[from].neighbors ?? []).filter(id => rules.checkMoveHQ(snap, fid, from, id).ok), fid);
    return to ? usePower({ faction: fid, power, from, to }) : null;
  }
  if ( power === "bad_intel" ) {
    const target = snap.factions[snap.turn?.faction];
    const options = (target?.continents ?? []).map(id => ({ value: id, label: snap.continents[id]?.name || snap.continents[id]?.label || id }));
    const continent = await choose({ title: t("RL.Turn.Prompt.badIntel", { faction: target?.name ?? "" }), options });
    return continent ? usePower({ faction: fid, power, continent }) : null;
  }
  return usePower({ faction: fid, power });
}
