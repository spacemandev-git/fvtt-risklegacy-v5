/**
 * The chat-model bots' brain (BOTS-LLM.md §6): the same API as module/bots/brain/index.mjs (same names, arguments and
 * return shapes, `why` included), plus `debrief`. Pure: no Foundry globals.
 *
 * Context: the Jev BotContext plus
 *  - `ctx.bot = {engine, model, personality: Personality, memory: BotMemory|null, userId}`;
 *  - `ctx.chat(purpose, {messages, schema, reasoning, maxTokens, temperature})` → `{parsed, content, reasoning, model,
 *    usage, cost, ms}` (the driver adds `model`; throws LLMError, never caught here); `null` = heuristic mode, where
 *    every function returns the Jev brain's built-in decision (`ask: null`);
 *  - optional `view.seats`, `view.campaign`, `view.recent` (§7); each degrades gracefully when absent.
 * `ctx.ask` is unused.
 *
 * Decisions may carry `say` (a capped table-talk line, §5.4) and `why.thinking` (the model's 1–3 sentences).
 * Model answers are validated against the menu; an invalid answer after one corrective retry throws
 * LLMError {code: "bad_output"}.
 *
 * Calls per own turn: turn plan (1) + attack plan (1) + replans (easy 0, normal ≤1, hard ≤2) + end of turn (0–1);
 * none when code finds no real choice. Code-only: assessSituation, moveIn, chooseDefenseDice, pickName, winning
 * moves and purchases, verified missions. All wording: ../prompts.mjs. Levels: ../profiles.mjs.
 */
export {
  assessSituation, planStartOfTurn, planScars, planRecruit, planPlacement, nextMove, moveIn, planManeuver, planEndOfTurn
} from "./turn.mjs";

export { chooseDefenseDice, preRollScar, missileDecision, chooseStartingTerritory, chooseOption, pickName } from "./react.mjs";

export { debrief, mergeMemory, normalizeMemory } from "./debrief.mjs";

export { clearLLMCaches, capSay } from "./call.mjs";

export { LLM_PROFILES as PROFILES } from "../profiles.mjs";

/** `why` reasons this brain uses beyond BOTS.md §5.3 and the Jev brain's additions. */
export const WHY_REASONS_ADDED = Object.freeze({
  missileSwing: "fired a missile to swing a battle that matters (not an HQ or the win)",
  defendFewer: "defended with fewer dice because the exact odds favour it",
  debrief: "wrote its notes after the war"
});
