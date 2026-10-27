import { SYSTEM_ID } from "../config.mjs";
import WarData from "../data/combat-war.mjs";
import * as turn from "../turn/_module.mjs";

/**
 * Combat document class. OWNER: turn/game-logic area (module/turn/).
 *
 * For Combats of type "war" (one per game of Risk Legacy):
 * - Combatants are faction actors without tokens (`actorId` only). Turn order is seat order
 *   (`flags[SYSTEM_ID].seat`, falling back to the faction's `system.war.seat`); `initiative` = seat + 1, display only.
 * - `_onStartTurn` (active GM only) hands over to the turn controller (reset of the turn record, Join the War /
 *   elimination, start-of-turn powers).
 * - The core tracker's turn controls go through the rules: "Next turn" runs `turn.endTurn` (the end-of-turn
 *   choices, card draw, events), eliminated factions are skipped, and only GMs can rewind.
 * Other Combat types behave like core Combats.
 */
export default class RLCombat extends foundry.documents.Combat {

  /** Is this a Risk Legacy war? */
  get isWar() {
    return this.type === "war";
  }

  /**
   * Seat order for wars (core sorts by descending initiative). Called unbound by `setupTurns`, so `this` is not
   * available here.
   * @override
   */
  _sortCombatants(a, b) {
    if ( a.parent?.type !== "war" ) return super._sortCombatants(a, b);
    const seat = c => c.flags?.[SYSTEM_ID]?.seat ?? c.actor?.system?.war?.seat
      ?? (Number.isFinite(c.initiative) ? c.initiative - 1 : Number.MAX_SAFE_INTEGER);
    return (seat(a) - seat(b)) || (a.id > b.id ? 1 : -1);
  }

  /** @override */
  async _onStartTurn(combatant, context) {
    await super._onStartTurn(combatant, context);
    if ( !this.isWar || context?.skipped ) return;
    try {
      await turn.onStartTurn(this, combatant, context);
    } catch(err) {
      console.error(`${SYSTEM_ID} | start of turn failed`, err);
      ui.notifications.error(err.message);
    }
  }

  /** Movement histories don't matter for piece tokens; skip the extra token updates. @override */
  async _clearMovementHistoryOnStartTurn(combatant, context) {
    if ( !this.isWar ) return super._clearMovementHistoryOnStartTurn(combatant, context);
  }

  /** Wars start through the turn controller (stage setup/placement → playing). @override */
  async startCombat() {
    if ( !this.isWar || (this.system.stage === "playing") ) return super.startCombat();
    if ( !game.user.isGM ) {
      ui.notifications.warn(game.i18n.localize("RL.Turn.Error.gmOnly"));
      return this;
    }
    await turn.beginPlay({});
    return this;
  }

  /** "Next turn" ends the current faction's turn properly. @override */
  async nextTurn() {
    if ( !this.isWar ) return super.nextTurn();
    if ( this.system.stage !== "playing" ) {
      ui.notifications.warn(game.i18n.localize("RL.Turn.Error.notPlaying"));
      return this;
    }
    await turn.endTurn({ faction: this.combatant?.actorId });
    return this;
  }

  /** @override */
  async nextRound() {
    if ( !this.isWar ) return super.nextRound();
    return this.nextTurn();
  }

  /** GM correction: rewind one turn and give that faction a fresh turn record (powers are not re-applied). @override */
  async previousTurn() {
    if ( !this.isWar ) return super.previousTurn();
    if ( !game.user.isGM ) {
      ui.notifications.warn(game.i18n.localize("RL.Turn.Error.gmOnly"));
      return this;
    }
    await super.previousTurn();
    const actorId = this.combatant?.actorId;
    if ( actorId ) {
      await this.update({
        "system.phase": "start",
        "system.turn": foundry.data.operators.ForcedReplacement.create(WarData.freshTurn(actorId))
      });
    }
    return this;
  }

  /** @override */
  async previousRound() {
    if ( !this.isWar ) return super.previousRound();
    if ( !game.user.isGM ) {
      ui.notifications.warn(game.i18n.localize("RL.Turn.Error.gmOnly"));
      return this;
    }
    return super.previousRound();
  }

  /** Turn order is seat order: initiative rolls don't apply to wars. @override */
  async rollInitiative(ids, options) {
    if ( !this.isWar ) return super.rollInitiative(ids, options);
    return this;
  }

  /** @override */
  async rollAll(options) {
    if ( !this.isWar ) return super.rollAll(options);
    return this;
  }

  /** @override */
  async rollNPC(options) {
    if ( !this.isWar ) return super.rollNPC(options);
    return this;
  }

  /** Advance to the next faction still in the war (GM; used by the turn controller). */
  async advanceTurn() {
    return turn.advanceTurn(this);
  }
}
