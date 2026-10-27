/**
 * Area: bots (owner: bots; contract in BOTS.md and BOTS-LLM.md), exposed as `game.risklegacy.bots`.
 *
 * AI players for Risk Legacy. A bot is a Foundry User that never logs in (users.mjs). On the active GM's client the
 * driver plays its turns and answers the prompts addressed to it (driver/), using a brain for every decision:
 * - Jev bots (brain/): judgments from Jev (TypeSafe's decision model) through the local relay (jev/client.mjs,
 *   tools/jev-proxy); the arithmetic and the final call stay in code.
 * - Chat-model bots (llm/brain): a chat LLM with a personality picks from code-made menus of legal moves
 *   (llm/client.mjs, an OpenAI-compatible API such as Nous Portal, directly or through the relay's /nous route).
 * ui/ holds the Bot Manager, the decision log, the chat narration and table talk.
 */
import { registerBotSettings } from "./settings.mjs";
import * as driver from "./driver/_module.mjs";
import * as ui from "./ui/_module.mjs";

export {
  DIFFICULTIES, ENGINES, botInfo, botEngine, botPersonality, isBotUser, botDifficulty, botUsers, botOfFaction,
  isBotFaction, difficultyLabel, botTag, seatedFaction, defaultBotName, createBot, setBotDifficulty, setBotConfig,
  setBotMemory, clearBotMemory, usedPersonalities, randomPersonality, removeBot
} from "./users.mjs";
export { getLog, clearLog, logStats } from "./log.mjs";
export { checkRelay, askJev, JevError } from "./jev/client.mjs";
export { askLLM, checkLLM, listModels, lastListError, LLMError, isLLMError } from "./llm/client.mjs";
export { PERSONALITIES, personalityById } from "./llm/personalities.mjs";
export {
  answer, pause, resume, isPaused, playTurn, placeStart, status, buildContext, ANSWERED_KINDS, testing, llmSpend,
  debriefNow
} from "./driver/_module.mjs";
export { openBotManager, openBotLog, narrate } from "./ui/_module.mjs";
export * as brain from "./brain/index.mjs";
export * as llmBrain from "./llm/brain/index.mjs";
export { SETTINGS } from "./settings.mjs";

export function init() {
  registerBotSettings();
  driver.init();
  ui.init();
}

export async function ready() {
  await ui.ready();
  await driver.ready();
}
