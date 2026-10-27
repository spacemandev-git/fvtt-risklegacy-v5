import { BOARD_VARIANTS, CITY_TYPES, FORTIFICATION_USES, GAME_RESULTS, LEGACY_GAMES } from "../config.mjs";

const {
  SchemaField, StringField, NumberField, BooleanField, ArrayField, TypedObjectField, HTMLField
} = foundry.data.fields;

const int = (initial = 0, extra = {}) => new NumberField({ required: true, nullable: false, integer: true, initial, ...extra });
const str = (extra = {}) => new StringField({ required: true, blank: true, ...extra });

/**
 * The Campaign (Actor type "campaign"): the physical game board and everything written on it that persists
 * between games. There is exactly one per world; its id is stored in the world setting `campaignActorId`.
 *
 * Keyed collections use TypedObjectField so a single territory/continent can be updated with a dotted path:
 *   campaign.update({"system.territories.egypt.city.type": "minor"})
 */
export default class CampaignData extends foundry.abstract.TypeDataModel {
  static LOCALIZATION_PREFIXES = ["RL.Campaign.Data"];

  static defineSchema() {
    return {
      /** Which board definition this world plays on (data/boards/<id>.json). Chosen when the campaign is created. */
      boardVariant: new StringField({ required: true, blank: false, initial: "original", choices: Object.keys(BOARD_VARIANTS) }),
      /** "The World Of ___", named after the 15th game. */
      worldName: str(),
      /** Who named the world (player name as written, and User id). */
      worldNamedBy: str(),
      worldNamedById: str(),
      /** The signatures on the inside of the box lid ("We, the undersigned…") and the date the wars started. */
      founding: new SchemaField({
        date: str(),
        signatures: new ArrayField(new StringField())
      }),
      /** "Before your first game" customization (starting powers chosen, 12 coin stickers placed) is done. */
      firstGameReady: new BooleanField(),

      /** One entry per completed game (the victors' section is derived from it: entries with `signed`). */
      games: new ArrayField(new SchemaField({
        number: int(1, { min: 1 }),
        date: str(),
        winner: new SchemaField({
          faction: str(),          // faction actor id
          factionName: str(),
          player: str(),           // name as signed
          playerId: str(),         // User id, if known
          motto: str()             // "slogans, comments, mottos, or trash talk"
        }),
        /** Winner signed the victors' section (first 15 games). */
        signed: new BooleanField(),
        /** Winner's reward key (WINNER_REWARDS) and a human-readable description of what was done. */
        reward: str(),
        rewardDetail: str(),
        results: new ArrayField(new SchemaField({
          faction: str(),
          factionName: str(),
          player: str(),
          playerId: str(),
          startingTerritory: str(),
          result: new StringField({ required: true, blank: true, choices: { "": "", ...GAME_RESULTS } }),
          reward: str(),           // held-on reward key (HELDON_REWARDS) or ""
          rewardDetail: str()
        }))
      })),

      /** Permanent marks per territory id. Missing keys mean "unmarked". */
      territories: new TypedObjectField(new SchemaField({
        city: new SchemaField({
          type: new StringField({ required: true, blank: true, choices: { "": "", ...Object.fromEntries(Object.keys(CITY_TYPES).map(k => [k, CITY_TYPES[k].label])) } }),
          name: str(),
          founder: str(),          // player name written on the sticker ("you may put your initials here")
          founderId: str(),        // User id; a Major City is a legal starting territory for its founder only
          game: int(0)
        }),
        fortification: new SchemaField({
          active: new BooleanField(),
          /** Boxes marked off (0..10). At FORTIFICATION_USES the city is no longer fortified. */
          used: int(0, { min: 0, max: FORTIFICATION_USES })
        }),
        /** Board scar id (bunker, ammo_shortage, … from the content catalog) or "". */
        scar: str(),
        scarGame: int(0),
        /** "Destroy a Territory Card" reward: the small "x" next to the name on the board. */
        cardDestroyed: new BooleanField(),
        /** Pack-specific marks (biohazard, mercenary, fallout, ruins, …), ids from the content catalog. */
        marks: new ArrayField(new StringField())
      })),

      /** Per continent id of the campaign's board variant. */
      continents: new TypedObjectField(new SchemaField({
        name: str(),
        namedBy: str(),            // player name
        namedById: str(),          // User id: that player gets +1 troop for controlling it
        /** +1/-1 continent mark (a continent can only be changed once). */
        modifier: new NumberField({ required: true, nullable: false, integer: true, min: -1, max: 1, initial: 0 }),
        game: int(0)
      })),

      /** Remaining stickers by sticker id (STICKERS + pack additions). */
      stickers: new TypedObjectField(new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 })),

      /** Opened packages by pack id. */
      packs: new TypedObjectField(new SchemaField({
        opened: new BooleanField(),
        game: int(0),
        date: str()
      })),

      /**
       * Territory-card facts that must survive a deck rebuild (written by the cards area): current resource value
       * per territory id (pre-game coins and upgrades), and permanently removed catalog cards as
       * "<type>:<catalogId>" → count (played scars, destroyed missions/events). Destroyed territory cards are
       * `territories.<id>.cardDestroyed`.
       */
      cards: new SchemaField({
        values: new TypedObjectField(new NumberField({ required: true, nullable: false, integer: true, min: 1, max: 6, initial: 1 })),
        removed: new TypedObjectField(new NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }))
      }),

      /** Rulebook bracket letter (A–N) → content catalog rule id of the sticker placed there. */
      rulesAdditions: new TypedObjectField(new StringField()),

      /**
       * Reference stickers placed in the empty reference-sticker spaces along the top of the board (catalog rule ids
       * of `kind: "reference"`, e.g. biohazard_reference), in the order they were placed: the first one goes in the
       * first empty space of `board.furniture.referenceStickers` (those with `printed: null`), and so on.
       */
      referenceStickers: new ArrayField(new StringField()),

      /**
       * Sea-line start stickers connected in pen (Explore the World mission, Alien Island): new connections. They are
       * merged into the campaign board's adjacency (state/boards.mjs `augmentBoard`), so every rule sees them.
       */
      seaLines: new ArrayField(new SchemaField({
        a: str(),
        b: str(),
        /** Sticker id used (sea_line_start, alien_island_sea_line_start). */
        sticker: str(),
        game: int(0),
        /** The pen line's two ends in scene px [[xa, ya], [xb, yb]] (the start stickers). Empty = computed. */
        points: new ArrayField(new ArrayField(new NumberField({ required: true, nullable: false, integer: true })))
      })),

      /**
       * Territories added to the board during the campaign, by territory id (e.g. "alien_island": the Alien Island
       * sticker placed on an ocean). They become real territories of the campaign board: a round sticker at (x, y)
       * with the given radius, connected only through `seaLines`.
       */
      customTerritories: new TypedObjectField(new SchemaField({
        name: str(),
        /** What it is (e.g. "alien_island"); the board overlay picks its sticker art from this. */
        kind: str(),
        x: int(0),
        y: int(0),
        radius: int(150, { min: 40 }),
        /** Continent id, or "" (Alien Island is not part of any continent). */
        continent: str(),
        game: int(0),
        by: str()
      })),

      /** Ids of world documents created for this campaign, by role (CARD_STACKS keys, "scene", "rulebook", "war"). */
      documents: new TypedObjectField(new StringField()),

      /** The world's chronicle: every permanent change, in order (shown on the campaign sheet). */
      log: new ArrayField(new SchemaField({
        game: int(0),
        date: str(),
        kind: str(),               // e.g. "city", "scar", "continent", "card", "pack", "victory", "power"
        text: str()
      })),

      notes: new HTMLField()
    };
  }

  /** Number of games completed in this world. */
  get gamesPlayed() {
    return this.games.length;
  }

  /** The game number of the next/current game. */
  get nextGameNumber() {
    return this.games.length + 1;
  }

  /** Victors' section rows (games whose winner signed the board). */
  get victors() {
    return this.games.filter(g => g.signed);
  }

  /**
   * How many times a player has signed the board. Players start each game with that many Missiles (or a Red Star
   * token if they have never signed).
   * @param {string} playerId  User id
   * @param {string} [playerName]  Fallback match by name for signatures recorded without a user id
   */
  signaturesOf(playerId, playerName) {
    return this.victors.filter(g => (playerId && g.winner.playerId === playerId)
      || (!g.winner.playerId && playerName && g.winner.player === playerName)).length;
  }

  /** Is the pack opened? */
  isPackOpen(packId) {
    return !!this.packs[packId]?.opened;
  }

  /**
   * Number of cities of a type on the board.
   * @param {string} [type]  "minor" | "major" | "capital"; omit for all cities
   */
  cityCount(type) {
    return Object.values(this.territories).filter(t => t.city?.type && (!type || (t.city.type === type))).length;
  }

  /** Stickers of this id still on the sticker sheet. */
  stickersLeft(id) {
    return this.stickers[id] ?? 0;
  }

  /** The first 15 games are over: winning and holding on no longer change the world. */
  get isComplete() {
    return this.games.length >= LEGACY_GAMES;
  }

  /** Signature totals per player (victors' section), most first: [{playerId, player, count}]. */
  get signatureTotals() {
    const totals = new Map();
    for ( const g of this.victors ) {
      const key = g.winner.playerId || `name:${g.winner.player}`;
      const entry = totals.get(key) ?? { playerId: g.winner.playerId, player: g.winner.player, count: 0 };
      entry.count += 1;
      entry.player = g.winner.player || entry.player;
      totals.set(key, entry);
    }
    return [...totals.values()].sort((a, b) => b.count - a.count);
  }
}
