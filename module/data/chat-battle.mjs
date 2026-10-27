const { SchemaField, StringField, NumberField, BooleanField, ArrayField, ObjectField } = foundry.data.fields;

const str = () => new StringField({ required: true, blank: true });
const int = (initial = 0, extra = {}) => new NumberField({ required: true, nullable: false, integer: true, initial, ...extra });
const side = () => new StringField({ required: true, blank: false, initial: "attack", choices: ["attack", "defend"] });

/** One die in a battle. */
const dieSchema = () => new SchemaField({
  /** Position of the die in the original roll (stable id used to target it with a missile). */
  slot: int(0, { min: 0 }),
  /** The rolled value. */
  natural: int(1, { min: 1, max: 6 }),
  /** The value after modifiers and missiles (clamped to 1..6). */
  value: int(1, { min: 1, max: 6 }),
  /** Changed to an unmodifiable 6 by a missile. */
  missile: new BooleanField(),
  /** Faction actor id that fired the missile on this die. */
  missileBy: str(),
  /** Modifiers applied to this die, for display ("+1 Bunker", "-1 Ammo Shortage", "+1 Fortified"). */
  mods: new ArrayField(new SchemaField({
    source: str(),     // scar id, "fortification", power key, mark/event id…
    label: str(),      // localization key or literal name (localized at render time)
    delta: int(0)
  }))
});

/**
 * A battle (ChatMessage type "battle"): one combat roll between two territories, shown as an interactive chat card.
 * Owned by module/battle/. Lifecycle:
 *   declared (preRoll: waiting for the attacker to roll while reactions are possible)
 *     → awaitingDefender (defenderChoice = prompt) → rolled (missile window; `hold` blocks resolution)
 *     → resolved (follow-ups until `closed`) | cancelled
 * All writes happen on the active GM through the battle.* GM actions.
 */
export default class BattleData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["RL.Battle.Data"];

  static defineSchema() {
    return {
      attacker: str(),        // faction actor id
      defender: str(),        // faction actor id
      from: str(),            // territory id
      to: str(),              // territory id
      attackDice: int(1, { min: 1, max: 3 }),
      /** 0 while waiting for the defender's choice. */
      defendDice: int(0, { min: 0, max: 2 }),
      status: new StringField({
        required: true, blank: false, initial: "declared",
        choices: ["declared", "awaitingDefender", "rolled", "resolved", "cancelled"]
      }),
      /** Declared and waiting for the attacker's Roll (someone could react first: EMP, a scar card). */
      preRoll: new BooleanField(),
      /** Resolution is on hold (e.g. "threemissiles" while Pocket 1 is being opened). */
      hold: str(),
      /** Troops in the two territories when the battle was declared. */
      troops: new SchemaField({ attacker: int(0), defender: int(0) }),
      attack: new ArrayField(dieSchema()),
      defend: new ArrayField(dieSchema()),
      /** Modifier sources fixed when the dice were rolled (re-applied when a missile changes a die). */
      sources: new ArrayField(new SchemaField({
        source: str(), label: str(), side: side(),
        die: new StringField({ required: true, blank: false, initial: "highest" }),
        delta: int(0)
      })),
      /** Whole-battle rules (see modifiers.mjs emptyRules). */
      rules: new SchemaField({
        winTies: new ArrayField(new SchemaField({ side: side(), value: int(6, { min: 1, max: 6 }) })),
        conquerOnNaturalTriple: new BooleanField(),
        protectOnDoubleSix: new BooleanField(),
        cloneOnNaturalDoubles: new BooleanField(),
        rerollOnes: new BooleanField(),
        unmodifiable: new ArrayField(new StringField()),
        fortified: new BooleanField(),
        fortifiedBy: str()
      }),
      /** Missiles fired on this roll, in order. `index` is the die's `slot`. */
      missiles: new ArrayField(new SchemaField({
        by: str(),            // faction actor id
        userId: str(),
        side: side(),
        index: int(0)
      })),
      result: new SchemaField({
        attackerLosses: int(0),
        defenderLosses: int(0),
        conquered: new BooleanField(),
        /** Enclave of the Bear (natural three of a kind): every defender was removed. */
        conqueredAll: new BooleanField(),
        /** Troops moved into the conquered territory (attacking survivors + extra moves). */
        movedIn: int(0),
        /** The extra "move more in" step has been used. */
        moveInDone: new BooleanField(),
        /** Troops lost to an enterLoss effect (Fallout Zone). */
        enterLosses: int(0),
        /** Fortification boxes marked off by this battle (3-troop attacks; several in a blitz). */
        fortificationWorn: int(0, { min: 0 }),
        /** Die Mechaniker: the territory can't be attacked again this turn. */
        protected: new BooleanField(),
        /** Mutants (unstable cloning): a defending troop was added. */
        cloned: new BooleanField(),
        /** Attacker troops left in `from` / defender (or, after a conquest, attacker) troops in `to`. */
        fromLeft: int(0),
        toLeft: int(0),
        pairs: new ArrayField(new SchemaField({ attack: int(0), defend: int(0), winner: side() }))
      }),
      /** Rules notes shown on the card: localization key + format data. */
      notes: new ArrayField(new SchemaField({ key: str(), data: new ObjectField() })),
      /** Consecutive battle number between the same territories this turn (1, 2, …). */
      round: int(1, { min: 1 }),
      /** Follow-up controls are gone (Stop, Attack again, a newer battle, or cancelled). */
      closed: new BooleanField(),
      /** Blitz: rounds rolled automatically on this card (the last one is shown as dice). */
      blitz: new SchemaField({
        active: new BooleanField(),
        stopAt: int(1, { min: 1 }),
        rounds: new ArrayField(new SchemaField({
          attack: new ArrayField(new NumberField({ integer: true })),
          defend: new ArrayField(new NumberField({ integer: true })),
          attackerLosses: int(0),
          defenderLosses: int(0)
        }))
      })
    };
  }

  /** Has the battle been decided? */
  get isOver() {
    return ["resolved", "cancelled"].includes(this.status);
  }

  /** Is the battle still waiting for something before it can be resolved? */
  get isOpen() {
    return !this.isOver;
  }
}
