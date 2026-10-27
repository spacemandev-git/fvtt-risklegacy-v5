/**
 * The chat-model bots' debrief after a war (BOTS-LLM.md §7): on `risklegacy.warEnded(war, winner)`, each seated chat
 * bot of difficulty normal or hard writes a short memo into its memory (users.mjs setBotMemory), which it reads in later
 * games.
 *
 * Timing: after the end-of-game prompts the bots answer (the end-of-game wizard's results, signature, winner's reward
 * and held-on rewards, saved on the campaign as flag `endGame`), so the summary includes the rewards, cities and scars
 * of this game. If the wizard never gets there, the debrief runs anyway after a while. Never twice for one war: a bot
 * whose memory was already updated for this game is skipped (this survives a reload), and so is one in progress.
 */
import { LEGACY_GAMES, SYSTEM_ID } from "../../config.mjs";
import { botInfo, botOfFaction, setBotMemory } from "../users.mjs";
import { botName, buildContext } from "./context.mjs";
import { decide } from "./decide.mjs";
import { warAccount } from "./recent.mjs";
import { RL, getWar, noteError, plain, sleep, snapshot, status, territoryName } from "./util.mjs";

/** "<war id>:<user id>" debriefs done or running. */
const started = new Set();
/** War ids being watched. */
const watching = new Set();
/** Captured wars waiting for their debrief (so debriefNow can skip the wait). */
const pendingInfo = new Map();

const POLL_MS = 2000;
/** Without any end-of-game progress for this war, go ahead after this long. */
const NO_WIZARD_MS = 3 * 60_000;
/** Whatever happens, go ahead after this long. */
const MAX_WAIT_MS = 20 * 60_000;

const DEBRIEF_LEVELS = new Set(["normal", "hard"]);

/** The war's chat bots that debrief (normal and hard), with what the end of the war looked like. */
function capture(war, winner) {
  const state = snapshot();
  const winnerId = winner?.id ?? war.system.winner ?? "";
  const ids = (war.turns ?? war.combatants?.contents ?? []).map(c => c.actorId).filter(Boolean);
  let results = [];
  try {
    results = RL().turn.computeResults?.(war) ?? [];
  } catch(err) { /* fall back below */ }
  const seats = [];
  const everyone = ids.map(fid => {
    const actor = game.actors.get(fid);
    const bot = botOfFaction(actor);
    return { fid, name: actor?.name ?? fid, userId: actor?.system.war?.playerId || null, bot };
  });
  for ( const s of everyone ) {
    if ( (s.bot?.engine !== "llm") || !DEBRIEF_LEVELS.has(s.bot.difficulty) ) continue;
    const f = state?.factions?.[s.fid];
    const actor = game.actors.get(s.fid);
    const start = actor?.system.war?.startingTerritory || "";
    const hqOwner = start ? (state?.territories?.[start]?.owner ?? null) : null;
    const result = results.find(r => (r.faction === s.fid) || (r.faction?.id === s.fid))?.result
      ?? ((s.fid === winnerId) ? "won" : ((actor?.system.war?.status === "eliminated") || !(f?.troops > 0)) ? "eliminated" : "heldOn");
    seats.push({
      fid: s.fid, userId: s.userId, faction: s.name, difficulty: s.bot.difficulty, result,
      hq: !start ? "unknown" : (hqOwner === s.fid ? `held (${territoryName(start)})`
        : hqOwner ? `captured by ${state.factions[hqOwner]?.name ?? "another faction"} (${territoryName(start)})` : `lost (${territoryName(start)})`),
      account: warAccount(s.fid, state)
    });
  }
  return {
    warId: war.id, game: war.system.game ?? RL().state.getCampaign()?.system.nextGameNumber ?? 0, rounds: war.round ?? 0,
    winnerId, winner: winnerId ? (game.actors.get(winnerId)?.name ?? "") : "",
    stars: Object.fromEntries(everyone.map(s => [s.name, state?.factions?.[s.fid]?.redStars?.total ?? 0])),
    everyone: everyone.map(s => ({
      fid: s.fid, faction: s.name, user: s.userId, bot: !!s.bot, botName: s.bot ? botName(s.bot) : null,
      personality: s.bot?.personality ?? null
    })),
    seats
  };
}

/** Have the end-of-game prompts the bots answer been answered? */
function promptsDone(info) {
  const end = RL().state.getCampaign()?.getFlag(SYSTEM_ID, "endGame");
  if ( end?.warId !== info.warId ) return null;
  if ( end.finished ) return true;
  if ( !end.confirmed ) return false;
  if ( (end.game ?? info.game) > LEGACY_GAMES ) return true;
  for ( const s of info.seats ) {
    const row = (end.results ?? []).find(r => r.faction === s.fid);
    if ( (row?.result === "won") && !(end.signature && end.reward) ) return false;
    if ( (row?.result === "heldOn") && !end.heldOn?.[s.fid] ) return false;
  }
  return true;
}

/** This game's legacy record, from the campaign (rewards, cities, scars, continents). */
function legacyOfGame(info, seat) {
  const sys = RL().state.getCampaign()?.system;
  if ( !sys ) return {};
  const entry = (sys.games ?? []).find(g => g.number === info.game);
  const mine = entry?.results?.find(r => r.faction === seat.fid);
  const cities = [];
  const scars = [];
  for ( const [id, t] of Object.entries(sys.territories ?? {}) ) {
    if ( t.city?.type && (t.city.game === info.game) ) cities.push(`${t.city.type} city ${t.city.name || territoryName(id)} in ${territoryName(id)}${t.city.founderId === seat.userId ? " (yours)" : ""}`);
    if ( t.scar && (t.scarGame === info.game) ) scars.push(`${RL().state.findEntry("scars", t.scar)?.name ?? t.scar} on ${territoryName(id)}`);
  }
  const label = id => RL().state.getCampaignBoard?.()?.continents?.[id]?.label ?? id;
  const continents = Object.entries(sys.continents ?? {}).filter(([, c]) => c.game === info.game)
    .map(([id, c]) => (c.name ? `${label(id)} named "${c.name}"${c.namedById === seat.userId ? " by you" : ""}` : `${label(id)} bonus ${c.modifier > 0 ? "+1" : "-1"}`));
  return {
    winnerReward: entry?.rewardDetail || entry?.reward || "",
    myReward: mine?.rewardDetail || mine?.reward || "",
    cities, scars, continents
  };
}

/** The debrief summary for one bot (BOTS-LLM.md §7). No player names: opponents by user id and faction. */
export function summaryFor(info, seat) {
  const legacy = legacyOfGame(info, seat);
  return {
    game: info.game,
    rounds: info.rounds,
    winner: info.winner || null,
    youWon: info.winnerId === seat.fid,
    faction: seat.faction,
    result: seat.result,
    stars: info.stars[seat.faction] ?? 0,
    finalStars: info.stars,
    hq: seat.hq,
    against: seat.account.against,
    by: seat.account.by,
    counts: seat.account.counts,
    hitHardestBy: Object.entries(seat.account.attackers ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([fid, n]) => ({ faction: info.everyone.find(e => e.fid === fid)?.faction ?? fid, user: info.everyone.find(e => e.fid === fid)?.user ?? null, attacks: n })),
    rewards: { winner: legacy.winnerReward ?? "", yours: legacy.myReward ?? "" },
    cities: legacy.cities ?? [],
    scars: legacy.scars ?? [],
    continents: legacy.continents ?? [],
    opponents: info.everyone.filter(e => e.fid !== seat.fid).map(e => ({
      user: e.user, faction: e.faction, bot: e.bot, botName: e.botName, personality: e.personality
    }))
  };
}

/** Debrief every bot of a captured war that hasn't yet. */
async function runDebriefs(info) {
  const out = [];
  for ( const seat of info.seats ) {
    const user = game.users.get(seat.userId ?? "");
    const bot = botInfo(user);
    const key = `${info.warId}:${seat.userId}`;
    if ( !bot || (bot.engine !== "llm") || !DEBRIEF_LEVELS.has(bot.difficulty) ) continue;
    if ( started.has(key) || ((Number(bot.memory?.updated) || 0) >= info.game) ) continue;
    started.add(key);
    try {
      const summary = summaryFor(info, seat);
      const ctx = buildContext(seat.fid, { difficulty: bot.difficulty, bot: user });
      ctx.view.game = info.game;
      if ( !Object.keys(ctx.view.seats ?? {}).length ) {
        ctx.view.seats = Object.fromEntries(info.everyone.map(e => [e.fid, { user: e.user, bot: e.bot, botName: e.botName, personality: e.personality }]));
      }
      const d = await decide({ kind: "debrief", ctx, user, fn: "debrief", args: { summary }, fallback: () => null });
      if ( d?.memory && (typeof d.memory === "object") ) {
        const memory = plain(d.memory);
        memory.updated = Math.max(Number(memory.updated) || 0, info.game);
        await setBotMemory(user, memory);
      }
      status.stats.debriefs += 1;
      out.push({ user: user.id, faction: seat.faction, memory: !!d?.memory, say: d?.say ?? "" });
    } catch(err) {
      console.error(`risklegacy | bots: debrief for ${user?.name} failed`, err);
      noteError(`debrief: ${err.message}`, seat.fid);
    }
  }
  return out;
}

/** Wait for the end-of-game prompts, then debrief. */
async function watch(info) {
  if ( watching.has(info.warId) ) return [];
  watching.add(info.warId);
  try {
    const t0 = Date.now();
    for ( ;; ) {
      const done = promptsDone(info);
      const elapsed = Date.now() - t0;
      if ( done === true ) break;
      const wizardOpen = !!foundry.applications.instances.get("rl-end-game");
      if ( (done === null) && !wizardOpen && (elapsed > NO_WIZARD_MS) ) break;
      if ( elapsed > MAX_WAIT_MS ) break;
      await sleep(POLL_MS);
    }
    return await runDebriefs(info);
  } finally {
    watching.delete(info.warId);
  }
}

/** risklegacy.warEnded */
export function onWarEnded(war, winner) {
  if ( !game.user?.isActiveGM || !war ) return;
  let info;
  try {
    info = capture(war, winner);
  } catch(err) {
    console.error("risklegacy | bots: could not prepare the debriefs", err);
    return;
  }
  if ( !info.seats.length ) return;
  pendingInfo.set(war.id, info);
  watch(info).catch(err => console.error("risklegacy | bots: debrief failed", err)).finally(() => pendingInfo.delete(war.id));
}

/** On ready: a war that ended before a reload still gets its debriefs. */
export function resumeDebriefs() {
  if ( !game.user?.isActiveGM ) return;
  const war = getWar();
  if ( war?.system.stage !== "ended" ) return;
  onWarEnded(war, game.actors.get(war.system.winner ?? "") ?? null);
}

/**
 * [GM] Debrief the chat bots of an ended war now, without waiting for the end-of-game prompts (manual or tests).
 * @param {{warId?: string}} [options]   default: the current war
 * @returns {Promise<{user:string, faction:string, memory:boolean, say:string}[]>}
 */
export async function debriefNow({ warId = null } = {}) {
  const war = warId ? game.combats.get(warId) : getWar();
  const info = pendingInfo.get(war?.id ?? warId ?? "") ?? (war ? capture(war, game.actors.get(war.system.winner ?? "") ?? null) : null);
  if ( !info ) return [];
  return runDebriefs(info);
}
