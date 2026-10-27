/**
 * Bot players are ordinary Foundry Users that never log in, flagged
 * `flags[SYSTEM_ID].bot = {difficulty, engine, model, personality, memory}` (BOTS-LLM.md §3).
 * `engine` is "jev" (TypeSafe's decision model, BOTS.md) or "llm" (a chat model with a personality, BOTS-LLM.md);
 * bots created before chat models existed have no engine and are Jev bots.
 * Being real Users lets them sit in the game-setup wizard, sign the board, found cities and name continents like any
 * player (those legacy records are keyed by User id). They get a random password so nobody can join as them.
 */
import { SYSTEM_ID } from "../config.mjs";
import { PERSONALITIES, personalityById } from "./llm/personalities.mjs";

export const DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);
export const ENGINES = Object.freeze(["jev", "llm"]);
const AVATAR = "icons/svg/clockwork.svg";

const userOf = u => (typeof u === "string" ? game.users.get(u) : u) ?? null;

/**
 * @typedef {object} BotMemory   What a chat-model bot remembers between games (written by its debrief, BOTS-LLM.md §6)
 * @property {string} notes                                   its own notes, at most ~120 words
 * @property {{user:string, text:string, game:number}[]} grudges   keyed by the other player's User id (never a name)
 * @property {string[]} lessons                               short strategy lessons, newest first (at most 6)
 * @property {{game:number, faction:string, result:string, summary:string}[]} games   one line per game played
 * @property {number} updated                                 the game number of the last debrief
 */

/**
 * @returns {{difficulty: "easy"|"normal"|"hard", engine: "jev"|"llm", model: string|null, personality: string|null,
 *   memory: BotMemory|null}|null}  `model` null = the world default (setting bots.llmModel)
 */
export function botInfo(userOrId) {
  const bot = userOf(userOrId)?.flags?.[SYSTEM_ID]?.bot;
  if ( !bot ) return null;
  const engine = ENGINES.includes(bot.engine) ? bot.engine : "jev";
  return {
    difficulty: DIFFICULTIES.includes(bot.difficulty) ? bot.difficulty : "normal",
    engine,
    model: (engine === "llm") && bot.model ? String(bot.model) : null,
    personality: (engine === "llm") ? (personalityById(bot.personality)?.id ?? null) : null,
    memory: (engine === "llm") && bot.memory ? bot.memory : null
  };
}

export const botEngine = userOrId => botInfo(userOrId)?.engine ?? null;
/** The personality object of a chat-model bot (module/bots/llm/personalities.mjs), or null. */
export const botPersonality = userOrId => personalityById(botInfo(userOrId)?.personality) ?? null;

export const isBotUser = userOrId => !!botInfo(userOrId);
export const botDifficulty = userOrId => botInfo(userOrId)?.difficulty ?? null;
export const botUsers = () => game.users.filter(u => isBotUser(u));

/**
 * The bot playing a faction in the current war, from `faction.system.war.playerId`.
 * @param {Actor|string} factionOrId
 * @returns {{user: User, difficulty: string, engine: string, model: string|null, personality: string|null,
 *   memory: BotMemory|null}|null}
 */
export function botOfFaction(factionOrId) {
  const faction = typeof factionOrId === "string" ? game.actors.get(factionOrId) : factionOrId;
  const user = game.users.get(faction?.system?.war?.playerId ?? "");
  const info = botInfo(user);
  return info ? { user, ...info } : null;
}

export const isBotFaction = factionOrId => !!botOfFaction(factionOrId);

export const difficultyLabel = d => game.i18n.localize(`RL.Bots.Difficulty.${d}`);

/** "BOT · Warlord" (a Jev bot) or "BOT · Warlord · The Unbreached" (a chat bot): the tag next to its factions and seats. */
export const botTag = userOrId => {
  const d = botDifficulty(userOrId);
  if ( !d ) return "";
  const title = botPersonality(userOrId)?.title;
  const difficulty = difficultyLabel(d);
  return title ? game.i18n.format("RL.Bots.TagTitle", { difficulty, title }) : game.i18n.format("RL.Bots.Tag", { difficulty });
};

/**
 * The faction a user plays in the current war, if that war hasn't ended (a bot can't be removed meanwhile).
 * @param {User|string} userOrId
 * @returns {Actor|null}
 */
export function seatedFaction(userOrId) {
  const user = userOf(userOrId);
  if ( !user ) return null;
  const faction = game.actors.find(a => (a.type === "faction") && a.system.war?.active && (a.system.war.playerId === user.id));
  const war = game.risklegacy?.state?.getWar?.();
  return (faction && war && (war.system.stage !== "ended")) ? faction : null;
}

/** A free user name: `base`, else "base 2", "base 3"... */
function freeName(base) {
  if ( !game.users.getName(base) ) return base;
  for ( let n = 2; ; n++ ) if ( !game.users.getName(`${base} ${n}`) ) return `${base} ${n}`;
}

/** A free default name such as "Jev Commander" or "Jev Commander 2". */
export function defaultBotName(difficulty) {
  return freeName(game.i18n.format("RL.Bots.DefaultName", { difficulty: difficultyLabel(difficulty) }));
}

/** Personality ids already used by chat-model bots (optionally ignoring one user). */
export function usedPersonalities({ except = null } = {}) {
  const ex = userOf(except);
  return new Set(botUsers().filter(u => u !== ex).map(u => botInfo(u).personality).filter(Boolean));
}

/**
 * A personality id for "random": an unused one if any, else any. `exclude` = ids to avoid too.
 * @param {{except?: User|string, exclude?: Iterable<string>, random?: () => number}} [options]
 */
export function randomPersonality({ except = null, exclude = [], random = Math.random } = {}) {
  const avoid = new Set([...usedPersonalities({ except }), ...exclude]);
  const free = PERSONALITIES.filter(p => !avoid.has(p.id));
  const pool = free.length ? free : PERSONALITIES;
  return pool[Math.floor(random() * pool.length)]?.id ?? null;
}

/** Resolve a personality argument ("random", an id, or null) to an id. */
function resolvePersonality(personality, options) {
  if ( !personality || (personality === "random") ) return randomPersonality(options);
  if ( !personalityById(personality) ) throw new Error(`Unknown bot personality "${personality}"`);
  return personality;
}

/**
 * [GM] Create a bot player.
 * @param {object} [options]
 * @param {"easy"|"normal"|"hard"} [options.difficulty]
 * @param {string} [options.name]            default: the personality's name (chat bots) or "Jev <level>"
 * @param {"jev"|"llm"} [options.engine]
 * @param {string|null} [options.model]       chat bots: a model id, or null for the world default
 * @param {string|null} [options.personality] chat bots: an id, "random" or null (= random unused)
 */
export async function createBot({ difficulty = "normal", name, engine = "jev", model = null, personality = null } = {}) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("RL.Bots.Error.gmOnly"));
  if ( !DIFFICULTIES.includes(difficulty) ) throw new Error(`Unknown bot difficulty "${difficulty}"`);
  if ( !ENGINES.includes(engine) ) throw new Error(`Unknown bot engine "${engine}"`);
  const bot = { difficulty, engine };
  let base = null;
  let avatar = AVATAR;
  if ( engine === "llm" ) {
    bot.personality = resolvePersonality(personality);
    bot.model = model || null;
    bot.memory = null;
    const p = personalityById(bot.personality);
    base = p?.name ?? null;
    avatar = p?.portrait || AVATAR;
  }
  return User.create({
    name: name?.trim() || (base ? freeName(base) : defaultBotName(difficulty)),
    role: CONST.USER_ROLES.PLAYER,
    password: foundry.utils.randomID(32),
    avatar,
    flags: { [SYSTEM_ID]: { bot } }
  });
}

/** [GM] Change a bot's difficulty (takes effect from its next decision). */
export async function setBotDifficulty(userOrId, difficulty) {
  return setBotConfig(userOrId, { difficulty });
}

/**
 * [GM] Change a bot's settings (each takes effect from its next decision).
 * Changing a chat bot's personality also renames it and changes its avatar when `rename` is true and its name/avatar
 * are still the old personality's.
 * @param {User|string} userOrId
 * @param {{difficulty?:string, engine?:string, model?:string|null, personality?:string|null}} patch
 * @param {{rename?: boolean}} [options]
 */
export async function setBotConfig(userOrId, patch = {}, { rename = true } = {}) {
  const user = userOf(userOrId);
  if ( !isBotUser(user) ) throw new Error(game.i18n.localize("RL.Bots.Error.notBot"));
  const info = botInfo(user);
  const path = `flags.${SYSTEM_ID}.bot`;
  const update = {};
  if ( patch.difficulty !== undefined ) {
    if ( !DIFFICULTIES.includes(patch.difficulty) ) throw new Error(`Unknown bot difficulty "${patch.difficulty}"`);
    update[`${path}.difficulty`] = patch.difficulty;
  }
  const engine = patch.engine ?? info.engine;
  if ( patch.engine !== undefined ) {
    if ( !ENGINES.includes(patch.engine) ) throw new Error(`Unknown bot engine "${patch.engine}"`);
    update[`${path}.engine`] = patch.engine;
  }
  if ( patch.model !== undefined ) update[`${path}.model`] = patch.model || null;
  let personality = info.personality;
  if ( (patch.personality !== undefined) || ((engine === "llm") && !personality) ) {
    personality = resolvePersonality(patch.personality ?? null, { except: user });
    update[`${path}.personality`] = personality;
  }
  if ( rename && (engine === "llm") && (personality !== info.personality) ) {
    const old = personalityById(info.personality);
    const next = personalityById(personality);
    const autoNamed = !old || (user.name === old.name) || user.name.startsWith(`${old.name} `)
      || /^Jev\b/.test(user.name);
    if ( next && autoNamed ) update.name = freeName(next.name);
    if ( next?.portrait && (!old || (user.avatar === old.portrait) || (user.avatar === AVATAR)) ) update.avatar = next.portrait;
  }
  return Object.keys(update).length ? user.update(update) : user;
}

/** [GM] Replace a chat bot's memory (the driver's debrief writes it). */
export async function setBotMemory(userOrId, memory) {
  const user = userOf(userOrId);
  if ( !isBotUser(user) ) throw new Error(game.i18n.localize("RL.Bots.Error.notBot"));
  return user.update({ [`flags.${SYSTEM_ID}.bot.memory`]: memory ?? null });
}

/** [GM] Forget everything a chat bot remembers from past games. */
export const clearBotMemory = userOrId => setBotMemory(userOrId, null);

/** [GM] Delete a bot player. Refuses while the bot is seated in a war that hasn't ended. */
export async function removeBot(userOrId) {
  const user = userOf(userOrId);
  if ( !isBotUser(user) ) throw new Error(game.i18n.localize("RL.Bots.Error.notBot"));
  const faction = seatedFaction(user);
  if ( faction ) throw new Error(game.i18n.format("RL.Bots.Error.seated", { name: user.name, faction: faction.name }));
  return user.delete();
}
