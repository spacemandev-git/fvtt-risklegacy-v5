import { PHASES, STARTING_TROOPS, WAR_STAGES } from "../config.mjs";

const { SchemaField, StringField, NumberField, BooleanField, ArrayField, ObjectField, TypedObjectField } = foundry.data.fields;

const int = (initial = 0, extra = {}) => new NumberField({ required: true, nullable: false, integer: true, min: 0, initial, ...extra });
const str = () => new StringField({ required: true, blank: true });

/**
 * One game of Risk Legacy = one Combat document of type "war" ("The War", game N).
 *
 * Combatants are the participating factions (actorId = faction actor, no token), sorted by `initiative` so turn
 * order = seat order. `combat.combatant.actor` is the faction whose turn it is. Only the active GM writes to this
 * document (players request changes through GM actions, module/gm/actions.mjs).
 *
 * `turn` is reset at the start of every turn by the turn controller (module/turn/).
 *
 * `turn.flags` keys written by the turn controller (read by the rules engine, cards and battle areas):
 *   placedIn: string[]            territories recruited troops were placed in (cautious)
 *   stealthy: string              territory used by the stealthy power this turn
 *   lastAdvance: {from, to, kind} the last expansion/conquest: more troops may follow from `from` (not a maneuver)
 *   expansions: [{from, to, cost, city}]
 *   conquests: [{from, to, defender, city, seaLine}]   (mission checks)
 *   knockouts: [{faction, handCount}]                  (Forced Occupation)
 *   trade: {coins, effective, troops, cards: [{type, value, territory}]}   (Advanced Training/Tactics)
 *   startContinents: string[]     continents controlled at the start of the turn (Wide Border)
 *   deniedContinents: string[], deniedBy: {continent: factionId}           (Bad Intel)
 *   missilePowers: {factionId: powerKey}               missile power used this turn (once per turn)
 *   recon: boolean, interference: string[] (card ids)  resource-draw modifiers
 *   startOfTurn: [{source, territory, troops}]         automatic start-of-turn placements (khan_1)
 */
export default class WarData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["RL.War.Data"];

  /** A fresh per-turn record. */
  static freshTurn(factionId = "") {
    return {
      faction: factionId,
      recruited: false, recruitTotal: 0, joinedWar: false,
      starsBought: 0, tradedForTroops: false,
      conquered: 0, expanded: 0, expandedIntoCity: false,
      attacks: 0, firstAttackTarget: "", protected: [],
      maneuver: { done: false, from: "", to: "" },
      cardDrawn: false, missionCompleted: false, events: 0,
      flags: {}
    };
  }

  static defineSchema() {
    return {
      /** Game number in this world (campaign.system.nextGameNumber at creation). */
      game: int(1, { min: 1 }),
      stage: new StringField({ required: true, blank: false, initial: "setup", choices: WAR_STAGES }),
      /** Current turn step. */
      phase: new StringField({ required: true, blank: false, initial: "start", choices: Object.keys(PHASES) }),

      /** Faction actor ids in pick order (setup) and the index of the faction currently choosing. */
      placement: new SchemaField({
        order: new ArrayField(new StringField()),
        index: int(0)
      }),

      /** Per-turn bookkeeping, reset each turn. */
      turn: new SchemaField({
        faction: str(),
        recruited: new BooleanField(),
        recruitTotal: int(0),
        joinedWar: new BooleanField(),
        starsBought: int(0),
        tradedForTroops: new BooleanField(),
        /** Territories taken from an opponent this turn (enables drawing a resource card). */
        conquered: int(0),
        /** Expansions into unoccupied territories this turn. */
        expanded: int(0),
        expandedIntoCity: new BooleanField(),
        attacks: int(0),
        /** First territory attacked this turn (Enclave of the Bear power). */
        firstAttackTarget: str(),
        /** Territories that can't be attacked again this turn (Die Mechaniker power, events…). */
        protected: new ArrayField(new StringField()),
        maneuver: new SchemaField({
          done: new BooleanField(),
          from: str(),
          to: str()
        }),
        cardDrawn: new BooleanField(),
        missionCompleted: new BooleanField(),
        events: int(0),
        /** Free-form per-turn data for powers/events that need it. */
        flags: new ObjectField()
      }),

      /** The Coin-card pile has been depleted once this game (its Red Star was awarded or skipped on a tie). */
      coinPileDepleted: new BooleanField(),
      /** Faction ids eliminated this game, in order. */
      eliminated: new ArrayField(new StringField()),
      /** Chat message id of the battle in progress, if any. */
      battle: str(),
      /** Faction id of the winner once the war has ended. */
      winner: str(),
      /** Ongoing event effects in play (catalog event ids). */
      activeEvents: new ArrayField(new StringField()),

      /**
       * Starting troops per faction id (8, or the value of a draft card). Join the War places half of it.
       * Missing = STARTING_TROOPS.
       */
      startingTroops: new TypedObjectField(new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 8 })),

      /**
       * Protections that outlast the turn they were made in (e.g. Mass Hypnosis: "until the beginning of your next
       * turn"). Copied into `turn.protected` at the start of every turn until the start of `until`'s next turn.
       */
      protections: new ArrayField(new SchemaField({
        territory: str(),
        /** Faction id whose next turn start ends the protection. */
        until: str(),
        /** Power / scar / event id that granted it. */
        source: str()
      }))
    };
  }

  /** @returns {number} starting troops of a faction this war */
  startingTroopsOf(factionId) {
    return this.startingTroops?.[factionId] ?? STARTING_TROOPS;
  }

  /** @returns {boolean} the war is being played (turns are running) */
  get isPlaying() {
    return this.stage === "playing";
  }
}
