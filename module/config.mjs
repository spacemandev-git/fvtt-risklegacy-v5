/**
 * Static configuration for the Risk Legacy system.
 *
 * This file is the shared vocabulary of the whole system: every area (rules, canvas, cards, apps, campaign,
 * battle) imports its ids from here. Exposed at runtime as `CONFIG.RISKLEGACY` and `game.risklegacy.config`.
 *
 * Label values are localization keys; localize at render time.
 */

export const SYSTEM_ID = "fvtt-risklegacy-v5";

/** Root URL of this system's files (prefix for every asset/template path). */
export const SYSTEM_PATH = `systems/${SYSTEM_ID}`;

/** Build a full path to a file shipped with the system: `systemPath("assets/icons/star.png")`. */
export const systemPath = (relative) => relative?.startsWith("systems/") || relative?.includes("://")
  ? relative : `${SYSTEM_PATH}/${relative}`;

/* -------------------------------------------- */
/*  Board                                       */
/* -------------------------------------------- */

/** Board variants. Each has a definition file in data/boards/<id>.json (see ARCHITECTURE.md §Board definition). */
export const BOARD_VARIANTS = {
  original: { label: "RL.Board.original", file: "data/boards/original.json" },
  advanced: { label: "RL.Board.advanced", file: "data/boards/advanced.json" }
};

/** The 42 territory ids (identical on both boards; they are also the territory card ids). */
export const TERRITORY_IDS = [
  "alaska", "northwest_territory", "greenland", "alberta", "ontario", "eastern_canada", "western_united_states",
  "eastern_united_states", "central_america",
  "venezuela", "brazil", "peru", "argentina",
  "iceland", "scandinavia", "great_britain", "northern_europe", "western_europe", "southern_europe", "russia",
  "north_africa", "egypt", "east_africa", "central_africa", "south_africa", "madagascar",
  "middle_east", "afghanistan", "ural", "siberia", "yakutsk", "kamchatka", "irkutsk", "mongolia", "japan", "china",
  "india", "southeast_asia",
  "indonesia", "new_guinea", "western_australia", "eastern_australia"
];

/* -------------------------------------------- */
/*  Factions and pieces                         */
/* -------------------------------------------- */

/** Faction keys → accent colour (DESIGN.md §2 "Faction accents"). Pack factions are added from the content catalog. */
export const FACTIONS = {
  balkania: { label: "RL.Faction.balkania", color: "#6f38ad" },
  enclave: { label: "RL.Faction.enclave", color: "#17a838" },
  khan: { label: "RL.Faction.khan", color: "#5f6062" },
  mechaniker: { label: "RL.Faction.mechaniker", color: "#9a0b0c" },
  saharan: { label: "RL.Faction.saharan", color: "#c9b400" },
  mutants: { label: "RL.Faction.mutants", color: "#c8862a" },   // Pocket 1 (threemissiles)
  aliens: { label: "RL.Faction.aliens", color: "#2e76d0" }      // Pocket 2 (thirtytroops)
};

/**
 * Plastic pieces. A token's piece kind is stored in `token.flags[SYSTEM_ID].piece`.
 * `value` is how many troops the piece counts as; HQs count 0 troops (they are worth a Red Star to whoever controls
 * the territory they stand in). `scale` multiplies the board definition's `pieceSize`.
 */
export const PIECES = {
  troop: { label: "RL.Piece.troop", value: 1, scale: 1 },
  triple: { label: "RL.Piece.triple", value: 3, scale: 1.3 },
  hq: { label: "RL.Piece.hq", value: 0, scale: 1.4 }
};

/** Troops every faction starts with; Join the War gives half (rounded down). */
export const STARTING_TROOPS = 8;

/* -------------------------------------------- */
/*  Turn structure                              */
/* -------------------------------------------- */

/** Game-level stages of a war (Combat `system.stage`). */
export const WAR_STAGES = {
  setup: "RL.Stage.setup",           // choosing players/factions, dealing scars, laying out the sideboard
  placement: "RL.Stage.placement",   // factions choose starting territories in pick order
  playing: "RL.Stage.playing",       // normal turns
  ended: "RL.Stage.ended"            // someone won; end-of-game rewards pending/done
};

/** The five turn steps (Combat `system.phase`), in order. Labels are the rulebook's step names. */
export const PHASES = {
  start: { step: 1, label: "RL.Phase.start" },
  recruit: { step: 2, label: "RL.Phase.recruit" },     // "Join the War or Recruit Troops"
  attack: { step: 3, label: "RL.Phase.attack" },       // "Expand & Attack" (optional)
  maneuver: { step: 4, label: "RL.Phase.maneuver" },   // (optional)
  end: { step: 5, label: "RL.Phase.end" }
};
export const PHASE_ORDER = ["start", "recruit", "attack", "maneuver", "end"];

/** Faction status during a war (`faction.system.war.status`). */
export const FACTION_STATUS = {
  playing: "RL.Status.playing",
  knockedOut: "RL.Status.knockedOut",   // no troops on the board; may Join the War next turn
  eliminated: "RL.Status.eliminated"    // no legal starting territory when joining: out for the rest of the game
};

/** Results recorded on the back of a faction card. */
export const GAME_RESULTS = {
  won: "RL.Result.won",
  heldOn: "RL.Result.heldOn",
  eliminated: "RL.Result.eliminated",
  absent: "RL.Result.absent"            // the "X" for factions not chosen this game
};

/** Rules enforcement levels (world setting `enforcement`). */
export const ENFORCEMENT = {
  strict: "RL.Settings.enforcement.strict",       // illegal actions are blocked, with the reason
  advisory: "RL.Settings.enforcement.advisory",   // illegal actions warn but go through
  off: "RL.Settings.enforcement.off"              // free play; nothing is checked
};

/* -------------------------------------------- */
/*  Recruitment and trading                     */
/* -------------------------------------------- */

/** Coins turned in → troops (board chart). Keys are coin totals 2..10. */
export const TROOP_TRADE = { 2: 2, 3: 4, 4: 7, 5: 10, 6: 13, 7: 17, 8: 21, 9: 25, 10: 30 };

/** Resource cards (any) turned in for one Red Star token. */
export const CARDS_PER_RED_STAR = 4;

/** Red Stars needed to win. */
export const RED_STARS_TO_WIN = 4;

/** Minimum troops recruited from territories+population. */
export const MIN_RECRUIT = 3;

/** Maximum resource value of a territory card (and before the first game, 3). */
export const MAX_CARD_VALUE = 6;
export const MAX_CARD_VALUE_BEFORE_FIRST_GAME = 3;

/** The sideboard's face-up territory row has four slots. */
export const ROW_SLOTS = 4;

/* -------------------------------------------- */
/*  Marks (permanent board changes)             */
/* -------------------------------------------- */

/** City types and their population. */
export const CITY_TYPES = {
  minor: { label: "RL.City.minor", population: 1 },
  major: { label: "RL.City.major", population: 2 },
  capital: { label: "RL.City.capital", population: 5 }
};

/** Fortification: +1 to both defence dice; 10 boxes worn off by 3-troop attacks; +2 cost to expand into. */
export const FORTIFICATION_USES = 10;
export const FORTIFICATION_EXPAND_COST = 2;

/** Base-game board scars. Packs add more (their definitions come from the content catalog's `scars[].effect`). */
export const SCARS = {
  bunker: { label: "RL.Scar.bunker", effect: { type: "dieMod", side: "defender", die: "highest", delta: 1 } },
  ammo_shortage: { label: "RL.Scar.ammo_shortage", effect: { type: "dieMod", side: "defender", die: "highest", delta: -1 } }
};

/* -------------------------------------------- */
/*  Faction powers                              */
/* -------------------------------------------- */

/** Faction-card slots (DESIGN.md §2 "Power-slot colours"). `scar` is the white slot. */
export const POWER_SLOTS = {
  scar: { label: "RL.Power.scar", color: "#ffffff" },
  mission: { label: "RL.Power.mission", color: "#c23b40" },
  weakness: { label: "RL.Power.weakness", color: "#e3c34f" },
  missile: { label: "RL.Power.missile", color: "#d9781e" },
  knockout: { label: "RL.Power.knockout", color: "#2f9fd0" },
  starter: { label: "RL.Power.starter", color: "#8db540" },
  other: { label: "RL.Power.other", color: "#939598" }
};
export const POWER_SLOT_ORDER = ["scar", "mission", "weakness", "missile", "knockout", "starter"];

/* -------------------------------------------- */
/*  Stickers (sticker sheet inventory)          */
/* -------------------------------------------- */

/** Base sticker sheet. Packs add entries; the campaign actor tracks remaining counts in `system.stickers`. */
export const STICKERS = {
  coin_pregame: { label: "RL.Sticker.coin_pregame", qty: 12 },
  coin_heldon: { label: "RL.Sticker.coin_heldon", qty: 41 },
  minor_city: { label: "RL.Sticker.minor_city", qty: 9 },
  major_city: { label: "RL.Sticker.major_city", qty: 5 },
  fortification: { label: "RL.Sticker.fortification", qty: 5 },
  cancel_scar: { label: "RL.Sticker.cancel_scar", qty: 4 },
  continent_plus: { label: "RL.Sticker.continent_plus", qty: 1 },
  continent_minus: { label: "RL.Sticker.continent_minus", qty: 1 }
};

/* -------------------------------------------- */
/*  End of game                                 */
/* -------------------------------------------- */

/** Winner chooses one (only during the first 15 games). */
export const WINNER_REWARDS = {
  nameContinent: { label: "RL.Reward.nameContinent", hint: "RL.Reward.nameContinentHint" },
  foundMajorCity: { label: "RL.Reward.foundMajorCity", hint: "RL.Reward.foundMajorCityHint", sticker: "major_city" },
  cancelScar: { label: "RL.Reward.cancelScar", hint: "RL.Reward.cancelScarHint", sticker: "cancel_scar" },
  changeContinentBonus: { label: "RL.Reward.changeContinentBonus", hint: "RL.Reward.changeContinentBonusHint" },
  fortifyCity: { label: "RL.Reward.fortifyCity", hint: "RL.Reward.fortifyCityHint", sticker: "fortification" },
  destroyTerritoryCard: { label: "RL.Reward.destroyTerritoryCard", hint: "RL.Reward.destroyTerritoryCardHint" }
};

/** Each faction that held on chooses one, clockwise from the winner. */
export const HELDON_REWARDS = {
  foundMinorCity: { label: "RL.Reward.foundMinorCity", hint: "RL.Reward.foundMinorCityHint", sticker: "minor_city" },
  upgradeCard: { label: "RL.Reward.upgradeCard", hint: "RL.Reward.upgradeCardHint", sticker: "coin_heldon" }
};

/** Games in which winning/holding on changes the world; after this the world is "completed". */
export const LEGACY_GAMES = 15;

/* -------------------------------------------- */
/*  Packages                                    */
/* -------------------------------------------- */

/** Sealed packages, in rulebook order. Contents come from data/content/<id>.json. */
export const PACKS = {
  base: { label: "RL.Pack.base", trigger: "start", order: 0 },
  minorcities: { label: "RL.Pack.minorcities", trigger: "nineMinorCities", order: 1 },
  eliminated: { label: "RL.Pack.eliminated", trigger: "factionEliminated", order: 2 },
  secondwin: { label: "RL.Pack.secondwin", trigger: "secondSignature", order: 3 },
  worldcapital: { label: "RL.Pack.worldcapital", trigger: "worldCapitalPlaced", order: 4 },
  threemissiles: { label: "RL.Pack.threemissiles", trigger: "threeMissilesOneRoll", order: 5 },
  thirtytroops: { label: "RL.Pack.thirtytroops", trigger: "thirtyTroopsWithMissile", order: 6 }
};

/* -------------------------------------------- */
/*  Cards                                       */
/* -------------------------------------------- */

/**
 * Cards stacks the campaign creates, by role. The created document ids are stored in the campaign actor's
 * `system.documents[role]`; every stack also carries `flags[SYSTEM_ID].role`. Faction hands use role "hand" plus
 * `flags[SYSTEM_ID].faction = <faction actor id>`.
 */
export const CARD_STACKS = {
  territoryDeck: { type: "deck", label: "RL.Cards.territoryDeck" },   // DRAW
  coinDeck: { type: "deck", label: "RL.Cards.coinDeck" },             // the face-up Coin card pile
  row: { type: "pile", label: "RL.Cards.row" },                       // face-up territory slots 1–4 (card.system.slot)
  discard: { type: "pile", label: "RL.Cards.discard" },               // DISCARD
  scarDeck: { type: "deck", label: "RL.Cards.scarDeck" },
  missionDeck: { type: "deck", label: "RL.Cards.missionDeck" },
  missionSlot: { type: "pile", label: "RL.Cards.missionSlot" },       // MISSION
  eventDeck: { type: "deck", label: "RL.Cards.eventDeck" },           // EVENT
  eventDiscard: { type: "pile", label: "RL.Cards.eventDiscard" },     // resolved events kept in play
  draftDeck: { type: "deck", label: "RL.Cards.draftDeck" }
};

/** Other world documents the campaign creates, by role (ids also in `campaign.system.documents`). */
export const WORLD_DOCUMENTS = {
  scene: "Scene",
  rulebook: "JournalEntry",
  war: "Combat"
};

/* -------------------------------------------- */
/*  Aggregate                                   */
/* -------------------------------------------- */

export const RISKLEGACY = {
  id: SYSTEM_ID,
  path: SYSTEM_PATH,
  boards: BOARD_VARIANTS,
  territoryIds: TERRITORY_IDS,
  factions: FACTIONS,
  pieces: PIECES,
  startingTroops: STARTING_TROOPS,
  stages: WAR_STAGES,
  phases: PHASES,
  phaseOrder: PHASE_ORDER,
  factionStatus: FACTION_STATUS,
  gameResults: GAME_RESULTS,
  enforcement: ENFORCEMENT,
  troopTrade: TROOP_TRADE,
  cardsPerRedStar: CARDS_PER_RED_STAR,
  redStarsToWin: RED_STARS_TO_WIN,
  minRecruit: MIN_RECRUIT,
  maxCardValue: MAX_CARD_VALUE,
  rowSlots: ROW_SLOTS,
  cityTypes: CITY_TYPES,
  fortificationUses: FORTIFICATION_USES,
  fortificationExpandCost: FORTIFICATION_EXPAND_COST,
  scars: SCARS,
  powerSlots: POWER_SLOTS,
  powerSlotOrder: POWER_SLOT_ORDER,
  stickers: STICKERS,
  winnerRewards: WINNER_REWARDS,
  heldOnRewards: HELDON_REWARDS,
  legacyGames: LEGACY_GAMES,
  packs: PACKS,
  cardStacks: CARD_STACKS
};
