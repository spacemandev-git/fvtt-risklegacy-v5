/**
 * BotContext gathering (BOTS.md §6.5, BOTS-LLM.md §7): the snapshot plus the public facts it lacks. Public information
 * only: the bot's own hand and scar cards, the revealed row, mission and events, everyone's hand counts and coin
 * totals, who sits where (bots by their bot name, people by user id only), the campaign's public record and what
 * happened recently. Never the deck order, the event or mission deck order, other players' scar cards, or a person's
 * name.
 *
 * `ctx.bot = {engine, model, personality, memory, userId}` describes the bot itself (users.mjs); the Jev brain ignores
 * it, the chat-model brain reads its personality, model and memory.
 */
import { HELDON_REWARDS, LEGACY_GAMES, PACKS, SYSTEM_ID, WINNER_REWARDS } from "../../config.mjs";
import { personalityById } from "../llm/personalities.mjs";
import { botInfo, difficultyLabel } from "../users.mjs";
import { recentFor } from "./recent.mjs";
import { RL, getWar, plain, snapshot, territoryName } from "./util.mjs";

/** Run a getter; a missing deck or area must not break the context. */
function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch(err) {
    return fallback;
  }
}

const coinsOf = card => Number(card.system?.coins ?? (card.type === "coin" ? 1 : card.system?.value ?? 0)) || 0;

/** Own resource cards. */
function handOf(fid) {
  return safe(() => RL().cards.getResourceCards(fid).map(c => ({
    id: c.id, kind: c.type === "coin" ? "coin" : "territory", territory: c.system?.territory || null, coins: coinsOf(c)
  })), []);
}

/** Own scar cards, with their catalog name, text and play timing. */
export function scarCardsOf(fid) {
  if ( !fid ) return [];
  return safe(() => RL().cards.getScarCards(fid).map(c => {
    const scar = c.system?.scar || c.system?.catalogId || "";
    const entry = RL().state.findEntry("scars", scar);
    const play = entry?.play ?? c.getFlag?.(SYSTEM_ID, "play") ?? {};
    return {
      id: c.id, scar, name: entry?.name ?? c.name, text: entry?.text ?? c.system?.text ?? "",
      target: c.system?.target || entry?.target || "territory", timing: play.timing ?? "", where: play.where ?? ""
    };
  }), []);
}

/** cards.missionStatus without the Card document, plus `complete` (the check is met and it may be claimed now). */
function missionStatusOf(fid) {
  const ms = safe(() => RL().cards.missionStatus(fid), null);
  if ( !ms ) return null;
  const { mission, ...rest } = ms;
  return { ...plain(rest), complete: (ms.status === "complete") && !!ms.canComplete };
}

function powersByFaction(state) {
  const out = {};
  const ids = Object.keys(state?.factions ?? {}).filter(id => state.factions[id].active);
  for ( const id of ids ) {
    const actor = game.actors.get(id);
    out[id] = (actor?.items ?? []).filter(i => i.type === "power").map(i => ({
      key: i.system.key, name: i.name, text: i.system.text ?? "", timing: i.system.timing ?? "", used: !!i.system.used
    }));
  }
  return out;
}

/**
 * The public view (BotView in brain/index.mjs), plus for the chat-model bots (BOTS-LLM.md §7):
 * - `seats`: {factionId: {user, bot, botName, personality}};
 * - `campaign`: campaignView() below (null without a campaign);
 * - `recent`: [{type, by, text, round}], public events since this faction's last turn started (recent.mjs).
 * @param {string|null} fid
 * @param {object|null} state
 * @param {string|null} [botUserId]  the bot's own user id (to tell its own wins, cities and continents)
 */
export function buildView(fid, state, botUserId = null) {
  const war = getWar();
  const hands = {};
  const factionNames = {};
  for ( const f of Object.values(state?.factions ?? {}) ) {
    factionNames[f.id] = f.name;
    if ( f.active ) hands[f.id] = { count: f.hand?.count ?? 0, coins: f.hand?.coins ?? 0 };
  }
  const mission = safe(() => {
    const m = RL().cards.currentMission();
    return m ? { name: m.name, text: m.system?.text ?? "", reward: String(m.system?.reward ?? "") } : null;
  }, null);
  return {
    hand: fid ? handOf(fid) : [],
    hands,
    scarCards: scarCardsOf(fid),
    row: safe(() => RL().cards.getRow().map(c => ({
      cardId: c.id, territory: c.system?.territory ?? null, slot: c.system?.slot ?? 0, coins: coinsOf(c)
    })), []),
    coinCount: safe(() => RL().cards.coinCount(), 0),
    mission,
    missionStatus: fid ? missionStatusOf(fid) : null,
    drawOptions: fid ? safe(() => plain(RL().cards.drawOptions(fid)), null) : null,
    powers: safe(() => powersByFaction(state), {}),
    activeEvents: safe(() => (war?.system.activeEvents ?? []).map(id => {
      const e = RL().state.findEntry("events", id);
      return { id, name: e?.name ?? id, text: e?.text ?? "" };
    }), []),
    protections: safe(() => plain(war?.system.protections ?? []), []),
    factionNames,
    round: war?.round ?? 0,
    game: war?.system.game ?? state?.campaign?.nextGame ?? 0,
    seats: safe(() => seatsView(state), {}),
    campaign: safe(() => campaignView(fid, botUserId, state), null),
    recent: safe(() => recentFor(fid, state), [])
  };
}

/* -------------------------------------------- */
/*  Seats, campaign                             */
/* -------------------------------------------- */

/** A bot's table name: its personality's name (chat bots) or "Jev <level>"; never a user-chosen name. */
export function botName(info) {
  if ( !info ) return null;
  if ( info.engine === "llm" ) return personalityById(info.personality)?.name ?? "Chat bot";
  return game.i18n.format("RL.Bots.DefaultName", { difficulty: difficultyLabel(info.difficulty) });
}

/**
 * Who plays each faction in the war: `{factionId: {user, bot, botName, personality}}`. `botName` only for bots.
 * @param {object} state
 */
export function seatsView(state) {
  const out = {};
  for ( const f of Object.values(state?.factions ?? {}) ) {
    if ( !f.active ) continue;
    const info = f.playerId ? botInfo(f.playerId) : null;
    out[f.id] = { user: f.playerId || null, bot: !!info, botName: info ? botName(info) : null, personality: info?.personality ?? null };
  }
  return out;
}

const loc = key => game.i18n.localize(key);

/**
 * Public campaign facts from the Campaign actor and the faction cards (module/data/actor-campaign.mjs,
 * actor-faction.mjs; rewards from config.mjs WINNER_REWARDS/HELDON_REWARDS; starting missiles and Red Star tokens from
 * turn/war.mjs createWar). No player names: winners and founders by user id, compared with the bot's own.
 * @param {string|null} fid       the bot's faction
 * @param {string|null} me        the bot's user id
 * @param {object} state
 */
export function campaignView(fid, me, state) {
  const campaign = RL().state.getCampaign();
  if ( !campaign ) return null;
  const sys = campaign.system;
  const war = getWar();
  const gameNo = war?.system.game ?? sys.nextGameNumber;
  const legacy = gameNo <= LEGACY_GAMES;
  const factionName = (id, fallback = "") => game.actors.get(id)?.name ?? state?.factions?.[id]?.name ?? fallback;
  const victors = (sys.games ?? []).filter(g => (g.number < gameNo) && (g.winner?.faction || g.winner?.factionName)).map(g => {
    const name = g.winner.factionName || factionName(g.winner.faction);
    const wasMe = !!me && (g.winner.playerId === me);
    return {
      game: g.number, faction: name, factionName: name, user: g.winner.playerId || null, wasMe,
      reward: g.rewardDetail || g.reward || "", text: `Game ${g.number}: ${name} won${wasMe ? " (you)" : ""}`
    };
  });
  const wins = {};
  for ( const v of victors ) if ( v.user ) wins[v.user] = (wins[v.user] ?? 0) + 1;
  const signatures = me ? sys.signaturesOf(me) : 0;
  const actor = fid ? game.actors.get(fid) : null;
  const RESULT = { won: "won", heldOn: "held on", eliminated: "was eliminated", absent: "sat out" };
  const faction = actor ? {
    name: actor.name,
    record: plain(actor.system.record),
    history: (actor.system.history ?? []).map(h => {
      const start = h.startingTerritory ? territoryName(h.startingTerritory) : "";
      return { game: h.game, result: h.result || "", start, text: `Game ${h.game}: ${actor.name} ${RESULT[h.result] ?? "played"}${start ? `, starting in ${start}` : ""}` };
    }),
    powers: actor.items.filter(i => i.type === "power").map(i => ({
      name: i.name, slot: i.system.slot ?? "", text: `${i.name}${i.system.slot === "weakness" ? " (weakness)" : ""}: ${String(i.system.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`
    }))
  } : null;
  const scars = [];
  const cities = [];
  const destroyedCards = [];
  for ( const [id, t] of Object.entries(sys.territories ?? {}) ) {
    if ( t.scar ) {
      const scar = RL().state.findEntry("scars", t.scar)?.name ?? t.scar;
      scars.push({ territory: id, name: territoryName(id), scar, game: t.scarGame || null, text: `${scar} scar on ${territoryName(id)}` });
    }
    if ( t.city?.type ) {
      const mine = !!me && (t.city.founderId === me);
      const name = t.city.name || territoryName(id);
      cities.push({
        territory: id, name, type: t.city.type, game: t.city.game || null, founder: t.city.founderId || null, mine,
        fortified: !!t.fortification?.active,
        text: `${t.city.type === "major" ? "Major city" : t.city.type === "capital" ? "World capital" : "Minor city"} ${name}${name !== territoryName(id) ? ` in ${territoryName(id)}` : ""}${mine ? " (founded by you)" : ""}${t.fortification?.active ? ", fortified" : ""}`
      });
    }
    if ( t.cardDestroyed ) destroyedCards.push(territoryName(id));
  }
  const board = RL().state.getCampaignBoard?.();
  const continents = Object.entries(sys.continents ?? {}).filter(([, c]) => c.name || c.modifier).map(([id, c]) => {
    const label = board?.continents?.[id]?.label ?? id;
    const mine = !!me && (c.namedById === me);
    const bits = [c.name ? `${label} is named "${c.name}"${mine ? " by you (+1 troop for you while you hold it)" : ""}` : label];
    if ( c.modifier ) bits.push(`bonus ${c.modifier > 0 ? "+1" : "-1"}`);
    return { id, label, name: c.name || null, namedBy: c.namedById || null, mine, modifier: c.modifier || 0, text: bits.join(", ") };
  });
  const packs = Object.entries(sys.packs ?? {}).filter(([, p]) => p.opened).map(([id, p]) => ({ id, name: PACKS[id] ? loc(PACKS[id].label) : id, game: p.game || null }));
  const rewardList = table => Object.values(table).map(r => loc(r.label));
  const stakes = legacy ? {
    winner: rewardList(WINNER_REWARDS), heldOn: rewardList(HELDON_REWARDS),
    signature: "The winner signs the board: in every later game each signature is one Missile at the start (a player who never signed starts with a Red Star token instead)."
  } : null;
  return {
    game: gameNo, totalGames: LEGACY_GAMES, gamesPlayed: sys.gamesPlayed, board: sys.boardVariant, worldName: sys.worldName || null,
    legacy, victors, wins, myWins: me ? (wins[me] ?? 0) : 0, mySignatures: signatures,
    faction, history: faction?.history ?? [], powers: faction?.powers ?? [],
    scars, cities, continents, packs, destroyedCards, stakes,
    /** The same stakes as lines. */
    rewards: stakes ? [
      `The winner of this game picks one: ${stakes.winner.join("; ")}.`,
      `Each faction that held on (still on the board, not the winner) picks one: ${stakes.heldOn.join("; ")}.`,
      "Eliminated factions get nothing.",
      stakes.signature
    ] : ["The 15 legacy games are over: winning no longer changes the world."]
  };
}

/** `ctx.bot` from a User, a botOfFaction() result or a botInfo()-like object. */
export function botOf(bot) {
  if ( !bot ) return null;
  const user = (bot instanceof foundry.documents.BaseUser) ? bot : (bot.user ?? (bot.userId ? game.users.get(bot.userId) : null));
  const info = user ? botInfo(user) : (bot.engine ? bot : null);
  if ( !info ) return null;
  return {
    engine: info.engine ?? "jev",
    model: info.model ?? null,
    personality: personalityById(info.personality) ?? null,
    memory: info.memory ?? null,
    userId: user?.id ?? bot.userId ?? null
  };
}

/**
 * A fresh BotContext for one faction (or none: faction picks before the bot has one).
 * `ask` / `chat` are set by the decision runner; `situation`/`excluded` by the turn loop.
 * @param {string|null} fid
 * @param {{difficulty?: string, bot?: User|object|null}} [options]  `bot`: the bot user (or botOfFaction() result),
 *   which sets `ctx.bot`; `difficulty` defaults to the bot's
 */
export function buildContext(fid, { difficulty, bot = null } = {}) {
  const state = snapshot();
  const me = botOf(bot);
  return {
    me: fid || null,
    difficulty: difficulty ?? (me?.userId ? botInfo(me.userId)?.difficulty : null) ?? "normal",
    state,
    view: buildView(fid || null, state, me?.userId ?? null),
    lookup: (category, id) => RL().state.findEntry(category, id),
    ask: null,
    chat: null,
    bot: me,
    random: Math.random,
    excluded: new Set()
  };
}

/** A battle message as plain data for the brain. */
export function battleData(message) {
  if ( !message ) return null;
  return { id: message.id, ...plain(message.system.toObject()) };
}
