/**
 * Driver plumbing: settings, waiting, pausing, the shared status/stats, and small accessors over
 * `game.risklegacy` (the other areas are reached at runtime only, ARCHITECTURE §2.3).
 */
import { SYSTEM_ID } from "../../config.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";
import { botOfFaction, isBotUser } from "../users.mjs";

export const RL = () => game.risklegacy;

/** Turn guards (BOTS.md §6.1). */
export const MAX_ACTIONS = 60;
export const MAX_REFUSALS = 5;
/** How long to poll for the board to reflect an action. */
export const SETTLE_MS = 3000;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/**
 * Poll a predicate until it holds.
 * @returns {Promise<boolean>} whether it held before the timeout
 */
export async function waitFor(fn, ms = SETTLE_MS, interval = 100) {
  const t0 = Date.now();
  for ( ;; ) {
    try {
      if ( fn() ) return true;
    } catch(err) { /* keep waiting */ }
    if ( Date.now() - t0 >= ms ) return false;
    await sleep(interval);
  }
}

const setting = (key, fallback) => {
  try {
    return getSetting(key) ?? fallback;
  } catch(err) {
    return fallback;
  }
};

/** Delay between visible actions (ms). */
export const pace = () => Math.max(0, Number(setting(SETTINGS.pace, 800)) || 0);

/**
 * The pace wait after a visible action of a bot turn `T`. Jev bots wait `pace` right away (as always). Chat-model bots
 * (`T.lazyPace`) only note when the next action may come; `paceBefore` waits what is left of it, so a decision slower
 * than the pace (chat calls take seconds) isn't followed by the full pace on top (BOTS-LLM.md §7).
 */
export async function paceAfter(T) {
  if ( T?.lazyPace ) {
    T.paceUntil = Date.now() + pace();
    return;
  }
  await sleep(pace());
}

/** Wait out the rest of a chat-model bot's pending pace before its next visible action (no-op for Jev bots). */
export async function paceBefore(T) {
  const until = T?.paceUntil ?? 0;
  if ( !until ) return;
  T.paceUntil = 0;
  const left = until - Date.now();
  if ( left > 0 ) await sleep(left);
}

/** The pace wait after a reactive decision's action: none for a chat-model decision that took longer than the pace. */
export function paceFor(ctx) {
  const ms = pace();
  return ((ctx?.bot?.engine === "llm") && ((ctx.decisionMs ?? 0) >= ms)) ? 0 : ms;
}
/** Reaction window for people (ms). */
export const reactionWindow = () => Math.max(0, Number(setting(SETTINGS.reactionWindow, 8)) || 0) * 1000;
/** "ask" | "heuristic" */
export const errorPolicy = () => (setting(SETTINGS.onError, "ask") === "heuristic" ? "heuristic" : "ask");

/* -------------------------------------------- */
/*  Pause                                       */
/* -------------------------------------------- */

const waiters = new Set();

export const isPaused = () => !!setting(SETTINGS.paused, false);

/** [GM] Pause or resume every bot (world setting, so it survives a reload). */
export async function setPaused(paused) {
  if ( !game.user?.isGM ) return;
  if ( isPaused() !== !!paused ) await game.settings.set(SYSTEM_ID, SETTINGS.paused, !!paused);
  if ( !paused ) wakeWaiters();
}

export function wakeWaiters() {
  for ( const resolve of waiters ) resolve();
  waiters.clear();
}

/** Wait while the bots are paused (checked before every action and answer). */
export async function waitIfPaused() {
  while ( isPaused() ) {
    status.waiting = "paused";
    await new Promise(resolve => {
      waiters.add(resolve);
      setTimeout(resolve, 1000);
    });
  }
  if ( status.waiting === "paused" ) status.waiting = null;
}

/* -------------------------------------------- */
/*  Status and statistics                       */
/* -------------------------------------------- */

const freshStats = () => ({
  turns: 0, actions: 0, refusals: 0, battles: 0, conquests: 0, expansions: 0, maneuvers: 0, starsBought: 0,
  cardsDrawn: 0, joins: 0, missilesFired: 0, scarsPlayed: 0, answers: 0, errors: 0, stalls: 0, guards: 0, turnMs: 0,
  debriefs: 0
});

/** Live driver state, read by `status()`. */
export const status = {
  running: null,     // {faction, name, key, step}
  waiting: null,     // "paused" | "jev" | "llm" | null
  lastError: null,   // {time, faction, message}
  stats: freshStats()
};

export function resetStats() {
  status.stats = freshStats();
  status.lastError = null;
}

export function noteError(message, faction = "") {
  status.lastError = { time: Date.now(), faction, message: String(message ?? "") };
}

/* -------------------------------------------- */
/*  War and factions                            */
/* -------------------------------------------- */

export const getWar = () => RL()?.state?.getWar?.() ?? null;

/** Is it this faction's turn, fully started (the turn handlers' own readiness condition)? */
export function isCurrent(fid) {
  const war = getWar();
  return !!war && (war.system.stage === "playing") && (war.combatant?.actorId === fid) && (war.system.turn.faction === fid);
}

export const warPlaying = () => getWar()?.system.stage === "playing";

/** A fresh snapshot, or null when there is no board yet. */
export function snapshot() {
  try {
    return RL().turn.snapshot();
  } catch(err) {
    return null;
  }
}

/** Factions in the current war (active, not eliminated). */
export function warFactions() {
  return (RL()?.state?.getFactions?.({ active: true }) ?? []).filter(f => f.system.war?.status !== "eliminated");
}

/** Bot-played factions in the current war: [{actor, user, difficulty, bot}] (`bot` = botOfFaction()). */
export function botFactions() {
  return warFactions().map(actor => ({ actor, bot: botOfFaction(actor) })).filter(x => x.bot)
    .map(({ actor, bot }) => ({ actor, user: bot.user, difficulty: bot.difficulty, bot }));
}

/** The faction a bot user plays (current war first, then any faction it was seated at). */
export function factionOfBot(user) {
  const id = typeof user === "string" ? user : user?.id;
  if ( !id ) return null;
  const all = RL()?.state?.getFactions?.() ?? [];
  return all.find(a => a.system.war?.active && (a.system.war.playerId === id))
    ?? all.find(a => a.system.war?.playerId === id) ?? null;
}

/** Is the faction played by a person (any non-bot player, including the GM in hot-seat)? */
export const isPersonFaction = actor => !botOfFaction(actor);

export { botOfFaction, isBotUser };

/** Plain JSON copy (drops documents, functions, cycles). */
export function plain(value) {
  if ( value === undefined ) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch(err) {
    return null;
  }
}

export const territoryName = id => RL()?.state?.getCampaignBoard?.()?.territories?.[id]?.name ?? id;
