/**
 * Bot driver (owner: bots-driver; BOTS.md §6). Runs on the active GM's client only; other clients load it and stay
 * idle.
 *
 * - turn.mjs     the turn loop (turnStarted / updateCombat / ready / resume) and scripted starting placement
 * - battle.mjs   battles as attacker, defender and bystander (scars, missiles, resolve, move in)
 * - answer.mjs   `answer(kind, ctx)` for every prompt addressed to a bot user (hook points in campaign, cards, battle)
 * - context.mjs  BotContext: the snapshot plus public facts only (seats, campaign, recent events for chat bots)
 * - decide.mjs   brain calls by engine (Jev `ask` / chat-model `chat`), the `bots.onError` policy, records, narration
 * - recent.mjs   this war's public events (view.recent, the debrief's account), from hooks and chat cards
 * - debrief.mjs  chat bots' end-of-war memo (risklegacy.warEnded, after the end-of-game prompts)
 * - spend.mjs    chat-model spend per war and its cap
 * - geometry.mjs sea lines and the Alien Island point (code only)
 * - prompts.mjs  pure prompt ↔ brain mapping (Node tests in tests/)
 */
import { SYSTEM_ID } from "../../config.mjs";
import { SETTINGS } from "../settings.mjs";
import { onBattleMessage } from "./battle.mjs";
import { debriefNow, onWarEnded, resumeDebriefs } from "./debrief.mjs";
import { errorDialogOpen, isSessionHeuristic, setBrainOverrides, setSessionHeuristic } from "./decide.mjs";
import { rebuildRecent, recentEvents, registerRecentHooks } from "./recent.mjs";
import { llmSpend, resetSpend } from "./spend.mjs";
import { playTurn as play, placeStart as place, runningTurn, schedule } from "./turn.mjs";
import { isPaused as paused, resetStats, setPaused, status as live, wakeWaiters } from "./util.mjs";

export { answer, ANSWERED_KINDS } from "./answer.mjs";
export { buildContext } from "./context.mjs";
export { llmSpend, debriefNow };

const PAUSED_KEY = `${SYSTEM_ID}.${SETTINGS.paused}`;

export function init() {
  registerRecentHooks();
  Hooks.on("risklegacy.warEnded", (war, winner) => onWarEnded(war, winner));
  Hooks.on("risklegacy.turnStarted", () => schedule(0));
  Hooks.on("updateCombat", combat => {
    if ( combat?.type === "war" ) schedule(250);
  });
  Hooks.on("createChatMessage", message => onBattleMessage(message));
  Hooks.on("updateChatMessage", message => onBattleMessage(message));
  const onSetting = setting => {
    if ( setting?.key !== PAUSED_KEY ) return;
    if ( !paused() ) {
      wakeWaiters();
      schedule(0);
    }
  };
  Hooks.on("updateSetting", onSetting);
  Hooks.on("createSetting", onSetting);
}

export async function ready() {
  if ( game.user?.isGM ) {
    try {
      rebuildRecent();
    } catch(err) {
      console.warn("risklegacy | bots: could not rebuild recent events", err);
    }
  }
  resumeDebriefs();
  // A bot turn interrupted by a reload carries on from its turn record.
  schedule(1500);
}

/** [GM] Pause every bot before its next action or answer. */
export async function pause() {
  await setPaused(true);
}

/** [GM] Resume the bots (and any bot turn waiting to start). */
export async function resume() {
  await setPaused(false);
  wakeWaiters();
  schedule(0);
}

export const isPaused = () => paused();

/** Manual trigger or retry of the current bot turn. */
export const playTurn = fid => play(fid);

/** Scripted setups: place a bot faction's starting forces (its pick, stage `placement`). */
export const placeStart = fid => place(fid);

/** @returns {{running: object|null, paused: boolean, lastError: object|null, waiting: string|null, errorDialog: boolean, heuristicSession: boolean, stats: object}} */
export function status() {
  return {
    running: live.running ? { ...live.running } : null,
    paused: paused(),
    lastError: live.lastError ? { ...live.lastError } : null,
    waiting: live.waiting,
    errorDialog: errorDialogOpen(),
    heuristicSession: isSessionHeuristic(),
    stats: { ...live.stats }
  };
}

/** Test helpers (e2e): not for play. */
export const testing = Object.freeze({
  setBrainOverrides, resetStats, setSessionHeuristic, runningTurn, resetSpend, recentEvents, rebuildRecent
});
